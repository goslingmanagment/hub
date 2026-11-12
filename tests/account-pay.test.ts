import { describe, expect, it } from "vitest";

import { ownPayOf } from "../apps/runtime/src/services/ledger-person-pay.ts";

// «Мои деньги»: the block's sums are the sums of what the screen shows, each day to the ledger's cent (`payMillsOf`).
// Invented amounts.

const day = (date: string, amountMicros: number, paidMicros = 0) => ({
  date, model: "Mia", amountMicros, worked: true, source: "reports", posts: [], state: paidMicros > 0 ? "paid" : "to_pay",
  paidMicros, unpaidMicros: amountMicros - paidMicros, paidBy: [],
});

const ledger = {
  person: "alex", name: "Alex", from: "2026-11-07", to: "2026-11-14", accrualFrom: "2026-09-01", factsFrom: "", reportsFrom: "2026-11-09",
  generatedAt: "2026-11-12T10:00:00Z", accruedMicros: 0, paidMicros: 0, balanceMicros: 20_025_000, oldestUnpaidDate: "2026-11-10",
  lastPayout: { date: "2026-11-09", document: 1, amountMicros: 5_005_000 },
  days: [
    // The day before the window: its money is not the window's.
    day("2026-11-07", 3_000_000),
    // Half a cent each: $10.005 → $10.00 and $10.025 → $10.02, half to even, as the rows show them.
    day("2026-11-10", 10_005_000),
    day("2026-11-11", 6_000_000),
    day("2026-11-11", 4_025_000),
  ],
  adjustments: [],
  payouts: [{ date: "2026-11-09", document: 1, amountMicros: 5_005_000 }, { date: "2026-11-12", document: 2, amountMicros: 5_015_000 }],
  checks: { stale: false, lastRebuildAt: "2026-11-12T09:30:00Z" },
};

describe("«Мои деньги»: totals of the rows shown", () => {
  it("adds up the window's days as each row shows it, never a cent apart from the rows", () => {
    const pay = ownPayOf(ledger, { from: "2026-11-08", to: "2026-11-14" });
    expect(pay.days.map((one) => [one.date, one.amountMills])).toEqual([["2026-11-07", 3_000], ["2026-11-10", 10_000], ["2026-11-11", 10_020]]);
    // The micro-dollars added up first would round once to $20.03; the rows read $10.00 + $10.02.
    expect(pay.accruedMills).toBe(20_020);
    // Each payout to its cent, then added: $5.00 + $5.02.
    expect(pay.paidMills).toBe(10_020);
  });
});
