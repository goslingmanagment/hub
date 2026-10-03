import { describe, expect, it } from "vitest";

import { HISTORY_WORK_RESOURCE, type SyncRouteUse } from "@agency_hub_core/db";

import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { FAMILY_BUDGETS, familyOfRoute, routeBudget } from "../apps/runtime/src/sync/fansly/routes.ts";
import { backtestEstimate, quantiles } from "../apps/runtime/src/sync/requests/eta-backtest.ts";
import {
  budgetUseOf,
  estimateItemReads,
  estimateRequest,
  ETA_USE_WINDOW_MS,
  HISTORY_READ_ROUTE,
  itemEtaFacts,
  CYCLE_TURNS,
  keptByRequests,
  requestsCapacity,
  type BudgetUse,
  type ItemEtaFacts,
  type RequestsCapacity,
} from "../apps/runtime/src/sync/requests/eta.ts";

// The ETA of a history request (plan §4.3, design §7.2; step 3b ruling 11)
// with fixed inputs: thread columns only, two numbers (a lower bound and an
// estimate), the rate from the tightest budget a history read draws on (the
// page's slots, `/message`, the messaging family) less what the other
// classes take of it, and the round robin between requests. The rate against
// the real scheduler and route clocks: tests/sync-history-eta-sim.test.ts.

const EPOCH_MS = 1561494359900;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-02T10:00:00Z");
const snowflake = (ms: number) => ((BigInt(ms - EPOCH_MS) << 22n) | 5n).toString();

function facts(overrides: Partial<ItemEtaFacts> = {}): ItemEtaFacts {
  return {
    complete: false,
    chainCount: 0,
    chainOldestAt: null,
    storedCount: 0,
    storedNewestAt: null,
    storedOldestAt: null,
    chatStartAt: new Date(NOW.getTime() - 100 * DAY),
    ...overrides,
  };
}

describe("one fan's reads", () => {
  it("a complete chat needs nothing", () => {
    expect(estimateItemReads({ depth: { kind: "all" }, anchored: false, belowAnchor: 0, facts: facts({ complete: true }), now: NOW }))
      .toEqual({ readsMin: 0, readsEstimate: 0, readsMax: null });
  });

  it("all, nothing stored: the head read and the empty page at least; no density, no estimate", () => {
    expect(estimateItemReads({ depth: { kind: "all" }, anchored: false, belowAnchor: 0, facts: facts(), now: NOW }))
      .toEqual({ readsMin: 2, readsEstimate: null, readsMax: null });
  });

  it("all: unproven stored messages are read again (the head read is their first page), the unknown span at the stored density", () => {
    // 250 stored, none proven, over 10 days; the chat began 100 days ago:
    // 90 unknown days at 25/day = 2 250 messages = 90 pages.
    const estimate = estimateItemReads({
      depth: { kind: "all" },
      anchored: false,
      belowAnchor: 0,
      facts: facts({
        storedCount: 250,
        storedNewestAt: new Date(NOW.getTime()),
        storedOldestAt: new Date(NOW.getTime() - 10 * DAY),
      }),
      now: NOW,
    });
    expect(estimate).toEqual({ readsMin: 11, readsEstimate: 101, readsMax: null });
  });

  it("all with a proven partial chain and an anchor: only what lies below, plus the empty page", () => {
    const estimate = estimateItemReads({
      depth: { kind: "all" },
      anchored: true,
      belowAnchor: 100,
      facts: facts({
        chainCount: 100,
        chainOldestAt: new Date(NOW.getTime() - 4 * DAY),
        storedCount: 150,
        storedNewestAt: new Date(NOW.getTime()),
        storedOldestAt: new Date(NOW.getTime() - 6 * DAY),
      }),
      now: NOW,
    });
    // 50 unproven = 2 pages + the end; unknown span from the oldest stored
    // (6 days) back to the start: 94 days × 25/day = 2 350 = 94 pages.
    expect(estimate).toEqual({ readsMin: 3, readsEstimate: 97, readsMax: null });
  });

  it("latest N: the bound with full pages, the estimate never above it", () => {
    const anchored = estimateItemReads({
      depth: { kind: "latest", count: 100 },
      anchored: true,
      belowAnchor: 30,
      facts: facts({ chainCount: 30, storedCount: 30, storedNewestAt: NOW, storedOldestAt: new Date(NOW.getTime() - DAY) }),
      now: NOW,
    });
    // need 70: at least 1 read; at most ⌈70/25⌉ + 1 = 4.
    expect(anchored).toEqual({ readsMin: 1, readsEstimate: 4, readsMax: 4 });
    expect(estimateItemReads({ depth: { kind: "latest", count: 30 }, anchored: true, belowAnchor: 30, facts: facts(), now: NOW }))
      .toEqual({ readsMin: 0, readsEstimate: 0, readsMax: null });
    const fresh = estimateItemReads({ depth: { kind: "latest", count: 100 }, anchored: false, belowAnchor: 0, facts: facts(), now: NOW });
    expect(fresh).toEqual({ readsMin: 1, readsEstimate: 6, readsMax: 6 });
  });

  it("reads the thread's columns: chain, stored window by snowflake, chat start by the group id", () => {
    const start = NOW.getTime() - 30 * DAY;
    expect(itemEtaFacts({
      historyState: "partial",
      historyProof: null,
      contiguousCount: 40,
      contiguousOldestAt: new Date(start + DAY),
      storedMessageCount: 50,
      newestStoredMessageId: snowflake(NOW.getTime()),
      oldestStoredMessageId: snowflake(start + DAY),
      groupId: snowflake(start),
    })).toEqual({
      complete: false,
      chainCount: 40,
      chainOldestAt: new Date(start + DAY),
      storedCount: 50,
      storedNewestAt: new Date(NOW.getTime()),
      storedOldestAt: new Date(start + DAY),
      chatStartAt: new Date(start),
    });
  });
});

