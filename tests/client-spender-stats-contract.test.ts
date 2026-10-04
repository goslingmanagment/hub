import { describe, expect, it } from "vitest";

import * as contracts from "@agency_hub_core/contracts";
import {
  CLIENT_COVERAGE_LEVELS,
  CLIENT_HUB_CAPABILITY_NAMES,
  CLIENT_SPENDER_STATS_COVERAGE_REASONS,
  CLIENT_SPENDER_STATS_REFUSAL_REASONS,
  CLIENT_SPENDER_STATS_REMAINDER_TIER_KEYS,
  CLIENT_SPENDER_STATS_WINDOW_DAYS,
  CLIENT_TOKEN_PROFILES,
  clientSpenderStatsQuerySchema,
  clientSpenderStatsResponseSchema,
  routeSchemas,
} from "@agency_hub_core/contracts";
import type { PageSpenderStats } from "@agency_hub_core/db";
import {
  SPENDER_AUTO_LIST_BUCKETS,
  SPENDER_STATS_BASIS,
  SPENDER_STATS_COVERAGE_REASONS,
  SPENDER_STATS_COVERAGE_STATES,
  SPENDER_STATS_MONEY_UNIT,
  SPENDER_STATS_SUPPORTED_WINDOW_DAYS,
  SPENDER_STATS_UNATTRIBUTED_KEY,
  SPENDER_STATS_UNTIERED_KEY,
  assembleSpenderStatsTiers,
  normalizeSpenderStatsTimeZone,
} from "@agency_hub_core/shared";

import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { evaluateClientFeature } from "../apps/runtime/src/services/client-features.ts";
import { toClientSpenderStats } from "../apps/runtime/src/services/spender-stats.ts";
import * as sdk from "../packages/sdk/src/index.ts";
import { kernelOperations } from "../packages/sdk/src/operations.ts";
import {
  FROZEN_CLIENT_TIME_ZONE_PATTERN,
  frozenClientSpenderStatsSchema,
} from "./helpers/client-frozen-spender-stats.ts";

// chat-extension H-8b: the wire shape of the Spenders statistics
// (`clientSpenderStats`). The chat extension froze this route in its contracts
// (packages/contracts/src/hub/spenders.ts: StatsQuerySchema, SpendersStatsSchema)
// before the hub shipped it, so the samples below are the client's own, and the
// hub must take every query the client can build and answer in a body the
// client parses. The behavior is tests/client-spender-stats-route.integration.test.ts.

const moneyWindow = {
  grossMills: 125_000,
  purchasesGrossMills: 130_000,
  adjustmentsMills: -5_000,
  creatorNetMills: 100_000,
  purchaseCount: 4,
  payerCount: 2,
};

/** The client's fixture of a valid answer (its packages/contracts/test/fixtures/hub.ts). */
function clientSample(): Record<string, unknown> {
  return {
    pageLabel: "lora-of",
    metricVersion: 1,
    moneyUnit: "USD-mills",
    basis: "gross",
    timeZone: "Europe/Moscow",
    from: "2026-09-04",
    to: "2026-10-03",
    asOf: "2026-10-03T12:00:00.000Z",
    projectionAsOf: "2026-10-03T12:00:00.000Z",
    includedStates: ["posted", "pending", "unknown"],
    coverage: { state: "complete", reasons: [] },
    days: [{
      date: "2026-10-03",
      grossMills: 25_000,
      purchasesGrossMills: 25_000,
      adjustmentsMills: 0,
      creatorNetMills: 20_000,
      purchaseCount: 1,
      byState: { posted: 25_000 },
    }],
    totals: { today: moneyWindow, d7: moneyWindow, prev7: { ...moneyWindow, grossMills: 0 }, d30: moneyWindow, d7DeltaPct: null },
    avgCheckMills: 32_500,
    tiers: [{ key: "0-25", label: "$0–25", minMills: 10, maxMills: 25_000, members: 2, windowPayers: 1, windowGrossMills: 25_000 }],
    silence: {
      d8to21: { fans: 1, lifetimeGrossMills: 50_000 },
      over21: { fans: 0, lifetimeGrossMills: 0 },
      unknown: { fans: 0, lifetimeGrossMills: 0 },
    },
    newPayers: { count: 1, firstPurchaseKnown: true },
    queueSummary: { total: 3, unknown: 1 },
  };
}

const zeroWindow = {
  grossMills: 0n, purchasesGrossMills: 0n, adjustmentsMills: 0n, creatorNetMills: 0n, purchaseCount: 0, payerCount: 0,
};

