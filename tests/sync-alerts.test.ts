import { describe, expect, it } from "vitest";

import {
  incidentTitleForKind,
  resolveMessageForIncident,
  SYNC_ENGINE_PACE_VIOLATION_SUBKEY,
  syncEngineIncidentKey,
  syncEngineRouteSubKey,
} from "../apps/runtime/src/services/notification-incidents.ts";
import { notificationPagingPolicyFor } from "../apps/runtime/src/services/notification-paging-policy.ts";
import { parseReportWindow } from "../apps/runtime/src/sync/cli/report.ts";
import {
  evaluatePageAlerts,
  evaluateRouteAlerts,
  SYNC_ALERT_CLEAN_MS,
  SYNC_HANDOVER_STUCK_MS,
  SYNC_OWNERSHIP_UNCONFIRMED_MS,
  SYNC_SOCKET_DOWN_MS,
  syncAlertResolveAfterMs,
  type PageAlertFacts,
} from "../apps/runtime/src/sync/engine/alerts.ts";
import { NETWORK_ALERT_AFTER_MS } from "../apps/runtime/src/sync/engine/errors.ts";
import { OWNERSHIP_ALERT_AFTER_MS } from "../apps/runtime/src/sync/engine/host.ts";
import { quantileOf, syncMetricsDue } from "../apps/runtime/src/sync/engine/metrics.ts";
import { POLL_JITTER } from "../apps/runtime/src/sync/engine/resource.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import { TIMELINE_PAGE_ESTIMATE } from "../apps/runtime/src/sync/fansly/resources/posts.ts";
import { moneyFramesMissing } from "../apps/runtime/src/sync/fansly/ws/money-frames.ts";
import { routeThreadAt } from "../apps/runtime/src/sync/fansly/ws/route-receipt.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import type { PurchaseAnnouncementCheck } from "../apps/runtime/src/sync/report/purchase-announcements.ts";
import { REPLAY_EXCUSED_REASONS, scoreReplayKind } from "../apps/runtime/src/sync/report/shadow-journal.ts";
import {
  DEMAND_REPLACED_STREAMS,
  demandOfPage,
  isOneTimeWalk,
  judgePollRuns,
  LEGACY_REGIME_SINCE,
  legacyComparisonBasis,
  legacyCounterparts,
  legacyVolumeRow,
  isQueueWalk,
  LOOK_CLOCK_TOLERANCE_MS,
  PAGE_CAPACITY_PER_HOUR,
  POLL_RUN_GAP_MS,
  pollScheduleFault,
  QUEUE_WALK_DRIVERS,
  queueOnSchedule,
  rateCount,
  recurrenceMs,
  runGroupingOf,
  runsOf,
  SHADOW_SETTLE_MS,
  SHADOW_WINDOW_RULES,
  shadowWindowCoverage,
  simulateCoalescedReads,
  socketDemandText,
  standingWalkOnSchedule,
  type CounterpartCheck,
  type AssumedRun,
  type KeyRun,
  type QueueFact,
  type RunAttempt,
  type ScheduleRow,
} from "../apps/runtime/src/sync/report/shadow-window.ts";

// The Fansly Sync Engine's alerts 1–4 (plan §10, design §9.6) as pure rules,
// their incident wiring (titles, keys, paging) and the report's pure parts.

const NOW = new Date("2026-10-02T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MINUTE = 60_000;
const registry = createFanslyRegistry();

function facts(overrides: {
  page?: Partial<PageAlertFacts["page"]>;
  journal?: Partial<PageAlertFacts["journal"]>;
  live?: Partial<PageAlertFacts["live"]>;
  money?: PageAlertFacts["money"];
} = {}): PageAlertFacts {
  return {
    now: NOW,
    page: {
      pageId: 7,
      mode: "live",
      modeChangedAt: at(-24 * 60 * MINUTE),
      holdKind: null,
      holdUntil: null,
      holdSince: null,
      holdDetail: {},
      resourceHolds: {},
      pausedAll: false,
      pausedRequests: false,
      pausedResources: [],
      registryOverrides: {},
      owner: {
        generation: 4n,
        instance: null,
        host: "sync-1",
        pid: 1,
        pidStart: null,
        pidNs: null,
        bootId: null,
        acquiredAt: at(-60 * MINUTE),
        heartbeatAt: at(-5_000),
        releasedAt: null,
        releaseGeneration: null,
        stopConfirmedAt: null,
        stopConfirmedBy: null,
      },
      ...overrides.page,
    },
    journal: {
      lastStopAttempt: null,
      quarantined: {},
      urgentWaiting: [],
      polls: [],
      ledgerIncomplete: null,
      stalledRequests: [],
      ...overrides.journal,
    },
    live: {
      socket: { up: true, lastAliveAt: at(-1_000) },
      decode: { receipts: 200, debt: 0 },
      unconfirmed: { count: 0, oldestVisibleAt: null },
      ...overrides.live,
    },
    money: overrides.money ?? null,
  };
}

function routeEntry(overrides: Record<string, unknown> = {}) {
  return {
    holdUntil: null,
    ladderStep: 1,
    effectivePerMin: null,
    policyVersion: null,
    last429AttemptId: null,
    last429At: null,
    revision: 1,
    ...overrides,
  };
}

function evaluate(input: PageAlertFacts) {
  return Object.fromEntries(evaluatePageAlerts(input, registry).map((entry) => [entry.subKey, entry.detail]));
}

describe("alert rules (design §9.6)", () => {
  it("a healthy live page holds no alert", () => {
    expect(evaluatePageAlerts(facts(), registry)).toEqual([]);
  });

  it("alert 1: holds in force, most severe first, with every reason listed", () => {
    const held = facts({ page: { holdKind: "rate_limit", holdUntil: at(MINUTE), holdSince: at(-MINUTE) } });
    expect(evaluate(held)).toEqual({ page_stopped: "rate_limit" });
    expect(evaluate(facts({ page: { holdKind: "auth", holdUntil: new Date(8.64e15), holdSince: at(-MINUTE) } })))
      .toEqual({ page_stopped: "auth" });
    expect(evaluate(facts({ page: { holdKind: "identity_mismatch", holdUntil: new Date(8.64e15), holdSince: at(-MINUTE) } })))
      .toEqual({ page_stopped: "identity_mismatch" });
    // An ended hold is no hold.
    expect(evaluate(facts({ page: { holdKind: "rate_limit", holdUntil: at(-1), holdSince: at(-MINUTE) } }))).toEqual({});
  });

  it("alert 1: a 429 or network hold carried beside an auth hold is listed too", () => {
    const carried = (kind: string, untilMs: number, detail: Record<string, unknown> = {}) => facts({
      page: {
        holdKind: "auth",
        holdUntil: new Date(8.64e15),
        holdSince: at(-MINUTE),
        holdDetail: { credentialsGeneration: "gen-1", timedHold: { kind, until: at(untilMs).toISOString(), detail } },
      },
    });
    const reasons = (input: PageAlertFacts) => evaluatePageAlerts(input, registry)
      .flatMap((entry) => entry.reasons.map((reason) => reason.detail));
    expect(evaluate(carried("rate_limit", MINUTE, { lastRateLimitAt: at(-1_000).toISOString() }))).toEqual({ page_stopped: "auth" });
    expect(reasons(carried("rate_limit", MINUTE))).toEqual(["auth", "rate_limit"]);
    expect(reasons(carried("rate_limit", -1))).toEqual(["auth"]);
    expect(reasons(carried("network", MINUTE, { networkSince: at(-NETWORK_ALERT_AFTER_MS - MINUTE).toISOString() })))
      .toEqual(["auth", "network"]);
    expect(reasons(carried("network", MINUTE, { networkSince: at(-MINUTE).toISOString() }))).toEqual(["auth"]);
  });

  it("alert 1: a network hold pages only after 10 min without the network", () => {
    const network = (sinceMs: number) => facts({
      page: { holdKind: "network", holdUntil: at(MINUTE), holdSince: at(-MINUTE), holdDetail: { networkSince: at(-sinceMs).toISOString() } },
    });
    expect(evaluate(network(NETWORK_ALERT_AFTER_MS - MINUTE))).toEqual({});
    expect(evaluate(network(NETWORK_ALERT_AFTER_MS + MINUTE))).toEqual({ page_stopped: "network" });
  });

  it("alert 1: a route held by a 429 never stops the page — it is the route's own incident (D5)", () => {
    const held = facts({ page: { routeState: { version: 1, routes: { "messaging.groups": routeEntry({ holdUntil: at(300_000).toISOString() }) } } } });
    expect(evaluate(held)).toEqual({});
  });

  it("alert 1: '10 min clean' — a stop answer within the window keeps the alert after its hold ended", () => {
    const answeredAt = at(-SYNC_ALERT_CLEAN_MS + MINUTE);
    const recent = facts({ journal: { lastStopAttempt: { errorClass: "auth", at: answeredAt } } });
    expect(evaluate(recent)).toEqual({ page_stopped: "auth" });
    // It holds as of the answer, not now: the latch resolves 10 min after it.
    expect(evaluatePageAlerts(recent, registry)).toEqual([expect.objectContaining({ subKey: "page_stopped", seenAt: answeredAt })]);
    // A hold in force holds now, whatever the journal says.
    const held = facts({
      page: { holdKind: "rate_limit", holdUntil: at(MINUTE), holdSince: at(-MINUTE) },
      journal: { lastStopAttempt: { errorClass: "auth", at: answeredAt } },
    });
    expect(evaluatePageAlerts(held, registry)).toEqual([expect.objectContaining({ detail: "rate_limit", seenAt: NOW })]);
    const clean = facts({ journal: { lastStopAttempt: { errorClass: "auth", at: at(-SYNC_ALERT_CLEAN_MS - MINUTE) } } });
    expect(evaluate(clean)).toEqual({});
  });

  it("alerts 1–3 resolve after 10 clean minutes, alert 4 as soon as progress resumes", () => {
    expect(syncAlertResolveAfterMs("page_stopped")).toBe(SYNC_ALERT_CLEAN_MS);
    expect(syncAlertResolveAfterMs("live_degraded")).toBe(10 * MINUTE);
    expect(syncAlertResolveAfterMs("freshness")).toBe(10 * MINUTE);
    expect(syncAlertResolveAfterMs("stuck")).toBe(0);
    // Every other condition holds as of now.
    const conditions = evaluatePageAlerts(facts({
      live: { socket: { up: false, lastAliveAt: null }, unconfirmed: { count: 1, oldestVisibleAt: at(-20 * MINUTE) } },
      journal: { ledgerIncomplete: { missing: 3, at: at(-MINUTE) } },
    }), registry);
    expect(conditions.map((entry) => [entry.subKey, entry.seenAt])).toEqual([
      ["live_degraded", NOW],
      ["freshness", NOW],
      ["stuck", NOW],
    ]);
  });

  it("alert 1: an owner that stopped beating is ownership_unconfirmed after 2 min; a fresh mode gets its grace", () => {
    expect(OWNERSHIP_ALERT_AFTER_MS).toBe(SYNC_OWNERSHIP_UNCONFIRMED_MS);
    const stale = (page: Partial<PageAlertFacts["page"]>) => facts({ page: { ...page, owner: { ...facts().page.owner, ...page.owner } } });
    expect(evaluate(stale({ owner: { ...facts().page.owner, heartbeatAt: at(-SYNC_OWNERSHIP_UNCONFIRMED_MS - 1_000) } })))
      .toEqual({ page_stopped: "ownership_unconfirmed" });
    expect(evaluate(stale({ owner: { ...facts().page.owner, heartbeatAt: null }, modeChangedAt: at(-MINUTE) }))).toEqual({});
    expect(evaluate(stale({ owner: { ...facts().page.owner, heartbeatAt: null }, modeChangedAt: at(-3 * MINUTE) })))
      .toEqual({ page_stopped: "ownership_unconfirmed" });
  });

  it("alert 1: handover suppresses the ownership alert; a handover older than 10 min is handover_stuck", () => {
    const handover = (sinceMs: number) => facts({
      page: { mode: "handover", modeChangedAt: at(-sinceMs), owner: { ...facts().page.owner, heartbeatAt: null } },
    });
    expect(evaluate(handover(5 * MINUTE))).toEqual({});
    expect(evaluate(handover(SYNC_HANDOVER_STUCK_MS + MINUTE))).toEqual({ page_stopped: "handover_stuck" });
  });

  it("alert 2: the socket down > 5 min, decode debt > 1 %, any quarantined work", () => {
    expect(evaluate(facts({ live: { socket: { up: false, lastAliveAt: at(-SYNC_SOCKET_DOWN_MS + MINUTE) } } }))).toEqual({});
    expect(evaluate(facts({ live: { socket: { up: false, lastAliveAt: at(-SYNC_SOCKET_DOWN_MS - MINUTE) } } })))
      .toEqual({ live_degraded: "socket_down" });
    expect(evaluate(facts({ live: { socket: { up: false, lastAliveAt: null } } }))).toEqual({ live_degraded: "socket_down" });
    expect(evaluate(facts({ live: { decode: { receipts: 200, debt: 2 } } }))).toEqual({});
    expect(evaluate(facts({ live: { decode: { receipts: 200, debt: 3 } } }))).toEqual({ live_degraded: "protocol_changed" });
    const quarantined = evaluatePageAlerts(facts({ journal: { quarantined: { "dm-messages.head": 2 } } }), registry);
    expect(quarantined).toEqual([expect.objectContaining({
      subKey: "live_degraded",
      detail: "quarantined",
      reasons: [expect.objectContaining({ context: { byResource: { "dm-messages.head": 2 } } })],
    })]);
  });

  it("alert 3: unconfirmed fan messages, money not in the ledger, urgent work waiting", () => {
    expect(evaluate(facts({ live: { unconfirmed: { count: 2, oldestVisibleAt: at(-20 * MINUTE) } } })))
      .toEqual({ freshness: "message_unconfirmed" });
    expect(evaluate(facts({ money: { count: 1, oldestReceivedAt: at(-6 * MINUTE) } }))).toEqual({ freshness: "money_not_in_ledger" });
    const waiting = { urgentWaiting: [{ resource: "dm-messages.head", subject: "1", dueAt: at(-3 * MINUTE), waitingReason: null }] };
    expect(evaluate(facts({ journal: waiting }))).toEqual({ freshness: "urgent_waiting" });
    // A held, paused or not-implemented wait is explained elsewhere.
    expect(evaluate(facts({ journal: waiting, page: { pausedAll: true } }))).toEqual({});
    expect(evaluate(facts({ journal: waiting, page: { pausedResources: ["dm-messages.head"] } }))).toEqual({});
    expect(evaluate(facts({
      journal: { urgentWaiting: [{ ...waiting.urgentWaiting[0]!, waitingReason: "dependency" }] },
    }))).toEqual({});
    expect(evaluate(facts({
      journal: waiting,
      page: { resourceHolds: { "dm-messages": { until: at(MINUTE).toISOString(), step: 1, since: at(-MINUTE).toISOString() } } },
    }))).toEqual({});
    // Every route it reads held by a 429: the route's own incident pages, not alert 3.
    const routeHeld = (until: Date) => ({ version: 1, routes: { "messages.page": routeEntry({ holdUntil: until.toISOString() }) } });
    expect(evaluate(facts({ journal: waiting, page: { routeState: routeHeld(at(MINUTE)) } }))).toEqual({});
    expect(evaluate(facts({ journal: waiting, page: { routeState: routeHeld(at(-1)) } }))).toEqual({ freshness: "urgent_waiting" });
    // A key with another route open is not explained by one held route.
    const find = { urgentWaiting: [{ resource: "dm-conversations.find", subject: "1", dueAt: at(-3 * MINUTE), waitingReason: null }] };
    const listHeld = { version: 1, routes: { "messaging.groups": routeEntry({ holdUntil: at(MINUTE).toISOString() }) } };
    expect(evaluate(facts({ journal: find, page: { routeState: listHeld } }))).toEqual({ freshness: "urgent_waiting" });
  });

  it("the route incident (D5): held routes, and a 429 within the clean window; an unreadable state is alert 1's", () => {
    const state = {
      version: 1,
      routes: {
        "messaging.groups": routeEntry({ holdUntil: at(5_000).toISOString(), last429At: at(-1_000).toISOString(), effectivePerMin: 6 }),
        "media.offer_stats": routeEntry({ holdUntil: at(-1).toISOString(), last429At: at(-SYNC_ALERT_CLEAN_MS + MINUTE).toISOString(), effectivePerMin: 2.5 }),
        "transactions.page": routeEntry({ holdUntil: at(-1).toISOString(), last429At: at(-SYNC_ALERT_CLEAN_MS - MINUTE).toISOString(), effectivePerMin: 8.5 }),
        "account.me": routeEntry({ holdUntil: at(MINUTE).toISOString() }),
      },
    };
    expect(evaluateRouteAlerts({ routeState: state }, NOW)).toEqual([
      {
        route: "account.me", detail: "route_held", seenAt: NOW, holdUntil: at(MINUTE), last429At: null, effectivePerMin: 15, currentPerMin: 15,
      },
      {
        route: "media.offer_stats", detail: "rate_limit", seenAt: at(-SYNC_ALERT_CLEAN_MS + MINUTE), holdUntil: null,
        last429At: at(-SYNC_ALERT_CLEAN_MS + MINUTE), effectivePerMin: 2.5, currentPerMin: 5,
      },
      {
        route: "messaging.groups", detail: "route_held", seenAt: NOW, holdUntil: at(5_000), last429At: at(-1_000), effectivePerMin: 6, currentPerMin: 12,
      },
    ]);
    expect(evaluateRouteAlerts({ routeState: null }, NOW)).toEqual([]);
    expect(evaluateRouteAlerts({ routeState: { version: 99, routes: {} } }, NOW)).toEqual([]);
    expect(evaluate(facts({ page: { routeState: { version: 99, routes: {} } } }))).toEqual({ page_stopped: "route_state_unreadable" });
  });

  it("alert 4: a stalled request, a poll past its SLO, an incomplete ledger", () => {
    expect(evaluate(facts({ journal: { stalledRequests: [{ requestRef: "r-1", lastServedAt: at(-40 * MINUTE), createdAt: at(-60 * MINUTE) }] } })))
      .toEqual({ stuck: "request_stalled" });
    // notifications.forward: SLO 60 min.
    const poll = (servedMs: number) => facts({
      journal: { polls: [{ resource: "notifications.forward", lastServedAt: at(-servedMs), createdAt: at(-24 * 60 * MINUTE) }] },
    });
    expect(evaluate(poll(55 * MINUTE))).toEqual({});
    expect(evaluate(poll(65 * MINUTE))).toEqual({ stuck: "planned_stale" });
    // A key the owner switched off for the page is not stale.
    const off = poll(65 * MINUTE);
    expect(evaluate({ ...off, page: { ...off.page, registryOverrides: { "notifications.forward": { enabled: false } } } })).toEqual({});
    expect(evaluate(facts({ journal: { ledgerIncomplete: { missing: 3, at: at(-MINUTE) } } })))
      .toEqual({ stuck: "transactions_ledger_incomplete" });
  });

  it("several alerts at once, one condition each", () => {
    expect(evaluate(facts({
      page: { holdKind: "rate_limit", holdUntil: at(MINUTE), holdSince: at(-MINUTE) },
      live: { socket: { up: false, lastAliveAt: null }, unconfirmed: { count: 1, oldestVisibleAt: at(-16 * MINUTE) } },
      journal: { ledgerIncomplete: { missing: 1, at: at(-MINUTE) } },
    }))).toEqual({
      page_stopped: "rate_limit",
      live_degraded: "socket_down",
      freshness: "message_unconfirmed",
      stuck: "transactions_ledger_incomplete",
    });
  });
});

describe("the incident kind fansly_sync_engine", () => {
  it("keys one latch per page and alert, the pace violation apart, one per page+route, alert 5 global", () => {
    expect(syncEngineIncidentKey({ subKey: "page_stopped", pageId: 7 })).toBe("fansly_sync_engine:7:page_stopped");
    expect(syncEngineIncidentKey({ subKey: syncEngineRouteSubKey("messaging.groups"), pageId: 7 }))
      .toBe("fansly_sync_engine:7:route_limited:messaging.groups");
    expect(syncEngineIncidentKey({ subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY, pageId: 7 }))
      .toBe("fansly_sync_engine:7:page_stopped:pace_violation");
    expect(syncEngineIncidentKey({ subKey: "process", pageId: null })).toBe("fansly_sync_engine:global:process");
  });

  it("opens and resolves under one title per alert", () => {
    const titles = ["page_stopped", SYNC_ENGINE_PACE_VIOLATION_SUBKEY, "live_degraded", "freshness", "stuck", "process", "route_limited:messages.page"]
      .map((subKey) => incidentTitleForKind({ kind: "fansly_sync_engine", subKey }));
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles.every((title) => title.startsWith("Fansly Sync Engine"))).toBe(true);
    expect(incidentTitleForKind({ kind: "fansly_sync_engine", subKey: "process" })).toContain("no sync heartbeat for 2 min");
    expect(resolveMessageForIncident({ kind: "fansly_sync_engine", subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY, pageLabel: "lilly-1", platform: "fansly" }))
      .toBe("✅ Resolved\nFansly Sync Engine pace violation acknowledged by the owner: lilly-1 (fansly)");
    expect(resolveMessageForIncident({ kind: "fansly_sync_engine", subKey: "process", pageLabel: null, platform: null }))
      .toBe("✅ Resolved\nFansly Sync Engine heartbeat back");
    // Every route's latch reads the same title; an empty route is no route latch.
    expect(incidentTitleForKind({ kind: "fansly_sync_engine", subKey: "route_limited:media.offer_stats" }))
      .toBe(incidentTitleForKind({ kind: "fansly_sync_engine", subKey: "route_limited:messages.page" }));
    expect(incidentTitleForKind({ kind: "fansly_sync_engine", subKey: "route_limited:" })).toBe("Fansly Sync Engine alert");
    expect(resolveMessageForIncident({ kind: "fansly_sync_engine", subKey: "route_limited:media.offer_stats", pageLabel: "lilly-1", platform: "fansly" }))
      .toBe("✅ Resolved\nFansly Sync Engine route open again (10 min clean; its slowdown stays until raised): lilly-1 (fansly)");
  });

  it("pages every alert at once", () => {
    for (const subKey of ["page_stopped", SYNC_ENGINE_PACE_VIOLATION_SUBKEY, "live_degraded", "freshness", "stuck", "process", "route_limited:messages.page"]) {
      expect(notificationPagingPolicyFor("fansly_sync_engine", subKey)).toMatchObject({ openHoldMs: 0, flap: null });
    }
  });
});