/** The window's journal as `readRouteUse` returns it: sends a minute. */
function use(rows: Array<[SyncRouteUse["class"], string, number]>): BudgetUse {
  const minutes = ETA_USE_WINDOW_MS / 60_000;
  return budgetUseOf(rows.map(([workClass, operation, perMin]) => ({ class: workClass, operation, sends: perMin * minutes })), ETA_USE_WINDOW_MS);
}

const QUIET = use([]);
/** A busy page (lora-1, an ordinary hour): ≈ 90 confirmations and catch-ups
 *  an hour, the list's head and a walk ≈ 20 an hour, the media statistics at
 *  their 5/min, the money heads and the polls. */
const BUSY = use([
  ["urgent", "messages.page", 1.5],
  ["planned", "messaging.groups", 0.3],
  ["planned", "media.offer_stats", 5],
  ["urgent", "transactions.page", 1],
  ["planned", "account.stats", 0.5],
]);

function capacity(overrides: Partial<Parameters<typeof requestsCapacity>[0]> = {}): RequestsCapacity {
  return requestsCapacity({
    settingMs: 2_500,
    routePerMin: routeBudget(HISTORY_READ_ROUTE).currentPerMin,
    familyPerMin: FAMILY_BUDGETS.messaging.currentPerMin,
    use: QUIET,
    ...overrides,
  });
}

