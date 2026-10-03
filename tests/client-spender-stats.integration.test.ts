// H-8a: the Spenders stats and awaiting-reply reads against a real schema.
// Proves the definitions (packages/shared/src/spender-stats.ts) as the SQL
// applies them, the reconciliation with the hub's existing money reads, the
// caller's zone across a DST change, and the perf gate (EXPLAIN).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countPageFansByLifetimeGrossBuckets,
  createModel,
  createOnlyFansPage,
  explainPageSpenderSilenceQuery,
  explainPageSpenderWindowQuery,
  getPageSpenderStats,
  getSpenderRevenueDiagnosticsForScope,
  listPageSpenderAwaitingReply,
  listRevenueDailyForPages,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  upsertFanPages,
  upsertFans,
  upsertTransaction,
  type SpenderAwaitingReplyItem,
  type SpenderAwaitingReplyPosition,
} from "@agency_hub_core/db";
import {
  SPENDER_AUTO_LIST_BUCKETS,
  nextBusinessDate,
  resolveRevenueBusinessDateRangeForPlatform,
  resolveSpenderBusinessDateRangeForPlatform,
  type TransactionState,
  type TransactionType,
} from "@agency_hub_core/shared";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

const AS_OF = new Date("2026-10-03T12:00:00.000Z");

let testDb: StartedTestDatabase | null = null;
let transactionSeq = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

function db() {
  if (!testDb) throw new Error("test database missing");
  return testDb;
}

async function seedPage(label: string) {
  const model = await createModel(db().db, { slug: `model-${label}`, name: `Model ${label}` });
  if (!model) throw new Error(`model for ${label} was not created`);
  const page = await createOnlyFansPage(db().db, { modelId: model.id, label });
  if (!page) throw new Error(`page ${label} was not created`);
  return page;
}

async function seedFan(pageId: number, ref: string, options: { deleted?: boolean } = {}) {
  const [fan] = await upsertFans(db().db, [{ platform: "onlyfans", platformUserId: ref, username: `fan${ref}` }]);
  await upsertFanPages(db().db, [{ fanId: fan!.id, platformAccountId: pageId }]);
  if (options.deleted) {
    await db().pool.query("update fans set deleted_detected_at = now() where id = $1", [fan!.id]);
  }
  return fan!.id;
}

async function addTransaction(pageId: number, input: {
  fanId: number | null;
  type: TransactionType;
  gross: bigint;
  at: string;
  state?: TransactionState;
}) {
  transactionSeq += 1;
  await upsertTransaction(db().db, {
    platformAccountId: pageId,
    source: "ofapi:webhook",
    fanId: input.fanId,
    transactionId: `stats-${transactionSeq}`,
    rawType: input.type,
    canonicalType: input.type,
    transactionState: input.state ?? "posted",
    rawStatus: "ok",
    grossAmountMills: input.gross,
    sourceDestinationAmountMills: input.gross,
    creatorNetAmountMills: (input.gross * 8n) / 10n,
    occurredAt: new Date(input.at),
  });
}

async function addThread(pageId: number, input: {
  fanId: number | null;
  conversationRef: string;
  unreadCount?: number;
  headRole?: "fan" | "model" | "system" | "unknown";
  lastMessageAt?: string | null;
  lastFanMessageAt?: string | null;
  lastModelMessageAt?: string | null;
  visible?: boolean;
}) {
  await db().pool.query(
    `insert into page_dm_threads (
       platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id,
       unread_count, last_message_sender_role, last_message_at,
       last_fan_message_at, last_model_message_at, is_visible
     ) values ($1, $2, $3, $3, $4, $5::dm_sender_role, $6, $7, $8, $9)`,
    [
      pageId,
      input.fanId,
      input.conversationRef,
      input.unreadCount ?? 0,
      input.headRole ?? "fan",
      input.lastMessageAt ?? input.lastFanMessageAt ?? input.lastModelMessageAt ?? null,
      input.lastFanMessageAt ?? null,
      input.lastModelMessageAt ?? null,
      input.visible ?? true,
    ],
  );
}

