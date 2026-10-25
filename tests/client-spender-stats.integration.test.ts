// H-8a: the Spenders stats and awaiting-reply reads against a real schema.
// Proves the definitions (packages/shared/src/spender-stats.ts) as the SQL
// applies them, the reconciliation with the hub's existing money reads and the
// caller's zone across a DST change.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countPageFansByLifetimeGrossBuckets,
  getPageSpenderStats,
  getSpenderRevenueDiagnosticsForScope,
  listPageSpenderAwaitingReply,
  listRevenueDailyForPages,
  type SpenderAwaitingReplyItem,
  type SpenderAwaitingReplyPosition,
} from "@agency_hub_core/db";
import {
  SPENDER_AUTO_LIST_BUCKETS,
  nextBusinessDate,
  resolveRevenueBusinessDateRangeForPlatform,
  resolveSpenderBusinessDateRangeForPlatform,
} from "@agency_hub_core/shared";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { SPENDER_STATS_FIXTURE_AS_OF, spenderStatsFixture } from "./helpers/spender-stats-fixture.ts";

const AS_OF = SPENDER_STATS_FIXTURE_AS_OF;

let testDb: StartedTestDatabase | null = null;

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

const { seedPage, seedFan, addTransaction, addThread, addMessage, seedMainPage, rebuildAll } = spenderStatsFixture(db);

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
    expect(stats.tiers.reduce((sum, tier) => sum + tier.windowNetMills, 0n)).toBe(stats.totals.d30.creatorNetMills);

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

  it("counts nothing after asOf: today is the day so far", async () => {
    const page = await seedPage("stats-as-of-of");
    const early = await seedFan(page.id, "6001");
    const late = await seedFan(page.id, "6002");
    await addTransaction(page.id, { fanId: null, type: "tip", gross: 1n, at: "2026-10-03T11:59:59Z" });
    await addTransaction(page.id, { fanId: early, type: "tip", gross: 10n, at: AS_OF.toISOString() });
    await addTransaction(page.id, { fanId: late, type: "tip", gross: 100n, at: "2026-10-03T15:00:00Z" });
    await rebuildAll(page.id);

    const stats = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF });

    expect(stats.days.at(-1)).toMatchObject({ date: "2026-10-03", grossMills: 11n, purchaseCount: 2 });
    expect(stats.totals.today).toMatchObject({ grossMills: 11n, purchaseCount: 2, payerCount: 1 });
    expect(stats.totals.d30).toMatchObject({ grossMills: 11n, payerCount: 1 });
    expect(stats.tiers.reduce((sum, tier) => sum + tier.windowGrossMills, 0n)).toBe(11n);
    expect(stats.tiers.reduce((sum, tier) => sum + tier.windowPayers, 0)).toBe(1);
    expect(stats.newPayers.count).toBe(1);
  });
});

