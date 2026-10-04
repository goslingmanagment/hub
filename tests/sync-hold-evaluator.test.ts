import { describe, expect, it } from "vitest";

import type { SyncHoldRow, SyncRouteSend } from "@agency_hub_core/db";
import { credentialsFailureDetail, INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import { pickExclusions } from "../apps/runtime/src/sync/engine/actor.ts";
import {
  EMPTY_HOLD_SET,
  heldByScope,
  holdSetOf,
  pageHoldsInForce,
  resourceFilesHeld,
  whyHeld,
  type RouteAdmissionView,
} from "../apps/runtime/src/sync/engine/admission.ts";
import { createEngineRegistry, type EngineResourceSpec, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { routeAdmissionView, RouteClocks, type RouteKeySpec } from "../apps/runtime/src/sync/engine/route-policy.ts";
import { pageHoldRow, resourceBreakerRow, routeHoldRows } from "./helpers/sync-holds.ts";

// The hold evaluator (step 4, owner decision №26): one answer to "what holds
// this request now?" over a page's hold set and its route clocks, asked by
// the actor's gate, its pick, its final check and the admission transaction,
// status and "why waiting", the alerts, the history requests and the metrics.
// What each scope's rule is has its own file's tests (the page-hold core:
// sync-page-holds; the route admission: sync-route-policy; the breakers:
// sync-engine-errors); here, how they compose, call site by call site.

const NOW = new Date("2026-10-04T12:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const engineSend = (operation: string, agoMs: number): SyncRouteSend => ({ journal: "engine", operation, lastAt: at(-agoMs) });

const authRow = (digest: string | null = "gen-b") =>
  pageHoldRow("auth", INDEFINITE_UNTIL, { since: at(-10 * MIN), detail: credentialsFailureDetail({ attemptId: 7, at: at(-MIN), digest }) });
const networkRow = (untilMs: number) => pageHoldRow("network", at(untilMs), { since: at(-MIN), detail: { streak: 3 } });

const specs: RouteKeySpec[] = [
  { key: "dm-conversations.head", operations: ["messaging.groups"] },
  { key: "dm-conversations.find", operations: ["messaging.groups", "group.detail"] },
  { key: "dm-messages.head", operations: ["messages.page"] },
  { key: "dm-messages.catchup", operations: ["messages.page"] },
  { key: "media-stats.walk", operations: ["media.offer_stats"] },
  { key: "probe.manual" },
];

/** The page's route admission at `NOW`: its rows' route state and the sends. */
function routesOf(rows: readonly SyncHoldRow[], sends: readonly SyncRouteSend[] = []): RouteAdmissionView {
  const holds = holdSetOf(rows);
  if (!holds.routes.ok) throw new Error(holds.routes.diagnostic);
  return routeAdmissionView(new RouteClocks({ sends, state: holds.routes.state }), specs, NOW);
}

describe("the hold set as the engine reads it", () => {
  it("a page that holds nothing holds nothing", () => {
    expect(holdSetOf([])).toEqual(EMPTY_HOLD_SET);
    expect(EMPTY_HOLD_SET).toEqual({ page: { credentials: null, timed: null }, resources: {}, routes: { ok: true, state: { routes: {} } }, unreadable: [] });
    expect(whyHeld(EMPTY_HOLD_SET, null, {}, NOW)).toBeNull();
    expect(pageHoldsInForce(EMPTY_HOLD_SET, NOW)).toBeNull();
  });

  it("sorts its rows by scope: the page's own holds, the breakers by file, the routes' state", () => {
    const holds = holdSetOf([
      authRow(),
      networkRow(30_000),
      resourceBreakerRow("transactions", at(30 * MIN), { step: 2, since: at(-MIN) }),
      ...routeHoldRows("messaging.groups", { holdUntil: at(5_000).toISOString(), effectivePerMin: 6, revision: 3 }),
    ]);
    expect(holds.page.credentials).toMatchObject({ kind: "auth", failure: { attemptId: 7, digest: "gen-b" } });
    expect(holds.page.timed).toMatchObject({ kind: "network", until: at(30_000) });
    expect(holds.resources).toEqual({ transactions: { until: at(30 * MIN), step: 2, since: at(-MIN) } });
    expect(holds.routes).toMatchObject({ ok: true, state: { routes: { "messaging.groups": { effectivePerMin: 6, revision: 3 } } } });
    expect(holds.unreadable).toEqual([]);
  });

  it("a row of a scope or kind this build does not know keeps the page closed until its end — for good when it names none", () => {
    for (const row of [
      pageHoldRow("maintenance", at(MIN)),
      { ...pageHoldRow("network", at(MIN)), key: "x" },
      { ...resourceBreakerRow("posts", at(MIN)), kind: "resource_quota" },
      { ...pageHoldRow("network", at(MIN)), scope: "fan", key: "f1" },
    ]) {
      const holds = holdSetOf([row]);
      const diagnostic = `hold_row:${row.scope}:${row.key}:${row.kind}`;
      expect(holds.unreadable, diagnostic).toEqual([{ diagnostic, until: at(MIN), routeState: false }]);
      expect(whyHeld(holds, null, { operation: { kind: "candidate_check" } }, NOW))
        .toEqual({ scope: "page", kind: "unreadable", until: at(MIN), diagnostic, routeState: false });
      expect(whyHeld(holds, null, {}, at(MIN))).toBeNull();
    }
    const forGood = holdSetOf([pageHoldRow("maintenance", null), pageHoldRow("frozen", at(MIN))]);
    expect(whyHeld(forGood, null, {}, at(365 * 24 * 60 * MIN))).toMatchObject({ kind: "unreadable", until: null, diagnostic: "hold_row:page::maintenance" });
    // The latest end of those that name one.
    const two = holdSetOf([pageHoldRow("frozen", at(MIN)), pageHoldRow("maintenance", at(5 * MIN))]);
    expect(whyHeld(two, null, {}, NOW)).toMatchObject({ until: at(5 * MIN), diagnostic: "hold_row:page::maintenance" });
  });

  it("route rows of a known route it cannot read close the page with no end, before anything else", () => {
    const holds = holdSetOf([authRow(), ...routeHoldRows("messages.page", { effectivePerMin: 0 })]);
    expect(holds.routes).toEqual({ ok: false, diagnostic: "route_state_entry:messages.page" });
    expect(whyHeld(holds, null, { operation: { kind: "candidate_check" } }, NOW))
      .toEqual({ scope: "page", kind: "unreadable", until: null, diagnostic: "route_state_entry:messages.page", routeState: true });
  });
});

describe("the gate: what holds the page itself", () => {
  it("a network hold stops everything until its end, alone or beside a credentials hold", () => {
    for (const rows of [[networkRow(30_000)], [authRow(), networkRow(30_000)]]) {
      const holds = holdSetOf(rows);
      for (const operation of [{ kind: "request" }, { kind: "candidate_check" }, { kind: "verify", digest: "gen-c" }] as const) {
        expect(whyHeld(holds, null, { operation }, NOW)).toMatchObject({ scope: "page", kind: "network", until: at(30_000) });
      }
    }
    expect(whyHeld(holdSetOf([networkRow(30_000)]), null, {}, at(30_000))).toBeNull();
  });

  it("a credentials hold stops everything but the identity checks it admits (A3)", () => {
    const holds = holdSetOf([authRow("gen-b")]);
    expect(whyHeld(holds, null, {}, NOW)).toMatchObject({ scope: "credentials", kind: "auth", until: INDEFINITE_UNTIL, hold: { failure: { digest: "gen-b" } } });
    expect(whyHeld(holds, null, { operation: { kind: "candidate_check" } }, NOW)).toBeNull();
    // The verify of stored credentials other than the refused ones, once.
    expect(whyHeld(holds, null, { operation: { kind: "verify", digest: "gen-c" } }, NOW)).toBeNull();
    expect(whyHeld(holds, null, { operation: { kind: "verify", digest: "gen-b" } }, NOW)).toMatchObject({ scope: "credentials" });
    expect(whyHeld(holds, null, { operation: { kind: "verify", digest: null } }, NOW)).toMatchObject({ scope: "credentials" });
    // Once the network hold beside it ended, the credentials hold is what holds.
    expect(whyHeld(holdSetOf([authRow(), networkRow(30_000)]), null, {}, at(30_000))).toMatchObject({ scope: "credentials", kind: "auth" });
  });

  it("names every hold of the page in force for the alerts and the metrics", () => {
    const both = holdSetOf([authRow(), networkRow(30_000), pageHoldRow("maintenance", at(MIN))]);
    expect(pageHoldsInForce(both, NOW)).toMatchObject({
      unreadable: { diagnostic: "hold_row:page::maintenance" },
      credentials: { kind: "auth" },
      timed: { kind: "network" },
    });
    expect(pageHoldsInForce(both, at(MIN))).toMatchObject({ unreadable: null, credentials: { kind: "auth" }, timed: null });
    expect(pageHoldsInForce(holdSetOf([networkRow(-1)]), NOW)).toBeNull();
  });
});

describe("the pick: what a slot leaves out", () => {
  const noop = (async () => ({})) as unknown as () => Promise<ResourceModule>;
  const spec = (key: string): EngineResourceSpec =>
    ({ key, kind: "trigger", class: "urgent", http: true, evidence: false, fence: "none", module: noop });
  const registry = createEngineRegistry([spec("dm-messages.head"), spec("dm-messages.catchup"), spec("transactions.head"), spec("posts.refresh")]);
  const page = (holds: SyncHoldRow[]) => ({ pausedResources: [], registryOverrides: {}, holds });

  it("the files whose breaker is in force — never the key a breaker does not stop, never one that ended", () => {
    const rows = [
      resourceBreakerRow("transactions", at(MIN)),
      resourceBreakerRow("dm-messages", at(MIN)),
      resourceBreakerRow("posts", at(-1)),
    ];
    expect(resourceFilesHeld(holdSetOf(rows), NOW)).toEqual(["dm-messages", "transactions"]);
    expect(pickExclusions(page(rows), registry, NOW)).toEqual({
      excludeResources: ["dm-messages.catchup"],
      excludeFiles: ["transactions"],
      excludeClasses: [],
    });
    // The work a pick fetched is judged by the same rule.
    const holds = holdSetOf(rows);
    expect(heldByScope(holds, null, { work: { resource: "transactions.head" } }, NOW).resource)
      .toEqual({ scope: "resource", kind: "resource_breaker", until: at(MIN), file: "transactions", step: 1 });
    expect(heldByScope(holds, null, { work: { resource: "dm-messages.head" } }, NOW).resource).toBeNull();
    expect(heldByScope(holds, null, { work: { resource: "posts.refresh" } }, NOW).resource).toBeNull();
  });

  it("a key all of whose routes are closed: `route_hold` when a 429 holds one of them, `route_budget` when only their pace does", () => {
    const rows = routeHoldRows("messaging.groups", { holdUntil: at(300_000).toISOString(), effectivePerMin: 6 });
    const held = routesOf(rows);
    expect(whyHeld(holdSetOf(rows), held, { work: { resource: "dm-conversations.head" } }, NOW))
      .toEqual({ scope: "route_hold", kind: "route", until: at(300_000), routes: ["messaging.groups"], held: ["messaging.groups"] });
    // Another route of the key is open: the key is not held.
    expect(whyHeld(holdSetOf(rows), held, { work: { resource: "dm-conversations.find" } }, NOW)).toBeNull();
    // Only the budgets' intervals close it: the key waits for its route's pace.
    const paced = routesOf([], [engineSend("media.offer_stats", 2_000)]);
    expect(whyHeld(EMPTY_HOLD_SET, paced, { work: { resource: "media-stats.walk" } }, NOW))
      .toEqual({ scope: "route_budget", kind: "route", until: at(10_000), routes: ["media.offer_stats"], held: [] });
    // A key that declares no route is never left out by its routes.
    expect(whyHeld(EMPTY_HOLD_SET, paced, { work: { resource: "probe.manual" } }, NOW)).toBeNull();
  });
});

describe("the final check of a planned request, and the admission", () => {
  it("the planned route itself: its hold, else its budget's interval — whatever the key's other routes", () => {
    const rows = routeHoldRows("messaging.groups", { holdUntil: at(9_000).toISOString() });
    const routes = routesOf(rows, [engineSend("group.detail", 1_000)]);
    const holds = holdSetOf(rows);
    // The key is open (its detail route admits), the list read it planned is not.
    expect(whyHeld(holds, routes, { work: { resource: "dm-conversations.find" }, plannedRoute: "messaging.groups" }, NOW))
      .toEqual({ scope: "route_hold", kind: "route", until: at(9_000), routes: ["messaging.groups"], held: ["messaging.groups"] });
    expect(whyHeld(holds, routes, { work: { resource: "dm-conversations.find" }, plannedRoute: "group.detail" }, NOW))
      .toEqual({ scope: "route_budget", kind: "route", until: at(3_000), routes: ["group.detail"], held: [] });
    expect(whyHeld(holds, routes, { work: { resource: "media-stats.walk" }, plannedRoute: "media.offer_stats" }, NOW)).toBeNull();
    // Asked of a route alone (the history requests' one read route).
    expect(heldByScope(holds, routes, { plannedRoute: "messaging.groups" }, NOW).route).toMatchObject({ scope: "route_hold", until: at(9_000) });
  });

  it("the first of what holds it: the page, then the subject's breaker, the file's, the route", () => {
    const rows = [
      networkRow(30_000),
      resourceBreakerRow("dm-conversations", at(MIN)),
      ...routeHoldRows("messaging.groups", { holdUntil: at(9_000).toISOString() }),
    ];
    const holds = holdSetOf(rows);
    const routes = routesOf(rows);
    const work = { resource: "dm-conversations.head", breakerUntil: at(2 * MIN), blockedByVendorAt: null };
    const scopes = heldByScope(holds, routes, { work }, NOW);
    expect(scopes).toMatchObject({
      page: { scope: "page", kind: "network" },
      subject: { scope: "subject", kind: "subject_breaker", until: at(2 * MIN) },
      resource: { scope: "resource", file: "dm-conversations" },
      route: { scope: "route_hold" },
    });
    expect(whyHeld(holds, routes, { work }, NOW)).toEqual(scopes.page);
    expect(whyHeld(holds, routes, { work }, at(30_000))).toEqual(scopes.subject);
    expect(whyHeld(holds, routesOf(rows), { work: { ...work, breakerUntil: null } }, at(30_000))).toEqual(scopes.resource);
    expect(whyHeld(holdSetOf(rows.slice(2)), routes, { work: { resource: work.resource } }, NOW)).toEqual(scopes.route);
    // A request its planned route put off waits until its own due time: by a
    // hold when one holds a route of its key now, else by that route's pace.
    const putOff = { resource: "dm-conversations.find", putOffUntil: at(20_000) };
    expect(heldByScope(holdSetOf(rows.slice(2)), routes, { work: putOff }, NOW).route)
      .toEqual({ scope: "route_hold", kind: "route", until: at(20_000), routes: [], held: ["messaging.groups"] });
    expect(heldByScope(EMPTY_HOLD_SET, routesOf([]), { work: putOff }, NOW).route)
      .toEqual({ scope: "route_budget", kind: "route", until: at(20_000), routes: [], held: [] });
    expect(heldByScope(EMPTY_HOLD_SET, null, { work: putOff }, NOW).route).toMatchObject({ scope: "route_budget", until: at(20_000) });
    expect(heldByScope(EMPTY_HOLD_SET, routesOf([]), { work: { ...putOff, putOffUntil: at(-1) } }, NOW).route).toBeNull();
    // A subject Fansly keeps refusing is blocked whatever its breaker's end.
    expect(heldByScope(EMPTY_HOLD_SET, null, { work: { resource: "dm-messages.head", breakerUntil: at(-1), blockedByVendorAt: at(-MIN) } }, NOW).subject)
      .toEqual({ scope: "subject", kind: "blocked_by_vendor", until: at(-1) });
  });

  it("the admission's last word is the page's alone: the identity checks pass a credentials hold, nothing a network hold", () => {
    const credentials = holdSetOf([authRow("gen-b")]);
    expect(whyHeld(credentials, null, { operation: { kind: "request" } }, NOW)).toMatchObject({ kind: "auth", until: INDEFINITE_UNTIL });
    expect(whyHeld(credentials, null, { operation: { kind: "candidate_check" } }, NOW)).toBeNull();
    expect(whyHeld(holdSetOf([authRow("gen-b"), networkRow(1_000)]), null, { operation: { kind: "candidate_check" } }, NOW))
      .toMatchObject({ kind: "network", until: at(1_000) });
  });
});
