import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, findCustomOrder, findMatterByKey, upsertTransaction } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { reportUnmatchedCards, runCustomOrderChecks } from "../apps/runtime/src/services/custom-orders/checks.ts";
import { applyCustomStep, factsOfRow, recordCustomOrder, urgencyOfRow } from "../apps/runtime/src/services/custom-orders/index.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Custom orders that keep themselves true (customs facts spec §6, §8; behind the switch `customsFacts`). The exact
// «given»: an order's files are its model's vault files named with its code; a page's message that carried every one
// of them to the order's fan (any account of the person) — free, or priced and bought — marks it given, and a bought
// one's purchase pays it; every file sent but a priced one not bought is «sent, not opened»; the same file sent to
// another fan means nothing (customs are resold); a message a person took off the order is no evidence. An order
// closes 72 hours after the mark, whatever the message's time. The switch-on step turns every open matter of the
// retired kinds into a finding before it closes them. Every name, number and file is made up.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HASH = "c".repeat(64);
/** The pass's clock: the orders were recorded five days before, their files sent two days before. */
const T = new Date(Math.floor(Date.now() / 1000) * 1000);
const ago = (ms: number) => new Date(T.getTime() - ms);

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
/** The same app with the switch on. */
let on: AppContext;
let ownerId = 0;
let pageId = 0;
const fans = { a: 0, a2: 0, b: 0, tipper: 0 };
const conv = { a: "8810000001", a2: "8810000002", b: "8810000003" };
let nextRef = 9_100_000_000;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

async function fan(platformUserId: string, username: string): Promise<number> {
  return Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', $1, $2) returning id", [platformUserId, username])).rows[0].id);
}

async function thread(fanId: number, conversation: string, partner: string) {
  await q(`insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, stored_message_count,
             message_coverage_status, last_message_at)
           values ($1, $2, $3, $4, 1, 'complete', $5)`, [pageId, fanId, conversation, partner, ago(DAY).toISOString()]);
}

/** A shot order of fan A on the page, recorded five days ago. */
async function shotOrder(): Promise<number> {
  return recordCustomOrder(app, {
    pageId, fanId: fans.a, buyer: null, conversationRef: null, card: { task: "Ролик по карточке" }, deadlineOn: "2099-01-01", state: "shot",
    acceptedByUserId: null, origin: "agent", actor: { door: "system" }, createdAt: ago(5 * DAY), now: ago(5 * DAY),
  });
}

/** A vault file of the page named with the order's code, uploaded three days ago; answers its media ref. */
async function file(orderId: number): Promise<string> {
  const mediaRef = String(nextRef++);
  await q(`insert into creator_raw_media (page_id, platform, media_ref, filename, created_at_platform, source_kind, first_origin,
             first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
           values ($1, 'fansly', $2, $3, $4, 'vault_media', 'vault', $4, $4, $5, 1, 1, 1)`,
    [pageId, mediaRef, `demo_clip_K-${orderId}_custom.mp4`, ago(3 * DAY).toISOString(), HASH]);
  return mediaRef;
}

/** An offer of the file (a send makes one): its own ref, or a bundle that holds it. Answers the offer's ref. */
async function offer(mediaRef: string, bundleRef: string | null = null): Promise<string> {
  const offerRef = String(nextRef++);
  await q(`insert into creator_media (page_id, platform, media_offer_ref, media_ref, bundle_refs, first_origin, first_observed_at,
             last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
           values ($1, 'fansly', $2, $3, $4::text[], 'dm_sidecar', now(), now(), $5, 1, 1, 1)`,
    [pageId, offerRef, mediaRef, bundleRef === null ? [] : [bundleRef], HASH]);
  return offerRef;
}

