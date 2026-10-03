// WP-F7 — the payout walk's pure helpers. No database: the form, paging,
// coverage and physical-attempt invariants that need one stay in
// fansly-payouts-lane.integration.test.ts.

import { describe, expect, it } from "vitest";

import { walkContinuationAt } from "../apps/runtime/src/services/sync/fansly-payouts.ts";
import {
  oldestCreatedAtMs,
  parseFanslyPayoutsCursorState,
  payoutHeadGap,
  payoutRequestRows,
  payoutRequestTotal,
  payoutWalkStopAt,
  settleWalkStop,
} from "../apps/runtime/src/sync/fansly/lib/payouts-rules.ts";
import {
  LIVE_TOTAL,
  NOW,
  OLDEST_MS,
  requestPage,
  stableRequestPage,
} from "./helpers/fansly-payouts-fixtures.ts";

describe("WP-F7 payout walk helpers", () => {
  it("reads rows and `total` out of the wire shape, and refuses anything else", () => {
    const page = requestPage(0);
    expect(payoutRequestRows(page)).toHaveLength(10);
    expect(payoutRequestTotal(page)).toBe(LIVE_TOTAL);
    // A drifted body is EMPTY here, and the shape gate refuses to parse it at
    // all — the two together are what stop a truncated response from reading as
    // "the history ends here".
    expect(payoutRequestRows({ total: 83 })).toEqual([]);
    expect(payoutRequestRows(null)).toEqual([]);
    expect(payoutRequestTotal({ data: [] })).toBeNull();
  });

  it("takes the FLOOR as the oldest instant on the page, ignoring junk", () => {
    expect(oldestCreatedAtMs(requestPage(80).data)).toBe(OLDEST_MS);
    expect(oldestCreatedAtMs([{ createdAt: 0 }, { createdAt: -1 }, { createdAt: "x" }]))
      .toBeNull();
    expect(oldestCreatedAtMs([])).toBeNull();
  });

  it("names a short page that contradicts its own `total`", () => {
    expect(payoutWalkStopAt({ offset: 10, rowCount: 4, total: 900 })).toBe("short_before_total");
    expect(payoutWalkStopAt({ offset: 80, rowCount: 3, total: 83 })).toBe("exhausted");
    expect(payoutWalkStopAt({ offset: 10, rowCount: 4, total: null })).toBe("exhausted");
    // A FULL page that reached `total` is the end, not a contradiction.
    expect(payoutWalkStopAt({ offset: 80, rowCount: 10, total: 83 })).toBe("exhausted");
  });

  it("never lets a later stop upgrade a partial one", () => {
    expect(settleWalkStop(null, "short_before_total")).toBe("short_before_total");
    expect(settleWalkStop("exhausted", "repeat_request")).toBe("repeat_request");
    expect(settleWalkStop("page_cap", "exhausted")).toBe("page_cap");
    expect(settleWalkStop("short_before_total", "exhausted")).toBe("short_before_total");
  });

  it("sees a head gap only on a FULL head that shares nothing with the last one", () => {
    const yesterday = stableRequestPage(0, LIVE_TOTAL).data.map((row) => row.id);
    const gap = (total: number, previousTotal: number | null = LIVE_TOTAL, refs = yesterday) =>
      payoutHeadGap({
        previousHeadRefs: refs,
        previousTotal,
        headRows: stableRequestPage(0, total).data,
        total,
      });
    expect(gap(LIVE_TOTAL + 9)).toBeNull();
    expect(gap(LIVE_TOTAL + 10)).toEqual({ stopRefs: yesterday, untilOffset: null });
    // Without refs, `total` has to grow by MORE than a head page.
    expect(gap(LIVE_TOTAL + 10, LIVE_TOTAL, [])).toBeNull();
    expect(gap(LIVE_TOTAL + 11, LIVE_TOTAL, [])).toEqual({ stopRefs: null, untilOffset: 11 });
    expect(gap(LIVE_TOTAL + 11, null, [])).toBeNull();
    // A short head holds every payout there is.
    expect(payoutHeadGap({
      previousHeadRefs: ["x"],
      previousTotal: 0,
      headRows: stableRequestPage(0, 4).data,
      total: 4,
    })).toBeNull();
  });

  it("reads a cursor saved before the stop was kept as an exhausted walk", () => {
    const legacy = parseFanslyPayoutsCursorState({
      version: 1,
      utcDay: "2026-08-22",
      walkOffset: 90,
      walkPages: 9,
      walkTotal: 83,
      walkDone: true,
    });
    expect(legacy?.walkStop).toBe("exhausted");
    expect(legacy?.headRefs).toEqual([]);
    expect(legacy?.catchUp).toBeNull();
    const open = parseFanslyPayoutsCursorState({ version: 1, utcDay: "2026-08-22", walkDone: false });
    expect(open?.walkStop).toBeNull();
  });

  it("spaces a walk continuation with jitter, never contiguously", () => {
    // Burst SHAPE is the ban-risk surface, not daily volume.
    expect(walkContinuationAt(NOW, 20_000, () => 0).getTime() - NOW.getTime()).toBe(14_000);
    expect(walkContinuationAt(NOW, 20_000, () => 1).getTime() - NOW.getTime()).toBe(26_000);
    expect(walkContinuationAt(NOW, 0, () => 0.5).getTime()).toBe(NOW.getTime());
  });
});