describe("listPageSpenderAwaitingReply", () => {
  beforeEach(async () => {
    await resetIntegrationDatabase(db().pool);
  });

  it("never takes a mass message for an answer, and lists every fan who wrote with `everyone`", async () => {
    // Chat Memory week 3: a Fansly mass message, or one text to 5+ chats within an hour, leaves the fan waiting.
    const page = await seedPage("wait-of");
    const fan = async (ref: string, gross: bigint) => {
      const id = await seedFan(page.id, ref);
      if (gross > 0n) await addTransaction(page.id, { fanId: id, type: "tip", gross, at: "2026-09-01T10:00:00Z" });
      return id;
    };
    const burst = await fan("2001", 90_000n);
    const typed = await fan("2006", 50_000n);
    const answered = await fan("2007", 30_000n);
    const stranger = await fan("2008", 0n);
    await addThread(page.id, { fanId: burst, conversationRef: "2001", lastFanMessageAt: "2026-10-05T10:00:00Z", lastModelMessageAt: "2026-10-05T12:00:00Z", headRole: "model" });
    await addMessage(page.id, { conversationRef: "2001", fromFan: false, at: "2026-10-05T09:00:00Z", text: "hey you" });
    await addMessage(page.id, { conversationRef: "2001", fromFan: true, at: "2026-10-05T10:00:00Z", text: "hi there" });
    for (const chat of ["2001", "2102", "2103", "2104", "2105"]) {
      await addMessage(page.id, { conversationRef: chat, fromFan: false, at: "2026-10-05T12:00:00Z", text: "new set is out, check your dms" });
    }
    await addThread(page.id, { fanId: typed, conversationRef: "2006", lastFanMessageAt: "2026-10-06T10:00:00Z", lastModelMessageAt: "2026-10-06T11:00:00Z", headRole: "model" });
    await addMessage(page.id, { conversationRef: "2006", fromFan: true, at: "2026-10-06T10:00:00Z", text: "miss me?" });
    const mass = await addMessage(page.id, { conversationRef: "2006", fromFan: false, at: "2026-10-06T11:00:00Z", text: "weekend sale" });
    await db().pool.query("update message_archive set message_type = 2 where message_ref = $1", [mass]);
    await addThread(page.id, { fanId: answered, conversationRef: "2007", lastFanMessageAt: "2026-10-07T10:00:00Z", lastModelMessageAt: "2026-10-07T10:05:00Z", headRole: "model" });
    await addMessage(page.id, { conversationRef: "2007", fromFan: true, at: "2026-10-07T10:00:00Z", text: "hello" });
    await addMessage(page.id, { conversationRef: "2007", fromFan: false, at: "2026-10-07T10:05:00Z", text: "hi babe, how was work" });
    await addThread(page.id, { fanId: stranger, conversationRef: "2008", lastFanMessageAt: "2026-10-08T10:00:00Z" });
    await addMessage(page.id, { conversationRef: "2008", fromFan: true, at: "2026-10-08T10:00:00Z", text: "first time here" });
    await rebuildAll(page.id, new Date("2026-10-10T00:00:00Z"));

    const now = new Date("2026-10-10T00:00:00Z");
    const payers = await listPageSpenderAwaitingReply(db().db, { pageId: page.id, limit: 50, now });
    expect(payers.items.map((item) => [item.fanRef, item.conversationRef, item.lastModelMessageAt?.toISOString() ?? null])).toEqual([
      ["2001", "2001", "2026-10-05T09:00:00.000Z"],
      ["2006", "2006", null],
    ]);
    const everyone = await listPageSpenderAwaitingReply(db().db, { pageId: page.id, limit: 50, now, everyone: true });
    expect(everyone.items.map((item) => item.fanRef)).toEqual(["2001", "2006", "2008"]);
  });

  it("keeps a personal answer older than the window when only a mass message came since; a deleted reply answers nothing", async () => {
    // Review 2026-10-25: a mass message inside the window erased a personal answer from before it, and payers
    // answered in May stood waiting since then (lilly-2: 19 → 204).
    const page = await seedPage("wait-old-of");
    const payer = async (ref: string) => {
      const id = await seedFan(page.id, ref);
      await addTransaction(page.id, { fanId: id, type: "tip", gross: 40_000n, at: "2026-05-01T10:00:00Z" });
      return id;
    };
    const may = await payer("3001");
    await addThread(page.id, { fanId: may, conversationRef: "3001", lastFanMessageAt: "2026-05-10T10:00:00Z", lastModelMessageAt: "2026-10-06T11:00:00Z", headRole: "model" });
    await addMessage(page.id, { conversationRef: "3001", fromFan: true, at: "2026-05-10T10:00:00Z", text: "see you" });
    await addMessage(page.id, { conversationRef: "3001", fromFan: false, at: "2026-05-11T09:00:00Z", text: "bye love" });
    const mass = await addMessage(page.id, { conversationRef: "3001", fromFan: false, at: "2026-10-06T11:00:00Z", text: "weekend sale" });
    await db().pool.query("update message_archive set message_type = 2 where message_ref = $1", [mass]);
    const deleted = await payer("3002");
    await addThread(page.id, { fanId: deleted, conversationRef: "3002", lastFanMessageAt: "2026-10-07T10:00:00Z", lastModelMessageAt: "2026-10-07T09:00:00Z", headRole: "fan" });
    await addMessage(page.id, { conversationRef: "3002", fromFan: false, at: "2026-10-07T09:00:00Z", text: "morning" });
    await addMessage(page.id, { conversationRef: "3002", fromFan: true, at: "2026-10-07T10:00:00Z", text: "hey" });
    const reply = await addMessage(page.id, { conversationRef: "3002", fromFan: false, at: "2026-10-07T10:05:00Z", text: "oops" });
    await db().pool.query("update message_archive set deleted_at = '2026-10-07T10:06:00Z' where message_ref = $1", [reply]);
    await rebuildAll(page.id, new Date("2026-10-10T00:00:00Z"));

    const result = await listPageSpenderAwaitingReply(db().db, { pageId: page.id, limit: 50, now: new Date("2026-10-10T00:00:00Z") });
    expect(result.items.map((item) => [item.fanRef, item.lastModelMessageAt?.toISOString() ?? null])).toEqual([
      ["3002", "2026-10-07T09:00:00.000Z"],
    ]);
  });

  it("leaves out a fan the page can no longer message", async () => {
    // ari-1, 2026-10-26: a deleted Fansly fan (the page's own lookup no longer finds him) stood «ждёт 10 д» in ⌘K.
    const page = await seedPage("wait-gone-of");
    const waiting = async (ref: string, gross: bigint) => {
      const id = await seedFan(page.id, ref);
      await addTransaction(page.id, { fanId: id, type: "tip", gross, at: "2026-09-01T10:00:00Z" });
      await addThread(page.id, { fanId: id, conversationRef: ref, lastFanMessageAt: "2026-10-05T10:00:00Z", headRole: "fan" });
      await addMessage(page.id, { conversationRef: ref, fromFan: true, at: "2026-10-05T10:00:00Z", text: "bye bye" });
      return id;
    };
    await waiting("4001", 90_000n);
    const gone = await waiting("4002", 80_000n);
    const closed = await waiting("4003", 70_000n);
    const seen = await waiting("4004", 60_000n);
    await db().pool.query("update page_fans set account_probe_at = now(), account_probe_resolved = false where platform_account_id = $1 and fan_id = $2", [page.id, gone]);
    await db().pool.query("update page_fans set account_contactability = 'unavailable' where platform_account_id = $1 and fan_id = $2", [page.id, closed]);
    await db().pool.query("update page_fans set account_probe_at = now(), account_probe_resolved = true where platform_account_id = $1 and fan_id = $2", [page.id, seen]);
    await rebuildAll(page.id, new Date("2026-10-10T00:00:00Z"));

    const now = new Date("2026-10-10T00:00:00Z");
    for (const everyone of [false, true]) {
      const result = await listPageSpenderAwaitingReply(db().db, { pageId: page.id, limit: 50, now, everyone });
      expect(result.items.map((item) => item.fanRef)).toEqual(["4001", "4004"]);
      expect(result.total).toBe(2);
    }
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
});