describe("the rate of the requests class (step 3b ruling 11)", () => {
  it("a history read is one /message page, paced by the messaging family", () => {
    const history = FANSLY_RESOURCE_SPECS.find((spec) => spec.key === HISTORY_WORK_RESOURCE)!;
    expect(history.operations).toEqual([HISTORY_READ_ROUTE]);
    expect(familyOfRoute(HISTORY_READ_ROUTE)).toBe("messaging");
  });

  it("a budget is shared by the cycle's turns (U 5, R 4, P 1); a class that wants less leaves the rest", () => {
    expect(CYCLE_TURNS).toEqual({ urgent: 5, requests: 4, planned: 1 });
    const rates = (urgent: number, planned: number) => ({ urgent, planned, requests: 0 });
    // Alone, and beside classes that want little: everything they leave.
    expect(keptByRequests(20, rates(0, 0))).toBe(20);
    expect(keptByRequests(20, rates(1, 2))).toBeCloseTo(17, 10);
    // Beside classes that want more than their turns: 4 of 10, 4 of 9, 4 of 5.
    expect(keptByRequests(20, rates(50, 50))).toBeCloseTo(8, 10);
    expect(keptByRequests(18, rates(50, 0))).toBeCloseTo(8, 10);
    expect(keptByRequests(20, rates(0, 50))).toBeCloseTo(16, 10);
    // A light urgent class beside a planned backlog: the urgent class takes
    // what it wants (1), the rest is shared 4 : 1 with the backlog.
    expect(keptByRequests(21, rates(1, 50))).toBeCloseTo(16, 10);
    // Urgent beyond its turns beside a light planned class.
    expect(keptByRequests(20, rates(50, 1))).toBeCloseTo(19 * 4 / 9, 10);
  });

  it("the window's journal as rates: each send on the page's slots, /message on its route, the list and a chat's detail on its family", () => {
    const rates = budgetUseOf([
      { class: "urgent", operation: "messages.page", sends: 30 },
      { class: "urgent", operation: "group.detail", sends: 15 },
      { class: "planned", operation: "messaging.groups", sends: 15 },
      { class: "planned", operation: "media.offer_stats", sends: 75 },
      { class: "requests", operation: "messages.page", sends: 150 },
    ], ETA_USE_WINDOW_MS);
    expect(rates.page).toEqual({ urgent: 3, planned: 6, requests: 10 });
    expect(rates.route).toEqual({ urgent: 2, planned: 0, requests: 10 });
    expect(rates.family).toEqual({ urgent: 3, planned: 1, requests: 10 });
    // An operation this build cannot place consumes every budget.
    expect(budgetUseOf([{ class: "planned", operation: "legacy.mystery", sends: 15 }], ETA_USE_WINDOW_MS))
      .toEqual({ page: { urgent: 0, planned: 1, requests: 0 }, route: { urgent: 0, planned: 1, requests: 0 }, family: { urgent: 0, planned: 1, requests: 0 } });
  });

  it("alone on a quiet page: the family's 15/min, 900 reads an hour — not S's 1 309", () => {
    expect(capacity()).toEqual({ perMin: 15, slotShare: 1, limitedBy: "family" });
  });

  it("a busy page: the family less the confirmations and the list, ≈ 800 reads an hour (owner decision №24)", () => {
    const busy = capacity({ use: BUSY });
    expect(busy.limitedBy).toBe("family");
    expect(busy.perMin).toBeCloseTo(15 - 1.8, 10);
    expect(busy.perMin * 60).toBeGreaterThanOrEqual(780);
    expect(busy.perMin * 60).toBeLessThanOrEqual(820);
    // The page's slots are not what limits it: S = 2.5 s gives ≈ 21.8 a
    // minute; the urgent class keeps its 2.5, the planned walks (5.8 wanted)
    // 1 of 5 of the rest, the requests class 4 of 5 — ≈ 15.5, above 13.2.
    const slots = 60_000 / 2_750;
    expect(busy.slotShare).toBeCloseTo((0.8 * (slots - 2.5)) / slots, 10);
  });

  it("a slowdown after a 429 sets the rate on its route: half of /message less the confirmations", () => {
    const slowed = capacity({ routePerMin: 7.5, use: BUSY });
    expect(slowed).toMatchObject({ limitedBy: "route" });
    expect(slowed.perMin).toBeCloseTo(7.5 - 1.5, 10);
  });

  it("a page busy with other work: the slots the cycle leaves the class — 4/10 beside urgent and planned, 4/5 beside planned alone", () => {
    const full = capacity({ use: use([["urgent", "transactions.page", 15], ["planned", "media.offer_stats", 5], ["planned", "account.stats", 15]]) });
    expect(full.limitedBy).toBe("page");
    expect(full.slotShare).toBeCloseTo(0.4, 10);
    expect(full.perMin).toBeCloseTo(0.4 * (60_000 / 2_750), 10);
    // A planned backlog alone yields 4 slots of 5: the family limits it again.
    const backlog = capacity({ use: use([["planned", "media.offer_stats", 5], ["planned", "account.stats", 15]]) });
    expect(backlog).toMatchObject({ perMin: 15, limitedBy: "family" });
    expect(backlog.slotShare).toBeCloseTo(0.8, 10);
  });

  it("what the other classes take is measured, never raised to a floor: a light use leaves the rest", () => {
    // Beside a little urgent and planned work the class keeps 98 % of the
    // slots — not the cycle's 40 %, and not a default share.
    const light = capacity({ use: use([["urgent", "transactions.page", 0.2], ["planned", "account.stats", 0.2]]) });
    expect(light.slotShare).toBeCloseTo(1 - 0.4 / (60_000 / 2_750), 10);
    // The family, used heavily by the list walk while no request competed:
    // the walk keeps its planned turn (1 of 5), the class the rest.
    const walk = capacity({ use: use([["planned", "messaging.groups", 12]]) });
    expect(walk).toMatchObject({ limitedBy: "family" });
    expect(walk.perMin).toBeCloseTo(15 - 0.2 * 15, 10);
    // A planned backlog beside a few confirmations: the confirmations keep
    // theirs, the backlog its 1 of 5 of the rest — the family limits, not 40 %.
    const backlog = capacity({ use: use([["urgent", "messages.page", 1.5], ["planned", "media.offer_stats", 5], ["planned", "account.stats", 15]]) });
    expect(backlog).toMatchObject({ limitedBy: "family" });
    expect(backlog.perMin).toBeCloseTo(13.5, 10);
  });
});

