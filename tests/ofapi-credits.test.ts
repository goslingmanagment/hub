import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  planOfapiCreditReconciliation,
  webhookAccrualCredits,
} from "../apps/runtime/src/services/ofapi-credits.ts";
import { estimateOfapiRunway } from "../apps/runtime/src/services/ofapi-credit-report.ts";
import { resolveOfapiCreditSpend } from "../apps/runtime/src/services/ofapi.ts";

describe("resolveOfapiCreditSpend", () => {
  it("uses server-reported credits and balance when _meta is present", () => {
    expect(resolveOfapiCreditSpend({
      httpStatus: 200,
      meta: { creditsUsed: 2, creditBalance: 4000, isCached: false, rateRemainingMinute: 999 },
    })).toEqual({ credits: 2, estimated: false, balanceAfter: 4000 });
  });

  it("records cached zero-credit responses with their balance anchor", () => {
    expect(resolveOfapiCreditSpend({
      httpStatus: 200,
      meta: { creditsUsed: 0, creditBalance: 4000, isCached: true, rateRemainingMinute: 999 },
    })).toEqual({ credits: 0, estimated: false, balanceAfter: 4000 });
  });

  it("estimates the standard 1-credit charge for a 2xx without _meta", () => {
    expect(resolveOfapiCreditSpend({ httpStatus: 200, meta: null }))
      .toEqual({ credits: 1, estimated: true, balanceAfter: null });
  });

  it("writes no row for error responses without _meta", () => {
    expect(resolveOfapiCreditSpend({ httpStatus: 429, meta: null })).toBeNull();
    expect(resolveOfapiCreditSpend({ httpStatus: 500, meta: null })).toBeNull();
    expect(resolveOfapiCreditSpend({ httpStatus: 404, meta: null })).toBeNull();
  });

  it("trusts server-reported credits even on error responses", () => {
    expect(resolveOfapiCreditSpend({
      httpStatus: 500,
      meta: { creditsUsed: 1, creditBalance: 3999, isCached: null, rateRemainingMinute: null },
    })).toEqual({ credits: 1, estimated: false, balanceAfter: 3999 });
  });

  it("keeps a balance-only error response as a zero-credit anchor", () => {
    expect(resolveOfapiCreditSpend({
      httpStatus: 503,
      meta: { creditsUsed: null, creditBalance: 3999, isCached: null, rateRemainingMinute: null },
    })).toEqual({ credits: 0, estimated: true, balanceAfter: 3999 });
  });
});

describe("webhookAccrualCredits", () => {
  it("charges one credit per started batch of 100 events", () => {
    expect(webhookAccrualCredits(0)).toBe(0);
    expect(webhookAccrualCredits(1)).toBe(1);
    expect(webhookAccrualCredits(99)).toBe(1);
    expect(webhookAccrualCredits(100)).toBe(1);
    expect(webhookAccrualCredits(101)).toBe(2);
    expect(webhookAccrualCredits(250)).toBe(3);
    expect(webhookAccrualCredits(-5)).toBe(0);
  });
});

describe("estimateOfapiRunway (A2 runway forecast)", () => {
  const now = new Date("2026-07-01T12:00:00.000Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  it("divides by the full window once a full week of history exists", () => {
    const runway = estimateOfapiRunway({
      lastBalance: 10_000,
      spendInWindow: 700,
      earliestSpendAt: daysAgo(7),
      now,
    });
    expect(runway.avgDailySpend).toBe(100);
    expect(runway.daysLeft).toBe(100);
  });

  it("divides by the observed span, not 7, for a young ledger", () => {
    const runway = estimateOfapiRunway({
      lastBalance: 10_000,
      spendInWindow: 200,
      earliestSpendAt: daysAgo(2),
      now,
    });
    // Observed two days → 100/day, not 200/7 ≈ 28.6 which would 3.5× the runway.
    expect(runway.avgDailySpend).toBe(100);
    expect(runway.daysLeft).toBe(100);
  });

  it("floors the observed span at one day so a few hours of spend is not extrapolated wildly", () => {
    const runway = estimateOfapiRunway({
      lastBalance: 10_000,
      spendInWindow: 137,
      earliestSpendAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
      now,
    });
    expect(runway.avgDailySpend).toBe(137);
    expect(runway.daysLeft).toBe(Math.floor(10_000 / 137));
  });

  it("caps the observed span at the window even if a spend row predates it", () => {
    const runway = estimateOfapiRunway({
      lastBalance: 7_000,
      spendInWindow: 700,
      earliestSpendAt: daysAgo(30),
      now,
    });
    expect(runway.avgDailySpend).toBe(100); // 700 / 7, not 700 / 30
  });

  it("returns a zero rate and null runway when the window holds no spend", () => {
    const runway = estimateOfapiRunway({
      lastBalance: 10_000,
      spendInWindow: 0,
      earliestSpendAt: null,
      now,
    });
    expect(runway.avgDailySpend).toBe(0);
    expect(runway.daysLeft).toBeNull();
  });

  it("returns a null runway when the balance is unknown", () => {
    const runway = estimateOfapiRunway({
      lastBalance: null,
      spendInWindow: 200,
      earliestSpendAt: daysAgo(2),
      now,
    });
    expect(runway.avgDailySpend).toBe(100);
    expect(runway.daysLeft).toBeNull();
  });

  it("reports a shorter runway for a young ledger than the legacy divide-by-7 would", () => {
    const spendInWindow = 210;
    const lastBalance = 2_100;
    const young = estimateOfapiRunway({
      lastBalance,
      spendInWindow,
      earliestSpendAt: daysAgo(3),
      now,
    });
    const legacyAvg = Math.round((spendInWindow / 7) * 10) / 10; // 30
    expect(young.avgDailySpend).toBeGreaterThan(legacyAvg); // 70 > 30
    expect(young.daysLeft ?? Infinity).toBeLessThan(Math.floor(lastBalance / legacyAvg));
  });
});

