import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Отчёт смены (ecosystem package F): who reads and who writes a shift's report.
// The person hands in their own shift, only with their switch on, by their
// session or their extension's narrow token; a colleague on the page and a team
// lead read the handed-in version and change nothing; a chatter of another page
// is refused; an agent key writes only with write:shift_reports, hands in only
// with the message and a sender who is the person. Money-adjacent: required.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const SENDER = 700_000_111;
const KEYS = {
  none: `${AGENT_KEY_TOKEN_PREFIX}shift-no-capability`,
  writer: `${AGENT_KEY_TOKEN_PREFIX}shift-writer-key`,
} as const;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let extensionToken = "";
let shiftA = 0;
let shiftOff = 0;

const asSession = (who: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asKey = (key: keyof typeof KEYS, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${KEYS[key]}` }, ...(payload ? { payload } : {}) });

async function insertShift(userId: number, page: string, startedAt: string, endedAt: string): Promise<number> {
  const result = await testDb!.pool.query(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 400, 300, $4::date, $5::jsonb) returning id`,
    [userId, startedAt, endedAt, startedAt.slice(0, 10), JSON.stringify([{ pageLabel: page, activeMinutes: 400, messages: 300, salesFrom: startedAt }])],
  );
  return Number(result.rows[0].id);
}

