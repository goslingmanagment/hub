import { describe, expect, it } from "vitest";

import type { SyncHoldRow } from "@agency_hub_core/db";
import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import { holdSetOf, type RouteAdmissionView } from "../apps/runtime/src/sync/engine/admission.ts";
import {
  buildPageStatus,
  estimateSlotOpensAt,
  explainWork,
  OWNER_HEARTBEAT_FRESH_MS,
  ownerRunning,
  summarizeQueue,
  WAITING_REASONS,
  type RuntimeSnapshot,
  type StatusPage,
  type StatusWork,
} from "../apps/runtime/src/sync/engine/status.ts";
import { pageHoldRow, resourceBreakerRow, routeHoldRows } from "./helpers/sync-holds.ts";

// "Почему ждёт" (plan §10, design §3.9): the closed dictionary, its
// precedence, and the page status assembled from it.

const NOW = new Date("2026-10-02T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const OPEN_SLOT: RuntimeSnapshot = { slotOpensAt: null };

/** A page whose hold set is `rows` (`sync_holds`). */
function page(overrides: Partial<Omit<StatusPage, "holds">> = {}, rows: readonly SyncHoldRow[] = []): StatusPage {
  return {
    mode: "shadow",
    pausedAll: false,
    pausedRequests: false,
    pausedResources: [],
    holds: holdSetOf(rows),
    owner: {
      generation: 3n,
      host: "sync-1",
      acquiredAt: at(-3_600_000),
      heartbeatAt: at(-5_000),
      releasedAt: null,
      releaseGeneration: null,
    },
    ...overrides,
  };
}

let nextId = 1;
function work(overrides: Partial<StatusWork> = {}): StatusWork {
  return {
    id: nextId++,
    resource: "subscribers.poll",
    subject: "",
    class: "planned",
    state: "open",
    dueAt: at(-1_000),
    breakerUntil: null,
    blockedByVendorAt: null,
    waitingReason: null,
    waitingUntil: null,
    ...overrides,
  };
}

const reason = (w: StatusWork, p: StatusPage = page(), rt: RuntimeSnapshot = OPEN_SLOT) =>
  explainWork(w, p, rt, NOW)?.reason ?? null;

/** A route admission whose every key and route is closed by `closure`. */
function closedRoutes(closure: NonNullable<ReturnType<RouteAdmissionView["keyOpensAt"]>>): RouteAdmissionView {
  return { keyOpensAt: () => closure, routeOpensAt: () => closure, keyHeldRoutes: () => closure.held };
}

describe("sync status: the closed dictionary", () => {
  it("is plan §10's list and a route's two computed reasons, nothing more (endpoint_interval is gone)", () => {
    expect([...WAITING_REASONS].sort()).toEqual([
      "blocked_by_vendor",
      "class_share",
      "dependency",
      "not_due",
      "ownership_unconfirmed",
      "pacer",
      "page_hold",
      "paused",
      "quarantined",
      "resource_hold",
      "route_budget",
      "route_hold",
      "running",
      "subject_breaker",
    ]);
  });
});

describe("sync status: why a work row waits", () => {
  it("running first, whatever else holds", () => {
    expect(reason(work({ state: "running" }), page({ pausedAll: true, mode: "off" }))).toBe("running");
  });

  it("ownership_unconfirmed when no actor runs the page", () => {
    expect(reason(work(), page({ mode: "off" }))).toBe("ownership_unconfirmed");
    expect(reason(work(), page({ mode: "handover" }))).toBe("ownership_unconfirmed");
    const stale = page();
    stale.owner.heartbeatAt = at(-OWNER_HEARTBEAT_FRESH_MS - 1);
    expect(reason(work(), stale)).toBe("ownership_unconfirmed");
    const released = page();
    released.owner.releasedAt = at(-1_000);
    released.owner.releaseGeneration = released.owner.generation;
    expect(reason(work(), released)).toBe("ownership_unconfirmed");
    const neverOwned = page();
    neverOwned.owner.generation = 0n;
    expect(reason(work(), neverOwned)).toBe("ownership_unconfirmed");
  });

  it("an old generation's release does not count against the current owner", () => {
    const p = page();
    p.owner.releasedAt = at(-60_000);
    p.owner.releaseGeneration = 2n;
    expect(ownerRunning(p, NOW)).toBe(true);
  });

  it("paused: the page, the requests class, or the resource", () => {
    expect(explainWork(work(), page({ pausedAll: true }), OPEN_SLOT, NOW)).toMatchObject({ reason: "paused", detail: { scope: "page" } });
    expect(explainWork(work({ class: "requests", resource: "dm-messages.history" }), page({ pausedRequests: true }), OPEN_SLOT, NOW))
      .toMatchObject({ reason: "paused", detail: { scope: "requests" } });
    expect(reason(work({ class: "planned" }), page({ pausedRequests: true }))).toBe("class_share");
    expect(explainWork(work(), page({ pausedResources: ["subscribers.poll"] }), OPEN_SLOT, NOW))
      .toMatchObject({ reason: "paused", detail: { scope: "resource" } });
  });

  it("page_hold, with the hold's end", () => {
    const held = page({}, [pageHoldRow("network", at(120_000))]);
    expect(explainWork(work(), held, OPEN_SLOT, NOW)).toEqual({ reason: "page_hold", until: at(120_000), detail: { kind: "network" } });
    expect(reason(work(), page({}, [pageHoldRow("network", at(-1))]))).toBe("class_share");
    // A credentials hold is in force until an identity proof clears it,
    // whatever digest the engine trusts since (ruling 5).
    expect(explainWork(work(), page({}, [pageHoldRow("auth", INDEFINITE_UNTIL, { detail: { credentialsGeneration: "gen-0" } })]), OPEN_SLOT, NOW))
      .toEqual({ reason: "page_hold", until: INDEFINITE_UNTIL, detail: { kind: "auth" } });
    // A network hold beside it is named first: nothing goes out before it ends.
    const both = page({}, [pageHoldRow("auth"), pageHoldRow("network", at(30_000))]);
    expect(explainWork(work(), both, OPEN_SLOT, NOW)).toEqual({ reason: "page_hold", until: at(30_000), detail: { kind: "network" } });
  });

  it("page_hold for rows of the hold set this build cannot read: until their end, for good when they name none", () => {
    const unknownKind = page({}, [pageHoldRow("maintenance", at(90_000))]);
    expect(explainWork(work(), unknownKind, OPEN_SLOT, NOW))
      .toEqual({ reason: "page_hold", until: at(90_000), detail: { holdSet: "hold_row:page::maintenance" } });
    expect(reason(work(), page({}, [pageHoldRow("maintenance", at(-1))]))).toBe("class_share");
    const routeState = page({}, routeHoldRows("messaging.groups", { effectivePerMin: -1 }));
    expect(explainWork(work(), routeState, OPEN_SLOT, NOW))
      .toEqual({ reason: "page_hold", until: null, detail: { holdSet: "route_state_entry:messaging.groups" } });
  });

  it("then quarantined, blocked_by_vendor, subject_breaker, resource_hold, in that order", () => {
    const breaker = [resourceBreakerRow("subscribers", at(60_000), { step: 1, since: at(-60_000) })];
    expect(reason(work({ state: "quarantined", blockedByVendorAt: at(-1) }))).toBe("quarantined");
    expect(explainWork(work({ blockedByVendorAt: at(-5_000), breakerUntil: at(86_000_000) }), page(), OPEN_SLOT, NOW))
      .toMatchObject({ reason: "blocked_by_vendor", until: at(86_000_000), detail: { since: at(-5_000).toISOString() } });
    expect(explainWork(work({ breakerUntil: at(60_000) }), page({}, breaker), OPEN_SLOT, NOW))
      .toMatchObject({ reason: "subject_breaker", until: at(60_000) });
    expect(explainWork(work(), page({}, breaker), OPEN_SLOT, NOW))
      .toMatchObject({ reason: "resource_hold", until: at(60_000), detail: { file: "subscribers", step: 1, kind: "breaker" } });
  });

  it("a resource hold never stops dm-messages.head", () => {
    const breaker = [resourceBreakerRow("dm-messages", at(60_000))];
    expect(reason(work({ resource: "dm-messages.head", class: "urgent" }), page({}, breaker))).toBe("class_share");
    expect(reason(work({ resource: "dm-messages.catchup" }), page({}, breaker))).toBe("resource_hold");
  });

  it("dependency and not_due wait for their time", () => {
    expect(explainWork(work({ waitingReason: "dependency", dueAt: at(30_000), waitingUntil: null }), page(), OPEN_SLOT, NOW))
      .toMatchObject({ reason: "dependency", until: at(30_000) });
    expect(explainWork(work({ dueAt: at(30_000) }), page(), OPEN_SLOT, NOW)).toMatchObject({ reason: "not_due", until: at(30_000) });
    // A dependency wait whose time came is runnable again (the resource re-plans).
    expect(reason(work({ waitingReason: "dependency", dueAt: at(-1) }))).toBe("class_share");
  });

  it("a runnable row waits for the pacer while the slot is closed, otherwise for its share", () => {
    expect(explainWork(work(), page(), { slotOpensAt: at(1_500) }, NOW)).toMatchObject({ reason: "pacer", until: at(1_500) });
    expect(reason(work(), page(), { slotOpensAt: at(-1) })).toBe("class_share");
    expect(reason(work())).toBe("class_share");
  });

  it("a key without requests never waits on the page hold or the pacer: it steps before the gate (ruling 9)", () => {
    const deletion = (overrides: Partial<StatusWork> = {}) =>
      work({ resource: "dm-live.deletions", class: "urgent", http: false, ...overrides });
    const closed = { slotOpensAt: at(1_500) };
    for (const held of [
      page({}, [pageHoldRow("network", at(30_000))]),
      page({}, [pageHoldRow("auth", INDEFINITE_UNTIL, { detail: { credentialsGeneration: "gen-1" } })]),
      page({}, [pageHoldRow("auth"), pageHoldRow("network", at(30_000))]),
    ]) {
      expect(explainWork(deletion(), held, closed, NOW)).toEqual({ reason: "class_share", until: null, detail: { class: "urgent" } });
      // A busy erasure fence is what it waits for, not the hold.
      expect(explainWork(deletion({ waitingReason: "dependency", dueAt: at(1_000) }), held, closed, NOW))
        .toMatchObject({ reason: "dependency", until: at(1_000) });
      // The owner's pauses still stop it; a key that sends still waits on the hold.
      expect(explainWork(deletion(), { ...held, pausedAll: true }, closed, NOW)).toMatchObject({ reason: "paused" });
      expect(reason(deletion(), { ...held, pausedResources: ["dm-live.deletions"] }, closed)).toBe("paused");
      expect(reason(work({ http: true }), held, closed)).toBe("page_hold");
    }
    expect(reason(deletion({ state: "quarantined" }), page({}, [pageHoldRow("network", at(30_000))]))).toBe("quarantined");
    // Nor on the route admission: a route state this build cannot read, or
    // closed routes, delay the requests only.
    const unreadable = page({}, routeHoldRows("messaging.groups", { effectivePerMin: -1 }));
    expect(reason(deletion(), unreadable)).toBe("class_share");
    expect(reason(work({ http: true }), unreadable)).toBe("page_hold");
    const budgetClosed: RuntimeSnapshot = { slotOpensAt: null, routes: closedRoutes({ at: at(30_000), routes: ["messaging.groups"], held: [] }) };
    expect(reason(deletion(), page(), budgetClosed)).toBe("class_share");
    expect(reason(work({ http: true }), page(), budgetClosed)).toBe("route_budget");
  });

  it("a route's budget and a route's hold are told apart: route_budget, route_hold with its deadline", () => {
    const budget: RuntimeSnapshot = { slotOpensAt: null, routes: closedRoutes({ at: at(4_000), routes: ["messaging.groups"], held: [] }) };
    expect(explainWork(work({ resource: "dm-conversations.head" }), page(), budget, NOW))
      .toEqual({ reason: "route_budget", until: at(4_000), detail: { routes: ["messaging.groups"] } });
    const held: RuntimeSnapshot = {
      slotOpensAt: null,
      routes: closedRoutes({ at: at(300_000), routes: ["messaging.groups"], held: ["messaging.groups"] }),
    };
    expect(explainWork(work({ resource: "dm-conversations.head" }), page(), held, NOW))
      .toEqual({ reason: "route_hold", until: at(300_000), detail: { routes: ["messaging.groups"], held: ["messaging.groups"] } });
    // A request its planned route put off stores `pacer`; it is named by what
    // keeps its key's routes closed, and waits until its own due time.
    const putOff = work({ resource: "dm-conversations.head", waitingReason: "pacer", dueAt: at(9_000) });
    expect(explainWork(putOff, page(), held, NOW))
      .toEqual({ reason: "route_hold", until: at(9_000), detail: { routes: ["messaging.groups"], held: ["messaging.groups"] } });
    expect(explainWork(putOff, page(), budget, NOW)).toEqual({ reason: "route_budget", until: at(9_000), detail: { routes: ["messaging.groups"] } });
    // Another route of its key is open now, but the one it planned is held.
    const oneHeld: RuntimeSnapshot = { slotOpensAt: null, routes: { keyOpensAt: () => null, routeOpensAt: () => null, keyHeldRoutes: () => ["messaging.groups"] } };
    expect(explainWork({ ...putOff, resource: "dm-conversations.find" }, page(), oneHeld, NOW))
      .toEqual({ reason: "route_hold", until: at(9_000), detail: { routes: [], held: ["messaging.groups"] } });
    // The route clocks not read: its route's pace, as far as anyone knows.
    expect(explainWork(putOff, page(), OPEN_SLOT, NOW)).toEqual({ reason: "route_budget", until: at(9_000), detail: { routes: [] } });
    // The page's own hold, a breaker and the due time come first.
    expect(reason(work({ resource: "dm-conversations.head" }), page({}, [pageHoldRow("auth")]), held)).toBe("page_hold");
    expect(reason(work({ resource: "dm-conversations.head", dueAt: at(1_000) }), page(), held)).toBe("not_due");
  });

  it("closed work waits for nothing", () => {
    for (const state of ["done", "cancelled", "superseded"] as const) {
      expect(explainWork(work({ state }), page(), OPEN_SLOT, NOW)).toBeNull();
    }
  });
});

describe("sync status: estimates and summaries", () => {
  it("estimates the next slot from the database facts with the largest jitter", () => {
    expect(estimateSlotOpensAt({ lastSendAt: null, lastCompletedAt: null, settingMs: 2_000 })).toBeNull();
    expect(estimateSlotOpensAt({ lastSendAt: NOW, lastCompletedAt: at(300), settingMs: 2_000 })).toEqual(at(2_400));
    expect(estimateSlotOpensAt({ lastSendAt: NOW, lastCompletedAt: at(9_000), settingMs: 2_000 })).toEqual(at(9_000));
  });

  it("counts open work by class: runnable, and waiting by reason", () => {
    const works = [
      work({ class: "urgent", resource: "dm-messages.head" }),
      work({ class: "urgent", resource: "transactions.head", breakerUntil: at(60_000) }),
      work({ class: "planned", dueAt: at(60_000) }),
      work({ class: "planned", state: "running" }),
      work({ class: "planned", state: "done" }),
    ];
    expect(summarizeQueue(works, page(), OPEN_SLOT, NOW)).toEqual({
      urgent: { runnable: 1, waitingByReason: { class_share: 1, subject_breaker: 1 } },
      requests: { runnable: 0, waitingByReason: {} },
      planned: { runnable: 0, waitingByReason: { not_due: 1, running: 1 } },
    });
  });

  it("assembles the page status", () => {
    const p = {
      ...page({}, [
        pageHoldRow("auth", INDEFINITE_UNTIL, { since: at(-60_000), detail: { credentialsGeneration: "gen-1" } }),
        resourceBreakerRow("media-stats", at(600_000), { step: 1, since: at(-60_000) }),
        resourceBreakerRow("catalog", at(-1), { step: 2, since: at(-9_000_000) }),
      ]),
      lastSendAt: at(-10_000),
    };
    const status = buildPageStatus({
      pageLabel: "lora-1",
      page: p,
      settingMs: 2_000,
      now: NOW,
      runtime: OPEN_SLOT,
      works: [
        work({ state: "quarantined" }),
        work({ breakerUntil: at(60_000) }),
        work({ blockedByVendorAt: at(-1), breakerUntil: at(86_000_000) }),
      ],
      sends: { lastHour: { urgent: 4, requests: 0, planned: 9, byResource: { "subscribers.poll": 1 } }, minGapLastHourMs: 2_013, violationsLastDay: 0 },
    });
    expect(status).toMatchObject({
      pageLabel: "lora-1",
      mode: "shadow",
      owner: { generation: "3", host: "sync-1", running: true },
      pause: { settingMs: 2_000, lastSendAt: at(-10_000).toISOString(), minGapLastHourMs: 2_013, violationsLastDay: 0 },
      holds: {
        page: { kind: "auth", until: "infinity", since: at(-60_000).toISOString() },
        resources: [{ file: "media-stats", until: at(600_000).toISOString(), step: 1 }],
      },
      breakers: { open: 1, blockedByVendor: 1 },
      quarantined: 1,
      requests: [],
      ws: null,
      shadow: null,
    });
    expect(status.queue.planned.waitingByReason).toEqual({ page_hold: 3 });
    expect(JSON.parse(JSON.stringify(status))).toEqual(status);
  });
});