/** A repository answer with every kind of value the wire carries: a refund day, nulls, both remainders. */
function repositoryAnswer(): PageSpenderStats {
  const d30 = {
    grossMills: 9_007_199_254_740_000n,
    purchasesGrossMills: 9_007_199_254_740_900n,
    adjustmentsMills: -900n,
    creatorNetMills: 7_205_759_403_792_000n,
    purchaseCount: 8,
    payerCount: 6,
  };
  return {
    pageId: 7,
    metricVersion: 1,
    messageSource: "union",
    timeZone: "America/Argentina/Buenos_Aires",
    asOf: new Date("2026-10-03T12:00:00.000Z"),
    from: "2026-09-04",
    to: "2026-10-03",
    projectionAsOf: null,
    includedStates: ["pending", "posted", "unknown"],
    coverage: { state: "partial", reasons: ["projection_missing", "messages_missing"] },
    days: [{
      date: "2026-09-30",
      grossMills: -1_000n,
      purchasesGrossMills: 2_000n,
      adjustmentsMills: -3_000n,
      creatorNetMills: -800n,
      purchaseCount: 1,
      byState: { posted: -3_000n, pending: 2_000n, unknown: 0n },
    }],
    totals: { today: zeroWindow, d7: d30, prev7: zeroWindow, d30, d7DeltaPct: null },
    avgCheckMills: null,
    tiers: assembleSpenderStatsTiers({
      byTierKey: new Map([["600-plus", { members: 1, windowPayers: 1, windowGrossMills: 10_000n }]]),
      untiered: { members: 2, windowPayers: 2, windowGrossMills: 3_000n },
      unattributedGrossMills: -4_000n,
    }),
    silence: {
      d8to21: { fans: 2, lifetimeGrossMills: 712_000n },
      over21: { fans: 1, lifetimeGrossMills: 197_000n },
      unknown: { fans: 1, lifetimeGrossMills: 1_000n },
    },
    newPayers: { count: 4, firstPurchaseKnown: false },
    queueSummary: { total: 3, unknown: 1 },
  };
}

