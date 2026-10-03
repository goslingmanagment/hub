import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { SyncRouteSend } from "@agency_hub_core/db";
import { FANSLY_WIRE_IDS, FANSLY_WIRE_SPECS, type FanslyWireId } from "@agency_hub_core/fansly";

import {
  EMPTY_ROUTE_STATE,
  lookaheadInstants,
  parseRouteState,
  routeAdmissionView,
  routeExclusions,
  routeJournalLookbackMs,
  RouteClocks,
  routeStatusView,
  ROUTE_STATE_VERSION,
  type RouteState,
  type RouteStateEntry,
} from "../apps/runtime/src/sync/engine/route-policy.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  DEFAULT_ROUTE_BUDGET,
  FAMILY_BUDGETS,
  FANSLY_LEGACY_OPERATION_ROUTES,
  FANSLY_ROUTE_FAMILIES,
  FANSLY_ROUTES,
  familyOfRoute,
  intervalMsOf,
  routeBudget,
  routeOfEngineOperation,
  routeOfLegacyOperation,
  ROUTE_BUDGETS,
  ROUTE_POLICY_HASH,
  routePolicyVersion,
  type FanslyRoute,
} from "../apps/runtime/src/sync/fansly/routes.ts";

// The route policy (step 3b rulings 1, 3, 4; A2; plan PR 1-1): the catalogue
// of every route a request of a page can take, the legacy send log's map onto
// it, the budget table, the stored route state and the pure admission over
// the journal's sends.

