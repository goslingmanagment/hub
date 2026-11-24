import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import type { HandinAgentActor, HandinPersonActor } from "../apps/runtime/src/services/shift-report-draft.ts";
import { handInShiftReport, readShiftReportBoard, runShiftReportBoardPass } from "../apps/runtime/src/services/shift-report-board.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { insertReviewerAgentKey } from "./helpers/shift-report-hand-in.ts";

// «Сдать смену» is the person's signature (owner, 2026-11-19). The hand-in carries what the person saw; equal to the
// candidate, it is signed, and a check that changes nothing counts the report by it — the version is exactly what was
// signed, with no «Подтверждаю». A check that changes anything (Gengar's card, a colleague's answer) leaves the report
// in «Подтвердите» with the signature cleared; an agent's «со слов» hand-in is never signed. Money: required.
//
// anna works mia-1 alone from 30 to 25 hours ago; cora alone from 16 to 11 hours ago (a sale of those hours is cora's).

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const NET = 100_000;
const SENDER = 700_000_433;
const REVIEWER = `${AGENT_KEY_TOKEN_PREFIX}signed-gengar-key`;
const WRITER = `${AGENT_KEY_TOKEN_PREFIX}signed-writer-key`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
let writerKeyId = 0;
const users: Record<string, number> = {};
let refs = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const asSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asReviewer = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${REVIEWER}` }, ...(payload ? { payload } : {}) });
const actorOf = (who: string): HandinPersonActor => ({ kind: "person", userId: users[who]!, role: "chatter", pageIds: [pageOne], door: "workboard" });

/** A closed shift row of a person on mia-1 from `fromHoursAgo` to `toHoursAgo` before now. */
async function shiftRow(who: string, fromHoursAgo: number, toHoursAgo: number): Promise<number> {
  const startedAt = new Date(Date.now() - fromHoursAgo * HOUR_MS);
  const endedAt = new Date(Date.now() - toHoursAgo * HOUR_MS);
  const result = await q(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 55, 20, $4::date, $5::jsonb) returning id`,
    [users[who], startedAt.toISOString(), endedAt.toISOString(), new Date(startedAt.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10),
      JSON.stringify([{ pageLabel: "mia-1", activeMinutes: 55, messages: 20, salesFrom: startedAt.toISOString() }])],
  );
  return Number(result.rows[0].id);
}

