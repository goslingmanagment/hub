import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AGENT_REPORT_BODY_MAX_BYTES,
  agentReportListResponseSchema,
  agentReportPutResponseSchema,
  reportGetResponseSchema,
  reportsListResponseSchema,
} from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Agent reports (ecosystem plan, package O): only a key with write:reports
// publishes, and each publish leaves an audit row with the body's digest; the
// owner reads every report, a team lead only the ones opened to team leads (an
// owner-only report is the same 404 as a missing one), and a chatter, a device
// token, an agent key and an anonymous request read none.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const PASSWORDS = { boss: "boss-secret", lead: "lead-secret", alice: "alice-secret" } as const;
const WRITER = `${AGENT_KEY_TOKEN_PREFIX}reports-writer-0000`;
const READER = `${AGENT_KEY_TOKEN_PREFIX}reports-reader-0000`;
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const users: Record<string, number> = {};
const keys: Record<string, number> = {};
const cookies: Record<string, string> = {};
let aliceToken = "";

async function loginCookie(username: keyof typeof PASSWORDS): Promise<string> {
  const login = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORDS[username] } });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}
const asSession = (who: string, url: string) => server!.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const put = (slug: string, payload: Record<string, unknown>, token: string | null = WRITER) => server!.inject({
  method: "PUT", url: `/api/v1/agent/reports/${slug}`, payload, headers: token === null ? {} : { authorization: `Bearer ${token}` },
});

const TRAFFIC = {
  title: "Трафик: доска каналов",
  section: "traffic",
  body: "# Доска каналов\n\n| Канал | Статус |\n|---|---|\n| Канал A | работает |\n\n- ждём: owner\n",
  validHours: 8,
};