let messageSeq = 0;
async function addMessage(pageId: number, input: {
  conversationRef: string;
  fromFan: boolean;
  at: string;
  text: string;
  deleted?: boolean;
  contentPending?: boolean;
}) {
  messageSeq += 1;
  await db().pool.query(
    `insert into message_archive (
       account_id, platform, conversation_ref, message_ref, fan_native_id,
       sender_role, is_sent_by_me, occurred_at, text_plain, deleted_at, content_pending
     ) values ($1, 'onlyfans', $2, $3, $2, $4, $5, $6, $7, $8, $9)`,
    [
      pageId,
      input.conversationRef,
      String(900_000 + messageSeq),
      input.fromFan ? "fan" : "model",
      !input.fromFan,
      input.at,
      input.text,
      input.deleted ? input.at : null,
      input.contentPending ?? false,
    ],
  );
}

/**
 * The main page, AS_OF 2026-10-03 12:00Z, UTC window 2026-09-04..2026-10-03.
 * See each fan's comment for what it proves.
 */
async function seedMainPage() {
  const page = await seedPage("stats-of");
  const other = await seedPage("stats-other-of");

  // A: tier 25-50 (37 000); paid before the window, so not new; one purchase
  // at 22:30Z on 09-03, outside the UTC window but 09-04 01:30 in Moscow;
  // last text 3 days ago (not silent); awaiting, 2 unread.
  const a = await seedFan(page.id, "1001");
  await addTransaction(page.id, { fanId: a, type: "tip", gross: 30_000n, at: "2026-08-01T10:00:00Z" });
  await addTransaction(page.id, { fanId: a, type: "tip", gross: 2_000n, at: "2026-09-03T22:30:00Z" });
  await addTransaction(page.id, { fanId: a, type: "tip", gross: 5_000n, at: "2026-10-03T09:00:00Z" });
  await addMessage(page.id, { conversationRef: "1001", fromFan: true, at: "2026-09-30T12:00:00Z", text: "hey" });
  await addMessage(page.id, { conversationRef: "1001", fromFan: false, at: "2026-10-02T08:00:00Z", text: "hi!" });
  await addThread(page.id, {
    fanId: a,
    conversationRef: "1001",
    unreadCount: 2,
    headRole: "fan",
    lastFanMessageAt: "2026-10-03T08:00:00Z",
    lastModelMessageAt: "2026-10-02T08:00:00Z",
  });

  // B: tier 0-25 (12 000); first purchase in the window (new); a pending tip;
  // last TEXT 10 days ago — a later deleted, blank or content-pending message
  // does not count; replied to, so not awaiting, and an older second chat
  // that is awaiting does not make B awaiting (primary chat rule).
  const b = await seedFan(page.id, "1002");
  await addTransaction(page.id, { fanId: b, type: "message_purchase", gross: 10_000n, at: "2026-09-25T10:00:00Z" });
  await addTransaction(page.id, { fanId: b, type: "tip", gross: 2_000n, at: "2026-09-30T10:00:00Z", state: "pending" });
  await addMessage(page.id, { conversationRef: "1002", fromFan: true, at: "2026-09-23T12:00:00Z", text: "remember me" });
  await addMessage(page.id, { conversationRef: "1002", fromFan: true, at: "2026-10-01T12:00:00Z", text: "deleted", deleted: true });
  await addMessage(page.id, { conversationRef: "1002", fromFan: true, at: "2026-10-02T12:00:00Z", text: " \n\t " });
  await addMessage(page.id, { conversationRef: "1002", fromFan: true, at: "2026-10-02T13:00:00Z", text: "stub", contentPending: true });
  await addMessage(page.id, { conversationRef: "1002", fromFan: false, at: "2026-10-03T11:00:00Z", text: "model text" });
  await addThread(page.id, {
    fanId: b,
    conversationRef: "1002",
    headRole: "model",
    lastMessageAt: "2026-09-24T12:00:00Z",
    lastFanMessageAt: "2026-09-23T12:00:00Z",
    lastModelMessageAt: "2026-09-24T12:00:00Z",
  });
  await addThread(page.id, {
    fanId: b,
    conversationRef: "b-old",
    unreadCount: 1,
    lastMessageAt: "2026-09-01T12:00:00Z",
    lastFanMessageAt: "2026-09-01T12:00:00Z",
    lastModelMessageAt: null,
  });

  // C: tier 150-350 (197 000); a refund in the window and no purchase;
  // silent since August (over 21 days); awaiting with no model message at
  // all and a chat row whose head is unknown → read state unknown.
  const c = await seedFan(page.id, "1003");
  await addTransaction(page.id, { fanId: c, type: "subscription", gross: 200_000n, at: "2026-07-01T10:00:00Z" });
  await addTransaction(page.id, { fanId: c, type: "refund", gross: -3_000n, at: "2026-09-30T11:00:00Z" });
  await addMessage(page.id, { conversationRef: "1003", fromFan: true, at: "2026-08-01T12:00:00Z", text: "bye" });
  await addThread(page.id, {
    fanId: c,
    conversationRef: "1003",
    headRole: "unknown",
    lastMessageAt: "2026-08-01T12:00:00Z",
    lastFanMessageAt: "2026-08-01T12:00:00Z",
    lastModelMessageAt: null,
  });

  // D: tier 0-25 (1 000); first purchase on the window's first UTC date, in
  // the unknown state; never wrote (silence unknown); no chat.
  const d = await seedFan(page.id, "1004");
  await addTransaction(page.id, { fanId: d, type: "stream_tip", gross: 1_000n, at: "2026-09-04T00:30:00Z", state: "unknown" });

  // E: bought and was refunded in the window: lifetime 0, so no tier — the
  // spend lands in "untiered"; awaiting but not a payer, so not queued.
  const e = await seedFan(page.id, "1005");
  await addTransaction(page.id, { fanId: e, type: "tip", gross: 500n, at: "2026-09-10T10:00:00Z" });
  await addTransaction(page.id, { fanId: e, type: "refund", gross: -500n, at: "2026-09-11T10:00:00Z" });
  await addThread(page.id, {
    fanId: e,
    conversationRef: "1005",
    unreadCount: 1,
    lastFanMessageAt: "2026-10-01T10:00:00Z",
  });

  // F: tier 600-plus (700 000); last text exactly 21 days ago (still 8–21);
  // awaiting, nothing unread and the chat's head is the fan → read.
  const f = await seedFan(page.id, "1006");
  await addTransaction(page.id, { fanId: f, type: "tip", gross: 690_000n, at: "2026-06-01T10:00:00Z" });
  await addTransaction(page.id, { fanId: f, type: "tip", gross: 10_000n, at: "2026-09-28T10:00:00Z" });
  await addMessage(page.id, { conversationRef: "1006", fromFan: true, at: "2026-09-12T12:00:00Z", text: "miss you" });
  await addThread(page.id, {
    fanId: f,
    conversationRef: "1006",
    headRole: "fan",
    lastFanMessageAt: "2026-09-30T10:00:00Z",
    lastModelMessageAt: "2026-09-29T10:00:00Z",
  });

  // G: a deleted account that paid in the window: never a tier member, its
  // spend is "untiered".
  const g = await seedFan(page.id, "1007", { deleted: true });
  await addTransaction(page.id, { fanId: g, type: "tip", gross: 3_000n, at: "2026-09-15T10:00:00Z" });

  // Unattributed purchase; a payout reversal and an inactive row that no
  // number may count; another page's spend in the same window.
  await addTransaction(page.id, { fanId: null, type: "tip", gross: 4_000n, at: "2026-09-20T10:00:00Z" });
  await addTransaction(page.id, { fanId: null, type: "payout_reversal", gross: -50_000n, at: "2026-09-21T10:00:00Z" });
  await addTransaction(page.id, { fanId: a, type: "tip", gross: 99_000n, at: "2026-09-22T10:00:00Z" });
  await db().pool.query(
    "update transactions set is_active = false, inactive_reason = 'missing_from_sync_window' where gross_amount_mills = 99000",
  );
  const stranger = await seedFan(other.id, "2001");
  await addTransaction(other.id, { fanId: stranger, type: "tip", gross: 77_000n, at: "2026-09-29T10:00:00Z" });

  return { page, other, fans: { a, b, c, d, e, f, g } };
}