describe("the report's and the sampler's pure parts", () => {
  const coalesceOf = (resource: string) => registry.spec(resource)?.coalesce;

  it("coalesces a chat's socket signals into one read per quiet window, a new read after it", () => {
    // dm-messages.head: normal 5 s quiet / 20 s cap, extended by each signal.
    const spec = coalesceOf("dm-messages.head")!;
    expect(spec).toMatchObject({ extendOnSignal: true });
    const t0 = NOW.getTime();
    const signal = (atMs: number, subject = "g1") => ({ resource: "dm-messages.head", subject, atMs, dueAtMs: null, fast: false });
    const reads = simulateCoalescedReads([
      signal(t0), signal(t0 + 1_000), signal(t0 + 2_000), // one read, due at the last + quiet
      signal(t0 + 60_000), // a later read
      signal(t0 + 500, "g2"), // another chat
    ], coalesceOf).get("dm-messages.head")!;
    expect(reads.reads).toBe(3);
    expect(Math.max(...reads.dueLagsMs)).toBeLessThanOrEqual(spec.maxMs);
  });

  it("caps a stream of signals at the window's maximum", () => {
    const spec = coalesceOf("dm-messages.head")!;
    const t0 = NOW.getTime();
    const signals = Array.from({ length: 40 }, (_, i) => ({
      resource: "dm-messages.head", subject: "g1", atMs: t0 + i * (spec.quietMs - 100), dueAtMs: null, fast: false,
    }));
    const reads = simulateCoalescedReads(signals, coalesceOf).get("dm-messages.head")!;
    const span = signals.at(-1)!.atMs - t0;
    // Each read covers at most its cap plus the gap to the next signal.
    expect(reads.reads).toBeGreaterThanOrEqual(Math.floor(span / (spec.maxMs + spec.quietMs)));
    expect(reads.reads).toBeGreaterThan(1);
    expect(Math.max(...reads.dueLagsMs)).toBeLessThanOrEqual(spec.maxMs);
  });

  it("an explicit due time and a key without coalescing read at once", () => {
    const t0 = NOW.getTime();
    const reads = simulateCoalescedReads([
      { resource: "payouts.daily", subject: "", atMs: t0, dueAtMs: t0, fast: false },
      { resource: "payouts.daily", subject: "", atMs: t0 + 10, dueAtMs: t0 + 10, fast: false },
    ], coalesceOf).get("payouts.daily")!;
    expect(reads.reads).toBe(2);
    expect(reads.dueLagsMs).toEqual([0, 0]);
  });

  it("A1 leaves out only the one-time walks: first-pass backlogs and backfills only one-time events start", () => {
    const goals = FANSLY_RESOURCE_SPECS.filter((spec) => spec.kind === "goal" && spec.class !== "requests");
    const oneTime = goals.filter((spec) => isOneTimeWalk(spec)).map((spec) => spec.key).sort();
    expect(oneTime).toEqual([
      "catalog.vault", "fan-profiles.alias-backfill", "media-stats.walk", "notifications.backfill", "posts.backfill",
      "stats.backfill", "subscribers.history", "top-spenders.bootstrap", "transactions.backfill",
    ]);
    // The recurring walks count in the steady state (at their rate where
    // they run on a minimum interval, rule A1.rate).
    expect(goals.filter((spec) => !isOneTimeWalk(spec)).map((spec) => spec.key)).toEqual(expect.arrayContaining([
      "fan-earnings.roster", "post-replies.walk", "purchases.targets", "fan-profiles.lookup", "posts.engagement",
      "followers.reconcile", "payouts.walk",
    ]));
  });

  it("offline routing judges a chat as the router knew it at the frame", () => {
    const frameMs = NOW.getTime();
    const thread = {
      groupId: "g1", threadId: 1, bound: true, excluded: false, headConfirmedId: "900",
      headConfirmedAt: new Date(frameMs - MINUTE), firstSeenAt: new Date(frameMs - 60 * MINUTE),
    };
    expect(routeThreadAt(undefined, frameMs)).toEqual({ known: false, bound: false, excluded: false, headConfirmedId: null });
    expect(routeThreadAt(thread, frameMs)).toEqual({ known: true, bound: true, excluded: false, headConfirmedId: "900" });
    // A chat legacy listed after the frame was unknown then.
    expect(routeThreadAt({ ...thread, firstSeenAt: new Date(frameMs + 1) }, frameMs).known).toBe(false);
    // A head a later capture confirmed (a rebuild after the window) was not confirmed then.
    expect(routeThreadAt({ ...thread, headConfirmedAt: new Date(frameMs + 1) }, frameMs).headConfirmedId).toBeNull();
    expect(routeThreadAt({ ...thread, headConfirmedAt: null }, frameMs).headConfirmedId).toBeNull();
    // As it stands (the live router): the facts of the row.
    expect(routeThreadAt({ ...thread, headConfirmedAt: new Date(frameMs + 1), firstSeenAt: new Date(frameMs + 1) }, null))
      .toEqual({ known: true, bound: true, excluded: false, headConfirmedId: "900" });
  });

  it("B5 scores matched over every observation but legacy's own refusals; nothing judged fails", () => {
    const score = (counts: { total: number; matched: number; reasons?: Record<string, number> }) =>
      scoreReplayKind({ total: counts.total, matched: counts.matched, notReplayableReasons: counts.reasons ?? {} });
    // A kind without a single observation: listed as not replayable, not judged.
    expect(score({ total: 0, matched: 0 })).toEqual({ excused: 0, ratio: null, meetsTarget: null });
    expect(score({ total: 1_000, matched: 999 })).toEqual({ excused: 0, ratio: 0.999, meetsTarget: true });
    // Not judged for want of a body or an identity: not matched.
    expect(score({ total: 1_000, matched: 998, reasons: { body_unavailable: 1, page_account_unknown: 1 } }))
      .toMatchObject({ ratio: 0.998, meetsTarget: false });
    // Legacy's own refusals leave the denominator …
    expect(score({ total: 1_000, matched: 990, reasons: { legacy_refused_body_trimmed: 6, legacy_rejection_receipt: 4 } }))
      .toEqual({ excused: 10, ratio: 1, meetsTarget: true });
    // … but a kind of nothing else is no pass, nor is one where nothing was judged.
    expect(score({ total: 3, matched: 0, reasons: { legacy_refused_body_trimmed: 3 } })).toEqual({ excused: 3, ratio: null, meetsTarget: false });
    expect(score({ total: 3, matched: 0, reasons: { page_without_identity: 3 } })).toEqual({ excused: 0, ratio: 0, meetsTarget: false });
    // Where legacy stored no fact to compare with, each by its own name
    // (lib/replay-rules.ts); nothing else ever leaves the denominator.
    expect([...REPLAY_EXCUSED_REASONS].sort()).toEqual([
      "legacy_refused_body_trimmed",
      "legacy_rejection_receipt",
      "legacy_unstored_below_complete_claim",
      "legacy_unstored_below_window",
      "legacy_unstored_deleted_on_platform",
      "legacy_ws_hint_membership_pending",
    ]);
    // dm_messages on 2026-10-02: 111 pages legacy stored none of, the rest compared.
    expect(score({
      total: 23_030,
      matched: 22_919,
      reasons: { legacy_unstored_below_window: 108, legacy_unstored_below_complete_claim: 3 },
    })).toEqual({ excused: 111, ratio: 1, meetsTarget: true });
    // group_detail: three direct chats legacy deferred; one unexplained still fails.
    expect(score({ total: 174, matched: 170, reasons: { legacy_ws_hint_membership_pending: 3 } }))
      .toMatchObject({ excused: 3, meetsTarget: false });
  });

  it("parses the report window", () => {
    expect(parseReportWindow("2026-10-03T09:00:00Z/2026-10-03T10:00:00Z")).toEqual({
      start: new Date("2026-10-03T09:00:00Z"),
      end: new Date("2026-10-03T10:00:00Z"),
    });
    expect(parseReportWindow("2026-10-03T09:00:00Z").end).toEqual(new Date("2026-10-03T10:00:00Z"));
    expect(() => parseReportWindow("2026-10-03T10:00:00Z/2026-10-03T09:00:00Z")).toThrow();
  });

  it("a window covers only pages in shadow, settled, from 10 min before its start (not one begun before the deploy)", () => {
    const window = { start: at(-60 * MINUTE), end: NOW };
    const settledBy = window.start.getTime() - SHADOW_SETTLE_MS;
    const page = (mode: "off" | "shadow" | "handover" | "live", modeChangedAt: Date) => ({ pageId: 7, pageLabel: "lilly-1", mode, modeChangedAt });
    const coverage = (...args: Parameters<typeof shadowWindowCoverage>) => {
      const { covered, reason } = shadowWindowCoverage(...args);
      return { covered, reason };
    };
    const longAgo = at(-30 * 60 * MINUTE);
    // In shadow and running well before the window.
    expect(coverage(page("shadow", longAgo), longAgo, window)).toEqual({ covered: true, reason: null });
    expect(coverage(page("shadow", longAgo), new Date(settledBy), window)).toEqual({ covered: true, reason: null });
    // Switched to shadow (the deploy) inside the window or its 10-minute settling.
    expect(coverage(page("shadow", at(-35 * MINUTE)), at(-34 * MINUTE), window)).toEqual({ covered: false, reason: "mode_changed" });
    expect(coverage(page("shadow", new Date(settledBy + 1)), at(-65 * MINUTE), window)).toEqual({ covered: false, reason: "mode_changed" });
    // Set to shadow long before, but the shadow actor began only later (the
    // process deployed after the mode was set), or never ran.
    expect(coverage(page("shadow", longAgo), at(-25 * MINUTE), window)).toEqual({ covered: false, reason: "shadow_began_late" });
    expect(coverage(page("shadow", longAgo), new Date(settledBy + 1), window)).toEqual({ covered: false, reason: "shadow_began_late" });
    expect(coverage(page("shadow", longAgo), null, window)).toEqual({ covered: false, reason: "no_shadow_admission" });
    // Off during the window.
    expect(coverage(page("off", longAgo), null, window)).toEqual({ covered: false, reason: "off" });
    expect(coverage(page("off", at(-10 * MINUTE)), longAgo, window)).toEqual({ covered: false, reason: "off" });
    // Switched on after the window: judged by the journal alone.
    expect(coverage(page("live", at(5 * MINUTE)), longAgo, window)).toEqual({ covered: true, reason: null });
    expect(coverage(page("handover", at(5 * MINUTE)), at(-30 * MINUTE), window)).toEqual({ covered: false, reason: "shadow_began_late" });
  });

  it("money frames missing per page after 5 min; nearest-rank quantiles; the sampler's cadence", () => {
    const frame = (pageId: number, receivedMs: number, ledger: boolean) => ({
      pageId, observationId: 1, receivedAt: at(-receivedMs), transactionId: "1", ledgerCreatedAt: ledger ? NOW : null,
    });
    const missing = moneyFramesMissing([frame(1, 6 * MINUTE, false), frame(1, 9 * MINUTE, false), frame(1, 4 * MINUTE, false), frame(2, 7 * MINUTE, true)], NOW, 5 * MINUTE);
    expect([...missing]).toEqual([[1, { count: 2, oldestReceivedAt: at(-9 * MINUTE) }]]);
    expect(quantileOf([], 0.5)).toBeNull();
    expect(quantileOf([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantileOf([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(syncMetricsDue(new Date("2026-10-02T12:05:30Z"))).toBe(true);
    expect(syncMetricsDue(new Date("2026-10-02T12:06:30Z"))).toBe(false);
  });
});

// ── shadow report part A: the rules A1.rate, A1.ceiling, A1.floor,
// A1.poll-schedule, A2.rate, A2.legacy-regime, A2.live-only (design §3.12),
// pinned on the production numbers of 2026-10-02 ──────────────────────────────

const HOUR = 60 * MINUTE;
const T = (iso: string) => new Date(iso).getTime();
/** The acceptance hour of the first production report. */
const WINDOW = { startMs: T("2026-10-02T11:50:00Z"), endMs: T("2026-10-02T12:50:00Z") };

/** One attempt: sent at `sentMs`, done 500 ms later. */
function attempt(sentMs: number, extra: Partial<RunAttempt> = {}): RunAttempt {
  return { workId: null, demandRevision: 1, sentMs, doneMs: sentMs + 500, workClosedMs: null, ...extra };
}

/** A run of `steps` attempts `stepMs` apart from `startMs`. */
function steps(startMs: number, count: number, stepMs = 3_000, extra: Partial<RunAttempt> = {}): RunAttempt[] {
  return Array.from({ length: count }, (_, index) => attempt(startMs + index * stepMs, extra));
}

/** Runs of one request every `everyMs` from `firstMs` while before `untilMs`. */
function periodic(firstMs: number, everyMs: number, untilMs: number): KeyRun[] {
  const attempts: RunAttempt[] = [];
  for (let at = firstMs; at < untilMs; at += everyMs) attempts.push(attempt(at));
  return runsOf(attempts, "poll");
}

const shadowPage = (label: string, registryOverrides: Record<string, unknown> = {}) =>
  ({ pageId: 5, pageLabel: label, mode: "shadow" as const, registryOverrides });
const NO_GAPS: CounterpartCheck = { lacking: [], pending: [], scheduled: [], idle: [], onDemand: [], notInShadow: [] };

/**
 * lilly-2 in 2026-10-02 11:50–12:50: 20 poll requests, its daily follower
 * reconcile (186 steps, 12:32:28–12:48:02, its row closed at 12:48:02) and
 * every longer poll's newest run before the window, every poll on schedule.
 */
function lilly2(options: { reconcileAt?: number; insurance?: KeyRun[]; withoutRun?: string; extraObserved?: Record<string, { class: string; attempts: number }> } = {}) {
  const reconcileAt = options.reconcileAt ?? T("2026-10-02T12:32:28Z");
  const reconcile = runsOf(steps(reconcileAt, 186, 5_000, { workId: 5316, workClosedMs: reconcileAt + 186 * 5_000 + 2_000 }), "walk");
  const runs = new Map<string, readonly KeyRun[]>([
    ["transactions.insurance", options.insurance ?? periodic(T("2026-10-02T11:46:00Z"), 5 * MINUTE, WINDOW.endMs)],
    ["notifications.forward", periodic(T("2026-10-02T11:45:00Z"), 30 * MINUTE, WINDOW.endMs)],
    ["dm-conversations.head", periodic(T("2026-10-02T11:48:00Z"), 30 * MINUTE, WINDOW.endMs)],
    ["account.poll", periodic(T("2026-10-02T11:20:00Z"), HOUR, WINDOW.endMs)],
    ["followers.head", periodic(T("2026-10-02T11:30:00Z"), HOUR, WINDOW.endMs)],
    ["subscribers.poll", periodic(T("2026-10-02T11:40:00Z"), HOUR, WINDOW.endMs)],
    ["transactions.rescan", periodic(T("2026-10-02T11:25:00Z"), HOUR, WINDOW.endMs)],
    ["followers.reconcile", reconcile],
    // Each longer poll's newest run (its requests in lilly-2's journal).
    ["dm-conversations.full", runsOf(steps(T("2026-10-01T20:00:00Z"), 152), "poll")],
    ["posts.refresh", runsOf(steps(T("2026-10-02T10:52:03Z"), 2), "poll")],
    ["stats.daily", runsOf(steps(T("2026-10-01T14:00:00Z"), 11), "poll")],
    ["stats.hourly", runsOf(steps(T("2026-10-01T22:00:00Z"), 1), "poll")],
    ["catalog.fixed", runsOf(steps(T("2026-10-01T18:00:00Z"), 6), "poll")],
    ["payouts.daily", runsOf(steps(T("2026-10-01T19:00:00Z"), 2), "poll")],
    ["top-spenders.window", runsOf(steps(T("2026-10-02T10:30:00Z"), 1), "poll")],
  ]);
  if (options.withoutRun !== undefined) runs.delete(options.withoutRun);
  const inWindow = (key: string) => (runs.get(key) ?? []).flatMap((run) => run.sentMs).filter((ms) => ms >= WINDOW.startMs && ms < WINDOW.endMs).length;
  const observed = new Map<string, { class: string; attempts: number }>();
  for (const key of runs.keys()) {
    const n = inWindow(key);
    if (n > 0) observed.set(key, { class: "planned", attempts: n });
  }
  for (const [key, row] of Object.entries(options.extraObserved ?? {})) observed.set(key, row);
  return { runs, observed };
}

describe("shadow report A1 in runs and at rates (design §3.12, rules A1.*)", () => {
  it("names every rule it applies, the plan's band kept as the ceiling and a floor with its exception", () => {
    expect(SHADOW_WINDOW_RULES.map((rule) => rule.id)).toEqual([
      "A1.rate", "A1.rate-assumed", "A1.ceiling", "A1.ceiling-demand", "A1.shared-read", "A1.floor", "A1.floor-scheduled", "A1.floor-queue", "A1.floor-idle",
      "A1.poll-schedule",
      "A2.rate", "A2.legacy-regime", "A2.live-only", "A2.demand-replaced",
    ]);
    expect(SHADOW_WINDOW_RULES.find((rule) => rule.id === "A1.ceiling")!.text).toContain("at most 100 an hour");
    for (const ref of Object.keys(LEGACY_REGIME_SINCE)) {
      expect(SHADOW_WINDOW_RULES.find((rule) => rule.id === "A2.legacy-regime")!.text).toContain(ref);
    }
  });

  it("a run is a poll's consecutive steps; a gap or a new demand revision starts the next; a walk's run is its row", () => {
    // lora-2 stats.daily 12:05:02–12:05:30: 11 requests, one run.
    expect(runsOf(steps(T("2026-10-02T12:05:02Z"), 11, 2_800), "poll").map((run) => run.sentMs.length)).toEqual([11]);
    // ari-1 subscribers.poll: the period, then two socket bumps 5 s apart.
    const subscribers = runsOf([
      attempt(T("2026-10-02T11:32:26.756Z"), { demandRevision: 1 }),
      attempt(T("2026-10-02T11:56:44.283Z"), { demandRevision: 2 }),
      attempt(T("2026-10-02T11:56:49.494Z"), { demandRevision: 3 }),
    ], "poll");
    expect(subscribers).toHaveLength(3);
    // Two walks of one key, one row each, however close.
    const walks = runsOf([...steps(0, 3, 1_000, { workId: 1 }), ...steps(4_000, 2, 1_000, { workId: 2 })], "walk");
    expect(walks.map((run) => [run.workId, run.sentMs.length])).toEqual([[1, 3], [2, 2]]);
    // The run gap stays below the shortest poll period's earliest re-run.
    const shortest = Math.min(...FANSLY_RESOURCE_SPECS.filter((entry) => entry.kind === "poll").map((entry) => entry.period!.everyMs));
    expect(POLL_RUN_GAP_MS).toBeLessThan((1 - POLL_JITTER) * shortest);
  });

  it("judges polls in runs: a multi-request run is one run; a window between two hourly runs is no fault", () => {
    // ari-1 transactions.rescan: runs done 11:45:31.28 and at 12:51:15 — none in the window.
    const rescan = judgePollRuns({
      periodMs: HOUR,
      window: WINDOW,
      placementMs: T("2026-10-02T10:05:21Z"),
      runs: runsOf([attempt(T("2026-10-02T10:50:15.612Z")), { ...attempt(T("2026-10-02T11:45:29.9Z")), doneMs: T("2026-10-02T11:45:31.28Z") }], "poll"),
    });
    expect(rescan).toMatchObject({ runs: 0, expectedRuns: { min: 0, max: 2 }, early: [], late: [], overdue: null });
    expect(pollScheduleFault(rescan)).toBeNull();
    // lora-1 posts.refresh: 6 requests 2.6–3 s apart, its row placed 10:05:31.
    const refresh = judgePollRuns({
      periodMs: 6 * HOUR,
      window: WINDOW,
      placementMs: T("2026-10-02T10:05:31.56Z"),
      runs: runsOf(steps(T("2026-10-02T12:37:18.308Z"), 6, 2_740), "poll"),
    });
    expect(refresh).toMatchObject({ runs: 1, attemptsPerRun: [6], early: [], late: [], overdue: null });
    // lora-2 stats.daily: one run of 11.
    const daily = judgePollRuns({
      periodMs: 24 * HOUR,
      window: WINDOW,
      placementMs: T("2026-10-02T10:05:29Z"),
      runs: runsOf(steps(T("2026-10-02T12:05:02.439Z"), 11, 2_790), "poll"),
    });
    expect(daily).toMatchObject({ runs: 1, attemptsPerRun: [11] });
    expect(pollScheduleFault(daily)).toBeNull();
  });

  it("a poll off schedule is named: overdue, re-run in a loop, late after its placement; a demand bump is no fault", () => {
    // The rescan's last run done at 11:30: due by 12:38 at the latest.
    const overdue = judgePollRuns({ periodMs: HOUR, window: WINDOW, placementMs: null, runs: runsOf([attempt(T("2026-10-02T11:29:59.5Z"))], "poll") });
    expect(overdue.overdue).toEqual({ dueBy: new Date(T("2026-10-02T11:30:00Z") + 1.1 * HOUR + 2 * MINUTE) });
    expect(pollScheduleFault(overdue)).toMatch(/^overdue: no run since one was due by 2026-10-02T12:38:00\.000Z/);
    // An hourly poll re-run 5 min after its completion at the same revision: a loop.
    const loop = judgePollRuns({
      periodMs: HOUR,
      window: WINDOW,
      placementMs: null,
      runs: runsOf([attempt(T("2026-10-02T11:40:00Z")), attempt(T("2026-10-02T11:55:00Z")), attempt(T("2026-10-02T12:00:00Z"))], "poll"),
    });
    expect(loop.early.map((run) => run.at)).toEqual([new Date(T("2026-10-02T11:55:00Z")), new Date(T("2026-10-02T12:00:00Z"))]);
    expect(pollScheduleFault(loop)).toMatch(/^early: /);
    // ari-1 subscribers.poll: bumps at 11:56:44 (rev 2) and 11:56:49 (rev 3).
    const bumped = judgePollRuns({
      periodMs: HOUR,
      window: WINDOW,
      placementMs: null,
      runs: runsOf([
        attempt(T("2026-10-02T11:32:26.756Z"), { demandRevision: 1 }),
        attempt(T("2026-10-02T11:56:44.283Z"), { demandRevision: 2 }),
        attempt(T("2026-10-02T11:56:49.494Z"), { demandRevision: 3 }),
      ], "poll"),
    });
    expect(bumped).toMatchObject({ runs: 2, demandRuns: 2, early: [], late: [], overdue: null });
    // A 30-minute poll placed 40 min before its first run, and one that never ran.
    const placed = T("2026-10-02T11:20:00Z");
    expect(judgePollRuns({ periodMs: 30 * MINUTE, window: WINDOW, placementMs: placed, runs: runsOf([attempt(placed + 40 * MINUTE)], "poll") }).late)
      .toEqual([{ at: new Date(placed + 40 * MINUTE), afterMs: 40 * MINUTE }]);
    expect(judgePollRuns({ periodMs: 30 * MINUTE, window: WINDOW, placementMs: placed, runs: [] }).overdue)
      .toEqual({ dueBy: new Date(placed + 32 * MINUTE) });
  });

  it("a daily walk counts at its rate whatever hour it lands in: lilly-2's 186-step reconcile is 7.75 an hour", () => {
    const reconcile = (startMs: number) => runsOf(steps(startMs, 186, 5_000, { workId: 5316, workClosedMs: startMs + 932_000 }), "walk");
    const at = (startMs: number) => rateCount({ periodMs: 24 * HOUR, window: WINDOW, runs: reconcile(startMs), kind: "interval" });
    expect(at(T("2026-10-02T12:32:28Z"))).toMatchObject({ runSize: 186, extra: 0, counted: 7.75 });
    expect(at(T("2026-10-02T06:32:28Z"))).toMatchObject({ runSize: 186, extra: 0, counted: 7.75 });
    // Still running at the window end: not a size yet.
    expect(rateCount({
      periodMs: 24 * HOUR,
      window: WINDOW,
      runs: runsOf(steps(T("2026-10-02T12:40:00Z"), 100, 5_000, { workId: 9, workClosedMs: T("2026-10-02T12:58:00Z") }), "walk"),
      kind: "interval",
    })).toMatchObject({ runSize: null, counted: null });
    // An owner's walk within the interval counts besides the rate.
    const owner = rateCount({
      periodMs: 24 * HOUR,
      window: WINDOW,
      runs: [...reconcile(T("2026-10-02T06:32:28Z")), ...runsOf(steps(T("2026-10-02T12:00:00Z"), 10, 5_000, { workId: 7, workClosedMs: T("2026-10-02T12:01:00Z") }), "walk")],
      kind: "interval",
    });
    // The early walk counts besides; the regular walk sizes the rate.
    expect(owner).toMatchObject({ runSize: 186, extra: 10, beyond: 0, counted: 17.75 });
  });

  it("lilly-2's hour: 206 observed is 35.42 an hour at the rates, under the ceiling; below 40 the floor's exception holds", () => {
    const { runs, observed } = lilly2();
    const demand = demandOfPage(shadowPage("lilly-2"), {
      window: WINDOW, observed, reads: undefined,
      facts: { runs, placements: new Map(), firstShadowMs: T("2026-10-02T10:05:23Z") },
      counterparts: { lacking: [], pending: [], scheduled: [], idle: [], onDemand: [], notInShadow: [{ ref: "sender:ws_connect", why: "live_only" }] },
    });
    expect(demand.steadyStateRaw).toBe(206);
    // 20 + 186/24 + 152/24 + 2/6 + 11/24 + 1/22 + 6/24 + 2/24 + 1/6
    expect(demand.steadyState).toBe(35.42);
    expect(demand).toMatchObject({ unknownRunSize: [], ceiling: "ok", inBand: false, scheduleFaults: [], passes: true });
    expect(demand.floor).toMatchObject({ below: true, holds: true, outside: [] });
    expect(demand.resources.find((row) => row.resource === "followers.reconcile")).toMatchObject({
      observed: 186, rate: { runSize: 186, counted: 7.75 }, verdict: "not_modelled",
    });
    // The same walk 6 h before the window: the same steady state.
    const earlier = lilly2({ reconcileAt: T("2026-10-02T06:32:28Z") });
    const phased = demandOfPage(shadowPage("lilly-2"), {
      window: WINDOW, observed: earlier.observed, reads: undefined,
      facts: { runs: earlier.runs, placements: new Map(), firstShadowMs: null }, counterparts: NO_GAPS,
    });
    expect(phased).toMatchObject({ steadyStateRaw: 20, steadyState: 35.42, passes: true });
  });

  it("A1 fails: a key without a finished run, a starved poll, below the floor with an unmet expectation or a legacy stream without a counterpart", () => {
    const judge = (fixture: ReturnType<typeof lilly2>, extra: { reads?: Map<string, { reads: number; dueLagsMs: number[] }>; counterparts?: CounterpartCheck } = {}) =>
      demandOfPage(shadowPage("lilly-2"), {
        window: WINDOW, observed: fixture.observed, reads: extra.reads,
        facts: { runs: fixture.runs, placements: new Map(), firstShadowMs: T("2026-10-02T10:05:00Z") },
        counterparts: extra.counterparts ?? NO_GAPS,
      });
    // The daily list sweep has not run yet: its size, so the ceiling, is unknown.
    expect(judge(lilly2({ withoutRun: "dm-conversations.full" }))).toMatchObject({
      unknownRunSize: ["dm-conversations.full"], ceiling: "unknown", scheduleFaults: [], passes: false,
    });
    // The insurance poll's last run ended a minute before the window; nothing since.
    const starved = judge(lilly2({ insurance: periodic(T("2026-10-02T11:44:00Z"), 5 * MINUTE, WINDOW.startMs) }));
    expect(starved.scheduleFaults).toEqual([expect.stringMatching(/^transactions\.insurance: overdue: /)]);
    expect(starved.passes).toBe(false);
    // 70 chat reads on 70 socket reads: 105.42 an hour, of which 70 socket
    // demand out of the ceiling (rule A1.ceiling-demand).
    const busy = judge(
      lilly2({ extraObserved: { "dm-messages.head": { class: "urgent", attempts: 70 } } }),
      { reads: new Map([["dm-messages.head", { reads: 70, dueLagsMs: [] }]]) },
    );
    expect(busy).toMatchObject({ steadyState: 105.42, ceilingSteadyState: 35.42, socketDemand: { reads: 70 }, ceiling: "ok", inBand: true, passes: true });
    expect(busy.floor.below).toBe(false);
    // Below the floor with four chat reads the frames imply and none made.
    const missed = judge(lilly2(), { reads: new Map([["dm-messages.head", { reads: 4, dueLagsMs: [] }]]) });
    expect(missed.floor).toMatchObject({ below: true, holds: false, outside: ["dm-messages.head"] });
    expect(missed.passes).toBe(false);
    // Below the floor with a legacy stream the shadow never matched.
    const lacking = judge(lilly2(), { counterparts: { lacking: [{ ref: "stream:post_replies", why: "legacy 3 on its A2 basis, the shadow none in 6.5 h of shadow history on the page" }], pending: [], scheduled: [], idle: [], onDemand: [], notInShadow: [] } });
    expect(lacking.floor).toMatchObject({ below: true, holds: false });
    expect(lacking.passes).toBe(false);
  });

  it("rule A1.ceiling-demand: urgent trigger reads at their socket frames' expectation are demand, out of the 100-an-hour ceiling", () => {
    expect(PAGE_CAPACITY_PER_HOUR).toBe(1_636);
    // A page with only the chat head and its apply follow-ups switched on, so
    // the steady state is exactly what the window observed.
    const page = shadowPage("ari-1", Object.fromEntries(FANSLY_RESOURCE_SPECS
      .filter((entry) => entry.key !== "dm-messages.head" && entry.key !== "dm-messages.catchup")
      .map((entry) => [entry.key, { enabled: false }])));
    const judge = (observed: Record<string, { class: string; attempts: number }>, socketReads: number | null) => demandOfPage(page, {
      window: WINDOW,
      observed: new Map(Object.entries(observed)),
      reads: socketReads === null ? undefined : new Map([["dm-messages.head", { reads: socketReads, dueLagsMs: [] }]]),
      facts: { runs: new Map(), placements: new Map(), firstShadowMs: T("2026-10-02T10:05:00Z") },
      counterparts: NO_GAPS,
    });
    const head = (demand: ReturnType<typeof judge>) => demand.resources.find((row) => row.resource === "dm-messages.head")!;
    // ari-1 16:25–17:25: 104 chat reads on 104 socket reads + 29 other.
    const evening = judge({ "dm-messages.head": { class: "urgent", attempts: 104 }, "dm-messages.catchup": { class: "planned", attempts: 29 } }, 104);
    expect(head(evening)).toMatchObject({ observed: 104, expected: 104, verdict: "ok" });
    expect(evening).toMatchObject({
      steadyState: 133,
      ceilingSteadyState: 29,
      socketDemand: {
        reads: 104, perHour: 104, capacityShare: 6.4, capacityPerHour: 1_636,
        resources: [{ resource: "dm-messages.head", observed: 104, expected: 104, demand: 104, overExpectation: 0 }],
      },
      ceiling: "ok", inBand: true, scheduleFaults: [], floor: { below: false }, passes: true,
    });
    expect(socketDemandText(evening.socketDemand.resources[0]!)).toBe("dm-messages.head 104 on 104 socket reads");
    // The same page reading 104 times on 40 socket reads: outside, so in the ceiling.
    const overRead = judge({ "dm-messages.head": { class: "urgent", attempts: 104 }, "dm-messages.catchup": { class: "planned", attempts: 29 } }, 40);
    expect(head(overRead)).toMatchObject({ observed: 104, expected: 40, verdict: "outside" });
    expect(overRead).toMatchObject({
      steadyState: 133, ceilingSteadyState: 133, socketDemand: { reads: 0, resources: [] }, ceiling: "over", inBand: false, outside: [expect.objectContaining({ resource: "dm-messages.head" })], passes: false,
    });
    // At 2× its expectation the row is still demand, but only up to the
    // expectation: the 52 reads over it stay in the ceiling.
    const doubled = judge({ "dm-messages.head": { class: "urgent", attempts: 104 } }, 52);
    expect(head(doubled)).toMatchObject({ observed: 104, expected: 52, verdict: "ok" });
    expect(doubled).toMatchObject({
      steadyState: 104, ceilingSteadyState: 52,
      socketDemand: { reads: 52, perHour: 52, resources: [{ resource: "dm-messages.head", observed: 104, expected: 52, demand: 52, overExpectation: 52 }] },
      ceiling: "ok",
    });
    expect(socketDemandText(doubled.socketDemand.resources[0]!)).toBe("dm-messages.head 104 on 52 socket reads (52 over the expectation kept in the ceiling)");
    // Every read doubled (or two pages of each head walk): 208 on 104 + 29
    // planned is 237 an hour, 133 of it in the ceiling: over.
    const twice = judge({ "dm-messages.head": { class: "urgent", attempts: 208 }, "dm-messages.catchup": { class: "planned", attempts: 29 } }, 104);
    expect(head(twice)).toMatchObject({ observed: 208, expected: 104, verdict: "ok" });
    expect(twice).toMatchObject({
      steadyState: 237, ceilingSteadyState: 133,
      socketDemand: { reads: 104, resources: [{ resource: "dm-messages.head", demand: 104, overExpectation: 104 }] },
      ceiling: "over", inBand: false, passes: false,
    });
    // Under its expectation every read is demand; under 0.5× the row is
    // outside and none is.
    expect(judge({ "dm-messages.head": { class: "urgent", attempts: 30 } }, 40).socketDemand).toMatchObject({
      reads: 30, resources: [{ demand: 30, overExpectation: 0 }],
    });
    expect(judge({ "dm-messages.head": { class: "urgent", attempts: 10 } }, 40).socketDemand.reads).toBe(0);
    // 101 planned reads: over the ceiling; so are 101 urgent reads no frame implies.
    expect(judge({ "dm-messages.catchup": { class: "planned", attempts: 101 } }, null)).toMatchObject({
      steadyState: 101, ceilingSteadyState: 101, socketDemand: { reads: 0 }, ceiling: "over", passes: false,
    });
    const unexplained = judge({ "dm-messages.head": { class: "urgent", attempts: 101 } }, null);
    expect(head(unexplained)).toMatchObject({ expected: null, verdict: "not_modelled" });
    expect(unexplained).toMatchObject({ ceilingSteadyState: 101, socketDemand: { reads: 0 }, ceiling: "over", passes: false });
  });

  it("rule A1.shared-read: finds another key's list read served count beside the attempts against their frames, never in the steady state", () => {
    // A quiet page (below the band: every row must be at its expectation)
    // with only the new chats' finds switched on.
    const page = shadowPage("ari-1", Object.fromEntries(FANSLY_RESOURCE_SPECS
      .filter((entry) => entry.key !== "dm-conversations.find")
      .map((entry) => [entry.key, { enabled: false }])));
    const judge = (attempts: number, served: number | null) => demandOfPage(page, {
      window: WINDOW,
      observed: new Map([["dm-conversations.find", { class: "urgent", attempts }]]),
      ...(served === null ? {} : { served: new Map([["dm-conversations.find", served]]) }),
      reads: new Map([["dm-conversations.find", { reads: 6, dueLagsMs: [] }]]),
      facts: { runs: new Map(), placements: new Map(), firstShadowMs: T("2026-10-02T10:05:00Z") },
      counterparts: NO_GAPS,
    });
    const find = (demand: ReturnType<typeof judge>) => demand.resources.find((row) => row.resource === "dm-conversations.find")!;
    // Six new chats at once: one list read, five finds closed on it.
    const shared = judge(1, 5);
    expect(find(shared)).toMatchObject({
      observed: 1, expected: 6, ratio: 1, verdict: "ok",
      reason: "socket reads 6; 5 served by another key's read (rule A1.shared-read)",
    });
    expect(shared).toMatchObject({
      steadyState: 1,
      socketDemand: { reads: 1, resources: [{ resource: "dm-conversations.find", observed: 1, expected: 6, demand: 1, overExpectation: 0 }] },
      floor: { below: true, holds: true, outside: [] },
      passes: true,
    });
    // By its attempts alone the row would read a sixth of its expectation.
    expect(find(judge(1, null))).toMatchObject({ observed: 1, expected: 6, verdict: "outside" });
    expect(judge(1, null)).toMatchObject({ floor: { below: true, holds: false }, passes: false });
  });

  it("a single-request poll's run is its one request; every other poll's run is its consecutive steps", () => {
    expect(FANSLY_RESOURCE_SPECS.filter((entry) => entry.kind === "poll" && runGroupingOf(entry) === "single").map((entry) => entry.key).sort())
      .toEqual(["account.poll", "stats.hourly", "top-spenders.window"]);
    const spec = (key: string) => FANSLY_RESOURCE_SPECS.find((entry) => entry.key === key)!;
    expect(runGroupingOf(spec("transactions.insurance"))).toBe("poll");
    expect(runGroupingOf(spec("followers.reconcile"))).toBe("walk");
    // Two account polls 100 s apart: two runs, never one.
    expect(runsOf([attempt(0), attempt(100_000)], "single")).toHaveLength(2);
    expect(runsOf([attempt(0), attempt(100_000)], "poll")).toHaveLength(1);
  });

  it("a runaway poll or walk fails A1 on any page: a 6-h poll stepping every 3 s, a reconcile row that never closes, a 5-min poll every 100 s, an hourly account poll every 100 s", () => {
    const judge = (fixture: ReturnType<typeof lilly2>) => demandOfPage(shadowPage("lilly-2"), {
      window: WINDOW, observed: fixture.observed, reads: undefined,
      facts: { runs: fixture.runs, placements: new Map(), firstShadowMs: T("2026-10-02T10:05:00Z") }, counterparts: NO_GAPS,
    });
    const withRuns = (key: string, runs: KeyRun[]) => {
      const fixture = lilly2();
      fixture.runs.set(key, runs);
      fixture.observed.set(key, { class: "planned", attempts: runs.flatMap((run) => run.sentMs).filter((ms) => ms >= WINDOW.startMs && ms < WINDOW.endMs).length });
      return fixture;
    };
    // posts.refresh: its 6-step run at 06:00, then the next on schedule at
    // 11:40, a cursor walk stepping every 3 s that never ends.
    const refresh = judge(withRuns("posts.refresh", runsOf([...steps(T("2026-10-02T06:00:00Z"), 6), ...steps(T("2026-10-02T11:40:00Z"), 1_400)], "poll")));
    expect(refresh.resources.find((row) => row.resource === "posts.refresh")).toMatchObject({
      observed: 1_200, rate: { runSize: 6, extra: 0, beyond: 1_200 }, verdict: "outside",
    });
    expect(refresh.scheduleFaults).toEqual([expect.stringMatching(/^posts\.refresh: runaway: the run of 2026-10-02T11:40:00\.000Z still steps inside the window at 1400 requests, more than 22 /)]);
    expect(refresh).toMatchObject({ ceiling: "over", passes: false });
    expect(refresh.steadyState).toBeGreaterThan(1_200);
    // The same walk begun 48 min after the 10:52 run: an early run, all its window's requests counted besides.
    const early = judge(withRuns("posts.refresh", runsOf([...steps(T("2026-10-02T10:52:03Z"), 2), ...steps(T("2026-10-02T11:40:00Z"), 1_400)], "poll")));
    expect(early.resources.find((row) => row.resource === "posts.refresh")).toMatchObject({ rate: { runSize: 2, extra: 1_200, beyond: 0 } });
    expect(early.scheduleFaults).toEqual([expect.stringMatching(/^posts\.refresh: early: a run at 2026-10-02T11:40:00\.000Z .*; runaway: /)]);
    expect(early).toMatchObject({ ceiling: "over", passes: false });
    // followers.reconcile: yesterday's 100-step walk, today's on schedule at 11:00 and its row never closes.
    const reconcile = judge(withRuns("followers.reconcile", runsOf([
      ...steps(T("2026-10-01T11:00:00Z"), 100, 5_000, { workId: 1, workClosedMs: T("2026-10-01T11:10:00Z") }),
      ...steps(T("2026-10-02T11:00:00Z"), 1_320, 5_000, { workId: 2, workClosedMs: null }),
    ], "walk")));
    expect(reconcile.resources.find((row) => row.resource === "followers.reconcile")).toMatchObject({
      observed: 720, rate: { runSize: 100, extra: 0, beyond: 720 }, verdict: "outside",
    });
    expect(reconcile.scheduleFaults).toEqual([expect.stringMatching(/^followers\.reconcile: runaway: the run of 2026-10-02T11:00:00\.000Z still steps inside the window at 1320 requests, more than 210 .*\(rule A1\.rate\)$/)]);
    expect(reconcile).toMatchObject({ ceiling: "over", passes: false });
    // transactions.insurance re-admitted every 100 s since 11:00: below the run gap, so one long run.
    const insurance = judge(lilly2({ insurance: periodic(T("2026-10-02T11:00:00Z"), 100_000, WINDOW.endMs) }));
    expect(insurance.scheduleFaults).toEqual([expect.stringMatching(/^transactions\.insurance: runaway: the run of 2026-10-02T11:00:00\.000Z still steps inside the window 108\.3 min after it began \(66 requests\), longer than 5\.0 min /)]);
    expect(insurance.passes).toBe(false);
    // account.poll every 100 s: a single-request poll, so every re-run is early.
    const accountRuns: RunAttempt[] = [];
    for (let at = T("2026-10-02T11:00:00Z"); at < WINDOW.endMs; at += 100_000) accountRuns.push(attempt(at));
    const account = judge(withRuns("account.poll", runsOf(accountRuns, "single")));
    expect(account.resources.find((row) => row.resource === "account.poll")!.runs).toMatchObject({ runs: 36, demandRuns: 0 });
    expect(account.resources.find((row) => row.resource === "account.poll")!.runs!.early).toHaveLength(36);
    expect(account.scheduleFaults).toEqual([expect.stringMatching(/^account\.poll: early: .*; … and 33 more early runs \(period 60\.0 min, rule A1\.poll-schedule\)$/)]);
    expect(account.passes).toBe(false);
  });

  it("a normal run stays phase-independent: a walk still going below its last size, a head check a few pages longer, are no runaway", () => {
    // Today's reconcile at 12:40 still stepping at the window end (120 steps), yesterday's 186.
    const going = rateCount({
      periodMs: 24 * HOUR,
      window: WINDOW,
      runs: runsOf([
        ...steps(T("2026-10-01T12:32:28Z"), 186, 5_000, { workId: 1, workClosedMs: T("2026-10-01T12:48:02Z") }),
        ...steps(T("2026-10-02T12:40:00Z"), 120, 5_000, { workId: 2, workClosedMs: null }),
      ], "walk"),
      kind: "interval",
    });
    expect(going).toMatchObject({ runSize: 186, extra: 0, beyond: 0, counted: 7.75 });
    // A 5-min head check of 1 request, then one of 6 pages: inside 2 × 1 + 10.
    const insurance = judgePollRuns({
      periodMs: 5 * MINUTE,
      window: WINDOW,
      placementMs: null,
      runs: runsOf([attempt(T("2026-10-02T11:45:00Z")), ...steps(T("2026-10-02T11:50:00Z"), 6), attempt(T("2026-10-02T11:55:30Z"))], "poll"),
    });
    expect(insurance.runaway).toEqual([]);
    // A run that began before the window and still steps in it is judged against its predecessor.
    const anchor = judgePollRuns({
      periodMs: HOUR,
      window: WINDOW,
      placementMs: null,
      runs: runsOf([attempt(T("2026-10-02T11:40:00Z")), ...steps(T("2026-10-02T11:49:50Z"), 6)], "poll"),
    });
    expect(anchor.early).toEqual([{ at: new Date(T("2026-10-02T11:49:50Z")), afterMs: 10 * MINUTE - 500 - 10_000 }]);
  });

  it("transactions.rescan (socket, apply and period): frames that imply rescan reads none made are outside; a bump loop past the frames is outside", () => {
    const judge = (fixture: ReturnType<typeof lilly2>, reads: number) => demandOfPage(shadowPage("lilly-2"), {
      window: WINDOW, observed: fixture.observed, reads: new Map([["transactions.rescan", { reads, dueLagsMs: [] }]]),
      facts: { runs: fixture.runs, placements: new Map(), firstShadowMs: T("2026-10-02T10:05:00Z") }, counterparts: NO_GAPS,
    });
    const row = (demand: ReturnType<typeof judge>) => demand.resources.find((entry) => entry.resource === "transactions.rescan")!;
    // Six settled-transaction frames, no demand run: below 40 the floor fails.
    const missed = judge(lilly2(), 6);
    expect(row(missed)).toMatchObject({ expected: 6, verdict: "outside", reason: expect.stringContaining("0 demand runs vs 6 socket reads: fewer than 0.5×") });
    expect(missed).toMatchObject({ floor: { below: true, holds: false, outside: ["transactions.rescan"] }, passes: false });
    // Two frames, two bumped runs: ok.
    const bumped = lilly2();
    bumped.runs.set("transactions.rescan", runsOf([
      attempt(T("2026-10-02T11:25:00Z"), { demandRevision: 1 }),
      attempt(T("2026-10-02T12:01:00Z"), { demandRevision: 2 }),
      attempt(T("2026-10-02T12:20:00Z"), { demandRevision: 3 }),
    ], "poll"));
    expect(row(judge(bumped, 2))).toMatchObject({ verdict: "ok", runs: { demandRuns: 2 } });
    // A bump every 3 min at a new revision each time against one frame: more than 2 + 2 × 1.
    const loop = lilly2();
    loop.runs.set("transactions.rescan", runsOf([
      attempt(T("2026-10-02T11:25:00Z"), { demandRevision: 1 }),
      ...Array.from({ length: 19 }, (_, index) => attempt(WINDOW.startMs + (2 + 3 * index) * MINUTE, { demandRevision: 2 + index })),
    ], "poll"));
    expect(row(judge(loop, 1))).toMatchObject({ verdict: "outside", runs: { demandRuns: 19 }, reason: expect.stringContaining("more than the period's 2 runs + 2× the frames' reads (4) explain") });
  });

  it("lilly-1 at the registry's floor (19 requests) passes on schedule with its walks sized", () => {
    const fixture = lilly2({
      reconcileAt: T("2026-10-01T22:00:00Z"),
      // 11 insurance polls in the hour (the ±10 % jitter).
      insurance: runsOf([
        ...[0, 5.4, 10.8, 16.2, 21.6, 27, 32.4, 37.8, 43.2, 48.6, 54].map((minute) => attempt(WINDOW.startMs + 2 * MINUTE + minute * MINUTE)),
        attempt(WINDOW.startMs - 3 * MINUTE),
      ], "poll"),
    });
    const demand = demandOfPage(shadowPage("lilly-1"), {
      window: WINDOW, observed: fixture.observed, reads: undefined,
      facts: { runs: fixture.runs, placements: new Map(), firstShadowMs: null }, counterparts: NO_GAPS,
    });
    expect(demand.steadyStateRaw).toBe(19);
    expect(demand).toMatchObject({ ceiling: "ok", scheduleFaults: [], floor: { below: true, holds: true }, passes: true });
  });
});

describe("shadow report A2 bases (design §3.12, rules A2.*)", () => {
  const pages = Array.from({ length: 6 }, () => ({ registryOverrides: {} as Record<string, unknown> }));
  const specsOf = (ref: string) => FANSLY_RESOURCE_SPECS.filter((entry) => entry.legacy.some((legacy) =>
    ("stream" in legacy ? `stream:${legacy.stream}` : `sender:${legacy.sender}`) === ref));
  const basis = (ref: string, on = pages) => legacyComparisonBasis(specsOf(ref), on, HOUR, ref).basis;

  it("compares a stream as a rate when every key that runs in shadow recurs less often than the window", () => {
    for (const ref of [
      "stream:payouts", "stream:posts", "stream:stats_snapshot", "stream:fan_earnings", "stream:top_spenders",
      "stream:post_replies", "stream:catalog", "stream:media_stats", "stream:followers_reconcile",
    ]) expect([ref, basis(ref)]).toEqual([ref, "7d_rate"]);
    for (const ref of [
      "stream:light", "stream:transactions", "stream:dm_messages", "stream:dm_conversations", "stream:followers",
      "sender:ws_hint", "sender:account_me_api",
    ]) expect([ref, basis(ref)]).toEqual([ref, "window"]);
    for (const ref of ["sender:media_download", "sender:ws_connect", "sender:binding_preflight"]) expect([ref, basis(ref)]).toEqual([ref, "live_only"]);
    // Rule A2.demand-replaced: legacy's scheduled purchase poll against a key only demand drives.
    expect(DEMAND_REPLACED_STREAMS).toEqual(new Set(["stream:purchase_history"]));
    expect(basis("stream:purchase_history")).toBe("demand_replaced");
    // Without its ref (a caller that names no stream) the stream is compared on the window as before.
    expect(legacyComparisonBasis(specsOf("stream:purchase_history"), pages, HOUR).basis).toBe("window");
    // Other demand-driven streams are never exempted by it.
    expect(legacyComparisonBasis(specsOf("stream:dm_messages"), pages, HOUR, "stream:dm_messages").basis).toBe("window");
    // A page that polls the stats hourly puts the stream back on the window.
    expect(basis("stream:stats_snapshot", [...pages, { registryOverrides: { "stats.daily": { everyMs: HOUR } } }])).toBe("window");
  });

  it("counts physical attempts on both sides: legacy over its week, the shadow over each page's history", () => {
    const historyMs = [2.733, 2.695, 2.708, 2.673, 2.686, 2.743].map((hours) => hours * HOUR);
    const row = (ref: string, week: number, shadow: number[], note: string | null = null) => legacyVolumeRow({
      ref, keys: specsOf(ref).map((entry) => entry.key), basis: "7d_rate", liveOnlyKeys: [], windowMs: HOUR,
      legacy: { window: 0, rate: { attempts: week, from: new Date(WINDOW.endMs - 168 * HOUR), ms: 168 * HOUR } },
      shadow: { window: 0, history: shadow.map((attempts, index) => ({ attempts, historyMs: historyMs[index]! })) },
      note, regime: null,
    });
    // One stats.daily run of 11 requests counts 11, not one run.
    expect(row("stream:stats_snapshot", 582, [0, 11, 0, 0, 0, 0])).toMatchObject({ basis: "7d_rate", legacy: 3.46, shadow: 4.08, explained: true });
    expect(row("stream:payouts", 84, [0, 0, 2, 0, 0, 0])).toMatchObject({ legacy: 0.5, shadow: 0.74, explained: true });
    expect(row("stream:posts", 912, [6, 1, 0, 0, 2, 9])).toMatchObject({ legacy: 5.43, shadow: 6.59, explained: true });
    // Legacy's one-time lifetime re-walk in its week: outside unless its regime is cut off.
    const fanEarnings = row("stream:fan_earnings", 10_376, [12, 2, 4, 0, 2, 16]);
    expect(fanEarnings.ratio).toBeCloseTo(0.214, 2);
    expect(fanEarnings.explained).toBe(false);
    expect(LEGACY_REGIME_SINCE["stream:fan_earnings"]!.since).toEqual(new Date("2026-09-30T00:00:00Z"));
  });

  it("lists a live-only sender with its legacy volume, never as unexplained", () => {
    const keys = specsOf("sender:media_download").map((entry) => entry.key);
    expect(legacyVolumeRow({
      ref: "sender:media_download", keys, basis: "live_only", liveOnlyKeys: keys, windowMs: HOUR,
      legacy: { window: 5, rate: null }, shadow: { window: 0, history: [] }, note: null, regime: null,
    })).toMatchObject({ basis: "live_only", legacy: 5, shadow: 0, ratio: null, explained: true, note: expect.stringContaining("media-download.fetch") });
  });

  it("lists the legacy purchase poll with its volume when every order it read is announced; an order only it found leaves it unexplained (rule A2.demand-replaced)", () => {
    const keys = specsOf("stream:purchase_history").map((entry) => entry.key);
    const row = (legacyWindow: number, announcements: PurchaseAnnouncementCheck | null) => legacyVolumeRow({
      ref: "stream:purchase_history", keys, basis: "demand_replaced", liveOnlyKeys: [], windowMs: HOUR,
      legacy: { window: legacyWindow, rate: null }, shadow: { window: 0, history: [] }, note: null, regime: null, announcements,
    });
    const check = (overrides: Partial<PurchaseAnnouncementCheck> = {}): PurchaseAnnouncementCheck => ({
      captures: 3, targets: 3, targetsWithOrders: 0, orders: 0, ledger: 0, socketOnly: 0,
      unannounced: [], unannouncedCount: 0, unreadable: [], passes: true, ...overrides,
    });
    // Production, 2026-10-02 17:42–18:42: lora-1's poll read three empty targets.
    expect(row(3, check())).toMatchObject({
      basis: "demand_replaced", legacy: 3, shadow: 0, ratio: null, explained: true,
      note: expect.stringMatching(/^rule A2\.demand-replaced: purchases\.targets runs on demand only .*; the poll read 3 targets in 3 captures/),
      announcements: { passes: true },
    });
    const unannounced = check({
      targetsWithOrders: 1, orders: 1, passes: false, unannouncedCount: 1,
      unannounced: [{ page: "lora-1", pageId: 1, target: "media:5", orderId: "6", orderedAt: null }],
    });
    expect(row(3, unannounced)).toMatchObject({ explained: false, note: expect.stringContaining("1 NOT announced, a purchase only the poll found (lora-1 media:5 order 6)") });
    // Legacy attempts with nothing judged are no explanation; no attempt is nothing to explain.
    expect(row(3, null)).toMatchObject({ explained: false });
    expect(row(0, null)).toMatchObject({ explained: true, announcements: null });
  });

  it("the floor's counterparts: a stream the page's own shadow never served lacks one; live-only and history requests are listed apart", () => {
    const specsByRef = new Map(["stream:post_replies", "sender:media_download", "sender:targeted_backfill", "stream:notifications", "stream:light"]
      .map((ref) => [ref, specsOf(ref)] as const));
    const legacy = new Map([
      ["stream:post_replies", 3], ["sender:media_download", 5], ["sender:targeted_backfill", 2], ["stream:notifications", 2], ["stream:light", 1],
    ]);
    // 6.5 h of shadow history: the 30-min and hourly polls ran, the 6-hourly replies walk never did.
    const shadow = { attempts: new Map([["notifications.forward", 13], ["account.poll", 6]]), historyMs: 6.5 * HOUR };
    expect(legacyCounterparts({ page: shadowPage("ari-1"), legacy, specsByRef, shadow })).toEqual({
      lacking: [{ ref: "stream:post_replies", why: "legacy 3 on its A2 basis, the shadow none in 6.5 h of shadow history on the page" }],
      pending: [],
      scheduled: [],
      idle: [],
      onDemand: [],
      notInShadow: [{ ref: "sender:media_download", why: "live_only" }, { ref: "sender:targeted_backfill", why: "history_requests" }],
    });
    // The owner switched the account poll off on the page: its legacy stream lacks a counterpart there.
    expect(legacyCounterparts({
      page: shadowPage("ari-1", { "account.poll": { enabled: false } }), legacy: new Map([["stream:light", 1]]), specsByRef, shadow,
    }).lacking).toEqual([{ ref: "stream:light", why: "every key is switched off on the page" }]);
    // A page without legacy traffic on a stream is not judged on it.
    expect(legacyCounterparts({ page: shadowPage("lilly-1"), legacy: new Map([["stream:post_replies", 0]]), specsByRef, shadow }).lacking).toEqual([]);
  });

  it("the floor's counterparts are per page: one page's shadow volume never covers another's; a short history is not yet judgeable", () => {
    // 2026-10-02: fan_earnings legacy traffic on lilly-1 and lilly-2 since the
    // 09-30 regime; the shadow walked the roster on lilly-2 only.
    const specsByRef = new Map([["stream:fan_earnings", specsOf("stream:fan_earnings")]]);
    const legacy = new Map([["stream:fan_earnings", 29]]);
    const check = (attempts: Map<string, number>, historyMs: number | null) =>
      legacyCounterparts({ page: shadowPage("lilly-1"), legacy, specsByRef, shadow: { attempts, historyMs } });
    expect(check(new Map([["fan-earnings.roster", 2]]), 4.5 * HOUR)).toEqual({ lacking: [], pending: [], scheduled: [], idle: [], onDemand: [], notInShadow: [] });
    // lilly-1 4.5 h into shadow, its daily roster walk not yet due: not yet judgeable.
    expect(check(new Map(), 4.5 * HOUR)).toEqual({
      lacking: [],
      pending: [{
        ref: "stream:fan_earnings",
        why: "not yet judgeable: legacy 29 on its A2 basis, the shadow none in 4.5 h of shadow history on the page; its keys' first run is due within 24.03 h of the shadow's start",
      }],
      scheduled: [],
      idle: [],
      onDemand: [],
      notInShadow: [],
    });
    // A day and more without a walk on the page: it lacks one.
    expect(check(new Map(), 25 * HOUR).lacking).toEqual([
      { ref: "stream:fan_earnings", why: "legacy 29 on its A2 basis, the shadow none in 25 h of shadow history on the page" },
    ]);
    // lilly-2 11:50–12:50: legacy read one chat on a hint with no message
    // frame on the page; only demand drives the shadow's chat reads, so its
    // demand rows judge it and the stream is listed, not lacking.
    const dm = legacyCounterparts({
      page: shadowPage("lilly-2"),
      legacy: new Map([["stream:dm_messages", 1], ["sender:ws_hint", 1]]),
      specsByRef: new Map(["stream:dm_messages", "sender:ws_hint"].map((ref) => [ref, specsOf(ref)] as const)),
      shadow: { attempts: new Map([["dm-conversations.head", 6]]), historyMs: 2.69 * HOUR },
    });
    expect(dm).toMatchObject({ lacking: [], pending: [], scheduled: [] });
    expect(dm.onDemand.map((entry) => entry.ref)).toEqual(["sender:ws_hint", "stream:dm_messages"]);
    expect(dm.onDemand[1]!.why).toBe("legacy 1 on its A2 basis; only demand drives dm-messages.head, dm-messages.catchup, fan-profiles.probe, "
      + "none in 2.69 h of shadow history on the page (its demand rows judge the page's frames)");
    // Both pages below the floor, every resource at its expectation: lilly-2's
    // floor holds, lilly-1's fails on its own page's history alone.
    const fixture = lilly2();
    const judge = (counterparts: CounterpartCheck) => demandOfPage(shadowPage("lilly-1"), {
      window: WINDOW, observed: fixture.observed, reads: undefined,
      facts: { runs: fixture.runs, placements: new Map(), firstShadowMs: null }, counterparts,
    });
    expect(judge(check(new Map([["fan-earnings.roster", 2]]), 4.5 * HOUR))).toMatchObject({ floor: { below: true, holds: true }, passes: true });
    expect(judge(check(new Map(), 4.5 * HOUR))).toMatchObject({ floor: { below: true, holds: false }, passes: false });
    expect(judge(check(new Map(), 25 * HOUR))).toMatchObject({ floor: { below: true, holds: false }, passes: false });
  });

  it("rule A1.floor-scheduled: a stream whose recurring keys' rows are on schedule at the window end is scheduled; a missing, overdue or late row leaves it not yet judgeable", () => {
    // lilly-1 in 11:50–12:50, 2.67 h into shadow: 72 legacy reconcile
    // requests, its daily follower reconcile not run yet on the page (its row
    // a key with a row-kept schedule; a queue walk is rule A1.floor-queue's).
    const specsByRef = new Map(["stream:followers_reconcile", "stream:stats_snapshot"].map((ref) => [ref, specsOf(ref)] as const));
    const placed = T("2026-10-02T10:09:40Z");
    const row = (extra: Partial<ScheduleRow> = {}): ScheduleRow => ({ createdMs: placed, dueMs: T("2026-10-03T09:40:00Z"), firstAdmittedMs: null, quarantined: false, ...extra });
    const check = (rows: Record<string, ScheduleRow[]>, legacy = new Map([["stream:followers_reconcile", 72]])) => legacyCounterparts({
      page: shadowPage("lilly-1"),
      legacy,
      specsByRef,
      shadow: { attempts: new Map(), historyMs: WINDOW.endMs - T("2026-10-02T10:09:35Z"), schedule: { endMs: WINDOW.endMs, rows: new Map(Object.entries(rows)) } },
    });
    const bound = "placed 2026-10-02T10:09:40.000Z + 24 h + 2 min = 2026-10-03T10:11:40.000Z";
    // Due tomorrow 09:40, within its placement + 24 h + 2 min: scheduled.
    expect(check({ "followers.reconcile": [row()] })).toEqual({
      lacking: [],
      pending: [],
      scheduled: [{
        ref: "stream:followers_reconcile",
        why: `legacy 72 on its A2 basis, the shadow none yet in 2.67 h of shadow history on the page; on its schedule: followers.reconcile due 2026-10-03T09:40:00.000Z (${bound})`,
      }],
      idle: [],
      onDemand: [],
      notInShadow: [],
    });
    // Due a minute before the window end, waiting for its slot: still on schedule.
    expect(check({ "followers.reconcile": [row({ dueMs: WINDOW.endMs - MINUTE })] }).scheduled).toHaveLength(1);
    // Its first read came after the window end, by its bound: on schedule.
    expect(check({ "followers.reconcile": [row({ dueMs: T("2026-10-04T09:40:00Z"), firstAdmittedMs: T("2026-10-02T13:40:00Z") })] }).scheduled).toHaveLength(1);
    const pendingWhy = (rows: Record<string, ScheduleRow[]>, legacy?: Map<string, number>) => {
      const result = check(rows, legacy);
      expect(result.scheduled).toEqual([]);
      expect(result.pending).toHaveLength(1);
      return result.pending[0]!.why;
    };
    const notYet = "not yet judgeable: legacy 72 on its A2 basis, the shadow none in 2.67 h of shadow history on the page; its keys' first run is due within 24.03 h of the shadow's start; not on its schedule (rule A1.floor-scheduled): ";
    // No row of the key: the engine holds no read of it.
    expect(pendingWhy({})).toBe(`${notYet}followers.reconcile: no shadow work row on the page at the window end`);
    // Due in the window and not admitted by its end: overdue.
    expect(pendingWhy({ "followers.reconcile": [row({ dueMs: T("2026-10-02T12:30:00Z") })] }))
      .toBe(`${notYet}followers.reconcile: due 2026-10-02T12:30:00.000Z, not admitted by the window end`);
    // Due later than its placement + 24 h + 2 min: late.
    expect(pendingWhy({ "followers.reconcile": [row({ dueMs: T("2026-10-03T10:30:00Z") })] }))
      .toBe(`${notYet}followers.reconcile: due 2026-10-03T10:30:00.000Z, later than its bound (${bound})`);
    // A walk whose plan found nothing due (the owner's daily floor) set its
    // re-check past the bound without a read: still not on schedule, and the
    // reason is named.
    expect(pendingWhy({ "followers.reconcile": [row({ dueMs: T("2026-10-03T12:34:00Z"), recheckedMs: T("2026-10-02T12:34:00Z") })] }))
      .toBe(`${notYet}followers.reconcile: due 2026-10-03T12:34:00.000Z, later than its bound (${bound}); its last plan `
        + "(row updated 2026-10-02T12:34:00.000Z) found nothing due and set a re-check without a read");
    // Its first read after the window end came past the bound: late.
    expect(pendingWhy({ "followers.reconcile": [row({ firstAdmittedMs: T("2026-10-03T11:00:00Z") })] }))
      .toBe(`${notYet}followers.reconcile: its first read admitted 2026-10-03T11:00:00.000Z, after its bound (${bound})`);
    expect(pendingWhy({ "followers.reconcile": [row({ quarantined: true })] })).toBe(`${notYet}followers.reconcile: its row is quarantined`);
    // Every recurring key of the stream needs its row: stats.daily's alone does not schedule the 22-hourly stats.hourly.
    expect(pendingWhy({ "stats.daily": [row()] }, new Map([["stream:stats_snapshot", 11]])))
      .toMatch(/^not yet judgeable: .*; not on its schedule \(rule A1\.floor-scheduled\): stats\.hourly: no shadow work row on the page at the window end$/);
    // Past the shortest recurrence the schedule no longer helps: it lacks one.
    expect(legacyCounterparts({
      page: shadowPage("lilly-1"),
      legacy: new Map([["stream:followers_reconcile", 72]]),
      specsByRef,
      shadow: { attempts: new Map(), historyMs: 25 * HOUR, schedule: { endMs: WINDOW.endMs, rows: new Map([["followers.reconcile", [row()]]]) } },
    })).toMatchObject({ lacking: [{ ref: "stream:followers_reconcile" }], pending: [], scheduled: [] });
    // The floor's exception: scheduled holds, a missing or overdue row fails.
    const fixture = lilly2();
    const judge = (counterparts: CounterpartCheck) => demandOfPage(shadowPage("lilly-1"), {
      window: WINDOW, observed: fixture.observed, reads: undefined,
      facts: { runs: fixture.runs, placements: new Map(), firstShadowMs: null }, counterparts,
    });
    expect(judge(check({ "followers.reconcile": [row()] }))).toMatchObject({ floor: { below: true, holds: true }, passes: true });
    expect(judge(check({}))).toMatchObject({ floor: { below: true, holds: false }, passes: false });
    expect(judge(check({ "followers.reconcile": [row({ dueMs: T("2026-10-02T12:30:00Z") })] }))).toMatchObject({ floor: { below: true, holds: false }, passes: false });
  });

  it("the shadow's timeline estimate is the page size legacy measured (15 posts a page)", () => {
    expect(TIMELINE_PAGE_ESTIMATE).toBe(15);
  });
});

// ── the coverage gaps of the first production reports (2026-10-02): rules
// A1.floor-queue, A1.floor-idle and A1.rate-assumed on the production rows ──

describe("shadow report: queue walks, idle standing walks and assumed run sizes (rules A1.floor-queue, A1.floor-idle, A1.rate-assumed)", () => {
  const spec = (key: string) => FANSLY_RESOURCE_SPECS.find((entry) => entry.key === key)!;
  const specsOf = (ref: string) => FANSLY_RESOURCE_SPECS.filter((entry) => entry.legacy.some((legacy) =>
    ("stream" in legacy ? `stream:${legacy.stream}` : `sender:${legacy.sender}`) === ref));
  /** The integrator's window, 2026-10-02 13:30–14:30. */
  const END = T("2026-10-02T14:30:00Z");
  /** lilly-1's first shadow admission. */
  const LILLY1_FIRST_SHADOW = T("2026-10-02T10:09:35Z");

  it("a cadence is a schedule only for a subject-queue walk: the lookup is demand-only, the roster's shadow pass daily", () => {
    const page = shadowPage("lilly-1");
    expect(recurrenceMs(spec("fan-profiles.lookup"), page)).toBeNull();
    expect(spec("fan-profiles.lookup").cadence).toBeUndefined();
    expect(recurrenceMs(spec("fan-earnings.roster"), page)).toBe(24 * HOUR);
    expect(recurrenceMs(spec("followers.reconcile"), page)).toBe(24 * HOUR);
    expect(FANSLY_RESOURCE_SPECS.filter(isQueueWalk).map((entry) => entry.key)).toEqual(["fan-earnings.roster"]);
    expect(Object.keys(QUEUE_WALK_DRIVERS)).toEqual(["fan-earnings.roster"]);
    expect(LOOK_CLOCK_TOLERANCE_MS).toBe(MINUTE);
  });

  it("lilly-1 13:30–14:30: the reconcile waits on the owner's floor (scheduled), the roster's queue holds nothing due before 10-05 22:45 (idle); the floor's exception holds", () => {
    const specsByRef = new Map(["stream:followers_reconcile", "stream:fan_earnings"].map((ref) => [ref, specsOf(ref)] as const));
    const reconcile: ScheduleRow = {
      createdMs: T("2026-10-02T10:57:54.752Z"),
      dueMs: T("2026-10-03T08:16:37.783Z"),
      firstAdmittedMs: null,
      quarantined: false,
      recheckedMs: T("2026-10-02T10:57:54.800Z"),
    };
    // 99 spenders × 2 windows, read 09-29 10:45 … 09-30 10:45, no mark: the
    // first comes due 156 h after the oldest read.
    const roster: QueueFact = { nextDueMs: T("2026-10-05T22:45:08.767Z"), askedWithinMs: 1.1 * 5 * MINUTE + 2 * MINUTE };
    const check = (historyMs: number) => legacyCounterparts({
      page: shadowPage("lilly-1"),
      legacy: new Map([["stream:followers_reconcile", 72], ["stream:fan_earnings", 29]]),
      specsByRef,
      shadow: {
        attempts: new Map(),
        historyMs,
        schedule: { endMs: END, rows: new Map([["followers.reconcile", [reconcile]]]), queues: new Map([["fan-earnings.roster", roster]]) },
      },
    });
    const now = check(END - LILLY1_FIRST_SHADOW);
    expect(now).toEqual({
      lacking: [],
      pending: [],
      scheduled: [{
        ref: "stream:followers_reconcile",
        why: "legacy 72 on its A2 basis, the shadow none yet in 4.34 h of shadow history on the page; on its schedule: followers.reconcile "
          + "due 2026-10-03T08:16:37.783Z (placed 2026-10-02T10:57:54.752Z + 24 h + 2 min = 2026-10-03T10:59:54.752Z)",
      }],
      idle: [{
        ref: "stream:fan_earnings",
        why: "legacy 29 on its A2 basis, the shadow none in 4.34 h of shadow history on the page; nothing due: "
          + "fan-earnings.roster: queue idle, its next subject due 2026-10-05T22:45:08.767Z",
      }],
      onDemand: [],
      notInShadow: [],
    });
    const fixture = lilly2();
    const judge = (counterparts: CounterpartCheck) => demandOfPage(shadowPage("lilly-1"), {
      window: WINDOW, observed: fixture.observed, reads: undefined,
      facts: { runs: fixture.runs, placements: new Map(), firstShadowMs: null }, counterparts,
    });
    expect(judge(now)).toMatchObject({ floor: { below: true, holds: true }, passes: true });
    // A day on, the roster's queue still holds nothing due: idle, never lacking.
    const later = check(25 * HOUR);
    expect(later.idle.map((entry) => entry.ref)).toEqual(["stream:fan_earnings"]);
    expect(later.lacking.map((entry) => entry.ref)).toEqual(["stream:followers_reconcile"]);
  });

  it("rule A1.floor-queue: a subject due and no walk row is not yet judgeable, and lacking once the driver has had 1.1 × 5 min + 2 min", () => {
    const specsByRef = new Map([["stream:fan_earnings", specsOf("stream:fan_earnings")]]);
    const asked = 1.1 * 5 * MINUTE + 2 * MINUTE;
    const check = (nextDueMs: number | null, rows: ScheduleRow[] = [], historyMs = 4 * HOUR) => legacyCounterparts({
      page: shadowPage("lilly-1"),
      legacy: new Map([["stream:fan_earnings", 29]]),
      specsByRef,
      shadow: {
        attempts: new Map(),
        historyMs,
        schedule: {
          endMs: END,
          rows: new Map(rows.length === 0 ? [] : [["fan-earnings.roster", rows]]),
          queues: new Map([["fan-earnings.roster", { nextDueMs, askedWithinMs: asked }]]),
        },
      },
    });
    expect(queueOnSchedule({ key: "fan-earnings.roster", queue: { nextDueMs: null, askedWithinMs: asked }, endMs: END }))
      .toEqual({ onSchedule: true, idle: true, what: "fan-earnings.roster: queue idle, no subject comes due without a new write" });
    expect(check(null).idle).toHaveLength(1);
    // Due a minute before the window end: within the admission slack.
    expect(check(END - MINUTE).idle).toHaveLength(1);
    // Due 5 min before the end: the insurance poll may not have stepped yet.
    expect(check(END - 5 * MINUTE).pending).toEqual([{
      ref: "stream:fan_earnings",
      why: "not yet judgeable: legacy 29 on its A2 basis, the shadow none in 4 h of shadow history on the page; its keys' first run is due "
        + "within 24.03 h of the shadow's start; not on its schedule (rule A1.floor-queue): fan-earnings.roster: a subject due "
        + "2026-10-02T14:25:00.000Z, no walk row yet (its walk row is asked within 7.5 min of a due subject)",
    }]);
    // Due 10 min before the end and still no row: a missed due subject, at any history length.
    for (const historyMs of [HOUR, 4 * HOUR]) {
      expect(check(END - 10 * MINUTE, [], historyMs).lacking).toEqual([{
        ref: "stream:fan_earnings",
        why: `legacy 29 on its A2 basis, the shadow none in ${historyMs / HOUR} h of shadow history on the page; not on its schedule `
          + "(rule A1.floor-queue): fan-earnings.roster: a subject due 2026-10-02T14:20:00.000Z and no walk row by the window end "
          + "(its walk row is asked within 7.5 min of a due subject)",
      }]);
    }
    // An open row is judged by its schedule at any history length: the walk
    // asked a minute ago, waiting for its slot.
    const asking: ScheduleRow = { createdMs: END - MINUTE, dueMs: END - MINUTE, firstAdmittedMs: null, quarantined: false };
    expect(check(END - 2 * MINUTE, [asking], 30 * HOUR).scheduled).toHaveLength(1);
    // Without its queue read (no module check), the row rule stands as before.
    const unread = legacyCounterparts({
      page: shadowPage("lilly-1"),
      legacy: new Map([["stream:fan_earnings", 29]]),
      specsByRef,
      shadow: { attempts: new Map(), historyMs: 4 * HOUR, schedule: { endMs: END, rows: new Map() } },
    });
    expect(unread.pending[0]!.why).toMatch(/\(rule A1\.floor-scheduled\): fan-earnings\.roster: no shadow work row on the page at the window end$/);
    // A roster row legacy read after the window end: the queue as it stood
    // then is not known — not yet judgeable at any history length, never idle.
    const changed = "1 roster subject row changed after 2026-10-02T14:30:00.000Z (the newest 2026-10-02T14:40:00.000Z): the queue as it stood then is not known";
    const unknown: QueueFact = { nextDueMs: null, askedWithinMs: asked, unjudgeable: changed };
    expect(queueOnSchedule({ key: "fan-earnings.roster", queue: unknown, endMs: END })).toEqual({
      onSchedule: false,
      missed: false,
      fault: `fan-earnings.roster: ${changed} — its queue at the window end is not judgeable; report a window that ends after it`,
    });
    const moved = legacyCounterparts({
      page: shadowPage("lilly-1"),
      legacy: new Map([["stream:fan_earnings", 29]]),
      specsByRef,
      shadow: { attempts: new Map(), historyMs: 30 * HOUR, schedule: { endMs: END, rows: new Map(), queues: new Map([["fan-earnings.roster", unknown]]) } },
    });
    expect(moved).toMatchObject({ idle: [], lacking: [], pending: [{ ref: "stream:fan_earnings" }] });
    expect(moved.pending[0]!.why).toContain(`(rule A1.floor-queue): fan-earnings.roster: ${changed}`);
  });

  it("rule A1.floor-idle: the four standing walks of 2026-10-02 looked on time and found nothing due — idle at any history length", () => {
    // Its pick re-run at the look finds nothing; 5 years on it takes all 400 queued.
    const looked = (placed: string, look: string, due: string, extra: Partial<ScheduleRow> = {}): ScheduleRow => ({
      createdMs: T(placed),
      dueMs: T(due),
      firstAdmittedMs: null,
      quarantined: false,
      recheckedMs: T(look),
      dueAtLook: { count: 0, examples: [], queued: 400 },
      dueLater: { count: 400, examples: [], queued: 400 },
      ...extra,
    });
    const walk = (key: string, rows: ScheduleRow[], recheckMs: number) => standingWalkOnSchedule({ key, rows, recurrenceMs: recheckMs, endMs: END });
    // ari-1 media-stats.walk: placed 10:05:23, looked 12:34:23, next look 18:34:23.
    expect(walk("media-stats.walk", [looked("2026-10-02T10:05:23Z", "2026-10-02T12:34:23Z", "2026-10-02T18:34:23Z")], 6 * HOUR)).toEqual({
      onSchedule: true,
      idle: true,
      what: "media-stats.walk looked 2026-10-02T12:34:23.000Z, nothing due (its pick re-run there: none due and untouched since; "
        + "5 years on it takes 400 of the 400 queued); next look 2026-10-02T18:34:23.000Z (by the look + 6 h + 2 min)",
    });
    // ari-1 catalog.vault: its look at 14:30:44 came after the window end, within its placement + 24 h + 2 min.
    expect(walk("catalog.vault", [looked("2026-10-02T10:05:23Z", "2026-10-02T14:30:44Z", "2026-10-03T14:30:44Z")], 24 * HOUR))
      .toMatchObject({ onSchedule: true, idle: true, what: expect.stringContaining("looked 2026-10-02T14:30:44.000Z (after the window end), nothing due") });
    // lilly-1 posts.engagement and lora-1 post-replies.walk.
    expect(walk("posts.engagement", [looked("2026-10-02T10:05:03Z", "2026-10-02T10:47:18Z", "2026-10-02T16:47:18Z")], 6 * HOUR)).toMatchObject({ onSchedule: true, idle: true });
    expect(walk("post-replies.walk", [looked("2026-10-02T10:05:31Z", "2026-10-02T12:01:14Z", "2026-10-02T18:01:14Z")], 6 * HOUR)).toMatchObject({ onSchedule: true, idle: true });

    // A look after the window end, the walk still on its re-check: idle.
    expect(walk("media-stats.walk", [looked("2026-10-01T10:05:23Z", "2026-10-02T16:31:00Z", "2026-10-02T22:31:00Z")], 6 * HOUR))
      .toMatchObject({ onSchedule: true, idle: true });
    // Off schedule: a look more than a re-check after the window end (the
    // state at the end is not known), a next look past the look + re-check, a
    // look whose next one was due and not taken by the window end.
    expect(walk("media-stats.walk", [looked("2026-10-01T10:05:23Z", "2026-10-02T20:33:00Z", "2026-10-03T02:33:00Z")], 6 * HOUR)).toEqual({
      onSchedule: false,
      missed: false,
      fault: "media-stats.walk: looked 2026-10-02T20:33:00.000Z (after the window end), later than the window end + 6 h + 2 min = "
        + "2026-10-02T20:32:00.000Z: its state at the window end is not known — report a window that ends nearer to it",
    });
    expect(walk("media-stats.walk", [looked("2026-10-02T10:05:23Z", "2026-10-02T12:34:23Z", "2026-10-02T18:40:00Z")], 6 * HOUR)).toEqual({
      onSchedule: false,
      missed: false,
      fault: "media-stats.walk: looked 2026-10-02T12:34:23.000Z, its next look due 2026-10-02T18:40:00.000Z, later than the look + 6 h + 2 min = 2026-10-02T18:36:23.000Z",
    });
    expect(walk("media-stats.walk", [looked("2026-10-02T01:00:00Z", "2026-10-02T07:30:00Z", "2026-10-02T13:30:00Z")], 6 * HOUR))
      .toMatchObject({ onSchedule: false, missed: false, fault: "media-stats.walk: looked 2026-10-02T07:30:00.000Z, its next look due 2026-10-02T13:30:00.000Z and not taken by the window end" });
    // The pick re-run at the look finds due work untouched since: a missed look.
    expect(walk("media-stats.walk", [looked("2026-10-02T10:05:23Z", "2026-10-02T12:34:23Z", "2026-10-02T18:34:23Z", { dueAtLook: { count: 3, examples: ["m1", "m2", "m3"], queued: 400 } })], 6 * HOUR))
      .toEqual({
        onSchedule: false,
        missed: true,
        fault: "media-stats.walk: looked 2026-10-02T12:34:23.000Z and found nothing due, yet its own pick re-run there finds 3 due and untouched since (m1, m2, m3)",
      });
    // Its due rule's probe: the same pick 5 years on takes none of the 400
    // queued subjects — a rule that never reads, a missed look at once.
    const lookArgs = ["2026-10-02T10:05:23Z", "2026-10-02T12:34:23Z", "2026-10-02T18:34:23Z"] as const;
    expect(walk("media-stats.walk", [looked(...lookArgs, { dueLater: { count: 0, examples: [], queued: 400 } })], 6 * HOUR)).toEqual({
      onSchedule: false,
      missed: true,
      fault: "media-stats.walk: looked 2026-10-02T12:34:23.000Z and found nothing due, and its own pick takes none of the 400 subjects "
        + "on its queue even 5 years after the look: its due rule never reads",
    });
    // An empty queue: idle, nothing to read.
    expect(walk("media-stats.walk", [looked(...lookArgs, {
      dueAtLook: { count: 0, examples: [], queued: 0 }, dueLater: { count: 0, examples: [], queued: 0 },
    })], 6 * HOUR)).toMatchObject({ onSchedule: true, idle: true, what: expect.stringContaining("(its pick re-run there: none due and untouched since; its queue holds no subject)") });
    // Unverified: no look check, no probe, a probe that did not pick, a failed one.
    const { dueAtLook: _unchecked, ...unverified } = looked(...lookArgs);
    expect(walk("media-stats.walk", [unverified], 6 * HOUR))
      .toMatchObject({ onSchedule: false, missed: false, fault: expect.stringContaining("no look check verifies it") });
    const { dueLater: _unprobed, ...unprobed } = looked(...lookArgs);
    expect(walk("media-stats.walk", [unprobed], 6 * HOUR))
      .toMatchObject({ onSchedule: false, missed: false, fault: expect.stringContaining("no probe of its due rule verifies it") });
    expect(walk("media-stats.walk", [looked(...lookArgs, { dueLater: { count: 0, examples: [], queued: null } })], 6 * HOUR))
      .toMatchObject({ onSchedule: false, missed: false, fault: expect.stringContaining("no probe of its due rule verifies it") });
    expect(walk("media-stats.walk", [looked(...lookArgs, { dueLater: { error: "canceling statement due to statement timeout" } })], 6 * HOUR)).toEqual({
      onSchedule: false,
      missed: false,
      fault: "media-stats.walk: looked 2026-10-02T12:34:23.000Z; its due rule's probe failed: canceling statement due to statement timeout",
    });
    // A row that never looked is a first run on its placement's schedule.
    expect(walk("post-replies.walk", [{ createdMs: T("2026-10-02T10:05:27Z"), dueMs: T("2026-10-02T15:47:05Z"), firstAdmittedMs: null, quarantined: false }], 6 * HOUR))
      .toMatchObject({ onSchedule: true, idle: false });

    // The stream on ari-1: idle at 4.4 h and at 25 h of history; a missed
    // look lacks at once; a stale look lacks past the re-check.
    const specsByRef = new Map([["stream:media_stats", specsOf("stream:media_stats")]]);
    const counterparts = (rows: ScheduleRow[], historyMs: number) => legacyCounterparts({
      page: shadowPage("ari-1"),
      legacy: new Map([["stream:media_stats", 265]]),
      specsByRef,
      shadow: { attempts: new Map(), historyMs, schedule: { endMs: END, rows: new Map([["media-stats.walk", rows]]) } },
    });
    const ari1 = looked("2026-10-02T10:05:23Z", "2026-10-02T12:34:23Z", "2026-10-02T18:34:23Z");
    expect(counterparts([ari1], END - T("2026-10-02T10:05:24Z"))).toMatchObject({ idle: [{ ref: "stream:media_stats" }], lacking: [], pending: [] });
    expect(counterparts([ari1], 25 * HOUR).idle[0]!.why).toBe("legacy 265 on its A2 basis, the shadow none in 25 h of shadow history on the page; nothing due: "
      + "media-stats.walk looked 2026-10-02T12:34:23.000Z, nothing due (its pick re-run there: none due and untouched since; 5 years on it takes "
      + "400 of the 400 queued); next look 2026-10-02T18:34:23.000Z (by the look + 6 h + 2 min)");
    expect(counterparts([{ ...ari1, dueAtLook: { count: 1, examples: ["m1"], queued: 400 } }], 2 * HOUR).lacking).toHaveLength(1);
    expect(counterparts([{ ...ari1, dueLater: { count: 0, examples: [], queued: 400 } }], 2 * HOUR).lacking[0]!.why)
      .toMatch(/\(rule A1\.floor-idle\): media-stats\.walk: .* takes none of the 400 subjects on its queue even 5 years after the look: its due rule never reads$/);
    const stale = looked("2026-10-01T01:00:00Z", "2026-10-02T07:30:00Z", "2026-10-02T13:30:00Z");
    expect(counterparts([stale], 4 * HOUR).pending).toHaveLength(1);
    expect(counterparts([stale], 25 * HOUR).lacking[0]!.why).toMatch(/\(rule A1\.floor-idle\): media-stats\.walk: looked 2026-10-02T07:30:00\.000Z, its next look due 2026-10-02T13:30:00\.000Z and not taken by the window end$/);
  });

  it("rule A1.rate-assumed: lilly-1 14:00–15:00 with no daily key run yet is 23.34 an hour, the ceiling ok on assumed sizes", () => {
    const window = { startMs: T("2026-10-02T14:00:00Z"), endMs: T("2026-10-02T15:00:00Z") };
    const observed = new Map(Object.entries({
      "account.poll": 1, "dm-conversations.head": 2, "notifications.forward": 2, "subscribers.poll": 1, "transactions.insurance": 12,
      "transactions.rescan": 1, "media-stats.walk": 430, "catalog.vault": 14,
    }).map(([key, attempts]) => [key, { class: "planned", attempts }] as const));
    // lilly-1's rows of these keys on production: placed at its shadow start
    // (the reconcile at its first head decision), none run by 15:00 — the
    // posts and top-spenders polls first read at 15:04 and 15:05, by their bound.
    const placed = "2026-10-02T10:05:03.566Z";
    const row = (due: string, firstAdmitted: string | null = null, createdAt = placed): ScheduleRow => ({
      createdMs: T(createdAt), dueMs: T(due), firstAdmittedMs: firstAdmitted === null ? null : T(firstAdmitted), quarantined: false,
    });
    const lilly1Rows: Record<string, [number, ScheduleRow]> = {
      "dm-conversations.full": [36, row("2026-10-03T04:22:24.637Z")],
      "followers.reconcile": [36, row("2026-10-03T08:16:37.783Z", null, "2026-10-02T10:57:54.752Z")],
      "posts.refresh": [2, row("2026-10-02T20:46:59.716Z", "2026-10-02T15:04:32.655Z")],
      "stats.daily": [11, row("2026-10-02T17:00:25.190Z")],
      "catalog.fixed": [6, row("2026-10-03T02:41:25.679Z")],
      "payouts.daily": [2, row("2026-10-02T17:00:32.709Z")],
      "top-spenders.window": [1, row("2026-10-02T20:47:29.450Z", "2026-10-02T15:05:40.652Z")],
      "stats.hourly": [1, row("2026-10-02T20:25:48.556Z")],
    };
    const assumedRuns = new Map(Object.entries(lilly1Rows).map(([key, [steps, scheduleRow]]) => [key, {
      steps, rows: [scheduleRow], closedRunMs: null, runsFromMs: window.startMs - 28 * HOUR,
    } satisfies AssumedRun] as const));
    const judge = (assumed?: ReadonlyMap<string, AssumedRun>) => demandOfPage(shadowPage("lilly-1"), {
      window, observed, reads: undefined,
      facts: { runs: new Map(), placements: new Map(), firstShadowMs: null, ...(assumed === undefined ? {} : { assumed }) },
      counterparts: NO_GAPS,
    });
    // 19 + 36/24 + 36/24 + 2/6 + 11/24 + 6/24 + 2/24 + 1/6 + 1/22
    const assumed = judge(assumedRuns);
    expect(assumed).toMatchObject({ steadyState: 23.34, steadyStateRaw: 19, unknownRunSize: [], ceiling: "ok", ceilingBasis: "assumed" });
    expect(assumed.assumedRunSize).toHaveLength(8);
    expect(assumed.assumedRunSize).toContainEqual({ resource: "dm-conversations.full", steps: 36, periodMs: 24 * HOUR });
    expect(assumed.resources.find((row) => row.resource === "followers.reconcile")).toMatchObject({
      rate: { sizedBy: "assumed", runSize: 36, counted: 1.5 },
      reason: "a walk at most every 24 h: no finished walk yet, counted at its assumed 36 steps per 24 h (rule A1.rate-assumed)",
    });
    expect(assumed.resources.find((row) => row.resource === "stats.daily")!.reason).toContain("no finished run yet: counted at its assumed 11 per 24 h (rule A1.rate-assumed)");
    // Without an estimate the ceiling stays unknown on what the window saw.
    expect(judge()).toMatchObject({ steadyState: 19, ceiling: "unknown", ceilingBasis: "measured", assumedRunSize: [] });
    expect(judge().unknownRunSize).toHaveLength(8);
  });

  /** A daily key placed at the shadow's start, its first run not due yet. */
  const firstRunDue = (steps: number, extra: Partial<AssumedRun> = {}): AssumedRun => ({
    steps,
    rows: [{ createdMs: T("2026-10-02T10:05:25Z"), dueMs: T("2026-10-03T08:34:08Z"), firstAdmittedMs: null, quarantined: false }],
    closedRunMs: null,
    runsFromMs: WINDOW.startMs - 28 * HOUR,
    ...extra,
  });

  it("rule A1.rate-assumed in a key's count: the assumption until its first finished run, a first run past it counts its excess", () => {
    const day = 24 * HOUR;
    // No run, assumed 80 per 24 h.
    expect(rateCount({ periodMs: day, window: WINDOW, runs: [], kind: "poll", assumed: firstRunDue(80) }))
      .toMatchObject({ runSize: 80, runAt: null, sizedBy: "assumed", extra: 0, beyond: 0, notAssumed: null });
    expect(rateCount({ periodMs: day, window: WINDOW, runs: [], kind: "poll", assumed: firstRunDue(80) }).counted).toBeCloseTo(80 / 24, 6);
    // Its first run, 90 steps still going in the window: + 10 beyond.
    const going = rateCount({
      periodMs: day,
      window: WINDOW,
      runs: runsOf(steps(T("2026-10-02T12:46:00Z"), 90, 2_000), "poll"),
      kind: "poll",
      assumed: firstRunDue(80, {
        rows: [{ createdMs: T("2026-10-02T10:05:25Z"), dueMs: T("2026-10-02T12:49:58Z"), firstAdmittedMs: T("2026-10-02T12:46:00Z"), quarantined: false }],
      }),
    });
    expect(going).toMatchObject({ runSize: 80, sizedBy: "assumed", beyond: 10 });
    // A finished 44-step run: the measurement wins.
    const finished = rateCount({ periodMs: day, window: WINDOW, runs: runsOf(steps(T("2026-10-02T09:00:00Z"), 44, 2_000), "poll"), kind: "poll", assumed: firstRunDue(80) });
    expect(finished).toMatchObject({ runSize: 44, sizedBy: "run", notAssumed: null });
    expect(finished.counted).toBeCloseTo(44 / 24, 6);
    // No run and no estimate: unknown.
    expect(rateCount({ periodMs: day, window: WINDOW, runs: [], kind: "poll" })).toMatchObject({ runSize: null, counted: null, sizedBy: null, notAssumed: null });
    // lilly-2's hour before its daily list sweep ran: unknown without an
    // estimate, 35.17 an hour on its 146 assumed pages.
    const fixture = lilly2({ withoutRun: "dm-conversations.full" });
    const judge = (assumed?: ReadonlyMap<string, AssumedRun>) => demandOfPage(shadowPage("lilly-2"), {
      window: WINDOW, observed: fixture.observed, reads: undefined,
      facts: { runs: fixture.runs, placements: new Map(), firstShadowMs: T("2026-10-02T10:05:00Z"), ...(assumed === undefined ? {} : { assumed }) },
      counterparts: NO_GAPS,
    });
    expect(judge()).toMatchObject({ unknownRunSize: ["dm-conversations.full"], ceiling: "unknown", passes: false });
    expect(judge(new Map([["dm-conversations.full", firstRunDue(146)]]))).toMatchObject({
      steadyState: 35.17, unknownRunSize: [], ceiling: "ok", ceilingBasis: "assumed", passes: true,
    });
  });

  it("rule A1.rate-assumed holds only before a key's first finished run, while its row keeps that run on schedule: a stopped reconcile stays unknown", () => {
    const day = 24 * HOUR;
    const end = WINDOW.endMs;
    const reconcile = (assumed: AssumedRun, runs: readonly KeyRun[] = []) =>
      rateCount({ periodMs: day, window: WINDOW, runs, kind: "interval", assumed, key: "followers.reconcile" });
    // The reviewer's case: its only 85-step walk closed 40 h before the window
    // end (before the runs the report reads), the next row placed and on
    // schedule — the key ran: no assumption, unknown.
    const ranBefore = reconcile(firstRunDue(85, { closedRunMs: end - 40 * HOUR }));
    expect(ranBefore).toMatchObject({ runSize: null, counted: null, sizedBy: null });
    expect(ranBefore.notAssumed).toBe(`followers.reconcile: a run of it closed ${new Date(end - 40 * HOUR).toISOString()} — a key that ran is sized by its runs`);
    // The same walk among the runs read, outside its 27.4-h look-back.
    const walkStart = end - 40 * HOUR - 3 * MINUTE;
    const oldWalk = runsOf(steps(walkStart, 85, 2_000, { workId: 4773, workClosedMs: end - 40 * HOUR }), "walk");
    expect(reconcile(firstRunDue(85), oldWalk)).toMatchObject({
      sizedBy: null,
      notAssumed: `followers.reconcile: its run of ${new Date(walkStart).toISOString()} finished before the window end — a key that ran is sized by its runs`,
    });
    // Never ran, but its row is quarantined: unknown.
    const quarantined = firstRunDue(85, { rows: [{ createdMs: T("2026-10-02T10:57:54Z"), dueMs: T("2026-10-03T08:16:37Z"), firstAdmittedMs: null, quarantined: true }] });
    expect(reconcile(quarantined)).toMatchObject({ sizedBy: null, counted: null, notAssumed: "followers.reconcile: its row is quarantined" });
    // Never ran, no row at the window end; a row due and not admitted by the end.
    expect(reconcile(firstRunDue(85, { rows: [] })).notAssumed).toBe("followers.reconcile: no shadow work row on the page at the window end");
    const overdue = firstRunDue(85, { rows: [{ createdMs: T("2026-10-02T10:57:54Z"), dueMs: T("2026-10-02T12:00:00Z"), firstAdmittedMs: null, quarantined: false }] });
    expect(reconcile(overdue).notAssumed).toBe("followers.reconcile: due 2026-10-02T12:00:00.000Z, not admitted by the window end");
    // Its first walk admitted and then left due (stuck mid-walk).
    const stuck = firstRunDue(85, { rows: [{ createdMs: T("2026-10-02T10:57:54Z"), dueMs: T("2026-10-02T12:10:00Z"), firstAdmittedMs: T("2026-10-02T12:00:00Z"), quarantined: false }] });
    expect(reconcile(stuck, runsOf(steps(T("2026-10-02T12:00:00Z"), 10, 2_000, { workId: 5840 }), "walk")).notAssumed)
      .toBe("followers.reconcile: its first run, admitted 2026-10-02T12:00:00.000Z, was due again 2026-10-02T12:10:00.000Z and not taken by the window end");
    // A row whose first attempt precedes the runs the report reads.
    const old = firstRunDue(85, { rows: [{ createdMs: T("2026-09-29T10:00:00Z"), dueMs: T("2026-10-02T13:00:00Z"), firstAdmittedMs: T("2026-09-29T10:05:00Z"), quarantined: false }] });
    expect(reconcile(old).notAssumed).toBe(
      `followers.reconcile: its row's first run began 2026-09-29T10:05:00.000Z, before the runs the report reads (from ${new Date(WINDOW.startMs - 28 * HOUR).toISOString()})`,
    );
    // lilly-1's reconcile of 2026-10-02 (placed 10:57:54, due 10-03 08:16:37,
    // by its placement + 24 h + 2 min): assumed.
    const lilly1 = firstRunDue(36, { rows: [{ createdMs: T("2026-10-02T10:57:54.752Z"), dueMs: T("2026-10-03T08:16:37.783Z"), firstAdmittedMs: null, quarantined: false }] });
    expect(reconcile(lilly1)).toMatchObject({ runSize: 36, sizedBy: "assumed", notAssumed: null });

    // On the page: the ceiling is unknown and says why, A1 fails.
    const fixture = lilly2({ withoutRun: "followers.reconcile" });
    const page = demandOfPage(shadowPage("lilly-2"), {
      window: WINDOW, observed: fixture.observed, reads: undefined,
      facts: { runs: fixture.runs, placements: new Map(), firstShadowMs: T("2026-10-02T10:05:00Z"), assumed: new Map([["followers.reconcile", quarantined]]) },
      counterparts: NO_GAPS,
    });
    expect(page).toMatchObject({ unknownRunSize: ["followers.reconcile"], ceiling: "unknown", assumedRunSize: [], passes: false });
    expect(page.resources.find((entry) => entry.resource === "followers.reconcile")!.reason).toBe(
      "a walk at most every 24 h: no finished walk to size it yet and not counted at its estimate, followers.reconcile: its row is quarantined "
        + "(rule A1.rate-assumed)",
    );
  });
});