describe("planOfapiCreditReconciliation", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 5, 11, 12, minutes));

  function sums(byWindow: Record<string, number>) {
    return async (fromIdExclusive: number, toIdInclusive: number) =>
      byWindow[`${fromIdExclusive}-${toIdInclusive}`] ?? 0;
  }

  it("turns a positive residual into an external spend row", async () => {
    const plan = await planOfapiCreditReconciliation({
      cursor: { id: 1, occurredAt: at(0), balanceAfter: 1000 },
      observations: [{ id: 5, occurredAt: at(5), balanceAfter: 900 }],
      sumKnownCredits: sums({ "1-5": 60 }),
    });

    expect(plan.adjustments).toEqual([{
      source: "external",
      credits: 40,
      occurredAt: at(5),
      details: {
        fromLedgerId: 1,
        toLedgerId: 5,
        fromOccurredAt: at(0).toISOString(),
        fromBalance: 1000,
        toBalance: 900,
        knownCredits: 60,
        webhookCreditsEstimated: 0,
      },
    }]);
    expect(plan.cursorObservation?.id).toBe(5);
    expect(plan.lastDriftCredits).toBe(40);
  });

  it("turns a balance jump into a refill row with negative credits", async () => {
    const plan = await planOfapiCreditReconciliation({
      cursor: { id: 1, occurredAt: at(0), balanceAfter: 1000 },
      observations: [{ id: 7, occurredAt: at(5), balanceAfter: 25_900 }],
      sumKnownCredits: sums({ "1-7": 100 }),
    });

    expect(plan.adjustments).toEqual([{
      source: "refill",
      credits: -25_000,
      occurredAt: at(5),
      details: {
        fromLedgerId: 1,
        toLedgerId: 7,
        fromOccurredAt: at(0).toISOString(),
        fromBalance: 1000,
        toBalance: 25_900,
        knownCredits: 100,
        webhookCreditsEstimated: 0,
      },
    }]);
    expect(plan.lastDriftCredits).toBe(-25_000);
  });

  it("clamps sub-credit residual noise but still advances the cursor", async () => {
    const plan = await planOfapiCreditReconciliation({
      cursor: { id: 1, occurredAt: at(0), balanceAfter: 1000 },
      observations: [{ id: 3, occurredAt: at(5), balanceAfter: 990 }],
      sumKnownCredits: sums({ "1-3": 10 }),
    });

    expect(plan.adjustments).toEqual([]);
    expect(plan.cursorObservation?.id).toBe(3);
    expect(plan.lastDriftCredits).toBe(0);
  });

  it("skips observations closer than the minimum gap and folds their spend into the next window", async () => {
    const plan = await planOfapiCreditReconciliation({
      cursor: { id: 1, occurredAt: at(0), balanceAfter: 1000 },
      observations: [
        // 30s after the cursor: skipped (concurrent-request reordering guard).
        { id: 2, occurredAt: new Date(at(0).getTime() + 30_000), balanceAfter: 998 },
        { id: 6, occurredAt: at(5), balanceAfter: 980 },
      ],
      sumKnownCredits: sums({ "1-6": 20 }),
    });

    expect(plan.adjustments).toEqual([]);
    expect(plan.cursorObservation?.id).toBe(6);
    expect(plan.lastDriftCredits).toBe(0);
  });

  it("walks multiple windows in one pass", async () => {
    const plan = await planOfapiCreditReconciliation({
      cursor: { id: 1, occurredAt: at(0), balanceAfter: 1000 },
      observations: [
        { id: 4, occurredAt: at(2), balanceAfter: 950 },
        { id: 9, occurredAt: at(8), balanceAfter: 900 },
      ],
      sumKnownCredits: sums({ "1-4": 10, "4-9": 50 }),
    });

    expect(plan.adjustments).toEqual([
      expect.objectContaining({ source: "external", credits: 40, occurredAt: at(2) }),
    ]);
    expect(plan.cursorObservation?.id).toBe(9);
    expect(plan.lastDriftCredits).toBe(0);
  });

  // Audit F8: a balance drop caused by webhook burn must not reconcile as an
  // `external` row — the daily accrual posts those credits later, and counting
  // both doubles the webhook component in every non-refill aggregate.
  it("treats journal-estimated webhook burn as known spend instead of external drift", async () => {
    const plan = await planOfapiCreditReconciliation({
      cursor: { id: 1, occurredAt: at(0), balanceAfter: 1000 },
      // 400 webhook events landed between the observations: the balance
      // dropped 4 credits beyond the ledger-known REST spend.
      observations: [{ id: 5, occurredAt: at(10), balanceAfter: 936 }],
      sumKnownCredits: sums({ "1-5": 60 }),
      estimateWebhookCreditsBetween: async () => 4,
    });

    expect(plan.adjustments).toEqual([]);
    expect(plan.cursorObservation?.id).toBe(5);
    expect(plan.lastDriftCredits).toBe(0);
  });

  it("still surfaces genuinely external drift beyond the webhook estimate", async () => {
    const plan = await planOfapiCreditReconciliation({
      cursor: { id: 1, occurredAt: at(0), balanceAfter: 1000 },
      // 4 webhook credits + 60 REST credits explain 64 of the 100-credit drop.
      observations: [{ id: 5, occurredAt: at(10), balanceAfter: 900 }],
      sumKnownCredits: sums({ "1-5": 60 }),
      estimateWebhookCreditsBetween: async () => 4,
    });

    expect(plan.adjustments).toEqual([
      expect.objectContaining({
        source: "external",
        credits: 36,
        details: expect.objectContaining({ knownCredits: 64, webhookCreditsEstimated: 4 }),
      }),
    ]);
  });

  it("keeps fractional webhook estimates inside the noise tolerance", async () => {
    const plan = await planOfapiCreditReconciliation({
      cursor: { id: 1, occurredAt: at(0), balanceAfter: 1000 },
      // 70 events ≈ 0.7 credits estimated, 1 credit actually charged (started
      // batch): the 0.3 residual is noise, not external spend.
      observations: [{ id: 5, occurredAt: at(10), balanceAfter: 989 }],
      sumKnownCredits: sums({ "1-5": 10 }),
      estimateWebhookCreditsBetween: async () => 0.7,
    });

    expect(plan.adjustments).toEqual([]);
    expect(plan.lastDriftCredits).toBeCloseTo(0.3);
  });
});