async function rebuildAll(pageId: number, rebuiltAt = AS_OF) {
  await rebuildSpenderProjections(db().db, pageId, null, rebuiltAt);
  await rebuildRevenueRollups(db().db, pageId);
}

describe("getPageSpenderStats", () => {
  beforeEach(async () => {
    await resetIntegrationDatabase(db().pool);
  });

  it("counts the window's money by the definitions, in one snapshot", async () => {
    const { page } = await seedMainPage();
    await rebuildAll(page.id);

    const stats = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF });

    expect(stats).toMatchObject({
      pageId: page.id,
      metricVersion: 1,
      timeZone: "UTC",
      asOf: AS_OF,
      from: "2026-09-04",
      to: "2026-10-03",
      projectionAsOf: AS_OF,
      coverage: { state: "complete", reasons: [] },
    });
    expect([...stats.includedStates].sort()).toEqual(["pending", "posted", "unknown"]);
    expect(stats.days).toHaveLength(30);

    // Gross keeps the refunds; payout reversals, inactive rows and the other
    // page are nowhere.
    expect(stats.totals.d30).toEqual({
      grossMills: 32_000n,
      purchasesGrossMills: 35_500n,
      adjustmentsMills: -3_500n,
      creatorNetMills: 25_600n,
      purchaseCount: 8,
      payerCount: 6,
    });
    expect(stats.totals.today).toMatchObject({ grossMills: 5_000n, purchaseCount: 1, payerCount: 1 });
    expect(stats.totals.d7).toMatchObject({ grossMills: 14_000n, adjustmentsMills: -3_000n, payerCount: 3 });
    expect(stats.totals.prev7).toMatchObject({ grossMills: 14_000n, purchaseCount: 2, payerCount: 1 });
    expect(stats.totals.d7DeltaPct).toBe(0);
    // 35 500 / 8 = 4 437.5 → 4 438.
    expect(stats.avgCheckMills).toBe(4_438n);

    const day = (date: string) => stats.days.find((entry) => entry.date === date)!;
    expect(day("2026-09-04")).toMatchObject({ grossMills: 1_000n, byState: { posted: 0n, pending: 0n, unknown: 1_000n } });
    expect(day("2026-09-30")).toMatchObject({
      grossMills: -1_000n,
      purchasesGrossMills: 2_000n,
      adjustmentsMills: -3_000n,
      byState: { posted: -3_000n, pending: 2_000n, unknown: 0n },
    });
    expect(day("2026-09-21").grossMills).toBe(0n);
    expect(day("2026-09-22").grossMills).toBe(0n);

    // Tiers: lifetime membership; window spend of all rows sums to the total.
    const tiers = new Map(stats.tiers.map((tier) => [tier.key, tier]));
    expect(stats.tiers.map((tier) => tier.key)).toEqual([
      ...SPENDER_AUTO_LIST_BUCKETS.map((bucket) => bucket.key),
      "untiered",
      "unattributed",
    ]);
    expect(tiers.get("0-25")).toMatchObject({ members: 2, windowPayers: 2, windowGrossMills: 13_000n });
    expect(tiers.get("25-50")).toMatchObject({ members: 1, windowPayers: 1, windowGrossMills: 5_000n });
    expect(tiers.get("50-150")).toMatchObject({ members: 0, windowPayers: 0, windowGrossMills: 0n });
    expect(tiers.get("150-350")).toMatchObject({ members: 1, windowPayers: 0, windowGrossMills: -3_000n });
    expect(tiers.get("600-plus")).toMatchObject({ members: 1, windowPayers: 1, windowGrossMills: 10_000n });
    expect(tiers.get("untiered")).toMatchObject({ members: 2, windowPayers: 2, windowGrossMills: 3_000n });
    expect(tiers.get("unattributed")).toMatchObject({ members: 0, windowPayers: 0, windowGrossMills: 4_000n });
    expect(stats.tiers.reduce((sum, tier) => sum + tier.windowGrossMills, 0n)).toBe(stats.totals.d30.grossMills);

    // Silence counts only the fan's text messages, over the payers.
    expect(stats.silence).toEqual({
      d8to21: { fans: 2, lifetimeGrossMills: 712_000n },
      over21: { fans: 1, lifetimeGrossMills: 197_000n },
      unknown: { fans: 1, lifetimeGrossMills: 1_000n },
    });

    // New: B, D, E and G first paid inside the window; A and F paid before.
    expect(stats.newPayers).toEqual({ count: 4, firstPurchaseKnown: true });
    expect(stats.queueSummary).toEqual({ total: 3, unknown: 1 });
  });

  it("reconciles with /api/v2/spenders, the shelves and pageRevenueDaily (custom, net, UTC)", async () => {
    const { page } = await seedMainPage();
    await rebuildAll(page.id);

    const stats = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF });

    // /api/v2/spenders?period=30d: same 30 UTC dates, diagnostics total gross.
    const spenders = resolveSpenderBusinessDateRangeForPlatform("onlyfans", "30d", AS_OF);
    expect({ from: stats.from, to: stats.to }).toEqual({
      from: spenders.fromBusinessDate,
      to: spenders.toBusinessDateInclusive,
    });
    const diagnostics = await getSpenderRevenueDiagnosticsForScope(db().db, {
      pageIds: [page.id],
      fromBusinessDate: stats.from,
      toBusinessDateExclusive: nextBusinessDate(stats.to),
    });
    expect(stats.totals.d30.grossMills).toBe(diagnostics.totalGrossAmountMills);
    expect(diagnostics.unattributedGrossAmountMills).toBe(4_000n);

    // The shelves (pageSpenderAutoLists, lifetime) count the same members.
    const shelves = await countPageFansByLifetimeGrossBuckets(db().db, {
      pageId: page.id,
      buckets: SPENDER_AUTO_LIST_BUCKETS,
    });
    for (const shelf of shelves) {
      expect(stats.tiers.find((tier) => tier.key === shelf.key)?.members).toBe(shelf.entryCount);
    }

    // pageRevenueDaily serves net, and only `custom` covers these 30 dates:
    // on OnlyFans `30d` is 31 dates, and a custom `to` is exclusive.
    const ofThirtyDays = resolveRevenueBusinessDateRangeForPlatform("onlyfans", "30d", AS_OF);
    expect(ofThirtyDays.from).not.toBe(stats.from);
    const custom = resolveRevenueBusinessDateRangeForPlatform("onlyfans", "custom", AS_OF, {
      from: stats.from,
      to: nextBusinessDate(stats.to),
    });
    const revenue = await listRevenueDailyForPages(db().db, {
      pageIds: [page.id],
      fromBusinessDate: custom.from,
      toBusinessDate: custom.toExclusive,
    }) as Array<{ businessDate: string; netAmountMills: bigint }>;
    const revenueNet = revenue.reduce((sum, row) => sum + BigInt(row.netAmountMills), 0n);
    const daysNet = stats.days.reduce((sum, entry) => sum + entry.creatorNetMills, 0n);
    expect(daysNet).toBe(revenueNet);
    expect(daysNet).toBe(stats.totals.d30.creatorNetMills);
    for (const row of revenue) {
      expect(stats.days.find((entry) => entry.date === row.businessDate)?.creatorNetMills).toBe(BigInt(row.netAmountMills));
    }
  });

  it("dates the window in the caller's zone", async () => {
    const { page } = await seedMainPage();
    await rebuildAll(page.id);

    const moscow = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "Europe/Moscow", asOf: AS_OF });

    expect(moscow.timeZone).toBe("Europe/Moscow");
    expect({ from: moscow.from, to: moscow.to }).toEqual({ from: "2026-09-04", to: "2026-10-03" });
    // A's 09-03 22:30Z tip is 09-04 01:30 in Moscow.
    expect(moscow.days[0]).toMatchObject({ date: "2026-09-04", grossMills: 3_000n, purchaseCount: 2 });
    expect(moscow.totals.d30.grossMills).toBe(34_000n);
    expect(moscow.tiers.reduce((sum, tier) => sum + tier.windowGrossMills, 0n)).toBe(34_000n);
  });

  it("buckets local dates across a DST change by the zone's own midnights", async () => {
    const page = await seedPage("stats-dst-of");
    const asOf = new Date("2026-11-10T15:00:00.000Z");
    // America/New_York: EDT (−4) until 2026-11-01 06:00Z, EST (−5) after.
    await addTransaction(page.id, { fanId: null, type: "tip", gross: 100_000n, at: "2026-10-12T03:59:59Z" });
    await addTransaction(page.id, { fanId: null, type: "tip", gross: 10_000n, at: "2026-10-12T04:00:00Z" });
    await addTransaction(page.id, { fanId: null, type: "tip", gross: 1n, at: "2026-11-01T03:59:59Z" });
    await addTransaction(page.id, { fanId: null, type: "tip", gross: 10n, at: "2026-11-01T04:00:00Z" });
    await addTransaction(page.id, { fanId: null, type: "tip", gross: 100n, at: "2026-11-02T04:59:59Z" });
    await addTransaction(page.id, { fanId: null, type: "tip", gross: 1_000n, at: "2026-11-02T05:00:00Z" });
    await rebuildAll(page.id, asOf);

    const stats = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "America/New_York", asOf });
    const gross = (date: string) => stats.days.find((entry) => entry.date === date)?.grossMills;

    expect(stats.from).toBe("2026-10-12");
    expect(gross("2026-10-12")).toBe(10_000n);
    expect(gross("2026-10-31")).toBe(1n);
    // The 25-hour day keeps both of its ends.
    expect(gross("2026-11-01")).toBe(110n);
    expect(gross("2026-11-02")).toBe(1_000n);
    expect(stats.totals.d30.grossMills).toBe(11_111n);
    expect(stats.tiers.find((tier) => tier.key === "unattributed")?.windowGrossMills).toBe(11_111n);
    // The second before the window is history before it.
    expect(stats.coverage).toEqual({ state: "complete", reasons: [] });
    expect(stats.newPayers).toEqual({ count: 0, firstPurchaseKnown: true });
  });

  it("reports what it does not know", async () => {
    const { page } = await seedMainPage();

    // The spender projection was never built: window money is exact, the
    // lifetime half is empty and says so; the rows still sum to the total.
    const beforeRebuild = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF });
    expect(beforeRebuild.coverage).toEqual({ state: "partial", reasons: ["projection_missing"] });
    expect(beforeRebuild.projectionAsOf).toBeNull();
    expect(beforeRebuild.totals.d30.grossMills).toBe(32_000n);
    // No lifetime row yet, so every fan with window spend is untiered.
    expect(beforeRebuild.tiers.reduce((sum, tier) => sum + tier.members, 0)).toBe(7);
    expect(beforeRebuild.tiers.find((tier) => tier.key === "untiered")?.windowGrossMills).toBe(28_000n);
    expect(beforeRebuild.tiers.reduce((sum, tier) => sum + tier.windowGrossMills, 0n)).toBe(32_000n);
    expect(beforeRebuild.silence).toEqual({
      d8to21: { fans: 0, lifetimeGrossMills: 0n },
      over21: { fans: 0, lifetimeGrossMills: 0n },
      unknown: { fans: 0, lifetimeGrossMills: 0n },
    });
    expect(beforeRebuild.queueSummary).toEqual({ total: 0, unknown: 0 });

    // Rebuilt before the newest transaction occurred.
    await rebuildAll(page.id, new Date("2026-10-03T08:00:00.000Z"));
    const behind = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF });
    expect(behind.coverage).toEqual({ state: "partial", reasons: ["projection_behind"] });

    // A page that never had a transaction or a projection.
    const empty = await seedPage("stats-empty-of");
    const nothing = await getPageSpenderStats(db().db, { pageId: empty.id, timeZone: "UTC", asOf: AS_OF });
    expect(nothing.coverage).toEqual({ state: "unknown", reasons: ["no_revenue_history"] });
    expect(nothing.totals.d30.grossMills).toBe(0n);
    expect(nothing.avgCheckMills).toBeNull();
    expect(nothing.totals.d7DeltaPct).toBeNull();
    expect(nothing.newPayers).toEqual({ count: 0, firstPurchaseKnown: false });

    // Payers but no archived message at all: every silence is unknown.
    const silent = await seedPage("stats-silent-of");
    const payer = await seedFan(silent.id, "3001");
    await addTransaction(silent.id, { fanId: payer, type: "tip", gross: 20_000n, at: "2026-05-01T10:00:00Z" });
    await rebuildAll(silent.id);
    const quiet = await getPageSpenderStats(db().db, { pageId: silent.id, timeZone: "UTC", asOf: AS_OF });
    expect(quiet.coverage).toEqual({ state: "partial", reasons: ["messages_missing"] });
    expect(quiet.silence.unknown).toEqual({ fans: 1, lifetimeGrossMills: 20_000n });

    // History that starts inside the window: the first purchase seen there is
    // only the first one observed.
    const fresh = await seedPage("stats-fresh-of");
    const newcomer = await seedFan(fresh.id, "4001");
    await addTransaction(fresh.id, { fanId: newcomer, type: "tip", gross: 6_000n, at: "2026-09-20T10:00:00Z" });
    await rebuildAll(fresh.id);
    const young = await getPageSpenderStats(db().db, { pageId: fresh.id, timeZone: "UTC", asOf: AS_OF });
    expect(young.coverage).toEqual({ state: "partial", reasons: ["history_starts_in_window", "messages_missing"] });
    expect(young.newPayers).toEqual({ count: 1, firstPurchaseKnown: false });
  });

  it("refuses a zone the runtime does not know before reading", async () => {
    await expect(getPageSpenderStats(db().db, { pageId: 1, timeZone: "Mars/Olympus_Mons", asOf: AS_OF }))
      .rejects.toThrow(RangeError);
    await expect(getPageSpenderStats(db().db, { pageId: 1, timeZone: "+03:00", asOf: AS_OF }))
      .rejects.toThrow(RangeError);
  });
});

