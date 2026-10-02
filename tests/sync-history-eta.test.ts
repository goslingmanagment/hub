import { describe, expect, it } from "vitest";

import { backtestEstimate, quantiles } from "../apps/runtime/src/sync/requests/eta-backtest.ts";
import {
  estimateItemReads,
  estimateRequest,
  itemEtaFacts,
  requestsClassShare,
  type ItemEtaFacts,
} from "../apps/runtime/src/sync/requests/eta.ts";

// The ETA of a history request (plan §4.3, design §7.2) with fixed inputs:
// thread columns only, two numbers (a lower bound and an estimate), the
// class share and the round robin between requests.

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

describe("the request", () => {
  it("is the sum of its fans at S × 1.1, divided between k requests and the class share", () => {
    const eta = estimateRequest({
      items: [{ readsMin: 10, readsEstimate: 20, readsMax: null }, { readsMin: 5, readsEstimate: 5, readsMax: null }],
      unanchoredItems: 2,
      settingMs: 2_000,
      share: 0.8,
      k: 2,
    });
    expect(eta).toMatchObject({ remainingMin: 15, remainingEstimate: 25, meanPauseMs: 2_200, share: 0.8, k: 2 });
    // One read of this request every 2.2 s × 2 / 0.8 = 5.5 s.
    expect(eta.etaMinMs).toBe(82_500);
    expect(eta.etaEstimateMs).toBe(137_500);
    expect(eta.firstRoundMs).toBe(11_000);
    expect(eta.ratePerHour).toBeCloseTo(654.5, 1);
    expect(estimateRequest({ items: [{ readsMin: 1, readsEstimate: null, readsMax: null }], unanchoredItems: 0, settingMs: 2_000, share: 1, k: 1 }))
      .toMatchObject({ remainingEstimate: null, etaEstimateMs: null });
  });

  it("the class share: 1 alone, 0.8 below 20 sends, the observed share never below the guaranteed 40 %", () => {
    expect(requestsClassShare({ sends: { urgent: 50, requests: 0, planned: 50 }, otherClassesRunnable: false })).toBe(1);
    expect(requestsClassShare({ sends: { urgent: 5, requests: 5, planned: 5 }, otherClassesRunnable: true })).toBe(0.8);
    expect(requestsClassShare({ sends: { urgent: 10, requests: 80, planned: 10 }, otherClassesRunnable: true })).toBe(0.8);
    expect(requestsClassShare({ sends: { urgent: 80, requests: 10, planned: 10 }, otherClassesRunnable: true })).toBe(0.4);
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