const NOW = new Date("2026-10-03T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const engine = (operation: string, agoMs: number): SyncRouteSend => ({ journal: "engine", operation, lastAt: at(-agoMs) });
const legacy = (operation: string, agoMs: number): SyncRouteSend => ({ journal: "legacy", operation, lastAt: at(-agoMs) });

function entry(overrides: Partial<RouteStateEntry> = {}): RouteStateEntry {
  return {
    holdUntil: null,
    ladderStep: 0,
    effectivePerMin: null,
    policyVersion: null,
    last429AttemptId: null,
    last429At: null,
    revision: 1,
    ...overrides,
  };
}

function state(routes: RouteState["routes"]): RouteState {
  return { version: ROUTE_STATE_VERSION, routes };
}

describe("the route catalogue", () => {
  it("has every wire route, the socket's Upgrade and the media CDN among them, as itself", () => {
    for (const id of FANSLY_WIRE_IDS) {
      const route = FANSLY_ROUTES.get(id);
      expect(route, id).toEqual({ route: id, method: "GET", host: FANSLY_WIRE_SPECS[id].host, template: FANSLY_WIRE_SPECS[id].endpointTemplate, wire: id });
      expect(routeOfEngineOperation(id)).toBe(id);
    }
    expect(FANSLY_ROUTES.get("ws.upgrade")).toMatchObject({ host: "ws" });
    expect(FANSLY_ROUTES.get("cdn.media")).toMatchObject({ host: "cdn" });
    expect(routeOfEngineOperation("lists.items")).toBeNull();
    expect(routeOfEngineOperation("no.such")).toBeNull();
  });

  it("one route per endpoint: no two routes share a host and a path template", () => {
    const endpoints = [...FANSLY_ROUTES.values()].map((route) => `${route.method} ${route.host} ${route.template}`);
    expect(new Set(endpoints).size).toBe(endpoints.length);
    expect(FANSLY_ROUTES.size).toBe(FANSLY_WIRE_IDS.length + 7);
  });

  it("the families are routes, each route in one family at most", () => {
    const members = Object.values(FANSLY_ROUTE_FAMILIES).flat();
    expect(new Set(members).size).toBe(members.length);
    for (const route of members) expect(FANSLY_ROUTES.has(route), route).toBe(true);
    expect(FANSLY_ROUTE_FAMILIES.messaging).toEqual(["messaging.groups", "group.detail", "messages.page"]);
    // `/account/wallets/earnings/*`, the legacy overview included.
    expect([...FANSLY_ROUTE_FAMILIES.earnings].sort()).toEqual(
      [...FANSLY_ROUTES.values()].filter((route) => route.template.startsWith("/account/wallets/earnings")).map((route) => route.route).sort(),
    );
    expect(familyOfRoute("media.offer_stats")).toBeNull();
  });
});

describe("the legacy send log's operations", () => {
  /** Every operation a legacy sender can journal: the adapter's lanes and
   *  probes, and the direct captures of the step-1 guard. */
  function operationsInCode(): string[] {
    const adapter = readFileSync("packages/fansly/src/adapter.ts", "utf8");
    const found = new Set<string>();
    for (const match of adapter.matchAll(/operation: (?:[^"\n]*\? )?"([a-z_]+)"(?: : "([a-z_]+)")?/g)) {
      found.add(match[1]!);
      if (match[2] !== undefined) found.add(match[2]);
    }
    const captures = execFileSync("grep", ["-rhoE", String.raw`operation: "[a-z_]+", requestTimeoutMs|acquire\(\{ operation: "[a-z_]+"|^\s+operation: "[a-z_]+",$`,
      "apps/runtime/src/services/egress", "apps/runtime/src/services/fansly-ws", "scripts/fansly-ws"], { encoding: "utf8" });
    for (const match of captures.matchAll(/operation: "([a-z_]+)"/g)) found.add(match[1]!);
    return [...found].sort();
  }

  it("maps every operation the legacy code writes, and no other", () => {
    const inCode = operationsInCode();
    // The scan sees the adapter's lanes and every direct capture.
    for (const operation of ["messages", "messaging_groups", "media_offer_stats", "broadcast_stats_deleted_probe", "media_download", "ws_connect", "ws_probe", "account_me"]) {
      expect(inCode, operation).toContain(operation);
    }
    expect(Object.keys(FANSLY_LEGACY_OPERATION_ROUTES).sort()).toEqual(inCode);
    for (const route of Object.values(FANSLY_LEGACY_OPERATION_ROUTES)) expect(FANSLY_ROUTES.has(route), route).toBe(true);
  });

  it("each wire spec's legacy operation is its own route", () => {
    for (const id of FANSLY_WIRE_IDS) expect(routeOfLegacyOperation(FANSLY_WIRE_SPECS[id].legacyOperation), id).toBe(id);
    // The socket probes are Upgrades too; the legacy-only endpoints are their own.
    expect(routeOfLegacyOperation("ws_probe")).toBe("ws.upgrade");
    expect(routeOfLegacyOperation("list_items")).toBe("lists.items");
    expect(routeOfLegacyOperation("earnings_overview")).toBe("earnings.overview");
    expect(routeOfLegacyOperation("toString")).toBeNull();
    expect(routeOfLegacyOperation("no_such")).toBeNull();
  });

  it("maps every operation production's send log held on 2026-10-03 (read-only)", () => {
    const seen = [
      "account_lookup", "account_me", "account_stats", "account_walls_probe", "automated_messages",
      "broadcast_scheduled_probe", "broadcast_stats_deleted_probe", "broadcast_stats_probe", "discovery_media_suggestions",
      "earnings_accounts", "earnings_monthly_stats", "earnings_monthlystats_accounts", "earnings_stats_accounts",
      "earnings_stats_window", "earnings_transactions", "followers", "gift_codes", "group_detail", "media_download",
      "media_offer_stats", "media_orderhistory", "messages", "messaging_groups", "notifications_page", "payout_methods",
      "payout_requests", "polls_probe", "post_lookup", "post_replies", "post_tips", "recapstats_probe", "subscribers",
      "subscription_tiers", "timeline_posts", "tracking_links", "uservault_albums", "vault_albums", "vault_media", "ws_connect",
    ];
    for (const operation of seen) expect(routeOfLegacyOperation(operation), operation).not.toBeNull();
  });
});

describe("the budget table (owner decisions №21, D2, D4; A2)", () => {
  it("pins every budget: 15/min a route, the list 12, the media statistics 5 under a 12 ceiling; messaging 15, earnings 17", () => {
    expect(DEFAULT_ROUTE_BUDGET).toEqual({ ceilingPerMin: 15, currentPerMin: 15 });
    expect(ROUTE_BUDGETS).toEqual({
      "messaging.groups": { ceilingPerMin: 12, currentPerMin: 12 },
      "media.offer_stats": { ceilingPerMin: 12, currentPerMin: 5 },
    });
    expect(FAMILY_BUDGETS).toEqual({
      messaging: { ceilingPerMin: 15, currentPerMin: 15 },
      earnings: { ceilingPerMin: 17, currentPerMin: 17 },
    });
    expect(routeBudget("messages.page")).toEqual(DEFAULT_ROUTE_BUDGET);
    expect(routeBudget("ws.upgrade")).toEqual(DEFAULT_ROUTE_BUDGET);
    // No route above the owner's 15/min; `current` never above its ceiling.
    for (const route of FANSLY_ROUTES.keys()) {
      const budget = routeBudget(route);
      expect(budget.ceilingPerMin, route).toBeLessThanOrEqual(15);
      expect(budget.currentPerMin, route).toBeLessThanOrEqual(budget.ceilingPerMin);
      expect(budget.currentPerMin, route).toBeGreaterThan(0);
    }
    expect([15, 12, 5, 17].map(intervalMsOf)).toEqual([4_000, 5_000, 12_000, 3_530]);
    expect(() => intervalMsOf(0)).toThrow(RangeError);
  });

  it("the policy hash moves with any budget; a route's version with its own and its family's", () => {
    expect(ROUTE_POLICY_HASH).toBe("26722f8d6396edad21d3eae73c835225a4f4189f1e7573ecdbe7acd396b056fa");
    expect(routePolicyVersion("messages.page")).toBe("6bcdab5900273521");
    expect(routePolicyVersion("messages.page")).not.toBe(routePolicyVersion("group.detail"));
    expect(routePolicyVersion("media.offer_stats")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("every registry key's routes are known; only the owner's probe and the no-request keys declare none", () => {
    for (const spec of FANSLY_RESOURCE_SPECS) {
      for (const operation of spec.operations) expect(FANSLY_ROUTES.has(operation), `${spec.key} ${operation}`).toBe(true);
    }
    expect(FANSLY_RESOURCE_SPECS.filter((spec) => spec.http && spec.operations.length === 0).map((spec) => spec.key)).toEqual(["probe.manual"]);
  });
});

describe("the route state namespace (ruling 4)", () => {
  it("none stored is the empty state; a version-1 object reads", () => {
    expect(parseRouteState(null)).toEqual({ ok: true, state: EMPTY_ROUTE_STATE });
    expect(parseRouteState(undefined)).toEqual({ ok: true, state: EMPTY_ROUTE_STATE });
    const stored = {
      version: 1,
      routes: {
        "media.offer_stats": entry({ holdUntil: at(30_000).toISOString(), ladderStep: 2, effectivePerMin: 2.5, policyVersion: "abc", last429AttemptId: 7, last429At: NOW.toISOString(), revision: 3 }),
      },
    };
    expect(parseRouteState(stored)).toEqual({ ok: true, state: stored });
  });

  it("closes admission on a version it does not know, or an entry of a known route it cannot read", () => {
    expect(parseRouteState({ version: 2, routes: {} })).toEqual({ ok: false, diagnostic: "route_state_version:2" });
    expect(parseRouteState({ routes: {} })).toEqual({ ok: false, diagnostic: "route_state_version:undefined" });
    expect(parseRouteState("v1")).toEqual({ ok: false, diagnostic: "route_state_not_an_object" });
    expect(parseRouteState({ version: 1, routes: [] })).toEqual({ ok: false, diagnostic: "route_state_routes" });
    for (const bad of [
      { holdUntil: "soon" },
      { effectivePerMin: 0 },
      { effectivePerMin: -1 },
      { effectivePerMin: Number.NaN },
      { ladderStep: -1 },
      { revision: 1.5 },
      { last429AttemptId: 0 },
      { policyVersion: 3 },
    ]) {
      expect(parseRouteState({ version: 1, routes: { "messages.page": { ...entry(), ...bad } } }), JSON.stringify(bad))
        .toEqual({ ok: false, diagnostic: "route_state_entry:messages.page" });
    }
    expect(parseRouteState({ version: 1, routes: { "messages.page": "held" } })).toMatchObject({ ok: false });
  });

  it("leaves an entry of a route this build does not know alone (it never sends there)", () => {
    expect(parseRouteState({ version: 1, routes: { "future.route": { anything: true }, polls: entry() } }))
      .toEqual({ ok: true, state: state({ polls: entry() }) });
  });
});

describe("the route clocks", () => {
  it("open a route one interval after its newest send, from the journal alone", () => {
    const clocks = new RouteClocks({ sends: [engine("media.offer_stats", 5_000), engine("media.offer_stats", 9_000), engine("polls", 1_000)], state: EMPTY_ROUTE_STATE });
    expect(clocks.notBefore("media.offer_stats")).toEqual(at(7_000));
    expect(clocks.notBefore("polls")).toEqual(at(3_000));
    expect(clocks.notBefore("account.me")).toBeNull();
    expect(clocks.admits("media.offer_stats", at(6_999))).toBe(false);
    expect(clocks.admits("media.offer_stats", at(7_000))).toBe(true);
  });

  it("a family's send closes its members for the family's interval", () => {
    // The list sent 1 s ago: the list waits its own 5 s, `/message` and the
    // detail the messaging family's 4 s; earnings and media are untouched.
    const clocks = new RouteClocks({ sends: [engine("messaging.groups", 1_000)], state: EMPTY_ROUTE_STATE });
    expect(clocks.notBefore("messaging.groups")).toEqual(at(4_000));
    expect(clocks.notBefore("messages.page")).toEqual(at(3_000));
    expect(clocks.notBefore("group.detail")).toEqual(at(3_000));
    expect(clocks.notBefore("transactions.page")).toBeNull();
    const earnings = new RouteClocks({ sends: [engine("transactions.page", 1_000)], state: EMPTY_ROUTE_STATE });
    expect(earnings.notBefore("transactions.page")).toEqual(at(3_000));
    expect(earnings.notBefore("earnings.accounts")).toEqual(at(2_530));
  });

  it("count the legacy engine's sends through the operation map; an operation nobody can place counts on every route", () => {
    const takeover = new RouteClocks({ sends: [legacy("messages", 1_000), legacy("media_offer_stats", 2_000)], state: EMPTY_ROUTE_STATE });
    expect(takeover.notBefore("messages.page")).toEqual(at(3_000));
    expect(takeover.notBefore("messaging.groups")).toEqual(at(3_000));
    expect(takeover.notBefore("media.offer_stats")).toEqual(at(10_000));
    const unknown = new RouteClocks({ sends: [legacy("brand_new_lane", 1_000), engine("no.such", 2_000)], state: EMPTY_ROUTE_STATE });
    for (const route of ["polls", "messages.page", "media.offer_stats", "cdn.media"] as FanslyRoute[]) {
      expect(unknown.admits(route, NOW), route).toBe(false);
    }
    expect(unknown.notBefore("polls")).toEqual(at(3_000));
  });

  it("a send's upper bound in the future (an unknown outcome) pushes its route past it", () => {
    const clocks = new RouteClocks({ sends: [engine("messages.page", -13_000)], state: EMPTY_ROUTE_STATE });
    expect(clocks.notBefore("messages.page")).toEqual(at(17_000));
  });

  it("the stored state only ever slows a route: a slowdown below `current`, a hold to its end", () => {
    const sends = [engine("messages.page", 1_000), engine("polls", 1_000), engine("media.offer_stats", 1_000)];
    const clocks = new RouteClocks({
      sends,
      state: state({
        "messages.page": entry({ effectivePerMin: 7.5 }),
        // Above `current`: the table's 5/min stays.
        "media.offer_stats": entry({ effectivePerMin: 12 }),
        polls: entry({ holdUntil: at(40_000).toISOString() }),
      }),
    });
    expect(clocks.notBefore("messages.page")).toEqual(at(7_000));
    expect(clocks.notBefore("media.offer_stats")).toEqual(at(11_000));
    expect(clocks.notBefore("polls")).toEqual(at(40_000));
    // A hold on a route never sent on yet still closes it.
    const held = new RouteClocks({ sends: [], state: state({ "account.me": entry({ holdUntil: at(5_000).toISOString() }) }) });
    expect(held.notBefore("account.me")).toEqual(at(5_000));
    expect(held.view("account.me")).toMatchObject({ effectivePerMin: 15, intervalMs: 4_000, lastSendAt: null, holdUntil: at(5_000) });
  });

  it("a key opens when the first of its routes does; a key without routes is never closed by them", () => {
    const clocks = new RouteClocks({ sends: [engine("messaging.groups", 1_000), engine("group.detail", 500)], state: EMPTY_ROUTE_STATE });
    // `.find` reads the list or a detail: both wait for the family (detail sent last).
    expect(clocks.keyNotBefore(["messaging.groups", "group.detail"])).toEqual(at(3_500));
    expect(clocks.keyNotBefore(["messaging.groups", "polls"])).toBeNull();
    expect(clocks.keyNotBefore([])).toBeNull();
    expect(clocks.keyNotBefore(undefined)).toBeNull();
  });

  it("the look-back covers the longest interval the page can have now", () => {
    expect(routeJournalLookbackMs(EMPTY_ROUTE_STATE)).toBe(12_000);
    expect(routeJournalLookbackMs(state({ "messaging.groups": entry({ effectivePerMin: 1.5 }) }))).toBe(40_000);
    expect(routeJournalLookbackMs(EMPTY_ROUTE_STATE, { timeScale: 0.01 })).toBe(120);
    expect(routeJournalLookbackMs(EMPTY_ROUTE_STATE, { timeScale: 0 })).toBe(0);
    expect(() => routeJournalLookbackMs(EMPTY_ROUTE_STATE, { timeScale: -1 })).toThrow(RangeError);
  });

  it("a test time scale shrinks every interval (0 lifts them), never a hold", () => {
    const sends = [engine("media.offer_stats", 10), engine("messages.page", 10)];
    const scaled = new RouteClocks({ sends, state: EMPTY_ROUTE_STATE, timeScale: 0.01 });
    expect(scaled.notBefore("media.offer_stats")).toEqual(at(110));
    expect(scaled.notBefore("messages.page")).toEqual(at(30));
    // Lifted: not even an unknown outcome's upper bound closes a route.
    const lifted = new RouteClocks({
      sends: [...sends, engine("messages.page", -15_000)],
      state: state({ polls: entry({ holdUntil: at(1_000).toISOString() }) }),
      timeScale: 0,
    });
    expect(lifted.admits("media.offer_stats", NOW)).toBe(true);
    expect(lifted.notBefore("messages.page")).toBeNull();
    expect(lifted.admits("polls", NOW)).toBe(false);
  });
});

describe("the admission at the pick", () => {
  const specs = [
    { key: "dm-messages.history", operations: ["messages.page"] as FanslyWireId[] },
    { key: "dm-conversations.find", operations: ["messaging.groups", "group.detail"] as FanslyWireId[] },
    { key: "media-stats.walk", operations: ["media.offer_stats"] as FanslyWireId[] },
    { key: "probe.manual", operations: [] as FanslyWireId[] },
    { key: "dm-live.deletions" },
  ];

  it("leaves out exactly the keys none of whose routes admits a send at the instant", () => {
    const clocks = new RouteClocks({ sends: [engine("messages.page", 1_000), engine("media.offer_stats", 1_000)], state: EMPTY_ROUTE_STATE });
    expect(routeExclusions(specs, clocks, NOW)).toEqual(["dm-conversations.find", "dm-messages.history", "media-stats.walk"]);
    expect(routeExclusions(specs, clocks, at(3_000))).toEqual(["media-stats.walk"]);
    expect(routeExclusions(specs, clocks, at(11_000))).toEqual([]);
  });

  it("the look-ahead's instants are the openings in (now, until), ascending, each once", () => {
    const clocks = new RouteClocks({ sends: [engine("messages.page", 1_000), engine("media.offer_stats", 1_000)], state: EMPTY_ROUTE_STATE });
    expect(lookaheadInstants(specs, clocks, NOW, at(3_000))).toEqual([]);
    expect(lookaheadInstants(specs, clocks, NOW, at(3_001))).toEqual([at(3_000)]);
    expect(lookaheadInstants(specs, clocks, NOW, at(20_000))).toEqual([at(3_000), at(11_000)]);
  });

  it("why waiting names the routes still closed; the status lists the routes and families", () => {
    const clocks = new RouteClocks({ sends: [engine("messaging.groups", 1_000)], state: state({ polls: entry({ holdUntil: at(9_000).toISOString() }) }) });
    const why = routeAdmissionView(clocks, null, specs, NOW);
    expect(why.keyOpensAt("dm-conversations.find")).toEqual({ at: at(3_000), routes: ["group.detail", "messaging.groups"] });
    expect(why.keyOpensAt("media-stats.walk")).toBeNull();
    expect(why.keyOpensAt("probe.manual")).toBeNull();
    expect(routeAdmissionView(null, "route_state_version:9", specs, NOW)).toMatchObject({ stateError: "route_state_version:9" });
    const status = routeStatusView(clocks, null, NOW);
    expect(status.policyHash).toBe(ROUTE_POLICY_HASH);
    expect(status.routes.map((route) => route.name)).toEqual(["messaging.groups", "polls", "family:messaging", "family:earnings"]);
    expect(status.routes[0]).toEqual({
      name: "messaging.groups", family: "messaging", ceilingPerMin: 12, currentPerMin: 12, effectivePerMin: 12, intervalMs: 5_000,
      lastSendAt: at(-1_000).toISOString(), holdUntil: null, opensAt: at(4_000).toISOString(),
    });
    expect(status.routes[1]).toMatchObject({ name: "polls", holdUntil: at(9_000).toISOString(), opensAt: at(9_000).toISOString() });
    expect(status.routes[2]).toMatchObject({ name: "family:messaging", opensAt: at(3_000).toISOString() });
    expect(status.routes[3]).toMatchObject({ name: "family:earnings", lastSendAt: null, opensAt: null });
    expect(routeStatusView(null, "route_state_routes", NOW)).toEqual({ policyHash: ROUTE_POLICY_HASH, stateError: "route_state_routes", routes: [] });
  });
});
