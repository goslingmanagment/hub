import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { systemStateResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// «Состояние» (ecosystem plan, package P): only the owner reads the state of
// every routine and copy; only a key with write:system_state writes a
// reporter's list, never as Hub itself and never over another reporter's
// routine; the matters Hub's server keeps for it are no agent's to open.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const PASSWORDS = { boss: "boss-secret", lead: "lead-secret", alice: "alice-secret" } as const;
const REPORTER = `${AGENT_KEY_TOKEN_PREFIX}state-reporter-000`;
const OTHER = `${AGENT_KEY_TOKEN_PREFIX}state-otherrep-000`;
const MATTERS = `${AGENT_KEY_TOKEN_PREFIX}state-matters-0000`;
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};

async function loginCookie(username: keyof typeof PASSWORDS): Promise<string> {
  const login = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORDS[username] } });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}
const readState = (headers: Record<string, string>) => server!.inject({ method: "GET", url: "/api/v1/system/state", headers });
const put = (path: string, token: string, payload: Record<string, unknown>) =>
  server!.inject({ method: "PUT", url: `/api/v1/agent/system/${path}`, headers: { authorization: `Bearer ${token}` }, payload });

const now = () => new Date().toISOString();
const routine = (key: string, over: Record<string, unknown> = {}) => ({
  key, place: "mac", title: `Рутина ${key}`, periodSeconds: 900, lastRunAt: now(), lastSuccessAt: now(), lastResult: "ok", ...over,
});

describe("system state rights", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: PASSWORDS.boss }, AUDIT);
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    await createUserAccount(app, { username: "alice", role: "chatter" }, AUDIT);
    await setUserPassword(app, { userId: await fixtureUserId(app, "alice"), password: PASSWORDS.alice }, AUDIT);
    const boss = await fixtureUserId(app, "boss");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    const page = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    await assignPageToUser(app, { userId: await fixtureUserId(app, "lead"), pageLabel: "mia-1" }, AUDIT);
    for (const [token, name, capabilities] of [
      [REPORTER, "mac-reporter", ["write:system_state"]],
      [OTHER, "pc-reporter", ["write:system_state"]],
      [MATTERS, "matters-agent", ["write:matters", "read:datasets"]],
    ] as const) {
      await insertAgentKey(app.db, {
        name,
        keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
        keyDigest: sha256Hex(token),
        capabilities: [...capabilities] as never,
        pageIds: [page],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdBy: boss,
      });
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const name of ["boss", "lead", "alice"] as const) cookies[name] = await loginCookie(name);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("only the owner reads the state; a team lead, a chatter, an agent key and nobody do not", async (context) => {
    if (!testDb) return context.skip();
    const owner = await readState({ cookie: cookies.boss! });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(systemStateResponseSchema.safeParse(owner.json()).success).toBe(true);
    expect((await readState({ cookie: cookies.lead! })).statusCode).toBe(403);
    expect((await readState({ cookie: cookies.alice! })).statusCode).toBe(403);
    expect([401, 403]).toContain((await readState({ authorization: `Bearer ${REPORTER}` })).statusCode);
    expect((await readState({})).statusCode).toBe(401);
  });

  it("a key without write:system_state cannot write; with it a reporter's list lands and the owner sees who sent it", async (context) => {
    if (!testDb) return context.skip();
    const body = { reporter: "mac", place: "mac", readAt: now(), routines: [routine("mac.launchd.collect")] };
    expect((await put("routines", MATTERS, body)).statusCode).toBe(403);
    expect((await put("copies", MATTERS, { reporter: "mac", place: "mac", readAt: now(), copies: [] })).statusCode).toBe(403);
    expect((await server!.inject({ method: "PUT", url: "/api/v1/agent/system/routines", payload: body })).statusCode).toBe(401);

    const written = await put("routines", REPORTER, body);
    expect(written.statusCode, written.body).toBe(200);
    expect(written.json()).toMatchObject({ reporter: "mac", accepted: 1, retired: 0 });
    const copies = await put("copies", REPORTER, {
      reporter: "mac", place: "mac", readAt: now(),
      copies: [{ key: "copy.hub", title: "База", source: "сервер", destination: "мак", takenAt: now(), bytes: 10, kept: 1 }],
    });
    expect(copies.statusCode, copies.body).toBe(200);

    const state = systemStateResponseSchema.parse((await readState({ cookie: cookies.boss! })).json());
    expect(state.routines.find((row) => row.key === "mac.launchd.collect")).toMatchObject({ reportedBy: "mac-reporter", state: "ok", place: "mac" });
    expect(state.copies.find((row) => row.key === "copy.hub")).toMatchObject({ reportedBy: "mac-reporter", state: "fresh" });
    const audit = await testDb.pool.query("select operation from agent_read_audit where operation like 'agentSystem%' order by id");
    expect(audit.rows.map((row: { operation: string }) => row.operation)).toEqual(["agentSystemRoutines", "agentSystemCopies"]);
  });

  it("no key writes as Hub itself or over another reporter's routine", async (context) => {
    if (!testDb) return context.skip();
    const asHub = await put("routines", REPORTER, { reporter: "hub", place: "server", readAt: now(), routines: [routine("server.hub.fake", { place: "server" })] });
    expect(asHub.statusCode).toBe(400);
    const taken = await put("routines", OTHER, { reporter: "pc", place: "pc", readAt: now(), routines: [routine("mac.launchd.collect", { place: "pc" })] });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ reason: "routine_other_reporter" });
  });

  it("an agent key opens or closes none of the matters Hub's server keeps for the state", async (context) => {
    if (!testDb) return context.skip();
    const opened = await server!.inject({
      method: "POST", url: "/api/v1/agent/matters", headers: { authorization: `Bearer ${MATTERS}` },
      payload: { key: "routine.silent:mac.launchd.collect", kind: "routine.silent", title: "Молчит", owner: { role: "owner" } },
    });
    expect(opened.statusCode).toBe(409);
  });
});
