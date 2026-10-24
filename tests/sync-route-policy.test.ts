import { describe, expect, it } from "vitest";

import type { SyncRouteSend } from "@agency_hub_core/db";
import { FANSLY_WIRE_IDS, FANSLY_WIRE_SPECS, type FanslyWireId } from "@agency_hub_core/fansly";

import {
  EMPTY_ROUTE_STATE,
  lookaheadInstants,
  routeExclusions,
  routeJournalLookbackMs,
  RouteClocks,
  routeStateOfHolds,
  type RouteState,
  type RouteStateEntry,
} from "../apps/runtime/src/sync/engine/route-policy.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  DEFAULT_ROUTE_BUDGET,
  FAMILY_BUDGETS,
  FANSLY_ROUTE_FAMILIES,
  FANSLY_ROUTES,
  familyOfRoute,
  intervalMsOf,
  isFanslySiteRoute,
  routeBudget,
  routeOfEngineOperation,
  ROUTE_BUDGETS,
  ROUTE_POLICY_HASH,
  routePolicyVersion,
} from "../apps/runtime/src/sync/fansly/routes.ts";
import { pageHoldRow, resourceBreakerRow, routeHoldRows } from "./helpers/sync-holds.ts";

// The route policy (step 3b rulings 1, 3, 4; A2; plan PR 1-1): the catalogue
// of every route a request of a page can take, the legacy send log's map onto
// it, the budget table, the stored route state and the pure admission over
// the journal's sends.

const NOW = new Date("2026-10-03T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const engine = (operation: string, agoMs: number): SyncRouteSend => ({ journal: "engine", operation, lastAt: at(-agoMs) });

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
  return { routes };
}

describe("the route catalogue", () => {
  it("has every wire route, the socket's Upgrade and the media CDN among them, as itself", () => {
    for (const id of FANSLY_WIRE_IDS) {
      const route = FANSLY_ROUTES.get(id);
      expect(route, id).toEqual({ route: id, method: FANSLY_WIRE_SPECS[id].method ?? "GET", host: FANSLY_WIRE_SPECS[id].host, template: FANSLY_WIRE_SPECS[id].endpointTemplate, wire: id });
      expect(routeOfEngineOperation(id)).toBe(id);
    }
    expect(FANSLY_ROUTES.get("ws.upgrade")).toMatchObject({ host: "ws" });
    expect(FANSLY_ROUTES.get("cdn.media")).toMatchObject({ host: "cdn" });
    // Wall posts PR 6: the publishing routes are POSTs, the upload API's on its own host.
    const writes = [...FANSLY_ROUTES.values()].filter((route) => route.wire !== null && route.method === "POST");
    expect(writes.map((route) => `${route.host} ${route.template}`).sort()).toEqual([
      "api /account/media", "api /account/media/bundle", "api /mediastories", "api /post", "api /post/:postId/delete", "api /post/scheduled/:postId/cancel",
      "upload /media/upload/complete", "upload /media/upload/create",
    ]);
    // A site read of a legacy-only endpoint is journaled on its route
    // (Project Browser, 0271): its clock counts there, not against every route.
    expect(routeOfEngineOperation("lists.items")).toBe("lists.items");
    expect(routeOfEngineOperation("no.such")).toBeNull();
  });

  it("one route per endpoint: no two routes share a host and a path template", () => {
    const endpoints = [...FANSLY_ROUTES.values()].map((route) => `${route.method} ${route.host} ${route.template}`);
    expect(new Set(endpoints).size).toBe(endpoints.length);
    // The wire routes, 7 legacy-only and 3 of the site's own requests.
    expect(FANSLY_ROUTES.size).toBe(FANSLY_WIRE_IDS.length + 7 + 3);
  });

  it("has the routes of a page's own site requests (Project Browser, owner decision №3)", () => {
    expect(FANSLY_ROUTES.get("site.other")).toMatchObject({ method: "GET", host: "api", wire: null });
    expect(FANSLY_ROUTES.get("auth.login")).toEqual({ route: "auth.login", method: "POST", host: "api", template: "/login", wire: null });
    expect(FANSLY_ROUTES.get("auth.twofa")).toEqual({ route: "auth.twofa", method: "POST", host: "api", template: "/login/twofa", wire: null });
    // The site's reads outside the catalogue share the family `site`, 20 a
    // minute; the login operations have the default budget and no family.
    expect(familyOfRoute("site.other")).toBe("site");
    expect(FAMILY_BUDGETS.site).toEqual({ ceilingPerMin: 20, currentPerMin: 20 });
    expect(familyOfRoute("auth.login")).toBeNull();
    expect(routeBudget("auth.twofa")).toEqual(DEFAULT_ROUTE_BUDGET);
    // A site or login attempt of sync_attempts counts on its route.
    for (const route of ["site.other", "auth.login", "auth.twofa"] as const) expect(routeOfEngineOperation(route)).toBe(route);
    expect(isFanslySiteRoute("site.other")).toBe(true);
    expect(isFanslySiteRoute("account.me")).toBe(false);
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
    // `/account/stats/*`, the statistics pages of 2026-10: one family until their quota is measured.
    expect([...FANSLY_ROUTE_FAMILIES.creator_stats].sort()).toEqual(
      [...FANSLY_ROUTES.values()].filter((route) => route.template.startsWith("/account/stats/")).map((route) => route.route).sort(),
    );
    expect(familyOfRoute("stats.summary")).toBe("creator_stats");
    expect(familyOfRoute("earnings.transactions_account")).toBe("earnings");
  });
});