describe("listPageSpenderAwaitingReply", () => {
  beforeEach(async () => {
    await resetIntegrationDatabase(db().pool);
  });

  it("queues payers whose fan wrote last, by lifetime gross then waiting time", async () => {
    const { page, fans } = await seedMainPage();
    await rebuildAll(page.id);

    const result = await listPageSpenderAwaitingReply(db().db, { pageId: page.id, limit: 50 });

    expect(result.total).toBe(3);
    expect(result.unknown).toBe(1);
    expect(result.items.map((item) => item.fanRef)).toEqual(["1006", "1003", "1001"]);
    expect(result.items[0]).toMatchObject({
      fanId: fans.f,
      username: "fan1006",
      lifetimeGrossMills: 700_000n,
      lastFanMessageAt: new Date("2026-09-30T10:00:00Z"),
      lastModelMessageAt: new Date("2026-09-29T10:00:00Z"),
      readState: "read",
      unreadCount: 0,
    });
    expect(result.items[1]).toMatchObject({ fanRef: "1003", lastModelMessageAt: null, readState: "unknown", unreadCount: null });
    expect(result.items[2]).toMatchObject({ fanRef: "1001", readState: "unread", unreadCount: 2 });
    expect(result.items[2]!.position).toEqual({
      lifetimeGrossMills: 37_000n,
      lastFanMessageAtMicros: BigInt(Date.parse("2026-10-03T08:00:00Z")) * 1000n,
      fanId: fans.a,
    });
  });

  it("walks the queue exactly once with a keyset, through ties down to the microsecond", async () => {
    const page = await seedPage("stats-queue-of");
    const expected: string[] = [];
    // 4 lifetime levels × 6 fans; within a level three fans share one
    // millisecond and differ only in microseconds, two share the exact instant.
    const timestamps = [
      "2026-10-01 10:00:00.123401+00",
      "2026-10-01 10:00:00.123402+00",
      "2026-10-01 10:00:00.123403+00",
      "2026-10-02 10:00:00+00",
      "2026-10-02 10:00:00+00",
      "2026-10-02 11:00:00+00",
    ];
    for (const [level, gross] of [40_000n, 30_000n, 20_000n, 10_000n].entries()) {
      for (const [index, at] of timestamps.entries()) {
        const ref = `5${level}${index}`;
        const fanId = await seedFan(page.id, ref);
        await addTransaction(page.id, { fanId, type: "tip", gross, at: "2026-09-01T10:00:00Z" });
        await addThread(page.id, { fanId, conversationRef: ref, unreadCount: 1 });
        await db().pool.query(
          "update page_dm_threads set last_fan_message_at = $1, last_message_at = $1 where platform_conversation_id = $2",
          [at, ref],
        );
        expected.push(ref);
      }
    }
    await rebuildAll(page.id);

    const walk = async (limit: number, between?: (step: number) => Promise<void>) => {
      const seen: SpenderAwaitingReplyItem[] = [];
      let after: SpenderAwaitingReplyPosition | null = null;
      for (let step = 0; step < 100; step += 1) {
        const pageResult = await listPageSpenderAwaitingReply(db().db, { pageId: page.id, limit, after });
        seen.push(...pageResult.items);
        if (pageResult.items.length < limit) break;
        after = pageResult.items.at(-1)!.position;
        await between?.(step);
      }
      return seen;
    };

    const full = await walk(5);
    const refs = full.map((item) => item.fanRef);
    expect(new Set(refs).size).toBe(refs.length);
    // Seeded in queue order: levels by gross, then the timestamps in order.
    expect(refs).toEqual(expected);
    // Same lifetime → oldest waiting first → fan id.
    const sorted = [...full].sort((left, right) =>
      Number(right.lifetimeGrossMills - left.lifetimeGrossMills)
      || Number(left.position.lastFanMessageAtMicros - right.position.lastFanMessageAtMicros)
      || left.fanId - right.fanId);
    expect(refs).toEqual(sorted.map((item) => item.fanRef));
    expect(full.slice(0, 3).map((item) => item.position.lastFanMessageAtMicros % 1000n)).toEqual([401n, 402n, 403n]);

    // Chats change mid-walk: a not-yet-visited fan gets a reply and leaves
    // the queue; nothing is returned twice and the order holds.
    const changing = await walk(5, async (step) => {
      if (step === 0) {
        await db().pool.query(
          "update page_dm_threads set last_model_message_at = now(), last_message_at = now() where platform_conversation_id = '532'",
        );
      }
    });
    const changingRefs = changing.map((item) => item.fanRef);
    expect(new Set(changingRefs).size).toBe(changingRefs.length);
    expect(changingRefs).toEqual(refs.filter((ref) => ref !== "532"));
  });

  it("refuses a limit outside 1..200", async () => {
    await expect(listPageSpenderAwaitingReply(db().db, { pageId: 1, limit: 0 })).rejects.toThrow(RangeError);
    await expect(listPageSpenderAwaitingReply(db().db, { pageId: 1, limit: 201 })).rejects.toThrow(RangeError);
  });
});