describe("the shift report: who reads, who writes", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "lead", role: "team_lead", password: "lead-password-for-tests" }, { source: "cli" });
    for (const name of ["anna", "bella", "cora", "dina"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-password-for-tests` }, { source: "cli" });
    }
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    const one = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    const two = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-2" }))!.id;
    for (const [name, page] of [["anna", one], ["bella", one], ["cora", two], ["dina", one], ["lead", one]] as const) {
      await assignUserToPage(app.db, await fixtureUserId(app, name), page);
    }
    const owner = await fixtureUserId(app, "boss");
    const grants: Record<keyof typeof KEYS, string[]> = { none: ["read:team"], writer: ["write:shift_reports"] };
    for (const [name, token] of Object.entries(KEYS) as [keyof typeof KEYS, string][]) {
      await insertAgentKey(testDb.db, {
        name: `shift-${name}`,
        keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
        keyDigest: sha256Hex(token),
        capabilities: grants[name] as never,
        pageIds: [one, two],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdBy: owner,
      });
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "lead", "anna", "bella", "cora", "dina"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    // The people: anna and bella hand their shifts in in Hub, dina does not (her switch is off).
    const person = async (code: string, rights: string[], telegram?: number) => {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code, displayName: code, role: "chatter", state: "working", rights,
        ...(telegram === undefined ? {} : { telegram: { userId: telegram } }),
        logins: { add: [await fixtureUserId(app, code)] },
      });
      expect(created.statusCode, created.body).toBe(200);
    };
    await person("anna", ["submits_shift"], SENDER);
    await person("bella", ["submits_shift"]);
    await person("cora", ["submits_shift"]);
    await person("dina", []);
    // The switch was turned on before the shifts.
    await testDb.pool.query("update person_rights set granted_at = '2026-11-01T00:00:00Z'");
    shiftA = await insertShift(await fixtureUserId(app, "anna"), "mia-1", "2026-11-10T15:00:00Z", "2026-11-10T23:00:00Z");
    shiftOff = await insertShift(await fixtureUserId(app, "dina"), "mia-1", "2026-11-09T15:00:00Z", "2026-11-09T23:00:00Z");
    extensionToken = (await issueDeviceTokenForUserId(app, { userId: await fixtureUserId(app, "anna"), label: "ext", clientProfile: "chat-extension" })).token;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("lets the person write and hand in their own shift, each hand-in a new version", async (context) => {
    if (!testDb) return context.skip();
    const own = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shiftA}`)).json());
    expect(own).toMatchObject({ access: "own", enabled: true, canEdit: true, state: "open", latest: null });
    expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftA}/comment`, { comment: "фан ждёт ответа" })).statusCode).toBe(200);
    const off = await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/off-platform`, { amountMills: 50_000, fromWhom: "фан", whatFor: "кастом" });
    expect(off.statusCode, off.body).toBe(200);
    const first = shiftReportResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/submit`)).json());
    expect(first.state).toBe("submitted");
    expect(first.latest).toMatchObject({ version: 1, door: "workboard" });
    // «Мимо площадки» is shown, never summed.
    expect(first.view?.offPlatform).toEqual([expect.objectContaining({ amountMills: 50_000, state: "pending" })]);
    expect(first.view?.totalMills).toBe(0);
    // The extension's narrow token is the same person through the other door.
    const second = await server!.inject({ method: "POST", url: `/api/v1/shift-reports/${shiftA}/submit`, headers: { authorization: `Bearer ${extensionToken}` } });
    expect(second.statusCode, second.body).toBe(200);
    expect(shiftReportResponseSchema.parse(second.json()).latest).toMatchObject({ version: 2, door: "extension" });
    const versions = await testDb.pool.query("select version from shift_handin_versions order by version");
    expect(versions.rows.map((row: { version: number }) => Number(row.version))).toEqual([1, 2]);
    // A version is never changed.
    await expect(testDb.pool.query("update shift_handin_versions set total_mills = 1")).rejects.toThrow(/immutable/);
  });

  it("lets a colleague of the page and a team lead read the version handed in, and change nothing", async (context) => {
    if (!testDb) return context.skip();
    for (const who of ["bella", "lead"]) {
      const read = await asSession(who, "GET", `/api/v1/shift-reports/${shiftA}`);
      expect(read.statusCode, read.body).toBe(200);
      const report = shiftReportResponseSchema.parse(read.json());
      expect(report).toMatchObject({ access: "read", canEdit: false, posts: [], colleagues: [] });
      expect(report.view?.source).toBe("version");
      // What the person says came past the platform is the person's and the owner's, not a colleague's.
      expect(report.view?.offPlatform).toEqual([]);
      expect((await asSession(who, "PUT", `/api/v1/shift-reports/${shiftA}/comment`, { comment: "x" })).statusCode).toBe(403);
      expect((await asSession(who, "POST", `/api/v1/shift-reports/${shiftA}/submit`)).statusCode).toBe(403);
      expect((await asSession(who, "POST", `/api/v1/shift-reports/${shiftA}/off-platform`, { amountMills: 1_000, fromWhom: "x", whatFor: "y" })).statusCode).toBe(403);
    }
    const owner = shiftReportResponseSchema.parse((await asSession("boss", "GET", `/api/v1/shift-reports/${shiftA}`)).json());
    expect(owner.access).toBe("read");
    expect(owner.view?.offPlatform).toHaveLength(1);
    expect((await asSession("boss", "POST", `/api/v1/shift-reports/${shiftA}/submit`)).statusCode).toBe(403);
  });

  it("refuses a chatter of another page", async (context) => {
    if (!testDb) return context.skip();
    expect((await asSession("cora", "GET", `/api/v1/shift-reports/${shiftA}`)).statusCode).toBe(403);
    const list = await asSession("cora", "GET", `/api/v1/shift-reports?from=2026-11-09&to=2026-11-11&userId=${await fixtureUserId(app, "anna")}`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().shifts).toEqual([]);
  });

  it("changes nothing for a person whose switch is off", async (context) => {
    if (!testDb) return context.skip();
    expect((await asSession("dina", "PUT", `/api/v1/shift-reports/${shiftOff}/comment`, { comment: "x" })).statusCode).toBe(403);
    expect((await asSession("dina", "POST", `/api/v1/shift-reports/${shiftOff}/submit`)).statusCode).toBe(403);
    const list = await asSession("dina", "GET", "/api/v1/shift-reports?from=2026-11-08&to=2026-11-11");
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({ enabled: false, enabledSince: null, shifts: [] });
  });

  it("lets an agent key write only with write:shift_reports, and hand in only with the message and the person as its sender", async (context) => {
    if (!testDb) return context.skip();
    const draft = `/api/v1/agent/shift-reports/draft?shiftId=${shiftA}`;
    expect((await asKey("none", "GET", draft)).statusCode).toBe(403);
    expect((await asKey("none", "POST", "/api/v1/agent/shift-reports/submit", { shiftId: shiftA, telegramUserId: SENDER, sourceRef: "chat:1" })).statusCode).toBe(403);
    const read = await asKey("writer", "GET", `/api/v1/agent/shift-reports/draft?telegramUserId=${SENDER}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(shiftReportResponseSchema.parse(read.json()).shift.id).toBe(shiftA);
    // No message: refused.
    expect((await asKey("writer", "POST", "/api/v1/agent/shift-reports/submit", { shiftId: shiftA, telegramUserId: SENDER })).statusCode).toBe(400);
    // A sender who is not the person: refused, and nothing written.
    const stranger = await asKey("writer", "POST", "/api/v1/agent/shift-reports/submit", { shiftId: shiftA, telegramUserId: SENDER + 1, sourceRef: "chat:2" });
    expect(stranger.statusCode).toBe(409);
    expect(stranger.json().reason).toBe("sender_not_person");
    expect((await asKey("writer", "POST", "/api/v1/agent/shift-reports/comment", { shiftId: shiftA, comment: "x", telegramUserId: SENDER + 1 })).statusCode).toBe(409);
    const done = await asKey("writer", "POST", "/api/v1/agent/shift-reports/submit", { shiftId: shiftA, telegramUserId: SENDER, sourceRef: "chat:3" });
    expect(done.statusCode, done.body).toBe(200);
    expect(shiftReportResponseSchema.parse(done.json()).latest).toMatchObject({ door: "telegram" });
    const stored = await testDb.pool.query("select door, telegram_message_ref, telegram_sender_id from shift_handin_versions order by version desc limit 1");
    expect(stored.rows[0]).toMatchObject({ door: "telegram", telegram_message_ref: "chat:3" });
    expect(Number(stored.rows[0].telegram_sender_id)).toBe(SENDER);
    // The ledger's feed needs read:team and read:money.
    expect((await asKey("writer", "GET", "/api/v1/agent/shift-reports")).statusCode).toBe(403);
  });

  it("offers and takes a sale by hand only on a page the person may open", async (context) => {
    if (!testDb) return context.skip();
    const sale = async (page: string, ref: string) => {
      const pageId = (await testDb!.pool.query("select id from pages where label = $1", [page])).rows[0].id;
      const inserted = await testDb!.pool.query(
        `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
           gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
         values ($1, $2, 'subscription', 'subscription', 'posted', 'ok', 20000, 20000, 16000, 4000, now() - interval '1 hour', 'fansly:rest', 'USD')
         returning id`,
        [pageId, ref],
      );
      return Number(inserted.rows[0].id);
    };
    const open = await sale("mia-1", "tx-claim-open");
    const closed = await sale("mia-2", "tx-claim-closed");
    const offered = await asSession("anna", "GET", `/api/v1/shift-reports/${shiftA}/claimable`);
    expect(offered.statusCode, offered.body).toBe(200);
    const ids = offered.json().sales.map((one: { transactionId: number }) => one.transactionId);
    expect(ids).toContain(open);
    expect(ids).not.toContain(closed);
    // A page the person may not open: never taken, by the session or «со слов».
    const refused = await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftA}/lines/${closed}`, { statement: "mine", note: "моя договорённость" });
    expect(refused.statusCode).toBe(404);
    expect((await asKey("writer", "POST", "/api/v1/agent/shift-reports/line", {
      shiftId: shiftA, transactionId: closed, statement: "mine", note: "со слов", telegramUserId: SENDER,
    })).statusCode).toBe(404);
    // «Моё» needs a line of why.
    expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftA}/lines/${open}`, { statement: "mine" })).statusCode).toBe(400);
    const taken = await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftA}/lines/${open}`, { statement: "mine", note: "фан мой, договорились вчера" });
    expect(taken.statusCode, taken.body).toBe(200);
    const report = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shiftA}`)).json());
    // Its home is not computed yet: the «моё» is disputed — it claims the net and counts nothing until settled (review R2b-2).
    expect(report.view?.lines.find((line) => line.transactionId === open)).toMatchObject({ group: "mine", added: true, statement: "mine", amountMills: 0, claimedMills: 16_000, disputed: true });
    expect(report.view?.lines.some((line) => line.transactionId === closed)).toBe(false);
    // A colleague of the page cannot take it for the person, nor list it.
    expect((await asSession("bella", "GET", `/api/v1/shift-reports/${shiftA}/claimable`)).statusCode).toBe(403);
  });
});