/** A tip to mia-1 of $100.000 net `minutesAgo` before now. */
async function sale(minutesAgo: number): Promise<number> {
  refs += 1;
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, 4000, now() - make_interval(mins => $5::int), 'fansly:rest', 'USD') returning id`,
    [pageOne, `tx-signed-${refs}`, NET + 4_000, NET, minutesAgo],
  );
  const now = new Date();
  await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
  return Number(inserted.rows[0].id);
}

async function board(who: string, shiftId: number) {
  const read = await asSession(who, "GET", `/api/v1/shift-reports/${shiftId}`);
  expect(read.statusCode, read.body).toBe(200);
  return shiftReportResponseSchema.parse(read.json()).board!;
}

/** «Сдать смену» through the person's door with what the draft's bar showed. */
async function handIn(who: string, shiftId: number, seen: { nowMills: number; count: number }) {
  const handed = await asSession(who, "POST", `/api/v1/shift-reports/${shiftId}/submit`, { seenTotalMills: seen.nowMills, seenCount: seen.count });
  expect(handed.statusCode, handed.body).toBe(200);
  return shiftReportResponseSchema.parse(handed.json()).board!;
}

/** The report's row, its newest candidate and its newest version. */
async function stored(shiftId: number) {
  const handin = (await q("select id, phase, current_version from shift_handins where shift_id = $1", [shiftId])).rows[0] as
    { id: string; phase: string; current_version: number | null };
  const candidate = (await q(
    "select id, signed_total_mills, signed_count, signed_at, confirmed_version from shift_handin_candidates where handin_id = $1 order by number desc limit 1",
    [handin.id],
  )).rows[0] as { id: string; signed_total_mills: string | null; signed_count: number | null; signed_at: Date | null; confirmed_version: number | null };
  const version = (await q("select version, total_mills, lines, door from shift_handin_versions where handin_id = $1 order by version desc limit 1", [handin.id])).rows[0] as
    { version: number; total_mills: string; lines: Array<{ transactionId: number | null; amountMills: number }>; door: string } | undefined;
  const events = (await q("select event, changes from object_events where object_type = 'shift_report' and object_id = $1 order by id", [handin.id])).rows as
    Array<{ event: string; changes: Record<string, unknown> }>;
  return { handin, candidate, version, events };
}

describe("«Сдать смену» as the person's signature", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    users.boss = await fixtureUserId(app, "boss");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    for (const name of ["anna", "cora"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      users[name] = await fixtureUserId(app, name);
      await setUserPassword(app, { userId: users[name]!, password: `${name}-password-for-tests` }, { source: "cli" });
      await assignUserToPage(app.db, users[name]!, pageOne);
    }
    writerKeyId = Number((await insertAgentKey(testDb.db, {
      name: "signed-writer", keyPrefix: WRITER.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(WRITER),
      capabilities: ["write:shift_reports"] as never, pageIds: [pageOne], expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: users.boss!,
    })).id);
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna", "cora"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    for (const name of ["anna", "cora"]) {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code: name, displayName: name, role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [users[name]] },
        ...(name === "anna" ? { telegram: { userId: SENDER } } : {}),
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    await q("update person_rights set granted_at = now() - interval '30 days'");
    // The work: every minute of the hours, a message every three minutes.
    let base = 9_800_000_000;
    for (const [who, from, to] of [["anna", 30, 25], ["cora", 16, 11]] as const) {
      await q(
        `insert into chatter_activity_minutes (user_id, page_id, minute, input)
         select $1, $2, minute, true
         from generate_series(date_trunc('minute', now() - make_interval(hours => $3::int)), date_trunc('minute', now() - make_interval(hours => $4::int)), interval '1 minute') minute`,
        [users[who], pageOne, from, to],
      );
      await q(
        `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
         select 'fansly', $1, ($4::bigint + n)::text, '7700000433', $2, 'fansly-extension', false, false, now() - make_interval(hours => $3::int) + interval '3 minutes' * n, 'hand'
         from generate_series(0, ($3::int - $5::int) * 20 - 1) n`,
        [pageOne, users[who], from, base, to],
      );
      base += 1_000;
    }
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("counts a signed hand-in nothing checks at once, the version exactly what was signed; a hand-in that saw otherwise waits", async (context) => {
    if (!testDb) return context.skip();
    await sale(29.8 * 60);
    const shift = await shiftRow("anna", 30, 29.5);
    const draft = await board("anna", shift);
    expect(draft.phase).toBe("draft");
    expect(draft.totals.count).toBeGreaterThan(0);
    // No reviewer of the page and no wallet Hub can ask: the check lets it through at once, and the signature counts it.
    const handed = await handIn("anna", shift, draft.totals);
    expect(handed.phase).toBe("counted");
    const { handin, candidate, version, events } = await stored(shift);
    expect(handin.phase).toBe("counted");
    expect(Number(version!.total_mills)).toBe(draft.totals.nowMills);
    expect(version!.lines.filter((line) => line.amountMills > 0)).toHaveLength(draft.totals.count);
    expect({ total: Number(candidate.signed_total_mills), count: candidate.signed_count, confirmed: candidate.confirmed_version })
      .toEqual({ total: draft.totals.nowMills, count: draft.totals.count, confirmed: version!.version });
    expect(events.find((one) => one.event === "shift_report.submitted")?.changes).toMatchObject({ signedAtHandIn: true });
    expect((await q("select 1 from matters where reason_key = $1 and state = 'open'", [`shift.report.confirm:${shift}`])).rows).toHaveLength(0);

    // «Исправить», then «Сдать заново» from a bar that showed another total: not signed, «Подтверждаю» is the person's.
    expect((await asSession("anna", "POST", `/api/v1/shift-reports/${shift}/reopen`)).statusCode).toBe(200);
    const again = await handIn("anna", shift, { nowMills: draft.totals.nowMills + 1_000, count: draft.totals.count });
    expect(again.phase).toBe("confirm");
    expect(again.candidate).toMatchObject({ signed: false, signatureDeclined: false });
    expect((await stored(shift)).version!.version).toBe(version!.version);
  });

  it("counts a signed hand-in when Gengar is silent for 10 minutes, on the board's read, with no «Подтверждаю»", async (context) => {
    if (!testDb) return context.skip();
    // From here on Gengar reviews mia-1: a hand-in waits for his answer, 10 minutes at most.
    await insertReviewerAgentKey(testDb.db, {
      name: "signed-gengar", token: REVIEWER, pageIds: [pageOne], createdBy: users.boss!,
    });
    await sale(28.8 * 60);
    const shift = await shiftRow("anna", 29, 28.5);
    const draft = await board("anna", shift);
    const handed = await handIn("anna", shift, draft.totals);
    expect(handed.phase).toBe("checking");
    expect(handed.candidate?.signed).toBe(true);
    // Eleven minutes later, no pass in between: the read moves it to «Подтвердите» and the signature counts it.
    const later = new Date(Date.now() + 11 * 60_000);
    expect((await readShiftReportBoard(app, actorOf("anna"), shift, later)).board?.phase).toBe("counted");
    const { version, events } = await stored(shift);
    expect(Number(version!.total_mills)).toBe(draft.totals.nowMills);
    expect(events.find((one) => one.event === "shift_report.submitted")?.changes).toMatchObject({ signedAtHandIn: true });
  });

  it("leaves a signed hand-in that Gengar's card changes in «Подтвердите», its signature cleared", async (context) => {
    if (!testDb) return context.skip();
    const own = await sale(27.8 * 60);
    const shift = await shiftRow("anna", 28, 27.5);
    const draft = await board("anna", shift);
    const handed = await handIn("anna", shift, draft.totals);
    expect(handed).toMatchObject({ phase: "checking", candidate: { signed: true } });
    const card = await asReviewer("POST", `/api/v1/agent/shift-reports/checks/${handed.candidate!.id}`, {
      proposals: [{ transactionId: own, kind: "owner_change", to: { word: "pot" }, why: "Фан написал, что это за пост." }],
    });
    expect(card.statusCode, card.body).toBe(200);
    // Gengar's answer moved it on: the card waits for the person, the signature is not applied — not then, not later.
    await runShiftReportBoardPass(app, new Date(Date.now() + 60_000));
    const shown = await board("anna", shift);
    expect(shown.phase).toBe("confirm");
    expect(shown.candidate).toMatchObject({ signed: false, signatureDeclined: true });
    const { handin, candidate, version, events } = await stored(shift);
    expect(handin.current_version).toBeNull();
    expect(version).toBeUndefined();
    expect(candidate.signed_at).toBeNull();
    expect(events.filter((one) => one.event === "shift_report.signature_declined").map((one) => one.changes.why)).toEqual(["proposals"]);
  });

  it("leaves a signed hand-in that a colleague's answer changes in «Подтвердите», its signature cleared", async (context) => {
    if (!testDb) return context.skip();
    const taken = await sale(13 * 60);
    const shift = await shiftRow("anna", 14, 12);
    // anna writes the sale to herself (cora's by the rule): it counts for her at once, cora is told.
    const asked = await asSession("anna", "POST", `/api/v1/shift-reports/${shift}/asks`, { transactionId: taken, statement: "mine", note: "мой фан" });
    expect(asked.statusCode, asked.body).toBe(200);
    const draft = await board("anna", shift);
    const handed = await handIn("anna", shift, draft.totals);
    expect(handed).toMatchObject({ phase: "checking", candidate: { signed: true } });
    const claimId = Number((await q("select id from sale_claims where transaction_id = $1 and kind = 'claim' and state = 'agreed'", [taken])).rows[0].id);
    const disagreed = await asSession("cora", "POST", `/api/v1/sale-claims/${claimId}/answer`, { answer: "disagree" });
    expect(disagreed.statusCode, disagreed.body).toBe(200);
    // Gengar finds nothing; the report is no longer what anna signed: the sale waits for the decider now.
    const clean = await asReviewer("POST", `/api/v1/agent/shift-reports/checks/${handed.candidate!.id}`, { proposals: [] });
    expect(clean.statusCode, clean.body).toBe(200);
    await runShiftReportBoardPass(app, new Date(Date.now() + 60_000));
    const shown = await board("anna", shift);
    expect(shown.phase).toBe("confirm");
    expect(shown.candidate).toMatchObject({ signed: false, signatureDeclined: true });
    expect(shown.totals.nowMills).not.toBe(draft.totals.nowMills);
    const { handin, candidate, events } = await stored(shift);
    expect(handin.current_version).toBeNull();
    expect(candidate.signed_at).toBeNull();
    expect(events.filter((one) => one.event === "shift_report.signature_declined").map((one) => one.changes.why)).toEqual(["changed"]);
  });

  it("never counts an agent's «со слов» hand-in by itself, whatever it says it saw", async (context) => {
    if (!testDb) return context.skip();
    await sale(26.8 * 60);
    const shift = await shiftRow("anna", 27, 26.5);
    const draft = await board("anna", shift);
    const agent: HandinAgentActor = { kind: "agent", agentKeyId: writerKeyId, keyName: "signed-writer", pageIds: [pageOne], telegramUserId: SENDER, sourceRef: "chat:433" };
    const now = new Date();
    const handed = await handInShiftReport(app, agent, { shiftId: shift, seenTotalMills: draft.totals.nowMills, seenCount: draft.totals.count }, now);
    expect(handed.board).toMatchObject({ candidate: { door: "telegram", signed: false } });
    // Gengar silent for 10 minutes: «Подтвердите», and it waits there for the person.
    await runShiftReportBoardPass(app, new Date(now.getTime() + 11 * 60_000));
    await runShiftReportBoardPass(app, new Date(now.getTime() + 12 * 60_000));
    const { handin, candidate, version } = await stored(shift);
    expect(handin.phase).toBe("confirm");
    expect(version).toBeUndefined();
    expect(candidate.signed_at).toBeNull();
    expect((await q("select 1 from matters where reason_key = $1 and state = 'open'", [`shift.report.confirm:${shift}`])).rows).toHaveLength(1);
  });
});