describe("OFAPI single-gate invariant (D1)", () => {
  // Every OFAPI HTTP call must live in services/ofapi.ts so the client's
  // onCreditSpend sink sees all spend. The env-schema default in config.ts is
  // the only other place the host may appear. config-registry.ts references the
  // OFAPI_BASE_URL env-var NAME as descriptor metadata only — it deliberately does
  // not contain the host literal, so the spend-tap host stays pinned to the two
  // files above.
  const ALLOWED_FILES = new Set([
    "apps/runtime/src/services/ofapi.ts",
    "packages/shared/src/config.ts",
    "packages/shared/src/config-registry.ts",
  ]);

  it("keeps OFAPI_BASE_URL / app.onlyfansapi.com references inside the client and config", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const roots = ["apps", "packages"].map((dir) => path.join(repoRoot, dir));
    const offenders: string[] = [];

    const visit = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (["node_modules", "dist", "generated", ".turbo"].includes(entry)) {
          continue;
        }
        const fullPath = path.join(dir, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          visit(fullPath);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) {
          continue;
        }
        const relativePath = path.relative(repoRoot, fullPath);
        if (ALLOWED_FILES.has(relativePath)) {
          continue;
        }
        const content = readFileSync(fullPath, "utf8");
        if (content.includes("app.onlyfansapi.com") || content.includes("OFAPI_BASE_URL")) {
          offenders.push(relativePath);
        }
      }
    };

    for (const root of roots) {
      visit(root);
    }

    expect(offenders).toEqual([]);
  });
});
