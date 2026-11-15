import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { agentShiftReportChecksResponseSchema, agentShiftReportsFeedResponseSchema, shiftReportConfirmResponseSchema, shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { editingSession } from "./helpers/shift-report-hand-in.ts";

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
  // Issued in the last test only: a key that reviews makes every later hand-in wait for its check.
  reviewer: `${AGENT_KEY_TOKEN_PREFIX}shift-reviewer-key`,
  ledger: `${AGENT_KEY_TOKEN_PREFIX}shift-ledger-key`,
} as const;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let extensionToken = "";
let shiftA = 0;
let shiftOff = 0;

const rawSession = (who: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);
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
    const grants: Record<"none" | "writer" | "ledger", string[]> = { none: ["read:team"], writer: ["write:shift_reports"], ledger: ["read:team", "read:money"] };
    for (const [name, token] of Object.entries(KEYS).filter(([key]) => key !== "reviewer") as ["none" | "writer" | "ledger", string][]) {
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

  it("lets the person hand in a candidate and confirm it into a version, each confirmation a new version", async (context) => {
    if (!testDb) return context.skip();
    const own = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shiftA}`)).json());
    expect(own).toMatchObject({ access: "own", enabled: true, canEdit: true, state: "open", latest: null });
    expect(own.board).toMatchObject({ phase: "draft", chip: "Черновик", candidate: null, canConfirm: false });
    expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftA}/comment`, { comment: "фан ждёт ответа" })).statusCode).toBe(200);
    const off = await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/off-platform`, { amountMills: 50_000, fromWhom: "фан", whatFor: "кастом" });
    expect(off.statusCode, off.body).toBe(200);
    // «Сдать смену» records a candidate and makes no version; nothing checks this shift, so it waits for «Подтверждаю».
    const handed = shiftReportResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/submit`)).json());
    expect(handed).toMatchObject({ state: "open", latest: null });
    expect(handed.board).toMatchObject({ phase: "confirm", canConfirm: true, candidate: { number: 1, door: "workboard", superseded: false } });
    expect((await testDb.pool.query("select count(*)::int as n from shift_handin_versions")).rows[0].n).toBe(0);
    // A candidate is never changed.
    await expect(testDb.pool.query("update shift_handin_candidates set total_mills = 1")).rejects.toThrow(/immutable/);
    const first = shiftReportConfirmResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/confirm`, { candidateId: handed.board!.candidate!.id })).json());
    expect(first).toMatchObject({ confirmed: true, refused: null });
    expect(first.report.state).toBe("submitted");
    expect(first.report.latest).toMatchObject({ version: 1, door: "workboard" });
    expect(first.report.board?.phase).toBe("counted");
    // «Мимо площадки» is shown, never summed.
    expect(first.report.view?.offPlatform).toEqual([expect.objectContaining({ amountMills: 50_000, state: "pending" })]);
    expect(first.report.view?.totalMills).toBe(0);
    // The extension's narrow token is the same person through the other door: «Исправить», «Сдать заново», «Подтверждаю».
    const ext = (method: "POST", url: string, payload?: Record<string, unknown>) =>
      server!.inject({ method, url, headers: { authorization: `Bearer ${extensionToken}` }, ...(payload ? { payload } : {}) });
    expect((await ext("POST", `/api/v1/shift-reports/${shiftA}/reopen`)).statusCode).toBe(200);
    const again = shiftReportResponseSchema.parse((await ext("POST", `/api/v1/shift-reports/${shiftA}/submit`)).json());
    expect(again.board?.candidate?.number).toBe(2);
    // The first candidate is superseded: signing it is refused with the fresh board, and nothing is made.
    const stale = shiftReportConfirmResponseSchema.parse((await ext("POST", `/api/v1/shift-reports/${shiftA}/confirm`, { candidateId: handed.board!.candidate!.id })).json());
    expect(stale).toMatchObject({ confirmed: false, refused: "superseded" });
    expect(stale.report.board?.candidate?.number).toBe(2);
    const second = shiftReportConfirmResponseSchema.parse((await ext("POST", `/api/v1/shift-reports/${shiftA}/confirm`, { candidateId: again.board!.candidate!.id })).json());
    expect(second.report.latest).toMatchObject({ version: 2, door: "extension" });
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
      // Nor confirm it, reopen it or answer a card on it: only the person.
      expect((await asSession(who, "POST", `/api/v1/shift-reports/${shiftA}/confirm`, { candidateId: 1 })).statusCode).toBe(403);
      expect((await asSession(who, "POST", `/api/v1/shift-reports/${shiftA}/reopen`)).statusCode).toBe(403);
      expect(report.board?.canConfirm ?? false).toBe(false);
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
    // Counted: the agent cannot hand it in again until the person reopens it («Исправить» is the person's).
    expect((await asKey("writer", "POST", "/api/v1/agent/shift-reports/submit", { shiftId: shiftA, telegramUserId: SENDER, sourceRef: "chat:3" })).statusCode).toBe(409);
    expect((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/reopen`)).statusCode).toBe(200);
    const versionsBefore = (await testDb.pool.query("select count(*)::int as n from shift_handin_versions")).rows[0].n as number;
    const done = await asKey("writer", "POST", "/api/v1/agent/shift-reports/submit", { shiftId: shiftA, telegramUserId: SENDER, sourceRef: "chat:3" });
    expect(done.statusCode, done.body).toBe(200);
    // «Со слов» records a candidate: no version, the person still confirms on the board.
    expect(shiftReportResponseSchema.parse(done.json()).board).toMatchObject({ phase: "confirm", candidate: { door: "telegram" } });
    expect((await testDb.pool.query("select count(*)::int as n from shift_handin_versions")).rows[0].n).toBe(versionsBefore);
    const stored = await testDb.pool.query("select id, door, telegram_message_ref, telegram_sender_id from shift_handin_candidates order by id desc limit 1");
    expect(stored.rows[0]).toMatchObject({ door: "telegram", telegram_message_ref: "chat:3" });
    expect(Number(stored.rows[0].telegram_sender_id)).toBe(SENDER);
    // No agent door confirms.
    expect((await asKey("writer", "POST", "/api/v1/agent/shift-reports/confirm", { shiftId: shiftA, candidateId: Number(stored.rows[0].id) })).statusCode).toBe(404);
    const confirmed = await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/confirm`, { candidateId: Number(stored.rows[0].id) });
    expect(shiftReportConfirmResponseSchema.parse(confirmed.json()).confirmed).toBe(true);
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

  it("lets Gengar check a candidate and propose, never confirm; the ledger's feed never sees a candidate or a card", async (context) => {
    if (!testDb) return context.skip();
    const [one] = (await testDb.pool.query("select id from pages where label = 'mia-1'")).rows.map((row: { id: string }) => Number(row.id));
    await insertAgentKey(testDb.db, {
      name: "shift-reviewer", keyPrefix: KEYS.reviewer.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(KEYS.reviewer),
      capabilities: ["review:shift_reports"] as never, pageIds: [one!], expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: await fixtureUserId(app, "boss"),
    });
    const feed = async () => agentShiftReportsFeedResponseSchema.parse((await asKey("ledger", "GET", "/api/v1/agent/shift-reports")).json());
    const fedBefore = (await feed()).reports.filter((report) => report.shiftId === shiftA);
    expect((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/reopen`)).statusCode).toBe(200);
    const handed = shiftReportResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/submit`)).json());
    // A key reviews the shift's page: the report waits for its check.
    expect(handed.board).toMatchObject({ phase: "checking", chip: "Проверка", canConfirm: false, candidate: { gengar: { state: "reading" } } });
    const candidateId = handed.board!.candidate!.id;
    expect(shiftReportConfirmResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/confirm`, { candidateId })).json()))
      .toMatchObject({ confirmed: false, refused: "not_ready" });
    // The reviewer reads the candidates waiting for it; the writer key does not.
    expect((await asKey("writer", "GET", "/api/v1/agent/shift-reports/checks")).statusCode).toBe(403);
    const checks = agentShiftReportChecksResponseSchema.parse((await asKey("reviewer", "GET", "/api/v1/agent/shift-reports/checks")).json());
    const check = checks.checks.find((one) => one.candidateId === candidateId);
    expect(check).toBeDefined();
    // A proposal names a sale of the candidate and a legal word.
    const outside = await asKey("reviewer", "POST", `/api/v1/agent/shift-reports/checks/${candidateId}`, {
      proposals: [{ transactionId: 987_654_321, kind: "note", note: "x", why: "y" }],
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().reason).toBe("not_in_candidate");
    const sale = check!.lines[0]?.transactionId;
    const answer = await asKey("reviewer", "POST", `/api/v1/agent/shift-reports/checks/${candidateId}`, {
      proposals: sale === undefined ? [] : [{ transactionId: sale, kind: "note", note: "голосовое", why: "Фан просил голосовое в 19:10." }],
    });
    expect(answer.statusCode, answer.body).toBe(200);
    // Both checks are in: the person confirms now. The reviewer has no confirm.
    const board = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shiftA}`)).json()).board!;
    expect(board).toMatchObject({ phase: "confirm", canConfirm: true });
    expect((await asKey("reviewer", "POST", "/api/v1/agent/shift-reports/confirm", { shiftId: shiftA, candidateId })).statusCode).toBe(404);
    // Neither the candidate nor the card reached the ledger's feed.
    const fedChecked = (await feed()).reports.filter((report) => report.shiftId === shiftA);
    expect(fedChecked.map((report) => report.id)).toEqual(fedBefore.map((report) => report.id));
    expect(JSON.stringify(await feed())).not.toContain("Фан просил голосовое");
    const confirmed = shiftReportConfirmResponseSchema.parse((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/confirm`, { candidateId })).json());
    expect(confirmed.confirmed).toBe(true);
    // The version reached it, and only the version: one more report, a version's id.
    const fedAfter = (await feed()).reports.filter((report) => report.shiftId === shiftA);
    expect(fedAfter).toHaveLength(fedBefore.length + 1);
    const versionIds = (await testDb.pool.query("select v.id from shift_handin_versions v join shift_handins h on h.id = v.handin_id where h.shift_id = $1", [shiftA]))
      .rows.map((row: { id: string }) => Number(row.id));
    expect(fedAfter.map((report) => report.id).sort()).toEqual(versionIds.sort());
  });

  it("keeps what the site showed and Hub does not hold, journaled first; matches it when the sale arrives; the decider hears after 48 hours", async (context) => {
    if (!testDb) return context.skip();
    const ext = (payload: Record<string, unknown>) =>
      server!.inject({ method: "POST", url: "/api/v1/client/sale-sightings", headers: { authorization: `Bearer ${extensionToken}` }, payload });
    const row = { platformRef: "981336977431290668", kind: "tip", occurredAt: "2026-11-10T18:30:00.000Z", grossMills: null, netMills: 12_000, fanRef: "778899", fanName: "wren" };
    // A cookie session is not the extension.
    expect((await asSession("anna", "POST", "/api/v1/client/sale-sightings", { pageLabel: "mia-1", rows: [row] })).statusCode).toBe(403);
    const first = await ext({ pageLabel: "mia-1", rows: [row] });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ kept: 1, known: 0 });
    // Again: one sighting, one journal row.
    expect((await ext({ pageLabel: "mia-1", rows: [row] })).json()).toMatchObject({ kept: 1 });
    expect((await testDb.pool.query("select count(*)::int as n from sale_sightings where platform_ref = $1", [row.platformRef])).rows[0].n).toBe(1);
    expect((await testDb.pool.query("select count(*)::int as n from observations where kind = 'client.sale_sightings.v1'")).rows[0].n).toBe(1);
    // A page the token may not work is refused.
    expect((await ext({ pageLabel: "mia-2", rows: [row] })).statusCode).toBe(404);

    // Unmatched for 48 hours: the decider's matter.
    await testDb.pool.query("update sale_sightings set first_seen_at = now() - interval '49 hours' where platform_ref = $1", [row.platformRef]);
    const { runShiftReportBoardPass } = await import("../apps/runtime/src/services/shift-report-board.ts");
    await runShiftReportBoardPass(app);
    const opened = await testDb.pool.query("select state from matters where kind = 'shift.report.sighting_unmatched'");
    expect(opened.rows).toEqual([{ state: "open" }]);

    // The sale arrives in Hub: the sighting is matched and the matter closes.
    const pageId = (await testDb.pool.query("select id from pages where label = 'mia-1'")).rows[0].id;
    await testDb.pool.query(
      `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
       values ($1, $2, 'tip', 'tip', 'posted', 'ok', 15000, 15000, 12000, 3000, '2026-11-10T18:30:00Z', 'fansly:rest', 'USD')`,
      [pageId, row.platformRef],
    );
    await runShiftReportBoardPass(app);
    const sighting = await testDb.pool.query("select matched_transaction_id is not null as matched from sale_sightings where platform_ref = $1", [row.platformRef]);
    expect(sighting.rows[0].matched).toBe(true);
    expect((await testDb.pool.query("select state from matters where kind = 'shift.report.sighting_unmatched'")).rows).toEqual([{ state: "closed" }]);
    // Hub holds it now: the site showing it again keeps nothing.
    expect((await ext({ pageLabel: "mia-1", rows: [row] })).json()).toMatchObject({ kept: 0, known: 1 });
  });
});