describe("client Spenders statistics contract (H-8b)", () => {
  it("parses the client's own samples: complete, and partial with a reason it does not know", () => {
    expect(clientSpenderStatsResponseSchema.parse(clientSample())).toEqual(clientSample());
    const partial = { ...clientSample(), coverage: { state: "partial", reasons: ["history_unknown"] }, avgCheckMills: null };
    expect(clientSpenderStatsResponseSchema.parse(partial)).toEqual(partial);
  });

  it("keeps coverage, its reasons, the states and the tier keys open: an unknown one never fails the parse", () => {
    const body = {
      ...clientSample(),
      includedStates: ["posted", "some_future_state"],
      coverage: { state: "some_future_state", reasons: ["some_future_reason"] },
      days: [{ ...(clientSample().days as Array<Record<string, unknown>>)[0], byState: { some_future_state: 1 } }],
      tiers: [{ key: "some-future-tier", label: "", minMills: null, maxMills: null, members: 0, windowPayers: 0, windowGrossMills: 0 }],
    };
    expect(clientSpenderStatsResponseSchema.parse(body)).toEqual(body);
  });

  it("strips a key it does not know instead of refusing the answer", () => {
    const parsed = clientSpenderStatsResponseSchema.parse({ ...clientSample(), futureMetric: 1 });
    expect(parsed).not.toHaveProperty("futureMetric");
  });

  it("states the unit and the basis as constants, and takes money only as whole, signed mills", () => {
    expect(clientSpenderStatsResponseSchema.safeParse({ ...clientSample(), moneyUnit: "USD" }).success).toBe(false);
    expect(clientSpenderStatsResponseSchema.safeParse({ ...clientSample(), basis: "net" }).success).toBe(false);
    expect(SPENDER_STATS_MONEY_UNIT).toBe("USD-mills");
    expect(SPENDER_STATS_BASIS).toBe("gross");
    const withGross = (grossMills: unknown) => ({
      ...clientSample(),
      totals: { ...(clientSample().totals as Record<string, unknown>), d30: { ...moneyWindow, grossMills } },
    });
    // A refund-heavy window is negative; a fraction of a mill or dollars as text are not money.
    expect(clientSpenderStatsResponseSchema.safeParse(withGross(-5_000)).success).toBe(true);
    for (const grossMills of [1.5, "125000", null]) {
      expect(clientSpenderStatsResponseSchema.safeParse(withGross(grossMills)).success, String(grossMills)).toBe(false);
    }
    // A count is never negative.
    expect(clientSpenderStatsResponseSchema.safeParse({
      ...clientSample(), queueSummary: { total: -1, unknown: 0 },
    }).success).toBe(false);
  });

  it("serializes a repository answer into a body both the hub's and the client's schema take", () => {
    const body = toClientSpenderStats("lora-of", repositoryAnswer());

    expect(clientSpenderStatsResponseSchema.parse(body)).toEqual(body);
    expect(frozenClientSpenderStatsSchema.parse(body)).toEqual(body);
    // What silence was read from is the hub's business, not a wire field.
    expect(body).not.toHaveProperty("messageSource");
    expect(body).not.toHaveProperty("pageId");
    expect(body).toMatchObject({
      pageLabel: "lora-of",
      metricVersion: 1,
      moneyUnit: "USD-mills",
      basis: "gross",
      timeZone: "America/Argentina/Buenos_Aires",
      asOf: "2026-10-03T12:00:00.000Z",
      // Never rebuilt is null, not the epoch.
      projectionAsOf: null,
      coverage: { state: "partial", reasons: ["projection_missing", "messages_missing"] },
      avgCheckMills: null,
      newPayers: { count: 4, firstPurchaseKnown: false },
      queueSummary: { total: 3, unknown: 1 },
    });
    // Mills cross as exact integers up to the safe range, signs kept.
    expect(body.totals.d30).toEqual({
      grossMills: 9_007_199_254_740_000,
      purchasesGrossMills: 9_007_199_254_740_900,
      adjustmentsMills: -900,
      creatorNetMills: 7_205_759_403_792_000,
      purchaseCount: 8,
      payerCount: 6,
    });
    expect(Number.isSafeInteger(body.totals.d30.grossMills)).toBe(true);
    expect(body.totals.d7DeltaPct).toBeNull();
    expect(body.days[0]).toEqual({
      date: "2026-09-30",
      grossMills: -1_000,
      purchasesGrossMills: 2_000,
      adjustmentsMills: -3_000,
      creatorNetMills: -800,
      purchaseCount: 1,
      byState: { posted: -3_000, pending: 2_000, unknown: 0 },
    });
    // The hub's buckets in their order with their bounds, then the two remainders without any.
    expect(body.tiers.map((tier) => [tier.key, tier.minMills, tier.maxMills])).toEqual([
      ...SPENDER_AUTO_LIST_BUCKETS.map((bucket) => [
        bucket.key,
        Number(bucket.minAmountMills),
        bucket.maxAmountMillsExclusive === null ? null : Number(bucket.maxAmountMillsExclusive),
      ]),
      ["untiered", null, null],
      ["unattributed", null, null],
    ]);
    expect(body.tiers.at(-1)).toMatchObject({ members: 0, windowPayers: 0, windowGrossMills: -4_000 });
  });

  it("takes the one query the client builds: 30 days and an IANA zone", () => {
    // Query strings arrive as text.
    expect(clientSpenderStatsQuerySchema.parse({ windowDays: "30", timeZone: "Europe/Moscow" }))
      .toEqual({ windowDays: 30, timeZone: "Europe/Moscow" });
    expect(clientSpenderStatsQuerySchema.parse({ timeZone: "America/Argentina/Buenos_Aires" }))
      .toEqual({ windowDays: 30, timeZone: "America/Argentina/Buenos_Aires" });
    expect(CLIENT_SPENDER_STATS_WINDOW_DAYS).toBe(30);
    // The contract's window is the one the definitions serve.
    expect(SPENDER_STATS_SUPPORTED_WINDOW_DAYS).toEqual([CLIENT_SPENDER_STATS_WINDOW_DAYS]);
  });

  it("refuses a query that is not that: another window, no zone, an unknown key", () => {
    const refused: Array<Record<string, unknown>> = [
      {},
      { windowDays: "30" },
      { windowDays: "7", timeZone: "UTC" },
      { windowDays: "31", timeZone: "UTC" },
      { windowDays: "30.5", timeZone: "UTC" },
      { windowDays: "thirty", timeZone: "UTC" },
      { timeZone: "" },
      { timeZone: "x".repeat(65) },
      // The page is in the path. A page in the query would not be scope-checked,
      // so the strict query refuses it instead of ignoring it.
      { timeZone: "UTC", pageLabel: "lora-of" },
      { timeZone: "UTC", asOf: "2026-10-03T12:00:00.000Z" },
    ];
    for (const query of refused) {
      expect(clientSpenderStatsQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it("answers every zone name the client's own schema lets through with a zone or a refusal, never a throw", () => {
    const names = [
      "UTC", "Europe/Moscow", "America/Argentina/Buenos_Aires", "Etc/GMT+3", "Europe/Kiev", "Asia/Calcutta",
      "US/Pacific", "CET", "EST5EDT", "europe/moscow", "Mars/Olympus", "Moscow", "GMT+3", "UTC+3", "Factory",
      "localtime", "posixrules", "A/B/C", "x".repeat(64),
    ];
    for (const name of names) {
      expect(FROZEN_CLIENT_TIME_ZONE_PATTERN.test(name), name).toBe(true);
      expect(clientSpenderStatsQuerySchema.safeParse({ timeZone: name }).success, name).toBe(true);
      const zone = normalizeSpenderStatsTimeZone(name);
      expect(zone === null || typeof zone === "string", name).toBe(true);
    }
    expect(normalizeSpenderStatsTimeZone("Mars/Olympus")).toBeNull();
    // Known to Intl, though the hub's Postgres has no such zone (no tzdata-legacy).
    expect(normalizeSpenderStatsTimeZone("Europe/Kiev")).toBe("Europe/Kiev");
  });

  it("declares the route as a page-scoped device-token GET with the page in the path", () => {
    const route = routeSchemas.clientSpenderStats as {
      auth: { kind: string; scope?: string };
      tags: readonly string[];
      body?: unknown;
      querystring?: unknown;
      params?: { safeParse(value: unknown): { success: boolean } };
      response: Record<number, unknown>;
    };
    expect(route.auth).toEqual({ kind: "apiKey", scope: "page" });
    expect(route.tags).toEqual(["client"]);
    expect(route.body).toBeUndefined();
    expect(route.querystring).toBe(clientSpenderStatsQuerySchema);
    expect(route.params?.safeParse({ pageLabel: "lora-of" }).success).toBe(true);
    expect(Object.keys(route.response).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    expect(kernelOperations.clientSpenderStats).toEqual({
      method: "GET",
      path: "/api/v1/client/pages/:pageLabel/spenders/stats",
    });
  });

  it("is on the narrow token's list and served as spenders-stats-v1; the stats feature still waits for the queue", () => {
    expect(CLIENT_TOKEN_PROFILES["chat-extension"].operations).toContain("clientSpenderStats");
    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain("spenders-stats-v1");
    expect(SERVED_CLIENT_CAPABILITIES).toContain("spenders-stats-v1");

    // As merged: `stats` also needs `awaiting-reply-v1` (H-8c), so the owner's
    // switch alone does not open the route. H-8c flips the first half.
    const page = { label: "lora-of", platform: "onlyfans" as const, platformAccountId: "100000001" };
    const settings = { enabled: true, features: { "*": { stats: true } }, hostBindings: {} };
    expect(SERVED_CLIENT_CAPABILITIES).not.toContain("awaiting-reply-v1");
    expect(evaluateClientFeature({ settings, page, flag: "stats", served: SERVED_CLIENT_CAPABILITIES }))
      .toEqual({ available: false, reason: "hub_not_ready" });
    expect(evaluateClientFeature({
      settings, page, flag: "stats", served: [...SERVED_CLIENT_CAPABILITIES, "awaiting-reply-v1"],
    })).toEqual({ available: true });
  });

  it("re-exports the known values from the generated SDK, equal to the definitions the numbers follow", () => {
    for (const name of [
      "CLIENT_SPENDER_STATS_COVERAGE_REASONS",
      "CLIENT_SPENDER_STATS_REFUSAL_REASONS",
      "CLIENT_SPENDER_STATS_REMAINDER_TIER_KEYS",
      "CLIENT_SPENDER_STATS_WINDOW_DAYS",
    ] as const) {
      expect(sdk[name], name).toBeDefined();
      expect(sdk[name], name).toBe(contracts[name]);
    }
    // The contract cannot import the definitions (they are not vendored into the
    // client SDK), so it restates their vocabularies; this holds the two together.
    expect(CLIENT_SPENDER_STATS_COVERAGE_REASONS).toEqual([...SPENDER_STATS_COVERAGE_REASONS]);
    expect(CLIENT_COVERAGE_LEVELS).toEqual([...SPENDER_STATS_COVERAGE_STATES]);
    expect(CLIENT_SPENDER_STATS_REMAINDER_TIER_KEYS).toEqual([SPENDER_STATS_UNTIERED_KEY, SPENDER_STATS_UNATTRIBUTED_KEY]);
    expect(CLIENT_SPENDER_STATS_REFUSAL_REASONS).toEqual(["unknown_time_zone"]);
  });
});
