import { describe, expect, it } from "vitest";

import * as contracts from "@agency_hub_core/contracts";
import {
  CLIENT_AI_USAGE_COVERAGE,
  CLIENT_AI_USAGE_COVERAGE_REASONS,
  CLIENT_AI_USAGE_MAX_AGE_DAYS,
  CLIENT_AI_USAGE_MAX_DAYS,
  CLIENT_AI_USAGE_REFUSAL_REASONS,
  CLIENT_HUB_CAPABILITY_NAMES,
  CLIENT_TOKEN_PROFILES,
  clientAiUsageQuerySchema,
  clientAiUsageResponseSchema,
  routeSchemas,
} from "@agency_hub_core/contracts";

import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import * as sdk from "../packages/sdk/src/index.ts";
import { kernelOperations } from "../packages/sdk/src/operations.ts";

// chat-extension H-15: the wire shape of the caller's own AI spend
// (`clientAiUsageDaily`). The chat extension froze this route in its contracts
// (packages/contracts/src/hub/usage.ts: AiUsageQuerySchema, AiUsageReportSchema)
// before the hub shipped it, so the samples below are the client's own, and the
// hub must take every query the client can build and answer in a body the
// client parses. The behavior is tests/client-ai-usage.integration.test.ts.

const totals = {
  requestCount: 12,
  costMicroUsd: 34_500,
  costApproximate: false,
  tokens: { input: 9000, output: 800, cacheWrite: 0, cacheRead: 4000 },
  completed: 11,
  failed: 1,
  cancelled: 0,
  quotaDenied: 0,
  openReservations: 0,
  regenerations: 2,
};

/** The client's fixture of a valid answer (its packages/contracts/test/fixtures/hub.ts). */
function clientSample(): Record<string, unknown> {
  return {
    scope: { pageLabel: "lora-of", userId: 7 },
    timeZone: "Europe/Moscow",
    asOf: "2026-10-03T12:00:00.000Z",
    moneyUnit: "micro-USD",
    days: [{
      date: "2026-10-03",
      from: "2026-10-02T21:00:00Z",
      toExclusive: "2026-10-03T21:00:00Z",
      coverage: "partial",
      coverageReasons: ["day_open"],
      totals,
      features: [{ ...totals, feature: "fast-reply" }],
    }],
    quota: { dayBoundary: "UTC", remainingRequestsToday: 100, remainingMicroUsdToday: null },
  };
}