/** The page's message in a chat carrying offers (by offer ref or bundle ref), `price` 0 — free. Answers its ref. */
async function send(conversation: string, at: Date, carries: ReadonlyArray<{ offerRef?: string; bundleRef?: string }>, price = 0): Promise<string> {
  const ref = String(nextRef++);
  await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
             media_metadata, price_mills, message_type)
           values ($1, 'fansly', $2, $3, 'model', true, $4, '', '[{"type":"video"}]'::jsonb, $5, 1)`,
    [pageId, conversation, ref, at.toISOString(), price > 0 ? price : null]);
  for (const [ordinal, carried] of carries.entries()) {
    await q(`insert into message_media_offers (page_id, platform, message_ref, offer_ordinal, media_offer_ref, bundle_ref, conversation_ref,
               fan_platform_user_id, message_created_at, price_mills, purchase_state, first_observed_at, last_observed_at, content_hash,
               source_event_id, source_observation_id, source_account_seq)
             values ($1, 'fansly', $2, $3, $4, $5, $6, '7500000999', $7, $8, 'unknown', now(), now(), $9, 1, 1, 1)`,
      [pageId, ref, ordinal, carried.offerRef ?? null, carried.bundleRef ?? null, conversation, at.toISOString(), price, HASH]);
  }
  return ref;
}

async function purchase(fanId: number, correlationId: string, at: Date): Promise<number> {
  const name = `purchase-${nextRef++}`;
  await upsertTransaction(app.db, {
    platformAccountId: pageId, source: "fansly:rest", fanId, transactionId: name, correlationId, rawType: "7001",
    canonicalType: "message_purchase", transactionState: "posted", rawStatus: "ok", grossAmountMills: 20_000n,
    sourceDestinationAmountMills: 20_000n, creatorNetAmountMills: 16_000n, occurredAt: at,
  });
  return Number((await q("select id from transactions where transaction_id = $1", [name])).rows[0].id);
}

/** A sale of the fan on the page: its Hub id and its platform id. */
async function sale(fanId: number, kind: "tip" | "subscription", at: Date): Promise<{ id: number; name: string }> {
  const name = `${kind}-${nextRef++}`;
  await upsertTransaction(app.db, {
    platformAccountId: pageId, source: "fansly:rest", fanId, transactionId: name, correlationId: `corr-${name}`, rawType: "7001",
    canonicalType: kind, transactionState: "posted", rawStatus: "ok", grossAmountMills: 30_000n,
    sourceDestinationAmountMills: 30_000n, creatorNetAmountMills: 24_000n, occurredAt: at,
  });
  return { id: Number((await q("select id from transactions where transaction_id = $1", [name])).rows[0].id), name };
}

/** A person's step on the board (the owner's), at a moment. */
const byPerson = (orderId: number, step: Parameters<typeof applyCustomStep>[1]["step"], now: Date) =>
  applyCustomStep(app, { orderId, step, actor: { door: "workboard", userId: ownerId }, viewer: null, now });
const later = (ms: number) => new Date(T.getTime() + ms);
const rejectionsOf = async (id: number) => (await q("select kind, ref from custom_order_rejections where order_id = $1 order by kind, ref", [id])).rows;

const orderOf = async (id: number) => {
  const order = (await findCustomOrder(app.db, id))!;
  return { state: order.state, givenMessageRef: order.givenMessageRef, givenAt: order.givenAt?.toISOString() ?? null, sentAt: order.sentAt?.toISOString() ?? null };
};
const paymentsOf = async (id: number) => (await q("select transaction_id from custom_order_payments where order_id = $1 order by transaction_id", [id])).rows.map((row) => Number(row.transaction_id));

describe("custom orders keep themselves true: the checks pass", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    on = { ...app, config: { ...app.config, customsFacts: true } };
    ownerId = (await createUserAccount(app, { username: "boss", role: "owner", password: "boss-secret" }, { source: "cli" })).id;
    const model = await createModel(app.db, { slug: "demo-model", name: "Demo Model" });
    pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "demo-1" }))!.id;
    fans.a = await fan("7500000101", "fan_main");
    fans.a2 = await fan("7500000102", "fan_second");
    fans.b = await fan("7500000103", "fan_other");
    fans.tipper = await fan("7500000104", "fan_tipper");
    // The fan's second account is the same person.
    await q("insert into fan_links (fan_id, other_fan_id, decision, reason_kind, decided_by_user_id) values ($1, $2, 'same', 'same_username', $3)",
      [Math.min(fans.a, fans.a2), Math.max(fans.a, fans.a2), ownerId]);
    await thread(fans.a, conv.a, "7500000101");
    await thread(fans.a2, conv.a2, "7500000102");
    await thread(fans.b, conv.b, "7500000103");
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("gives an order whose only file went to the fan in a free message, by that message and its time", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    const message = await send(conv.a, ago(2 * DAY), [{ offerRef: await offer(await file(order)) }]);
    // With the switch off nothing moves by itself.
    await runCustomOrderChecks(app, T);
    expect((await orderOf(order)).state).toBe("shot");
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toEqual({ state: "given", givenMessageRef: message, givenAt: ago(2 * DAY).toISOString(), sentAt: null });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("gives an order whose file went in a bundle", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    const bundle = String(nextRef++);
    await offer(await file(order), bundle);
    const message = await send(conv.a, ago(2 * DAY), [{ bundleRef: bundle }]);
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toMatchObject({ state: "given", givenMessageRef: message });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not give an order of two files when only one was sent", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    const sent = await offer(await file(order));
    await offer(await file(order));
    await send(conv.a, ago(2 * DAY), [{ offerRef: sent }]);
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toEqual({ state: "shot", givenMessageRef: null, givenAt: null, sentAt: null });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("marks a priced message sent and not opened, then given with its purchase as the payment once bought", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    const offerRef = await offer(await file(order));
    const message = await send(conv.a, ago(2 * DAY), [{ offerRef }], 20_000);
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toEqual({ state: "shot", givenMessageRef: null, givenAt: null, sentAt: ago(2 * DAY).toISOString() });
    expect(await paymentsOf(order)).toEqual([]);
    const bought = await purchase(fans.a, offerRef, ago(DAY));
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toEqual({ state: "given", givenMessageRef: message, givenAt: ago(2 * DAY).toISOString(), sentAt: null });
    expect(await paymentsOf(order)).toEqual([bought]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does nothing when the file went to another fan (customs are resold)", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    await send(conv.b, ago(2 * DAY), [{ offerRef: await offer(await file(order)) }]);
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toEqual({ state: "shot", givenMessageRef: null, givenAt: null, sentAt: null });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("gives an order whose file went to another account of the same person", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    const message = await send(conv.a2, ago(2 * DAY), [{ offerRef: await offer(await file(order)) }]);
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toMatchObject({ state: "given", givenMessageRef: message });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("skips a message a person took off the order", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    const message = await send(conv.a, ago(2 * DAY), [{ offerRef: await offer(await file(order)) }]);
    await q("insert into custom_order_rejections (order_id, kind, ref, rejected_by_user_id) values ($1, 'given', $2, $3)", [order, message, ownerId]);
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toEqual({ state: "shot", givenMessageRef: null, givenAt: null, sentAt: null });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("closes a given order 72 hours after the mark, not after the message's old time", async (context) => {
    if (!testDb) return context.skip();
    // Recorded eleven days ago and sent the day after: the mark is set now, and the window counts from it.
    const order = await shotOrder();
    await q("update custom_orders set created_at = $2 where id = $1", [order, ago(11 * DAY).toISOString()]);
    await send(conv.a, ago(10 * DAY), [{ offerRef: await offer(await file(order)) }]);
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toMatchObject({ state: "given", givenAt: ago(10 * DAY).toISOString() });
    await runCustomOrderChecks(on, new Date(T.getTime() + 71 * HOUR));
    expect((await orderOf(order)).state).toBe("given");
    await runCustomOrderChecks(on, new Date(T.getTime() + 73 * HOUR));
    expect((await orderOf(order)).state).toBe("closed");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("on the switch, turns every open matter of the retired kinds into a finding before closing it", async (context) => {
    if (!testDb) return context.skip();
    // Before the switch: a tip whose note speaks of a custom is a matter, and so is a card the reader found.
    const soldAt = ago(3 * DAY);
    await upsertTransaction(app.db, {
      platformAccountId: pageId, source: "fansly:rest", fanId: fans.tipper, transactionId: "tip-custom", correlationId: "tip-ctx-1", rawType: "7001",
      canonicalType: "tip", transactionState: "posted", rawStatus: "ok", grossAmountMills: 50_000n,
      sourceDestinationAmountMills: 50_000n, creatorNetAmountMills: 40_000n, occurredAt: soldAt,
    });
    await q(`insert into transaction_tip_contexts (account_id, platform, platform_tip_id, captured_conversation_ref, tip_message_text,
               tip_message_captured_at, tip_amount_mills, occurred_at, sender_platform_user_id, captured_at, provenance)
             values ($1, 'fansly', 'tip-ctx-1', 'conv-tip', 'for my custom video', $2, 50000, $2, '7500000104', $2, 'fansly_dm_tip_sidecar')`,
      [pageId, soldAt.toISOString()]);
    const sale = Number((await q("select id from transactions where transaction_id = 'tip-custom'")).rows[0].id);
    const card = "tg:1000000001/3/777";
    await runCustomOrderChecks(app, T);
    await reportUnmatchedCards(app, { cards: [{ telegramRef: card, postedAt: ago(2 * DAY).toISOString() }], complete: false, agentKeyId: 1 }, T);
    const keys = [`custom.unrecorded:${sale}`, `custom.card_without_order:${card}`];
    for (const key of keys) expect((await findMatterByKey(app.db, key))?.state, key).toBe("open");

    await runCustomOrderChecks(on, T);
    for (const key of keys) expect(await findMatterByKey(app.db, key), key).toMatchObject({ state: "closed", closedHow: "withdrawn" });
    const found = (await q("select source, ref, status from custom_findings where (source, ref) in (('sale', $1), ('model_group', $2)) order by source",
      [String(sale), card])).rows;
    expect(found).toEqual([{ source: "model_group", ref: card, status: "open" }, { source: "sale", ref: String(sale), status: "open" }]);
    // The retired kinds are no longer written: the same card reported again is a finding, never a matter again.
    await reportUnmatchedCards(on, { cards: [{ telegramRef: card }], complete: true, agentKeyId: 1 }, T);
    await runCustomOrderChecks(on, T);
    for (const key of keys) expect((await findMatterByKey(app.db, key))?.state, key).toBe("closed");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not close a given order whose sale the platform took back: it burns, the owner's to settle", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    const paid = await sale(fans.a, "tip", ago(4 * DAY));
    await applyCustomStep(app, { orderId: order, step: { action: "payment", transactionId: paid.id }, actor: { door: "system" }, viewer: null, now: ago(4 * DAY) });
    await applyCustomStep(app, { orderId: order, step: { action: "given", messageRef: String(nextRef++), at: ago(2 * DAY) }, actor: { door: "system" }, viewer: null, now: T });
    // OnlyFans writes the chargeback as a row of its own after the order was given.
    await q(`insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
               gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
             values ($1, $2, $3, 'chargeback', 'chargeback', 'posted', 'ok', 30000, 30000, 24000, $4, 'fansly:rest', 'USD')`,
    [pageId, fans.a, `${paid.name}:chargeback`, ago(DAY).toISOString()]);
    const past = later(73 * HOUR);
    await runCustomOrderChecks(on, past);
    expect((await orderOf(order)).state).toBe("given");
    const row = (await findCustomOrder(app.db, order))!;
    expect(urgencyOfRow(row, factsOfRow(row), past)).toMatchObject({ burning: true });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("counts only the offer that carried the order's file: another clip of the message bought is neither delivery nor its money", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    const custom = await offer(await file(order));
    const extra = await offer(String(nextRef++));
    // One message, two priced offers: the custom and another clip.
    const message = await send(conv.a, ago(2 * DAY), [{ offerRef: custom }, { offerRef: extra }], 20_000);
    await purchase(fans.a, extra, ago(DAY));
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toEqual({ state: "shot", givenMessageRef: null, givenAt: null, sentAt: ago(2 * DAY).toISOString() });
    expect(await paymentsOf(order)).toEqual([]);
    // The fan buys the custom too: given, paid by that purchase alone.
    const paid = await purchase(fans.a, custom, ago(HOUR));
    await runCustomOrderChecks(on, later(HOUR));
    expect(await orderOf(order)).toMatchObject({ state: "given", givenMessageRef: message });
    expect(await paymentsOf(order)).toEqual([paid]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not close a given order whose only sale went inactive beside its reversal, nor one whose mark is fresh under the lock", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    const paid = await sale(fans.a, "tip", ago(4 * DAY));
    await applyCustomStep(app, { orderId: order, step: { action: "payment", transactionId: paid.id }, actor: { door: "system" }, viewer: null, now: ago(4 * DAY) });
    await applyCustomStep(app, { orderId: order, step: { action: "given", messageRef: String(nextRef++), at: ago(2 * DAY) }, actor: { door: "system" }, viewer: null, now: T });
    // The platform retires the original row and keeps its reversal: no money counts, and it is still a sale taken back.
    await q("update transactions set is_active = false, inactive_reason = 'missing_from_sync_window' where id = $1", [paid.id]);
    await q(`insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
               gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
             values ($1, $2, $3, 'reversal', 'chargeback', 'posted', 'ok', 30000, 30000, 24000, $4, 'fansly:rest', 'USD')`,
    [pageId, fans.a, `${paid.name}:reversal`, ago(DAY).toISOString()]);
    const row = (await findCustomOrder(app.db, order))!;
    expect(factsOfRow(row).paid.value).toBe("conflict");
    await runCustomOrderChecks(on, later(73 * HOUR));
    expect((await orderOf(order)).state).toBe("given");

    // A mark set again since it was read: the close under the lock reads its own age and refuses.
    const fresh = await shotOrder();
    await applyCustomStep(app, { orderId: fresh, step: { action: "given", messageRef: String(nextRef++), at: T }, actor: { door: "system" }, viewer: null, now: T });
    const closed = await applyCustomStep(app, { orderId: fresh, step: { action: "close", auto: { hours: 72 } }, actor: { door: "system" }, viewer: null, now: later(HOUR) });
    expect(closed).toBe(false);
    expect((await orderOf(fresh)).state).toBe("given");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("never sets the default deadline again once a person took it off", async (context) => {
    if (!testDb) return context.skip();
    const order = await recordCustomOrder(app, {
      pageId, fanId: fans.a, buyer: null, conversationRef: null, card: { task: "Ролик без срока" }, deadlineOn: null, state: "recorded",
      acceptedByUserId: null, origin: "agent", actor: { door: "system" }, createdAt: ago(5 * DAY), now: ago(5 * DAY),
    });
    await runCustomOrderChecks(on, T);
    const set = (await findCustomOrder(app.db, order))!;
    expect(set).toMatchObject({ deadlineDefault: true });
    expect(set.deadlineOn).not.toBeNull();
    const events = await q("select changes from object_events where object_type = 'custom_order' and object_id = $1 and event = 'custom_order.deadline'", [String(order)]);
    expect(events.rows.map((row) => row.changes)).toEqual([{ from: null, to: set.deadlineOn, approximate: true }]);
    // The board's «Вернуть срок»: the person's empty deadline is theirs.
    await byPerson(order, { action: "deadline", deadlineOn: null, by: "person" }, later(HOUR));
    await runCustomOrderChecks(on, later(2 * HOUR));
    expect(await findCustomOrder(app.db, order)).toMatchObject({ deadlineOn: null, deadlineDefault: false });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("after a person's «не отдан», a message of before it with the same file does not give the order again; a newer one does", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    const offerRef = await offer(await file(order));
    const first = await send(conv.a, ago(2 * DAY), [{ offerRef }]);
    await send(conv.a, ago(36 * HOUR), [{ offerRef }]);
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toMatchObject({ state: "given", givenMessageRef: first });
    await byPerson(order, { action: "ungive" }, later(HOUR));
    await runCustomOrderChecks(on, later(2 * HOUR));
    expect(await orderOf(order)).toMatchObject({ state: "shot", givenMessageRef: null });
    const afterIt = await send(conv.a, later(90 * 60_000), [{ offerRef }]);
    await runCustomOrderChecks(on, later(3 * HOUR));
    expect(await orderOf(order)).toMatchObject({ state: "given", givenMessageRef: afterIt });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("after a revision of a given order, its old message is no evidence, and a message of before the revision gives nothing", async (context) => {
    if (!testDb) return context.skip();
    const order = await shotOrder();
    const first = await send(conv.a, ago(2 * DAY), [{ offerRef: await offer(await file(order)) }]);
    await runCustomOrderChecks(on, T);
    expect(await orderOf(order)).toMatchObject({ state: "given", givenMessageRef: first });
    await byPerson(order, { action: "revision", note: "Другой свет" }, later(HOUR));
    expect((await orderOf(order)).state).toBe("revision");
    expect(await rejectionsOf(order)).toEqual([{ kind: "given", ref: first }]);
    // The vault shows a file named with the code only now (Hub saw it late), and the page had sent it before the revision.
    const lateMedia = String(nextRef++);
    await q(`insert into creator_raw_media (page_id, platform, media_ref, filename, created_at_platform, source_kind, first_origin,
               first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
             values ($1, 'fansly', $2, $3, null, 'vault_media', 'vault', $4, $4, $5, 1, 1, 1)`,
    [pageId, lateMedia, `demo_retake_K-${order}_custom.mp4`, later(2 * HOUR).toISOString(), HASH]);
    await send(conv.a, ago(DAY), [{ offerRef: await offer(lateMedia) }]);
    await runCustomOrderChecks(on, later(3 * HOUR));
    expect(await orderOf(order)).toMatchObject({ state: "revision", givenMessageRef: null });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("dismisses once only the findings the old tier finder wrote (the tier's name), never a fan's request or a tip; their matters close", async (context) => {
    if (!testDb) return context.skip();
    await q(`insert into page_subscription_tiers (page_id, platform, tier_ref, name, pos, base_price_mills, first_observed_at, last_observed_at,
               content_hash, source_event_id, source_observation_id, source_account_seq)
             values ($1, 'fansly', 'tier-demo-gold', ' Demo Gold (free custom video) ', 1, 100000, now(), now(), $2, 1, 1, 1)`, [pageId, HASH]);
    const finding = async (saleId: number, quote: string) => Number((await q(
      `insert into custom_findings (source, ref, page_id, fan_id, amount_mills, quote, happened_at, created_at)
       values ('sale', $1, $2, $3, 30000, $4, $5, $5) returning id`,
      [String(saleId), pageId, fans.tipper, quote, ago(2 * DAY).toISOString()],
    )).rows[0].id);
    // The old tier finder wrote the tier's name; the reader wrote the fan's own words on another tier sale.
    const tierOnly = await finding((await sale(fans.tipper, "subscription", ago(2 * DAY))).id, "Demo Gold (free custom video)");
    const asked = await finding((await sale(fans.tipper, "subscription", ago(2 * DAY))).id, "how do I send you the details for my custom?");
    const tip = await finding((await sale(fans.tipper, "tip", ago(2 * DAY))).id, "Demo Gold (free custom video)");
    // A day old: each is a matter of the check's leader.
    await runCustomOrderChecks(on, T);
    for (const id of [tierOnly, asked, tip]) expect((await findMatterByKey(app.db, `custom.finding:${id}`))?.state).toBe("open");

    await q(await readFile(path.resolve("packages/db/migrations/0437_custom_findings_not_asked.sql"), "utf8"));
    const rows = await q("select id, status, dismiss_reason, resolved_by_user_id, resolved_by_agent_key_id from custom_findings where id = any($1::bigint[]) order by id", [[tierOnly, asked, tip]]);
    expect(rows.rows.map((row) => [Number(row.id), row.status, row.dismiss_reason, row.resolved_by_user_id, row.resolved_by_agent_key_id])).toEqual([
      [tierOnly, "dismissed", "not_asked", null, null],
      [asked, "open", null, null, null],
      [tip, "open", null, null, null],
    ]);
    // The next pass: the dismissed one's matter closes; the request and the tip still wait.
    await runCustomOrderChecks(on, later(HOUR));
    expect((await findMatterByKey(app.db, `custom.finding:${tierOnly}`))?.state).toBe("closed");
    for (const id of [asked, tip]) expect((await findMatterByKey(app.db, `custom.finding:${id}`))?.state).toBe("open");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