describe("spender stats perf gate", () => {
  beforeEach(async () => {
    await resetIntegrationDatabase(db().pool, { physical: true });
  });

  it("probes the archive per chat through its conversation index and reads the window through the active index", async () => {
    const page = await seedPage("stats-perf-of");
    const other = await seedPage("stats-perf-other-of");
    for (let index = 0; index < 40; index += 1) {
      const ref = String(7000 + index);
      const fanId = await seedFan(page.id, ref);
      await addThread(page.id, { fanId, conversationRef: ref, lastFanMessageAt: "2026-09-01T10:00:00Z" });
    }
    await db().pool.query(
      `insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills)
       select $1, fp.fan_id, 50000, 40000 from page_fans fp where fp.platform_account_id = $1`,
      [page.id],
    );
    for (const pageId of [page.id, other.id]) {
      await db().pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref, is_sent_by_me, occurred_at, text_plain)
         select $1, 'onlyfans', (7000 + g % 40)::text, ($1::bigint * 1000000 + g)::text, g % 3 = 0,
                timestamptz '2026-10-01' - (g || ' minutes')::interval, 'text ' || g
         from generate_series(1, 20000) g`,
        [pageId],
      );
      await db().pool.query(
        `insert into transactions (
           platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
           gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills,
           occurred_at, is_active, source
         )
         select $1::bigint, 'perf-' || $1::text || '-' || g, 'tip', 'tip', 'posted', 'ok', 1000, 1000, 800,
                timestamptz '2026-10-03' - (g || ' hours')::interval, g % 3 <> 0, 'ofapi:rest'
         from generate_series(1, 20000) g`,
        [pageId],
      );
    }
    await db().pool.query("analyze message_archive, transactions, page_dm_threads, fan_spend_lifetime, page_fans, fans");

    const silencePlan = await explainPageSpenderSilenceQuery(db().db, { pageId: page.id, asOf: AS_OF });
    expect(silencePlan).toContain("message_archive_account_conv_idx");
    expect(silencePlan).not.toMatch(/Seq Scan on message_archive/);

    const windowPlan = await explainPageSpenderWindowQuery(db().db, { pageId: page.id, timeZone: "Europe/Moscow", asOf: AS_OF });
    expect(windowPlan).toContain("transactions_account_active_occurred_idx");
    expect(windowPlan).not.toMatch(/Seq Scan on transactions/);
  });
});