describe("client AI usage contract (H-15)", () => {
  it("parses the client's own samples: a quota, no quota, an unknown remaining amount", () => {
    expect(clientAiUsageResponseSchema.parse(clientSample())).toEqual(clientSample());
    expect(clientAiUsageResponseSchema.parse({ ...clientSample(), quota: null }).quota).toBeNull();
  });

  it("keeps coverage, its reasons and the feature open: an unknown one never fails the parse", () => {
    const body = clientSample();
    body.days = [{
      ...(body.days as Array<Record<string, unknown>>)[0],
      coverage: "some_future_coverage",
      coverageReasons: ["day_open", "some_future_reason"],
      features: [{ ...totals, feature: "some-future-feature" }],
    }];
    const parsed = clientAiUsageResponseSchema.parse(body);
    expect(parsed.days[0]!.coverage).toBe("some_future_coverage");
    expect(parsed.days[0]!.coverageReasons).toEqual(["day_open", "some_future_reason"]);
    expect(parsed.days[0]!.features[0]!.feature).toBe("some-future-feature");
  });

  it("strips a key it does not know instead of refusing the answer", () => {
    const parsed = clientAiUsageResponseSchema.parse({ ...clientSample(), someFutureField: { x: 1 } });
    expect(parsed).not.toHaveProperty("someFutureField");
  });

  it("states both units and boundaries as constants: micro-USD money, a UTC quota day", () => {
    expect(clientAiUsageResponseSchema.safeParse({ ...clientSample(), moneyUnit: "USD-mills" }).success).toBe(false);
    expect(clientAiUsageResponseSchema.safeParse({
      ...clientSample(),
      quota: { dayBoundary: "Europe/Moscow", remainingRequestsToday: 1, remainingMicroUsdToday: 1 },
    }).success).toBe(false);
    // Money is whole micro-USD, never a fraction and never negative.
    for (const costMicroUsd of [1.5, -1]) {
      const body = clientSample();
      body.days = [{ ...(body.days as Array<Record<string, unknown>>)[0], totals: { ...totals, costMicroUsd } }];
      expect(clientAiUsageResponseSchema.safeParse(body).success, String(costMicroUsd)).toBe(false);
    }
  });

  it("takes every query the client can build: a date, optionally 1 to 7 days and a zone", () => {
    // Query strings arrive as text; the defaults are one day in the cabinet's zone.
    expect(clientAiUsageQuerySchema.parse({ date: "2026-10-03" }))
      .toEqual({ date: "2026-10-03", days: 1, timeZone: "Europe/Moscow" });
    expect(clientAiUsageQuerySchema.parse({ date: "2026-10-03", days: "7", timeZone: "America/Argentina/Buenos_Aires" }))
      .toEqual({ date: "2026-10-03", days: 7, timeZone: "America/Argentina/Buenos_Aires" });
    for (const days of ["1", "2", "3", "4", "5", "6", "7"]) {
      expect(clientAiUsageQuerySchema.safeParse({ date: "2026-10-03", days }).success, days).toBe(true);
    }
    expect(CLIENT_AI_USAGE_MAX_DAYS).toBe(7);
    expect(CLIENT_AI_USAGE_MAX_AGE_DAYS).toBe(8);
  });

  it("refuses a query that is not that: no date, a date that is no calendar day, 0 or 8 days, an unknown key", () => {
    const refused: Array<Record<string, unknown>> = [
      {},
      { date: "2026-02-30" },
      { date: "03.10.2026" },
      { date: "2026-10-03", days: "0" },
      { date: "2026-10-03", days: "8" },
      { date: "2026-10-03", days: "1.5" },
      { date: "2026-10-03", days: "many" },
      { date: "2026-10-03", timeZone: "" },
      { date: "2026-10-03", timeZone: "x".repeat(65) },
      // The page is in the path. A page in the query would not be scope-checked,
      // so the strict query refuses it instead of ignoring it.
      { date: "2026-10-03", pageLabel: "lora-of" },
      { date: "2026-10-03", userId: "1" },
    ];
    for (const query of refused) {
      expect(clientAiUsageQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it("declares the route as a page-scoped device-token GET with the page in the path", () => {
    const route = routeSchemas.clientAiUsageDaily as {
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
    expect(route.querystring).toBe(clientAiUsageQuerySchema);
    expect(route.params?.safeParse({ pageLabel: "lora-of" }).success).toBe(true);
    expect(Object.keys(route.response).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    // The middleware resolves page scope from :pageLabel only (plan §5 item 19).
    expect(kernelOperations.clientAiUsageDaily).toEqual({
      method: "GET",
      path: "/api/v1/client/pages/:pageLabel/ai-usage",
    });
  });

  it("is on the narrow token's list and announced as ai-usage-v1", () => {
    expect(CLIENT_TOKEN_PROFILES["chat-extension"].operations).toContain("clientAiUsageDaily");
    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain("ai-usage-v1");
    expect(SERVED_CLIENT_CAPABILITIES).toContain("ai-usage-v1");
  });

  it("re-exports the known values from the generated SDK (the client cannot reach contracts)", () => {
    for (const name of [
      "CLIENT_AI_USAGE_COVERAGE",
      "CLIENT_AI_USAGE_COVERAGE_REASONS",
      "CLIENT_AI_USAGE_MAX_AGE_DAYS",
      "CLIENT_AI_USAGE_MAX_DAYS",
      "CLIENT_AI_USAGE_REFUSAL_REASONS",
    ] as const) {
      expect(sdk[name], name).toBeDefined();
      expect(sdk[name], name).toBe(contracts[name]);
    }
    expect(CLIENT_AI_USAGE_COVERAGE).toEqual(["complete", "partial"]);
    expect(CLIENT_AI_USAGE_COVERAGE_REASONS).toEqual(["day_open", "open_reservations", "approximate_cost"]);
    expect(CLIENT_AI_USAGE_REFUSAL_REASONS).toEqual(["unknown_time_zone", "date_in_future", "date_too_old"]);
  });
});