describe("agent reports", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: PASSWORDS.boss }, AUDIT);
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    await createUserAccount(app, { username: "alice", role: "chatter" }, AUDIT);
    await setUserPassword(app, { userId: await fixtureUserId(app, "alice"), password: PASSWORDS.alice }, AUDIT);
    for (const name of ["boss", "lead", "alice"]) users[name] = await fixtureUserId(app, name);
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    const page = (await createFanslyPage(app.db, { modelId: model!.id, label: "lora-1" }))!.id;
    for (const [token, capabilities] of [[WRITER, ["write:reports"]], [READER, ["read:messages", "write:matters"]]] as const) {
      const row = await insertAgentKey(app.db, {
        name: token === WRITER ? "traffic" : "reader",
        keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
        keyDigest: sha256Hex(token),
        capabilities: [...capabilities] as never,
        pageIds: [page],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdBy: users.boss!,
      });
      keys[token] = row.id;
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const name of ["boss", "lead", "alice"] as const) cookies[name] = await loginCookie(name);
    aliceToken = (await issueDeviceTokenForUserId(app, { userId: users.alice!, label: "alice client" })).token;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("only a key with write:reports publishes, and every publish leaves an audit row with the body's digest", async (context) => {
    if (!testDb) return context.skip();
    expect((await put("traffic", TRAFFIC, null)).statusCode).toBe(401);
    expect((await put("traffic", TRAFFIC, READER)).statusCode).toBe(403);
    expect((await testDb.pool.query("select count(*)::int as n from agent_reports")).rows[0].n).toBe(0);

    const first = await put("traffic", TRAFFIC);
    expect(first.statusCode, first.body).toBe(200);
    expect(agentReportPutResponseSchema.parse(first.json())).toMatchObject({
      changed: true,
      report: { slug: "traffic", section: "traffic", version: 1, teamLeads: false, validHours: 8, stale: false, publishedBy: { name: "traffic" } },
    });
    const audit = await testDb.pool.query(
      "select agent_key_id, request_summary from agent_read_audit where operation = 'agentReportPut' order by id",
    );
    expect(audit.rows).toHaveLength(1);
    expect(Number(audit.rows[0].agent_key_id)).toBe(keys[WRITER]);
    expect(audit.rows[0].request_summary).toEqual({
      reportSlug: "traffic",
      reportVersion: 1,
      created: true,
      textSha256: createHash("sha256").update(TRAFFIC.body, "utf8").digest("hex"),
      textLength: Buffer.byteLength(TRAFFIC.body, "utf8"),
    });

    // The same page again keeps its version; a changed text counts a new one.
    expect(agentReportPutResponseSchema.parse((await put("traffic", TRAFFIC)).json())).toMatchObject({ changed: false, report: { version: 1 } });
    const second = agentReportPutResponseSchema.parse((await put("traffic", { ...TRAFFIC, body: `${TRAFFIC.body}\nЕщё строка.\n` })).json());
    expect(second).toMatchObject({ changed: true, report: { version: 2 } });
    expect((await testDb.pool.query("select count(*)::int as n from agent_read_audit where operation = 'agentReportPut'")).rows[0].n).toBe(3);

    // Over the ceiling, a slug of the wrong shape: refused, nothing written.
    expect((await put("traffic", { ...TRAFFIC, body: "я".repeat(AGENT_REPORT_BODY_MAX_BYTES / 2 + 1) })).statusCode).toBe(400);
    expect((await put("Traffic!", TRAFFIC)).statusCode).toBe(400);
    expect((await testDb.pool.query("select version from agent_reports where slug = 'traffic'")).rows[0].version).toBe(2);

    // The key's own list: what is published, without bodies; a key without the capability gets nothing.
    const listed = await server!.inject({ method: "GET", url: "/api/v1/agent/reports", headers: { authorization: `Bearer ${WRITER}` } });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(agentReportListResponseSchema.parse(listed.json()).reports.map((report) => [report.slug, report.version])).toEqual([["traffic", 2]]);
    expect(listed.body).not.toContain("Канал A");
    expect((await server!.inject({ method: "GET", url: "/api/v1/agent/reports", headers: { authorization: `Bearer ${READER}` } })).statusCode).toBe(403);
  });

  it("the owner reads every report, a team lead the ones opened to team leads, nobody else any", async (context) => {
    if (!testDb) return context.skip();
    expect((await put("traffic", TRAFFIC)).statusCode).toBe(200);
    expect((await put("team-board", { title: "Доска команды", section: "team", body: "Всё спокойно.", teamLeads: true })).statusCode).toBe(200);

    const slugs = async (who: string) => {
      const response = await asSession(who, "/api/v1/reports");
      expect(response.statusCode, response.body).toBe(200);
      return reportsListResponseSchema.parse(response.json()).reports.map((report) => report.slug).sort();
    };
    expect(await slugs("boss")).toEqual(["team-board", "traffic"]);
    expect(await slugs("lead")).toEqual(["team-board"]);

    const owner = await asSession("boss", "/api/v1/reports/traffic");
    expect(owner.statusCode, owner.body).toBe(200);
    expect(reportGetResponseSchema.parse(owner.json()).report.body).toBe(TRAFFIC.body);
    expect((await asSession("lead", "/api/v1/reports/team-board")).statusCode).toBe(200);
    // An owner-only report is, for a team lead, the same 404 as a missing one.
    expect((await asSession("lead", "/api/v1/reports/traffic")).statusCode).toBe(404);
    expect((await asSession("boss", "/api/v1/reports/nothing-here")).statusCode).toBe(404);

    // A chatter's session, a chatter's device token, an agent key, nobody: no report.
    for (const url of ["/api/v1/reports", "/api/v1/reports/team-board"]) {
      expect((await asSession("alice", url)).statusCode).toBe(403);
      expect((await server!.inject({ method: "GET", url })).statusCode).toBe(401);
      expect([401, 403]).toContain((await server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${aliceToken}` } })).statusCode);
      expect([401, 403]).toContain((await server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${WRITER}` } })).statusCode);
    }
  });
});