describe("the budget table (owner decisions №21, D2, D4; A2)", () => {
  it("pins every budget: 15/min a route, the list 12, the media statistics 5 under a 12 ceiling; messaging 15, earnings 17, the 2026-10 statistics 5 under 12", () => {
    expect(DEFAULT_ROUTE_BUDGET).toEqual({ ceilingPerMin: 15, currentPerMin: 15 });
    expect(ROUTE_BUDGETS).toEqual({
      "messaging.groups": { ceilingPerMin: 12, currentPerMin: 12 },
      "media.offer_stats": { ceilingPerMin: 12, currentPerMin: 5 },
    });
    expect(FAMILY_BUDGETS).toEqual({
      messaging: { ceilingPerMin: 15, currentPerMin: 15 },
      earnings: { ceilingPerMin: 17, currentPerMin: 17 },
      creator_stats: { ceilingPerMin: 12, currentPerMin: 5 },
      // Owner decision №3: the site's own reads outside the catalogue.
      site: { ceilingPerMin: 20, currentPerMin: 20 },
    });
    expect(routeBudget("messages.page")).toEqual(DEFAULT_ROUTE_BUDGET);
    expect(routeBudget("stats.summary")).toEqual(DEFAULT_ROUTE_BUDGET);
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
    // The 7 publishing routes of wall posts PR 6, the schedule and story reads of PR 9 and an upload's part and status read of PR 8, at the default budget and in no family.
    expect(ROUTE_POLICY_HASH).toBe("61fbe377951fad9fe9fe40f93b0fc64918479454228849f62ea3803b136ae7a5");
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

describe("the route state in the hold set (ruling 4; step 4)", () => {
  it("none stored is the empty state; a route's two rows read as its entry", () => {
    expect(routeStateOfHolds([])).toEqual({ ok: true, state: EMPTY_ROUTE_STATE });
    const stored = entry({ holdUntil: at(30_000).toISOString(), ladderStep: 2, effectivePerMin: 2.5, policyVersion: "abc", last429AttemptId: 7, last429At: NOW.toISOString(), revision: 3 });
    expect(routeStateOfHolds(routeHoldRows("media.offer_stats", stored))).toEqual({ ok: true, state: state({ "media.offer_stats": stored }) });
    // A state without a hold (a raise after its hold ended), a hold whose state
    // row is missing: an entry either way.
    expect(routeStateOfHolds(routeHoldRows("polls", { effectivePerMin: 7.5, revision: 4 })))
      .toEqual({ ok: true, state: state({ polls: entry({ effectivePerMin: 7.5, revision: 4 }) }) });
    const holdOnly = routeHoldRows("polls", { holdUntil: at(9_000).toISOString() }).filter((row) => row.kind === "route_hold");
    expect(routeStateOfHolds(holdOnly)).toEqual({ ok: true, state: state({ polls: entry({ holdUntil: at(9_000).toISOString(), revision: 0 }) }) });
  });

  it("reads the route rows only: a page's own holds and its breakers are not route state", () => {
    const rows = [pageHoldRow("auth"), resourceBreakerRow("transactions", at(60_000)), ...routeHoldRows("polls", { revision: 2 })];
    expect(routeStateOfHolds(rows)).toEqual({ ok: true, state: state({ polls: entry({ revision: 2 }) }) });
  });

  it("closes admission on rows of a known route it cannot read", () => {
    for (const bad of [
      { effectivePerMin: 0 },
      { effectivePerMin: -1 },
      { effectivePerMin: Number.NaN },
      { ladderStep: -1 },
      { revision: 1.5 },
      { last429AttemptId: 0 },
      { last429At: "soon" },
      { policyVersion: 3 as unknown as string },
    ]) {
      expect(routeStateOfHolds(routeHoldRows("messages.page", bad)), JSON.stringify(bad))
        .toEqual({ ok: false, diagnostic: "route_state_entry:messages.page" });
    }
    // A hold row without an end, a kind a later build added.
    const [budget] = routeHoldRows("messages.page");
    expect(routeStateOfHolds([budget!, { ...budget!, kind: "route_hold", until: null }]))
      .toEqual({ ok: false, diagnostic: "route_state_entry:messages.page" });
    expect(routeStateOfHolds([budget!, { ...budget!, kind: "route_quota" }]))
      .toEqual({ ok: false, diagnostic: "route_state_kind:messages.page:route_quota" });
  });

  it("leaves the rows of a route this build does not know alone (it never sends there)", () => {
    const future = routeHoldRows("future.route", { effectivePerMin: -1 }).map((row) => ({ ...row, kind: row.kind === "route_budget" ? "route_quota" : row.kind }));
    expect(routeStateOfHolds([...future, ...routeHoldRows("polls")])).toEqual({ ok: true, state: state({ polls: entry() }) });
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
});
