import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, insertAgentKey, listLoginsByPersonCode } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { readAgentTeamSales } from "../apps/runtime/src/services/agent-team-sales.ts";
import { planImport } from "../apps/runtime/src/services/sale-claims-import.ts";
import { readSaleDecisionsFeed } from "../apps/runtime/src/services/sale-decisions-feed.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Which login a person code names (the bug happened: a decision «со слов» for a person whose older login was switched
// off was recorded on that switched-off login). A code names the person's live login, the lower id of two live ones;
// a person with no live login left is still known, by the lowest of their logins, so a word about someone who left is
// recorded and not refused as `person_unknown`. The same for the agent's door (decide, applied, ask) and for the
// carry-over from the ledger. Synthetic people and pages.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const KEY = `${AGENT_KEY_TOKEN_PREFIX}person-login-key`;
const SAID = { telegramUserId: 700_000_701, sourceRef: "https://t.me/c/1/71" };

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const users: Record<string, number> = {};

const asAgent = (url: string, payload: Record<string, unknown>) =>
  server!.inject({ method: "POST", url, headers: { authorization: `Bearer ${KEY}` }, payload });

describe("a person code names the person's live login", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, AUDIT);
    // In this order: each first login is the older one (the lower id).
    for (const name of ["vera-old", "vera-new", "gleb-one", "gleb-two"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, AUDIT);
    }
    for (const name of ["boss", "vera-old", "vera-new", "gleb-one", "gleb-two"]) users[name] = await fixtureUserId(app, name);
    const person = async (code: string, name: string, state: string, logins: number[]) => {
      const id = (await testDb!.pool.query<{ id: string }>(
        "insert into people (code, display_name, role, state) values ($1, $2, 'chatter', $3) returning id", [code, name, state],
      )).rows[0]!.id;
      for (const login of logins) await testDb!.pool.query("insert into person_logins (user_id, person_id) values ($1, $2)", [login, id]);
    };
    // vera's older login was switched off, she works on the newer one; gleb left: both his logins are off.
    await person("vera", "Вера", "working", [users["vera-old"]!, users["vera-new"]!]);
    await person("gleb", "Глеб", "left", [users["gleb-one"]!, users["gleb-two"]!]);
    await testDb.pool.query("update users set disabled_at = now() where id = any($1::bigint[])", [[users["vera-old"], users["gleb-one"], users["gleb-two"]]]);

    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    const page = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    await insertAgentKey(testDb.db, {
      name: "person-login", keyPrefix: KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(KEY),
      capabilities: ["write:shift_reports"] as never, pageIds: [page],
      expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: users.boss!,
    });
    server = await buildApiServer(app);
    await server.ready();
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("lists the live login first, and every login of a person who has none live", async (context) => {
    if (!testDb) return context.skip();
    const logins = await listLoginsByPersonCode(app.db, ["vera", "gleb", "nobody"]);
    expect(logins.get("vera")).toEqual([users["vera-new"], users["vera-old"]]);
    expect(logins.get("gleb")).toEqual([users["gleb-one"], users["gleb-two"]]);
    expect(logins.has("nobody")).toBe(false);
  });

  it("records a decision, its «учтено» and a question on the live login through the agent's door", async (context) => {
    if (!testDb) return context.skip();
    const decide = async (person: string, fanRef: string) => {
      const said = await asAgent("/api/v1/agent/sale-decisions", {
        pageLabel: "mia-1", fanRef, occurredAt: "2026-11-20T12:00:00.000Z", netMills: 9_000,
        kind: "owner", shares: [{ person, percent: 100 }], saidBy: "владелец", saidAt: "2026-11-20", ...SAID,
      });
      expect(said.statusCode, said.body).toBe(200);
      const decision = said.json().decision as { id: number; shares: Array<{ person: string | null; percent: number }> };
      expect(decision.shares).toMatchObject([{ person, percent: 100 }]);
      return decision;
    };
    // The login a decision's share is recorded on: the door's answer names the person, the row keeps the login.
    const sharedLogins = async (id: number) => {
      const row = await testDb!.pool.query<{ shares: Array<{ userId: number | string }> }>("select shares from sale_owner_decisions where id = $1", [id]);
      return row.rows[0]!.shares.map((share) => Number(share.userId));
    };

    const vera = await decide("vera", "7700000701");
    expect(await sharedLogins(vera.id)).toEqual([users["vera-new"]]);
    // No live login left: still known, by the lowest of the logins.
    const gleb = await decide("gleb", "7700000702");
    expect(await sharedLogins(gleb.id)).toEqual([users["gleb-one"]]);

    const receipt = { decisionId: vera.id, reportDate: "2026-11-20" };
    const outsider = await asAgent("/api/v1/agent/sale-decisions/applied", { ...receipt, person: "gleb" });
    expect([outsider.statusCode, outsider.json().reason]).toEqual([400, "not_recipient"]);
    await createUserAccount(app, { username: "fixture-realm-login", role: "chatter" }, AUDIT);
    const fixtureLogin = await fixtureUserId(app, "fixture-realm-login");
    await testDb.pool.query(`with p as (insert into people (code, display_name, role, state, is_test)
      values ('fixture-realm', 'Fixture Realm', 'chatter', 'working', true) returning id)
      insert into person_logins (person_id, user_id) select id, $1 from p`, [fixtureLogin]);
    await expect(testDb.pool.query("insert into sale_decision_deliveries (decision_id, recipient_user_id) values ($1, $2)",
      [vera.id, fixtureLogin])).rejects.toMatchObject({ code: "23514" });
    const otherRealm = await asAgent("/api/v1/agent/sale-decisions/applied", { ...receipt, person: "fixture-realm" });
    expect([otherRealm.statusCode, otherRealm.json().reason]).toEqual([400, "person_unknown"]);
    const applied = await asAgent("/api/v1/agent/sale-decisions/applied", { decisionId: vera.id, person: "vera", reportDate: "2026-11-20" });
    expect(applied.statusCode, applied.body).toBe(200);
    const taken = await testDb.pool.query("select applied_user_id from sale_owner_decisions where id = $1", [vera.id]);
    expect(Number(taken.rows[0].applied_user_id)).toBe(users["vera-new"]);

    const asked = await asAgent("/api/v1/agent/sale-questions", {
      pageLabel: "mia-1", fanRef: "7700000703", askedOf: "chatters", people: ["vera", "gleb"], question: "Чья продажа?", askedAt: "2026-11-20", ...SAID,
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const question = await testDb.pool.query("select claimant_user_id, side_user_id from sale_claims where id = $1", [asked.json().question.id]);
    expect([Number(question.rows[0].claimant_user_id), Number(question.rows[0].side_user_id)]).toEqual([users["vera-new"], users["gleb-one"]]);
  });

  it("carries the ledger's records over to the live login", async (context) => {
    if (!testDb) return context.skip();
    const plan = await planImport(app.db, {
      decisions: {
        columns: ["id", "status", "kind", "shares", "page_label", "fan_ref", "said_at", "said_by", "applied_person", "applied_report_date"],
        rows: [[9_001, "applied", "owner", JSON.stringify([{ person: "vera", percent: 100 }]), "mia-1", "7700000704", "2026-11-20", "владелец", "vera", "2026-11-20"]],
      },
      questions: {
        columns: ["id", "status", "question", "asked_of", "who", "page_label", "asked_at"],
        rows: [[9_101, "open", "Чья продажа?", "chatters", "vera и gleb", "mia-1", "2026-11-20"]],
      },
    });
    expect(plan.decisions[0]!.shares).toEqual([{ userId: users["vera-new"], percent: 100, person: "vera" }]);
    expect(plan.decisions[0]!.applied).toMatchObject({ person: "vera", userId: users["vera-new"], reportDate: "2026-11-20" });
    expect(plan.questions[0]!.people).toEqual([{ userId: users["vera-new"], name: "Вера" }, { userId: users["gleb-one"], name: "Глеб" }]);
  });

  it("normalizes deactivated logins and exports confirmed agreed marks in agentTeamSales + appliedDeliveries in decisions feed (OA-004, OA-005, OP-H5)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = Number((await testDb.pool.query<{ id: string }>("select id from pages where label = 'mia-1'")).rows[0]!.id);
    const fanId = Number((await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username, display_name) values ('fansly', '7700000799', 'fan_oa', 'Fan OA') returning id",
    )).rows[0]!.id);
    const occurredAt = "2026-11-20T14:00:00.000Z";
    const insertTx = async (ref: string) => Number((await testDb!.pool.query<{ id: string }>(
      `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
       values ($1, $2, $3, 'tip', 'tip', 'posted', 'ok', 10000, 10000, 10000, 0, $4::timestamptz, 'fansly:rest', 'USD') returning id`,
      [pageId, fanId, ref, occurredAt],
    )).rows[0]!.id);
    const txDecision = await insertTx("tx-oa-004-old-login");
    const txTransfer = await insertTx("tx-oa-005-transfer");

    // Stored decision pointing to vera's deactivated login (`vera-old`) + split delivery rows for both recipients.
    const decId = Number((await testDb.pool.query<{ id: string }>(
      `insert into sale_owner_decisions (transaction_id, page_id, kind, shares, outcome, decided_at, source)
       values ($1, $2, 'split', $3::jsonb, 'half', $4::timestamptz, 'dispute') returning id`,
      [txDecision, pageId, JSON.stringify([{ userId: users["vera-old"], percent: 50 }, { userId: users["gleb-one"], percent: 50 }]), occurredAt],
    )).rows[0]!.id);
    await testDb.pool.query(
      `insert into sale_decision_deliveries (decision_id, recipient_user_id, state, report_date)
       values ($1, $2, 'applied', '2026-11-20'), ($1, $3, 'applied', '2026-11-21')`,
      [decId, users["vera-new"], users["gleb-one"]],
    );

    // Submitted Hub shift report with confirmed `not_mine` from vera-old + agreed claim by gleb-one.
    const shiftId = Number((await testDb.pool.query<{ id: string }>(
      `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
       values ($1, 'closed', '2026-11-20T12:00:00Z', '2026-11-20T18:00:00Z', 300, 50, '2026-11-20', '[{"pageLabel":"mia-1","activeMinutes":300,"messages":50,"salesFrom":"2026-11-20T12:00:00Z"}]'::jsonb) returning id`,
      [users["vera-old"]],
    )).rows[0]!.id);
    const handinId = Number((await testDb.pool.query<{ id: string }>(
      `insert into shift_handins (shift_id, user_id, report_date, state, phase, current_version, submitted_at)
       values ($1, $2, '2026-11-20', 'submitted', 'counted', 1, now()) returning id`,
      [shiftId, users["vera-old"]],
    )).rows[0]!.id);
    const lines = [{
      transactionId: txTransfer, pageLabel: "mia-1", occurredAt, netMills: 10_000, group: "mine",
      statement: "not_mine", shareWithUserId: null, amountMills: 0, added: false, disputed: false, alreadyIn: null,
      rule: { home: "shift", reason: "holder", shareMills: 10_000, toUserId: null, senderUserId: null },
    }];
    await testDb.pool.query(
      `insert into shift_handin_versions (handin_id, version, door, actor_user_id, total_mills, pages, lines, off_platform, comment, rule_version, report_date, submitted_at)
       values ($1, 1, 'workboard', $2, 0, '[{"pageLabel":"mia-1","amountMills":0}]'::jsonb, $3::jsonb, '[]'::jsonb, '', '2026-11-12.1', '2026-11-20', now())`,
      [handinId, users["vera-old"], JSON.stringify(lines)],
    );
    const glebShiftId = Number((await testDb.pool.query<{ id: string }>(
      `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
       values ($1, 'closed', '2026-11-20T12:00:00Z', '2026-11-20T18:00:00Z', 300, 50, '2026-11-20', '[{"pageLabel":"mia-1","activeMinutes":300,"messages":50,"salesFrom":"2026-11-20T12:00:00Z"}]'::jsonb) returning id`,
      [users["gleb-one"]],
    )).rows[0]!.id);
    const glebHandinId = Number((await testDb.pool.query<{ id: string }>(
      `insert into shift_handins (shift_id, user_id, report_date, state, phase, current_version, submitted_at)
       values ($1, $2, '2026-11-20', 'submitted', 'counted', 1, now()) returning id`,
      [glebShiftId, users["gleb-one"]],
    )).rows[0]!.id);
    await testDb.pool.query(
      `insert into sale_claims (transaction_id, page_id, kind, claimant_user_id, claimant_handin_id, claimant_version, side_user_id, statement, state, answer, claimed_at, answered_at, closed_at)
       values ($1, $2, 'claim', $3, $4, 1, $5, 'mine', 'agreed', 'agree', now(), now(), now())`,
      [txTransfer, pageId, users["gleb-one"], glebHandinId, users["vera-old"]],
    );

    const sales = await readAgentTeamSales(app.db, {
      from: new Date("2026-11-20T00:00:00Z"),
      to: new Date("2026-11-21T00:00:00Z"),
      now: new Date("2026-11-21T00:00:00Z"),
      pages: [{ id: pageId, label: "mia-1" }],
    });
    const saleDec = sales.sales.find((s) => s.transactionRef === String(txDecision));
    expect(saleDec?.resolution).toEqual([
      { userId: users["vera-new"], percent: 50 },
      { userId: users["gleb-one"], percent: 50 },
    ]);
    const saleTr = sales.sales.find((s) => s.transactionRef === String(txTransfer));
    expect(saleTr?.marks).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: users["vera-new"], mark: "not_mine", confirmed: true }),
      expect.objectContaining({ userId: users["gleb-one"], mark: "mine", confirmed: true }),
    ]));

    // OP-H5: decisions feed exposes per-recipient appliedDeliveries for split decisions.
    const feed = await readSaleDecisionsFeed(app, { pageIds: [pageId], limit: 200 });
    const entry = feed.changes.find((c) => c.decision.id === decId);
    expect(entry?.decision.appliedDeliveries).toEqual(expect.arrayContaining([
      { person: "vera", userId: users["vera-new"], reportDate: "2026-11-20" },
      { person: "gleb", userId: users["gleb-one"], reportDate: "2026-11-21" },
    ]));
  });
});