describe("the request", () => {
  it("is the sum of its fans at the class's rate, divided between k requests", () => {
    const eta = estimateRequest({
      items: [{ readsMin: 10, readsEstimate: 20, readsMax: null }, { readsMin: 5, readsEstimate: 5, readsMax: null }],
      unanchoredItems: 2,
      capacity: { perMin: 15, slotShare: 1, limitedBy: "family" },
      k: 2,
    });
    expect(eta).toMatchObject({ remainingMin: 15, remainingEstimate: 25, share: 1, limitedBy: "family", k: 2 });
    // One read of this request every 60 s × 2 / 15 = 8 s.
    expect(eta.perReadMs).toBe(8_000);
    expect(eta.etaMinMs).toBe(120_000);
    expect(eta.etaEstimateMs).toBe(200_000);
    expect(eta.firstRoundMs).toBe(16_000);
    expect(eta.ratePerHour).toBe(450);
    expect(estimateRequest({ items: [{ readsMin: 1, readsEstimate: null, readsMax: null }], unanchoredItems: 0, capacity: capacity(), k: 1 }))
      .toMatchObject({ remainingEstimate: null, etaEstimateMs: null, ratePerHour: 900 });
  });

  it("20 payers whole (≈ 180 reads) on a busy page: ≈ 13–14 min, not the 7 of S alone", () => {
    const eta = estimateRequest({ items: [{ readsMin: 180, readsEstimate: 180, readsMax: null }], unanchoredItems: 20, capacity: capacity({ use: BUSY }), k: 1 });
    expect(eta.etaEstimateMs! / 60_000).toBeGreaterThan(13);
    expect(eta.etaEstimateMs! / 60_000).toBeLessThan(14);
  });
});

describe("the ETA backtest's forecast (§7.2.4)", () => {
  it("as if only the head page were known: its own span is the density", () => {
    const start = NOW.getTime() - 50 * DAY;
    const estimate = backtestEstimate(
      { headCount: 25, headNewestMs: NOW.getTime(), headOldestMs: NOW.getTime() - 5 * DAY },
      snowflake(start),
      NOW,
    );
    // 25 messages over 5 days = 5/day; 45 unknown days = 225 = 9 pages; +1 end.
    expect(estimate).toEqual({ readsMin: 1, readsEstimate: 10, readsMax: null });
  });

  it("nearest-rank quantiles", () => {
    expect(quantiles([])).toBeNull();
    expect(quantiles([3, 1, 2, 4, 5, 6, 7, 8, 9, 10])).toEqual({ p10: 1, p50: 5, p90: 9 });
  });
});
