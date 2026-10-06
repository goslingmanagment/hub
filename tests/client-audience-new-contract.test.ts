import { describe, expect, it } from "vitest";

import * as contracts from "@agency_hub_core/contracts";
import {
  CLIENT_AUDIENCE_NEW_COVERAGE_REASONS,
  CLIENT_AUDIENCE_NEW_DEFAULT_LIMIT,
  CLIENT_AUDIENCE_NEW_DEFAULT_WINDOW_HOURS,
  CLIENT_AUDIENCE_NEW_KINDS,
  CLIENT_AUDIENCE_NEW_MAX_LIMIT,
  CLIENT_AUDIENCE_NEW_MAX_WINDOW_HOURS,
  CLIENT_AUDIENCE_NEW_REFUSAL_REASONS,
  CLIENT_AUDIENCE_NEW_STATUS_SOURCES,
  CLIENT_AUDIENCE_NEW_SUBSCRIBED_AT_SOURCES,
  CLIENT_AUDIENCE_NEW_SUBSCRIPTION_STATUSES,
  CLIENT_COVERAGE_LEVELS,
  CLIENT_CUSTODY_STATES,
  CLIENT_GREETING_STATES,
  CLIENT_LEASE_HOLDERS,
  CLIENT_LEASE_STATES,
  CLIENT_TOKEN_PROFILES,
  clientAudienceNewQuerySchema,
  clientAudienceNewResponseSchema,
  clientClaimSummarySchema,
  clientCursorSchema,
  clientOpenToken,
  clientPageParamsSchema,
  errorResponseSchema,
  routeSchemas,
  type ClientAudienceNewResponse,
} from "@agency_hub_core/contracts";
import { CLIENT_AUDIENCE_NEW_CLASSES } from "@agency_hub_core/db";

import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { clientFeatureExistsOn, evaluateClientFeature } from "../apps/runtime/src/services/client-features.ts";
import { CLIENT_BOOTSTRAP_LIMITS } from "../apps/runtime/src/services/client-limits.ts";
import { BadRequestError } from "../apps/runtime/src/services/errors.ts";
import * as sdk from "../packages/sdk/src/index.ts";
import {
  FROZEN_AUDIENCE_KINDS,
  FROZEN_AUDIENCE_LIMITS,
  FROZEN_SUBSCRIBED_AT_SOURCES,
  frozenAudienceNewPageSchema as frozenPage,
  frozenAudienceNewQuerySchema as frozenQuery,
} from "./helpers/client-audience-new-frozen.ts";
import { frozenErrorBodySchema } from "./helpers/client-claim-frozen.ts";

// chat-extension H-7c: the "new subscribers" list (`clientAudienceNew`). Its
// behaviour over real rows is tests/client-audience-new.integration.test.ts and
// its rules tests/client-audience-new.test.ts. This file holds the shapes,
// against the client's frozen ones (tests/helpers/client-audience-new-frozen.ts).

const ISO = "2026-10-04T23:08:00.000Z";

function item(over: Record<string, unknown> = {}) {
  return {
    eventRef: "9001",
    fanRef: "700000001",
    username: "fan_one",
    displayName: "Fan One",
    kind: "new",
    trial: false,
    subscribedAt: ISO,
    subscribedAtSource: "notification",
    status: { isSubscriber: true, subscriptionStatus: "active", endsAt: ISO, asOf: ISO, source: "webhook" },
    thread: {
      lastMessageAt: ISO, lastFanMessageAt: null, lastModelMessageAt: ISO, storedMessageCount: 1,
      coverage: "unknown", backfillComplete: false,
    },
    claim: { greeting: "none", lease: "none", heldBy: null, custody: null },
    ...over,
  };
}

function page(over: Record<string, unknown> = {}): ClientAudienceNewResponse {
  return {
    pageLabel: "lora-of",
    window: { hours: 48, from: ISO, to: ISO, snapshotAt: ISO },
    serverNow: ISO,
    coverage: { state: "complete", deliveryFrontier: ISO, lastAudienceSweepAt: ISO, reasons: [] },
    unknownCount: 0,
    welcomeTemplate: { ref: "42", observedAt: ISO, enabled: true, hasText: true, hasMedia: false, priceMills: 5000 },
    items: [item()],
    nextCursor: null,
    ...over,
  } as ClientAudienceNewResponse;
}

