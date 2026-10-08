import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { SyncRouteSend } from "@agency_hub_core/db";
import { FANSLY_WIRE_IDS, FANSLY_WIRE_SPECS, type FanslyWireId } from "@agency_hub_core/fansly";

import {
  EMPTY_ROUTE_STATE,
  lookaheadInstants,
  routeAdmissionView,
  routeExclusions,
  routeJournalLookbackMs,
  RouteClocks,
  routeStateOfHolds,
  routeStatusView,
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
import { pageHoldRow, resourceBreakerRow, routeHoldRows } from "./helpers/sync-holds.ts";

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
  return { routes };
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
    // `/account/stats/*`, the statistics pages of 2026-10: one family until their quota is measured.
    expect([...FANSLY_ROUTE_FAMILIES.creator_stats].sort()).toEqual(
      [...FANSLY_ROUTES.values()].filter((route) => route.template.startsWith("/account/stats/")).map((route) => route.route).sort(),
    );
    expect(familyOfRoute("stats.summary")).toBe("creator_stats");
    expect(familyOfRoute("earnings.transactions_account")).toBe("earnings");
  });
});

describe("the legacy send log's operations", () => {
  /** Every operation a legacy sender journaled, frozen when the last of them
   *  was deleted: the adapter's lanes and probes and the describer's guarded
   *  CDN hop (step 4, S4-20; until then this list was scanned from the
   *  adapter's code), the legacy socket connect and the W0 socket probes
   *  (S4-12). The send log keeps their rows, and a page's route budgets count
   *  them. */
  const LEGACY_OPERATIONS = [
    "account_lookup", "account_me", "account_media_bundles_by_ids_probe", "account_media_by_ids_probe",
    "account_media_orders_probe", "account_stats", "account_walls_probe", "automated_messages",
    "broadcast_scheduled_probe", "broadcast_stats_deleted_probe", "broadcast_stats_probe", "discovery_media_suggestions",
    "earnings_accounts", "earnings_monthly_stats", "earnings_monthlystats_accounts", "earnings_overview",
    "earnings_stats_accounts", "earnings_stats_window", "earnings_transactions", "followers", "gift_codes", "group_detail",
    "group_mediaoffers_probe", "list_items", "lists_account", "media_download", "media_offer_stats", "media_orderhistory",
    "mediastory_views_probe", "messages", "messaging_groups", "notifications_page", "payout_methods", "payout_requests",
    "polls_probe", "post_lookup", "post_replies", "post_tips", "recapstats_probe", "subscribers", "subscription_tiers",
    "timeline_posts", "tips_account_probe", "tracking_links", "uservault_albums", "vault_albums", "vault_media",
    "ws_connect", "ws_probe",
  ];

  /** The captures of the step-1 guard left in the runtime's senders. */
  function guardCapturesInCode(): string[] {
    let captures = "";
    try {
      captures = execFileSync("grep", ["-rhoE", String.raw`operation: "[a-z_]+", requestTimeoutMs|acquire\(\{ operation: "[a-z_]+"`,
        "apps/runtime/src/services", "apps/runtime/src/sync", "apps/runtime/src/modules", "apps/runtime/src/cli.ts"], { encoding: "utf8" });
    } catch (error) {
      // grep exits 1 when nothing matches.
      if ((error as { status?: number }).status !== 1) throw error;
    }
    return [...captures.matchAll(/operation: "([a-z_]+)"/g)].map((match) => match[1]!).sort();
  }

  it("maps every operation the send log holds from a deleted legacy sender, and no other", () => {
    expect(Object.keys(FANSLY_LEGACY_OPERATION_ROUTES).sort()).toEqual([...LEGACY_OPERATIONS].sort());
    for (const route of Object.values(FANSLY_LEGACY_OPERATION_ROUTES)) expect(FANSLY_ROUTES.has(route), route).toBe(true);
    // No sender captures a page's guard any more: a new one would journal an
    // operation this map does not know.
    expect(guardCapturesInCode()).toEqual([]);
    // The one writer the send log still has is the identity check of a session
    // without a page, under the wire spec's own legacy operation.
    expect(readFileSync("apps/runtime/src/sync/fansly/identity-without-page.ts", "utf8")).toContain("operation: spec.legacyOperation,");
    expect(LEGACY_OPERATIONS).toContain(FANSLY_WIRE_SPECS["account.me"].legacyOperation);
  });

  it("each wire spec's legacy operation is its own route", () => {
    for (const id of FANSLY_WIRE_IDS) {
      const operation = FANSLY_WIRE_SPECS[id].legacyOperation;
      // A route no legacy sender read has no operation in the send log.
      if (operation === null) continue;
      expect(routeOfLegacyOperation(operation), id).toBe(id);
    }
    // Those routes are the statistics pages of 2026-10 and nothing else.
    expect(FANSLY_WIRE_IDS.filter((id) => FANSLY_WIRE_SPECS[id].legacyOperation === null))
      .toEqual([...FANSLY_ROUTE_FAMILIES.creator_stats, "earnings.transactions_account"]);
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
    expect(ROUTE_POLICY_HASH).toBe("83f306f5bb015298cd49dc9e99d65cffd71bd9c3fb8bc11c429736854c0f3495");
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
    const why = routeAdmissionView(clocks, specs, NOW);
    expect(why.keyOpensAt("dm-conversations.find")).toEqual({ at: at(3_000), routes: ["group.detail", "messaging.groups"], held: [] });
    // A route a 429 holds is named as held too.
    const listHeld = new RouteClocks({ sends: [], state: state({ "messaging.groups": entry({ holdUntil: at(9_000).toISOString() }) }) });
    const heldView = routeAdmissionView(listHeld, [...specs, { key: "dm-conversations.head", operations: ["messaging.groups"] }], NOW);
    expect(heldView.keyOpensAt("dm-conversations.head")).toEqual({ at: at(9_000), routes: ["messaging.groups"], held: ["messaging.groups"] });
    expect(why.keyOpensAt("media-stats.walk")).toBeNull();
    expect(why.keyOpensAt("probe.manual")).toBeNull();
    // One route, as the final check of a planned request asks: its budget's
    // interval, or its hold.
    expect(why.routeOpensAt("messaging.groups")).toEqual({ at: at(4_000), routes: ["messaging.groups"], held: [] });
    expect(why.routeOpensAt("polls")).toEqual({ at: at(9_000), routes: ["polls"], held: ["polls"] });
    expect(why.routeOpensAt("media.offer_stats")).toBeNull();
    expect(heldView.routeOpensAt("messaging.groups")).toEqual({ at: at(9_000), routes: ["messaging.groups"], held: ["messaging.groups"] });
    const status = routeStatusView(clocks, null, NOW);
    expect(status.policyHash).toBe(ROUTE_POLICY_HASH);
    expect(status.routes.map((route) => route.name)).toEqual(["messaging.groups", "polls", "family:messaging", "family:earnings", "family:creator_stats"]);
    expect(status.routes[0]).toEqual({
      name: "messaging.groups", family: "messaging", ceilingPerMin: 12, currentPerMin: 12, effectivePerMin: 12, intervalMs: 5_000,
      lastSendAt: at(-1_000).toISOString(), holdUntil: null, ladderStep: null, last429At: null, revision: null, opensAt: at(4_000).toISOString(),
    });
    expect(status.routes[1]).toMatchObject({
      name: "polls", holdUntil: at(9_000).toISOString(), ladderStep: 0, revision: 1, opensAt: at(9_000).toISOString(),
    });
    expect(status.routes[2]).toMatchObject({ name: "family:messaging", opensAt: at(3_000).toISOString() });
    expect(status.routes[3]).toMatchObject({ name: "family:earnings", lastSendAt: null, opensAt: null });
    expect(status.routes[4]).toMatchObject({ name: "family:creator_stats", ceilingPerMin: 12, currentPerMin: 5, intervalMs: 12_000, lastSendAt: null, opensAt: null });
    expect(routeStatusView(null, "route_state_routes", NOW)).toEqual({ policyHash: ROUTE_POLICY_HASH, stateError: "route_state_routes", routes: [] });
  });
});
