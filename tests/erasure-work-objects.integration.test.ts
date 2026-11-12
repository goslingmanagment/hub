import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeMatter, commentMatter, createFanslyPage, createModel, openMatter } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// A fan's erasure reaches the work objects Hub keeps about his sales: what people said of them (claims, the owner's
// decisions), what waits about them (matters) and their history (object events), the notes of a shift report (the
// draft's marks and the lines of a handed-in version). The money and the facts stay — ids, sums, states, who of the
// team, when — and the words about the fan go. A bystander fan's rows on the same page keep theirs. A handed-in
// version stays immutable to everything but the erasure clearing its lines' notes.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const FAN = "7500000001";
const BYSTANDER = "7500000002";
const ERASED_NAME = "erasedfan";
const KEPT_NAME = "keptfan";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let anna = 0;
let bella = 0;
let saleA = 0;
let saleB = 0;
let handinId = 0;
let versionId = 0;

async function q<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query(text, params)).rows as T[];
}

async function fan(ref: string, username: string): Promise<number> {
  const [row] = await q<{ id: string }>(
    "insert into fans (platform, platform_user_id, username, display_name) values ('fansly', $1, $2, $3) returning id",
    [ref, username, `Имя ${username}`],
  );
  await q("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [row!.id, pageId]);
  return Number(row!.id);
}

async function sale(ref: string, fanId: number, net: number): Promise<number> {
  const [row] = await q<{ id: string }>(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency, fan_id)
     values ($1, $2, 'subscription', 'subscription', 'posted', 'ok', $3, $3, $4, $5, '2026-11-10T18:00:00Z', 'fansly:rest', 'USD', $6)
     returning id`,
    [pageId, ref, net + 4_000, net, 4_000, fanId],
  );
  return Number(row!.id);
}

function line(transactionId: number, net: number, note: string) {
  return {
    transactionId, offPlatformId: null, group: "mine", pageLabel: "mia-1", kind: "subscription", occurredAt: "2026-11-10T18:00:00.000Z",
    netMills: net, rule: { home: "shift", reason: "holder", shareMills: net, toUserId: null, senderUserId: null }, alreadyIn: null,
    statement: "mine", shareWithUserId: null, note, amountMills: net, added: false, disputed: false,
  };
}

const SYSTEM = { door: "system" } as const;

describe("a fan's erasure reaches the work objects about his sales", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    for (const name of ["anna", "bella"]) await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
    anna = await fixtureUserId(app, "anna");
    bella = await fixtureUserId(app, "bella");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    const erased = await fan(FAN, ERASED_NAME);
    const kept = await fan(BYSTANDER, KEPT_NAME);
    saleA = await sale("tx-erased", erased, 16_001);
    saleB = await sale("tx-kept", kept, 9_000);

    // anna's shift, handed in: a line on each fan's sale, each with a note naming its fan; her draft's marks too.
    const [shift] = await q<{ id: string }>(
      `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
       values ($1, 'closed', '2026-11-10T15:00:00Z', '2026-11-10T23:00:00Z', 400, 300, '2026-11-10', '[]'::jsonb) returning id`,
      [anna],
    );
    const [handin] = await q<{ id: string }>(
      `insert into shift_handins (shift_id, user_id, report_date, state, current_version, submitted_at)
       values ($1, $2, '2026-11-10', 'submitted', 1, now()) returning id`,
      [shift!.id, anna],
    );
    handinId = Number(handin!.id);
    const lines = [line(saleA, 16_001, `${ERASED_NAME} обещал вернуться`), line(saleB, 9_000, `${KEPT_NAME} купил второй раз`)];
    const [version] = await q<{ id: string }>(
      `insert into shift_handin_versions (handin_id, version, door, actor_user_id, total_mills, pages, lines, off_platform, comment, rule_version)
       values ($1, 1, 'workboard', $2, 25001, $3::jsonb, $4::jsonb, '[]'::jsonb, '', 'test') returning id`,
      [handinId, anna, JSON.stringify([{ pageLabel: "mia-1", amountMills: 25_001 }]), JSON.stringify(lines)],
    );
    versionId = Number(version!.id);
    await q(
      `insert into shift_handin_marks (handin_id, transaction_id, statement, note) values
         ($1, $2, 'mine', $3), ($1, $4, 'mine', $5)`,
      [handinId, saleA, `${ERASED_NAME} сказал, что вернётся`, saleB, `${KEPT_NAME} постоянный`],
    );

    // The owner's decisions: one on each sale, one carried over from the ledger that names the fan and waits for a link.
    const [decisionA] = await q<{ id: string }>(
      `insert into sale_owner_decisions (transaction_id, page_id, kind, shares, outcome, rule_home, note, decided_by_user_id, decided_at, source)
       values ($1, $2, 'split', $3::jsonb, 'half', 'shift', $4, $5, now(), 'dispute') returning id`,
      [saleA, pageId, JSON.stringify([{ userId: anna, percent: 50 }, { userId: bella, percent: 50 }]), `пополам: ${ERASED_NAME} писал обеим`, await fixtureUserId(app, "boss")],
    );
    await q(
      `insert into sale_owner_decisions (transaction_id, page_id, kind, shares, outcome, note, decided_by_user_id, decided_at, source)
       values ($1, $2, 'nobody', '[]'::jsonb, 'nobody', $3, $4, now(), 'dispute')`,
      [saleB, pageId, `никому: ${KEPT_NAME} вернул деньги`, await fixtureUserId(app, "boss")],
    );
    await q(
      `insert into sale_owner_decisions (transaction_id, kind, shares, outcome, decided_at, said_by, source, ledger_decision_id, ledger_ref, needs_link)
       values (null, 'nobody', '[]'::jsonb, 'imported', now(), 'boss', 'ledger', 7, $1::jsonb, true),
              (null, 'nobody', '[]'::jsonb, 'imported', now(), 'boss', 'ledger', 8, $2::jsonb, true)`,
      [
        JSON.stringify({ pageLabel: "mia-1", fanRef: `u${FAN}`, fanName: `Имя ${ERASED_NAME}`, note: `${ERASED_NAME} просил скидку`, netMills: 16_001, status: "open" }),
        JSON.stringify({ pageLabel: "mia-1", fanRef: KEPT_NAME, fanName: `Имя ${KEPT_NAME}`, note: "без скидки", netMills: 9_000, status: "open" }),
      ],
    );

    // What people said: anna's claim on the fan's sale (bella disagreed), a ledger question on it, an unlinked ledger
    // question naming the fan by his login, and anna's claim on the bystander's sale.
    await q(
      `insert into sale_claims (transaction_id, page_id, kind, claimant_user_id, claimant_handin_id, claimant_version, statement,
         claimant_note, claimed_at, side_user_id, state, answer, answer_note, answered_at, answered_by_user_id, answer_door,
         escalated_at, escalated_why, decision_id)
       values ($1, $2, 'claim', $3, $4, 1, 'mine', $5, now(), $6, 'decided', 'disagree', $7, now(), $6, 'workboard', now(), 'disagree', $8),
              ($9, $2, 'claim', $3, $4, 1, 'mine', $10, now(), $6, 'asked', null, null, null, null, null, null, null, null)`,
      [saleA, pageId, anna, handinId, `${ERASED_NAME} мой`, bella, `${ERASED_NAME} писал мне`, decisionA!.id, saleB, `${KEPT_NAME} мой`],
    );
    await q(
      `insert into sale_claims (transaction_id, page_id, kind, claimed_at, state, escalated_at, escalated_why, ledger_question_id,
         question, who_text, ledger_ref, needs_link)
       values ($1, $2, 'imported', now(), 'owner', now(), 'imported', 11, $3, 'Анна и Белла', $4::jsonb, false),
              (null, null, 'imported', now(), 'owner', now(), 'imported', 12, $5, 'Анна', $6::jsonb, true)`,
      [
        saleA, pageId, `Чья продажа ${ERASED_NAME}?`,
        JSON.stringify({ pageLabel: "mia-1", fanRef: FAN, fanName: `Имя ${ERASED_NAME}`, note: "спорят", answer: `${ERASED_NAME} — Анны`, askedOf: "boss", netMills: 16_001 }),
        `Кто вёл ${ERASED_NAME}?`,
        JSON.stringify({ pageLabel: "mia-1", fanRef: ERASED_NAME.toUpperCase(), fanName: `Имя ${ERASED_NAME}`, note: null, netMills: 16_001 }),
      ],
    );
    const claims = await q<{ id: string; transaction_id: string | null; kind: string }>("select id, transaction_id, kind from sale_claims order by id");
    const claimA = claims.find((one) => one.kind === "claim" && Number(one.transaction_id) === saleA)!.id;
    const claimB = claims.find((one) => one.kind === "claim" && Number(one.transaction_id) === saleB)!.id;

    // What waits about them: bella's matter of anna's claim (its title names the fan, its evidence carries the note),
    // the owner's dispute of the ledger question, an agent's matter about the fan himself, a custom order's check, and
    // the bystander's claim. Comments and a closing note in their history.
    const [order] = await q<{ id: string }>("insert into custom_orders (page_id, fan_id, origin) values ($1, $2, 'workboard') returning id", [pageId, erased]);
    await openMatter(app.db, {
      key: `sale.claim:${claimA}`, kind: "sale.claim", source: "server",
      title: `anna считает своей: подписку, Имя ${ERASED_NAME}, $16.00, 10 нояб.`,
      object: { type: "sale_claim", id: claimA }, pageIds: [pageId], owner: { userId: bella }, money: false,
      evidence: { claimId: Number(claimA), transactionId: saleA, statement: "mine", note: `${ERASED_NAME} мой`, saidAt: "2026-11-10T23:00:00.000Z" },
      link: `/workboard/my/shifts/1?sale=${saleA}`,
    }, SYSTEM);
    await commentMatter(app.db, { key: `sale.claim:${claimA}`, text: `${ERASED_NAME} звонил` }, { door: "workboard", userId: bella });
    await closeMatter(app.db, { key: `sale.claim:${claimA}`, how: "resolved", note: `${ERASED_NAME} решено` }, SYSTEM);
    await openMatter(app.db, {
      key: `sale.dispute:${saleA}`, kind: "sale.dispute", source: "server",
      title: `Вопрос «чья продажа» из ledger: Чья продажа ${ERASED_NAME}?`,
      object: { type: "transaction", id: String(saleA) }, pageIds: [pageId], owner: { role: "owner" }, money: true,
      evidence: { transactionId: saleA, netMills: 16_001, why: ["imported"] }, link: `/workboard/decisions?dispute=${saleA}#questions`,
    }, SYSTEM);
    await commentMatter(app.db, { key: `sale.dispute:${saleA}`, text: `спросить ${ERASED_NAME}` }, { door: "workboard", userId: await fixtureUserId(app, "boss") });
    await openMatter(app.db, {
      key: "fan.vip:1", kind: "fan.vip", source: "agent", title: `Имя ${ERASED_NAME} просит скидку`,
      object: { type: "fan", id: FAN }, pageIds: [pageId], owner: { role: "owner" }, money: false,
      evidence: { note: `${ERASED_NAME} пишет каждый день`, count: 2 }, link: `/workboard/fans?name=${ERASED_NAME}`,
    }, { door: "api" });
    await openMatter(app.db, {
      key: `custom.overdue:K-${order!.id}`, kind: "custom.overdue", source: "server", title: `Кастом K-${order!.id} просрочен: срок был 10.11, mia-1`,
      object: { type: "custom_order", id: order!.id }, pageIds: [pageId], owner: { role: "team_lead" }, money: false,
      evidence: { code: `K-${order!.id}`, deadlineOn: "2026-11-10", state: "paid" }, link: `/workboard/customs/K-${order!.id}`,
    }, SYSTEM);
    await openMatter(app.db, {
      key: `sale.claim:${claimB}`, kind: "sale.claim", source: "server",
      title: `anna считает своей: подписку, Имя ${KEPT_NAME}, $9.00, 10 нояб.`,
      object: { type: "sale_claim", id: claimB }, pageIds: [pageId], owner: { userId: bella }, money: false,
      evidence: { claimId: Number(claimB), transactionId: saleB, statement: "mine", note: `${KEPT_NAME} мой` }, link: `/workboard/my/shifts/1?sale=${saleB}`,
    }, SYSTEM);
    await commentMatter(app.db, { key: `sale.claim:${claimB}`, text: `${KEPT_NAME} звонил` }, { door: "workboard", userId: bella });
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("clears the words about the fan and keeps the money, the states and the bystander", async (context) => {
    if (!testDb) return context.skip();
    const erasureApp = { db: app.db, pool: testDb.pool, config: app.config, logger: app.logger } as never;
    const scope = { scopeType: "fan", platform: "fansly", fanRef: FAN } as const;
    const eventsBefore = await q<{ object_id: string; n: string }>("select object_id, count(*)::text as n from object_events group by object_id order by object_id");

    const plan = await planErasure(erasureApp, scope);
    for (const [target, rows] of [
      ["object_events", 3], ["matters", 4], ["sale_claims", 3], ["sale_owner_decisions", 2], ["shift_handin_marks", 1], ["shift_handin_versions", 1],
    ] as const) {
      expect(plan.targets, target).toContainEqual(expect.objectContaining({ plane: "hot", target, action: "anonymize", rows }));
    }
    await executeErasure(erasureApp, scope, { initiatedBy: await fixtureUserId(app, "boss") });

    // Claims: the words go; the ids, the states, the answer and who of the team stay.
    const claims = await q<Record<string, unknown>>(
      `select transaction_id::text as sale, kind, state, answer, escalated_why, claimant_user_id::text as claimant, side_user_id::text as side,
              claimant_note, answer_note, question, who_text, ledger_ref
       from sale_claims order by id`,
    );
    expect(claims).toEqual([
      expect.objectContaining({ sale: String(saleA), kind: "claim", state: "decided", answer: "disagree", escalated_why: "disagree", claimant: String(anna), side: String(bella), claimant_note: null, answer_note: null }),
      expect.objectContaining({ sale: String(saleB), kind: "claim", state: "asked", claimant_note: `${KEPT_NAME} мой` }),
      expect.objectContaining({ sale: String(saleA), kind: "imported", state: "owner", question: null, who_text: null, ledger_ref: { pageLabel: "mia-1", askedOf: "boss", netMills: 16_001 } }),
      expect.objectContaining({ sale: null, kind: "imported", question: null, who_text: null, ledger_ref: { pageLabel: "mia-1", netMills: 16_001 } }),
    ]);

    // The owner's decisions: the outcome and the shares stay, the note and the ledger's words about the fan go.
    const decisions = await q<Record<string, unknown>>("select transaction_id::text as sale, outcome, shares, note, said_by, ledger_ref from sale_owner_decisions order by id");
    expect(decisions).toEqual([
      expect.objectContaining({ sale: String(saleA), outcome: "half", shares: [{ userId: anna, percent: 50 }, { userId: bella, percent: 50 }], note: null }),
      expect.objectContaining({ sale: String(saleB), outcome: "nobody", note: `никому: ${KEPT_NAME} вернул деньги` }),
      expect.objectContaining({ sale: null, said_by: "boss", ledger_ref: { pageLabel: "mia-1", netMills: 16_001, status: "open" } }),
      expect.objectContaining({ sale: null, ledger_ref: expect.objectContaining({ fanRef: KEPT_NAME, fanName: `Имя ${KEPT_NAME}` }) }),
    ]);

    // Matters: «Ждут вас» still reads — who, what kind — with the fan gone from the title and the evidence.
    const matters = await q<{ reason_key: string; title: string; evidence: Record<string, unknown>; link: string | null; state: string }>(
      "select reason_key, title, evidence, link, state from matters order by id",
    );
    expect(matters).toEqual([
      expect.objectContaining({ title: "anna считает своей: фан стёрт", evidence: { claimId: expect.any(Number), transactionId: saleA, statement: "mine", saidAt: "2026-11-10T23:00:00.000Z" }, state: "closed" }),
      expect.objectContaining({ title: "Вопрос «чья продажа» из ledger: фан стёрт", evidence: { transactionId: saleA, netMills: 16_001, why: ["imported"] }, link: `/workboard/decisions?dispute=${saleA}#questions` }),
      expect.objectContaining({ reason_key: "fan.vip:1", title: "Дело о стёртом фане", evidence: {}, link: null }),
      expect.objectContaining({ title: expect.stringMatching(/^Кастом K-\d+ просрочен: фан стёрт$/u) }),
      expect.objectContaining({ title: `anna считает своей: подписку, Имя ${KEPT_NAME}, $9.00, 10 нояб.`, evidence: expect.objectContaining({ note: `${KEPT_NAME} мой` }) }),
    ]);
    for (const matter of matters.slice(0, 4)) expect(JSON.stringify(matter)).not.toMatch(new RegExp(ERASED_NAME, "iu"));

    // The history: every event stays; the comments' and the closing's words about the fan go, the bystander's stay.
    expect(await q("select object_id, count(*)::text as n from object_events group by object_id order by object_id")).toEqual(eventsBefore);
    const events = await q<{ event: string; changes: Record<string, unknown> }>("select event, changes from object_events where event in ('matter.comment', 'matter.closed') order by id");
    expect(events).toEqual([
      { event: "matter.comment", changes: {} },
      { event: "matter.closed", changes: { how: "resolved" } },
      { event: "matter.comment", changes: {} },
      { event: "matter.comment", changes: { text: `${KEPT_NAME} звонил` } },
    ]);

    // The draft's marks and the handed-in version: the notes on the fan's sale go; sums, amounts, lines and the
    // bystander's note stay.
    const marks = await q<{ transaction_id: string; statement: string; note: string | null }>("select transaction_id::text, statement, note from shift_handin_marks order by transaction_id");
    expect(marks).toEqual([
      { transaction_id: String(saleA), statement: "mine", note: null },
      { transaction_id: String(saleB), statement: "mine", note: `${KEPT_NAME} постоянный` },
    ]);
    const [version] = await q<{ total_mills: string; pages: unknown; lines: Array<Record<string, unknown>> }>("select total_mills::text, pages, lines from shift_handin_versions where id = $1", [versionId]);
    expect(version!.total_mills).toBe("25001");
    expect(version!.lines).toEqual([{ ...line(saleA, 16_001, ""), note: null }, line(saleB, 9_000, `${KEPT_NAME} купил второй раз`)]);

    // Converged: a second plan finds nothing left in these tables.
    const again = await planErasure(erasureApp, scope);
    for (const target of ["object_events", "matters", "sale_claims", "sale_owner_decisions", "shift_handin_marks", "shift_handin_versions"]) {
      const rows = again.targets.filter((one) => one.target === target).reduce((sum, one) => sum + one.rows, 0);
      expect(rows, target).toBe(0);
    }
  });

  it("keeps a handed-in version immutable to anything but the erasure clearing its notes", async (context) => {
    if (!testDb) return context.skip();
    const client = await testDb.pool.connect();
    const sanctioned = "select set_config('agency_hub.erasure', 'shift_handin_lines', true)";
    // Lines with the bystander's note cleared, everything else as it is.
    const cleared = `(select jsonb_agg(case when (l ->> 'transactionId')::bigint = ${saleB} then l || '{"note": null}'::jsonb else l end order by i)
                        from jsonb_array_elements(lines) with ordinality as e(l, i))`;
    const refused = async (statement: string, withSetting: boolean) => {
      await client.query("begin");
      try {
        if (withSetting) await client.query(sanctioned);
        await expect(client.query(statement, [versionId]), statement).rejects.toThrow(/immutable/u);
      } finally {
        await client.query("rollback");
      }
    };
    try {
      // Without the erasure's setting nothing changes a version, not even clearing a note.
      await expect(testDb.pool.query(`update shift_handin_versions set lines = ${cleared} where id = $1`, [versionId])).rejects.toThrow(/immutable/u);
      await refused(`update shift_handin_versions set lines = ${cleared} where id = $1`, false);
      // With it: no sum, no amount, no line, no other column and no other words — only a note cleared.
      await refused("update shift_handin_versions set total_mills = total_mills + 1 where id = $1", true);
      await refused("update shift_handin_versions set comment = 'x' where id = $1", true);
      await refused(`update shift_handin_versions set lines = jsonb_set(lines, '{1,amountMills}', '1') where id = $1`, true);
      await refused(`update shift_handin_versions set lines = jsonb_set(lines, '{1,note}', '"другие слова"') where id = $1`, true);
      await refused(`update shift_handin_versions set lines = lines - 1 where id = $1`, true);
      await refused(`update shift_handin_versions set lines = lines || '[{"transactionId": null}]'::jsonb where id = $1`, true);
      await refused("delete from shift_handin_versions where id = $1", true);

      await client.query("begin");
      await client.query(sanctioned);
      await client.query(`update shift_handin_versions set lines = ${cleared} where id = $1`, [versionId]);
      await client.query("commit");
      const [after] = await q<{ lines: Array<{ note: string | null }> }>("select lines from shift_handin_versions where id = $1", [versionId]);
      expect(after!.lines.map((one) => one.note)).toEqual([null, null]);
      // The setting is the transaction's own: the next one is refused again.
      await expect(client.query("update shift_handin_versions set lines = lines where id = $1", [versionId])).rejects.toThrow(/immutable/u);
    } finally {
      client.release();
    }
  });
});