describe("audience-new contract", () => {
  it("declares one device-token page route with every status it answers", () => {
    const route = (routeSchemas as unknown as Record<string, {
      auth: { kind: string; scope?: string };
      tags: readonly string[];
      params: unknown;
      querystring?: unknown;
      body?: unknown;
      response: Record<number, unknown>;
    }>).clientAudienceNew!;
    expect(route.auth).toEqual({ kind: "apiKey", scope: "page" });
    expect(route.tags).toEqual(["client"]);
    expect(route.params).toBe(clientPageParamsSchema);
    expect(route.querystring).toBe(clientAudienceNewQuerySchema);
    expect(route.body).toBeUndefined();
    expect(Object.keys(route.response).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    expect(route.response[200]).toBe(clientAudienceNewResponseSchema);
    for (const status of [400, 401, 403, 404, 409]) {
      expect(route.response[status], String(status)).toBe(errorResponseSchema);
    }
    expect(sdk.kernelOperations.clientAudienceNew).toEqual({
      method: "GET",
      path: "/api/v1/client/pages/:pageLabel/audience-new",
    });
  });

  it("takes every query the client's frozen schema lets out, and nothing beside the three keys", () => {
    const cursor = "c".repeat(2048);
    for (const query of [
      { windowHours: 1 },
      { windowHours: 48 },
      { windowHours: 720 },
      { windowHours: 24, limit: 1 },
      { windowHours: 168, limit: 100, cursor },
      { windowHours: 72, cursor: "a" },
    ]) {
      expect(frozenQuery.safeParse({ pageLabel: "lora-of", ...query }).success, JSON.stringify(query)).toBe(true);
      // As it travels: every value of a query string is text.
      const wire = Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)]));
      expect(clientAudienceNewQuerySchema.parse(wire), JSON.stringify(query)).toEqual({
        limit: CLIENT_AUDIENCE_NEW_DEFAULT_LIMIT,
        ...query,
      });
    }
    // The hub's own defaults are the client's.
    expect(clientAudienceNewQuerySchema.parse({})).toEqual({
      windowHours: FROZEN_AUDIENCE_LIMITS.defaultWindowHours,
      limit: FROZEN_AUDIENCE_LIMITS.defaultLimit,
    });
    expect(CLIENT_AUDIENCE_NEW_DEFAULT_WINDOW_HOURS).toBe(FROZEN_AUDIENCE_LIMITS.defaultWindowHours);
    expect(CLIENT_AUDIENCE_NEW_MAX_WINDOW_HOURS).toBe(FROZEN_AUDIENCE_LIMITS.maxWindowHours);
    expect(CLIENT_AUDIENCE_NEW_DEFAULT_LIMIT).toBe(FROZEN_AUDIENCE_LIMITS.defaultLimit);
    expect(CLIENT_AUDIENCE_NEW_MAX_LIMIT).toBe(FROZEN_AUDIENCE_LIMITS.maxLimit);
    // The bootstrap announces the bound the query enforces.
    expect(CLIENT_BOOTSTRAP_LIMITS.audienceWindowHours).toBe(CLIENT_AUDIENCE_NEW_MAX_WINDOW_HOURS);

    for (const query of [
      { windowHours: "0" }, { windowHours: "721" }, { windowHours: "1.5" }, { windowHours: "two" },
      { limit: "0" }, { limit: "101" }, { cursor: "" }, { cursor: "c".repeat(2049) },
      // The page is the path's, and the reader is the caller: neither is taken from the query.
      { pageLabel: "mia-of" }, { userId: "1" }, { fanRef: "700000001" }, { from: ISO },
    ]) {
      expect(clientAudienceNewQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it("answers only what the client's frozen schema reads", () => {
    const answers = [
      page(),
      // Nothing known beyond the event itself.
      page({
        coverage: { state: "unknown", deliveryFrontier: null, lastAudienceSweepAt: null, reasons: ["delivery_history_off", "audience_sweep_missing"] },
        unknownCount: 3,
        welcomeTemplate: null,
        nextCursor: "c".repeat(2048),
        items: [item({
          username: null, displayName: null, kind: "returning", subscribedAtSource: "subscribeAt",
          status: { isSubscriber: null, subscriptionStatus: "unknown", endsAt: null, asOf: null, source: "none" },
          thread: null,
          claim: { greeting: "confirmed", lease: "held", heldBy: "you-elsewhere", custody: "uncertain-held" },
        })],
      }),
      page({ items: [], welcomeTemplate: { ref: "43", observedAt: ISO, enabled: null, hasText: false, hasMedia: true, priceMills: null } }),
      page({ items: [item({ trial: true, fanRef: "9".repeat(30), claim: { greeting: "none", lease: "held", heldBy: "someone-else", custody: "dispatching" } })] }),
    ];
    for (const answer of answers) {
      const parsed = clientAudienceNewResponseSchema.parse(answer);
      // Neither schema is strict; nothing is stripped by either.
      expect(parsed).toEqual(answer);
      expect(frozenPage.parse(answer)).toEqual(answer);
    }
    // The row's fan id is the client's one numeric shape: the hub's schema refuses what the client's would.
    for (const fanRef of ["0700", "group-7", "", "7".repeat(31)]) {
      expect(clientAudienceNewResponseSchema.safeParse(page({ items: [item({ fanRef })] })).success, fanRef).toBe(false);
      expect(frozenPage.safeParse(page({ items: [item({ fanRef })] })).success, fanRef).toBe(false);
    }
    // A response object is not strict (§4.0): a key a later hub adds is dropped, never a failed parse.
    expect(frozenPage.safeParse({ ...page(), later: 1 }).success).toBe(true);
  });

  it("keeps the automaton states closed and every growing vocabulary an open token the client can read", () => {
    const states = clientClaimSummarySchema.shape;
    expect(states.greeting.options).toEqual([...CLIENT_GREETING_STATES]);
    expect(states.lease.options).toEqual([...CLIENT_LEASE_STATES]);
    expect(states.heldBy.unwrap().options).toEqual([...CLIENT_LEASE_HOLDERS]);
    expect(states.custody.unwrap().options).toEqual([...CLIENT_CUSTODY_STATES]);
    expect(clientClaimSummarySchema.safeParse({ greeting: "none", lease: "none", heldBy: null, custody: "queued" }).success)
      .toBe(false);

    // Open: an unknown member parses on both sides and reads as unknown there.
    const open = page({
      coverage: { state: "later", deliveryFrontier: null, lastAudienceSweepAt: null, reasons: ["a_later_reason"] },
      items: [item({
        kind: "renewed", subscribedAtSource: "later",
        status: { isSubscriber: null, subscriptionStatus: "later", endsAt: null, asOf: null, source: "later" },
        thread: {
          lastMessageAt: null, lastFanMessageAt: null, lastModelMessageAt: null, storedMessageCount: 0,
          coverage: "later", backfillComplete: false,
        },
      })],
    });
    expect(clientAudienceNewResponseSchema.safeParse(open).success).toBe(true);
    expect(frozenPage.safeParse(open).success).toBe(true);

    // What this hub answers are the client's known values, and every one fits an open token.
    expect(CLIENT_AUDIENCE_NEW_KINDS).toEqual(FROZEN_AUDIENCE_KINDS);
    expect(CLIENT_AUDIENCE_NEW_SUBSCRIBED_AT_SOURCES).toEqual(FROZEN_SUBSCRIBED_AT_SOURCES);
    expect(CLIENT_AUDIENCE_NEW_SUBSCRIPTION_STATUSES).toEqual(["active", "expired", "unknown"]);
    expect(CLIENT_AUDIENCE_NEW_STATUS_SOURCES).toEqual(["sweep", "webhook", "none"]);
    for (const token of [
      ...CLIENT_AUDIENCE_NEW_KINDS, ...CLIENT_AUDIENCE_NEW_SUBSCRIBED_AT_SOURCES,
      ...CLIENT_AUDIENCE_NEW_SUBSCRIPTION_STATUSES, ...CLIENT_AUDIENCE_NEW_STATUS_SOURCES,
      ...CLIENT_AUDIENCE_NEW_COVERAGE_REASONS, ...CLIENT_COVERAGE_LEVELS,
    ]) {
      expect(clientOpenToken.safeParse(token).success, token).toBe(true);
    }
    // No kind is "renewed", and every row the reader lists is one of the known kinds.
    expect(CLIENT_AUDIENCE_NEW_KINDS).not.toContain("renewed");
    expect([...new Set(CLIENT_AUDIENCE_NEW_CLASSES.map((entry) => entry.kind))].sort()).toEqual([...CLIENT_AUDIENCE_NEW_KINDS].sort());
  });

  it("a refused cursor is a 400 with a reason the client froze, in the error body it reads", () => {
    // The client's error map (its hub/error-map.ts): both reasons read the first page again.
    expect(CLIENT_AUDIENCE_NEW_REFUSAL_REASONS).toEqual(["cursor_invalid", "cursor_window_mismatch"]);
    for (const reason of CLIENT_AUDIENCE_NEW_REFUSAL_REASONS) {
      const error = new BadRequestError("cursor refused", { reason });
      const body = { error: error.code, message: error.message, statusCode: error.statusCode, reason: error.reason };
      expect(body).toMatchObject({ error: "bad_request", statusCode: 400, reason });
      expect(errorResponseSchema.safeParse(body).success).toBe(true);
      expect(frozenErrorBodySchema.safeParse(body).success).toBe(true);
    }
    // A cursor is the client's bounded opaque text on both sides.
    expect(clientCursorSchema.safeParse("c".repeat(2048)).success).toBe(true);
    expect(clientCursorSchema.safeParse("c".repeat(2049)).success).toBe(false);
  });

  it("serves the capability, lists the route for the narrow token and exports the vocabularies through the SDK", () => {
    expect(SERVED_CLIENT_CAPABILITIES).toContain("audience-new-v1");
    expect(CLIENT_TOKEN_PROFILES["chat-extension"].operations).toContain("clientAudienceNew");

    const on = { enabled: true, features: { "*": { newcomers: true } }, hostBindings: {} };
    const ofPage = { label: "lora-of", platform: "onlyfans" as const, platformAccountId: "100000001" };
    // With this route the hub serves all of `newcomers`: the owner's switch decides from here on.
    expect(evaluateClientFeature({ settings: on, page: ofPage, flag: "newcomers", served: SERVED_CLIENT_CAPABILITIES }))
      .toEqual({ available: true });
    expect(evaluateClientFeature({
      settings: on, page: ofPage, flag: "newcomers",
      served: SERVED_CLIENT_CAPABILITIES.filter((capability) => capability !== "audience-new-v1"),
    })).toEqual({ available: false, reason: "hub_not_ready" });
    expect(clientFeatureExistsOn("newcomers", "onlyfans")).toBe(true);
    expect(clientFeatureExistsOn("newcomers", "fansly")).toBe(false);

    for (const name of [
      "CLIENT_AUDIENCE_NEW_COVERAGE_REASONS", "CLIENT_AUDIENCE_NEW_DEFAULT_LIMIT",
      "CLIENT_AUDIENCE_NEW_DEFAULT_WINDOW_HOURS", "CLIENT_AUDIENCE_NEW_KINDS", "CLIENT_AUDIENCE_NEW_MAX_LIMIT",
      "CLIENT_AUDIENCE_NEW_MAX_WINDOW_HOURS", "CLIENT_AUDIENCE_NEW_REFUSAL_REASONS",
      "CLIENT_AUDIENCE_NEW_STATUS_SOURCES", "CLIENT_AUDIENCE_NEW_SUBSCRIBED_AT_SOURCES",
      "CLIENT_AUDIENCE_NEW_SUBSCRIPTION_STATUSES",
    ] as const) {
      expect(sdk[name], name).toBe(contracts[name]);
    }
  });
});
