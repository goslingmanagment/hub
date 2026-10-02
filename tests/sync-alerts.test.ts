import { describe, expect, it } from "vitest";

import {
  incidentTitleForKind,
  resolveMessageForIncident,
  SYNC_ENGINE_PACE_VIOLATION_SUBKEY,
  syncEngineIncidentKey,
} from "../apps/runtime/src/services/notification-incidents.ts";
import { notificationPagingPolicyFor } from "../apps/runtime/src/services/notification-paging-policy.ts";
import { parseReportWindow } from "../apps/runtime/src/sync/cli/report.ts";
import {
  evaluatePageAlerts,
  SYNC_ALERT_CLEAN_MS,
  SYNC_HANDOVER_STUCK_MS,
  SYNC_OWNERSHIP_UNCONFIRMED_MS,
  SYNC_SOCKET_DOWN_MS,
  syncAlertResolveAfterMs,
  type PageAlertFacts,
} from "../apps/runtime/src/sync/engine/alerts.ts";
import { LIST_RATE_LIMIT_LADDER_MS, NETWORK_ALERT_AFTER_MS } from "../apps/runtime/src/sync/engine/errors.ts";
import { OWNERSHIP_ALERT_AFTER_MS } from "../apps/runtime/src/sync/engine/host.ts";
import { quantileOf, syncMetricsDue } from "../apps/runtime/src/sync/engine/metrics.ts";
import { POLL_JITTER } from "../apps/runtime/src/sync/engine/resource.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import { TIMELINE_PAGE_ESTIMATE } from "../apps/runtime/src/sync/fansly/resources/posts.ts";
import { moneyFramesMissing } from "../apps/runtime/src/sync/fansly/ws/money-frames.ts";
import { routeThreadAt } from "../apps/runtime/src/sync/fansly/ws/route-receipt.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { REPLAY_EXCUSED_REASONS, scoreReplayKind } from "../apps/runtime/src/sync/report/shadow-journal.ts";
import {
  demandOfPage,
  isOneTimeWalk,
  judgePollRuns,
  LEGACY_REGIME_SINCE,
  legacyComparisonBasis,
  legacyCounterparts,
  legacyVolumeRow,
  POLL_RUN_GAP_MS,
  pollScheduleFault,
  rateCount,
  runGroupingOf,
  runsOf,
  SHADOW_SETTLE_MS,
  SHADOW_WINDOW_RULES,
  shadowWindowCoverage,
  simulateCoalescedReads,
  type CounterpartCheck,
  type KeyRun,
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

  it("alert 1: the list's 429 hold pages only at the top of its ladder", () => {
    const list = (step: number) => facts({
      page: {
        resourceHolds: {
          "dm-conversations": { kind: "rate_limit_list", until: at(MINUTE).toISOString(), step, since: at(-10 * MINUTE).toISOString() },
        },
      },
    });
    expect(evaluate(list(LIST_RATE_LIMIT_LADDER_MS.length - 1))).toEqual({});
    expect(evaluate(list(LIST_RATE_LIMIT_LADDER_MS.length))).toEqual({ page_stopped: "rate_limit_list" });
  });

  it("alert 1: '10 min clean' — a stop answer within the window keeps the alert after its hold ended", () => {
    const answeredAt = at(-SYNC_ALERT_CLEAN_MS + MINUTE);
    const recent = facts({ journal: { lastStopAttempt: { errorClass: "rate_limit", at: answeredAt } } });
    expect(evaluate(recent)).toEqual({ page_stopped: "rate_limit" });
    // It holds as of the answer, not now: the latch resolves 10 min after it.
    expect(evaluatePageAlerts(recent, registry)).toEqual([expect.objectContaining({ subKey: "page_stopped", seenAt: answeredAt })]);
    // A hold in force holds now, whatever the journal says.
    const held = facts({
      page: { holdKind: "rate_limit", holdUntil: at(MINUTE), holdSince: at(-MINUTE) },
      journal: { lastStopAttempt: { errorClass: "rate_limit", at: answeredAt } },
    });
    expect(evaluatePageAlerts(held, registry)).toEqual([expect.objectContaining({ detail: "rate_limit", seenAt: NOW })]);
    const clean = facts({ journal: { lastStopAttempt: { errorClass: "rate_limit", at: at(-SYNC_ALERT_CLEAN_MS - MINUTE) } } });
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
  it("keys one latch per page and alert, the pace violation apart, alert 5 global", () => {
    expect(syncEngineIncidentKey({ subKey: "page_stopped", pageId: 7 })).toBe("fansly_sync_engine:7:page_stopped");
    expect(syncEngineIncidentKey({ subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY, pageId: 7 }))
      .toBe("fansly_sync_engine:7:page_stopped:pace_violation");
    expect(syncEngineIncidentKey({ subKey: "process", pageId: null })).toBe("fansly_sync_engine:global:process");
  });

  it("opens and resolves under one title per alert", () => {
    const titles = ["page_stopped", SYNC_ENGINE_PACE_VIOLATION_SUBKEY, "live_degraded", "freshness", "stuck", "process"]
      .map((subKey) => incidentTitleForKind({ kind: "fansly_sync_engine", subKey }));
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles.every((title) => title.startsWith("Fansly Sync Engine"))).toBe(true);
    expect(incidentTitleForKind({ kind: "fansly_sync_engine", subKey: "process" })).toContain("no sync heartbeat for 2 min");
    expect(resolveMessageForIncident({ kind: "fansly_sync_engine", subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY, pageLabel: "lilly-1", platform: "fansly" }))
      .toBe("✅ Resolved\nFansly Sync Engine pace violation acknowledged by the owner: lilly-1 (fansly)");
    expect(resolveMessageForIncident({ kind: "fansly_sync_engine", subKey: "process", pageLabel: null, platform: null }))
      .toBe("✅ Resolved\nFansly Sync Engine heartbeat back");
  });

  it("pages every alert at once", () => {
    for (const subKey of ["page_stopped", SYNC_ENGINE_PACE_VIOLATION_SUBKEY, "live_degraded", "freshness", "stuck", "process"]) {
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
const NO_GAPS: CounterpartCheck = { lacking: [], pending: [], scheduled: [], onDemand: [], notInShadow: [] };

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
      "A1.rate", "A1.ceiling", "A1.floor", "A1.floor-scheduled", "A1.poll-schedule", "A2.rate", "A2.legacy-regime", "A2.live-only",
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
      counterparts: { lacking: [], pending: [], scheduled: [], onDemand: [], notInShadow: [{ ref: "sender:ws_connect", why: "live_only" }] },
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

  it("A1 fails: a key without a finished run, a starved poll, over the ceiling, below the floor with an unmet expectation or a legacy stream without a counterpart", () => {
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
    // 70 chat reads on 70 socket reads: 105.42 an hour, over the ceiling.
    const busy = judge(
      lilly2({ extraObserved: { "dm-messages.head": { class: "urgent", attempts: 70 } } }),
      { reads: new Map([["dm-messages.head", { reads: 70, dueLagsMs: [] }]]) },
    );
    expect(busy).toMatchObject({ steadyState: 105.42, ceiling: "over", inBand: false, passes: false });
    expect(busy.floor.below).toBe(false);
    // Below the floor with four chat reads the frames imply and none made.
    const missed = judge(lilly2(), { reads: new Map([["dm-messages.head", { reads: 4, dueLagsMs: [] }]]) });
    expect(missed.floor).toMatchObject({ below: true, holds: false, outside: ["dm-messages.head"] });
    expect(missed.passes).toBe(false);
    // Below the floor with a legacy stream the shadow never matched.
    const lacking = judge(lilly2(), { counterparts: { lacking: [{ ref: "stream:post_replies", why: "legacy 3 on its A2 basis, the shadow none in 6.5 h of shadow history on the page" }], pending: [], scheduled: [], onDemand: [], notInShadow: [] } });
    expect(lacking.floor).toMatchObject({ below: true, holds: false });
    expect(lacking.passes).toBe(false);
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
  const basis = (ref: string, on = pages) => legacyComparisonBasis(specsOf(ref), on, HOUR).basis;

  it("compares a stream as a rate when every key that runs in shadow recurs less often than the window", () => {
    for (const ref of [
      "stream:payouts", "stream:posts", "stream:stats_snapshot", "stream:fan_earnings", "stream:top_spenders",
      "stream:post_replies", "stream:catalog", "stream:media_stats", "stream:followers_reconcile",
    ]) expect([ref, basis(ref)]).toEqual([ref, "7d_rate"]);
    for (const ref of [
      "stream:light", "stream:transactions", "stream:dm_messages", "stream:dm_conversations", "stream:followers",
      "stream:purchase_history", "sender:ws_hint", "sender:account_me_api",
    ]) expect([ref, basis(ref)]).toEqual([ref, "window"]);
    for (const ref of ["sender:media_download", "sender:ws_connect", "sender:binding_preflight"]) expect([ref, basis(ref)]).toEqual([ref, "live_only"]);
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
    expect(check(new Map([["fan-earnings.roster", 2]]), 4.5 * HOUR)).toEqual({ lacking: [], pending: [], scheduled: [], onDemand: [], notInShadow: [] });
    // lilly-1 4.5 h into shadow, its daily roster walk not yet due: not yet judgeable.
    expect(check(new Map(), 4.5 * HOUR)).toEqual({
      lacking: [],
      pending: [{
        ref: "stream:fan_earnings",
        why: "not yet judgeable: legacy 29 on its A2 basis, the shadow none in 4.5 h of shadow history on the page; its keys' first run is due within 24.03 h of the shadow's start",
      }],
      scheduled: [],
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
    // lilly-1 in 11:50–12:50, 2.67 h into shadow: 29 legacy fan_earnings
    // requests, its daily roster walk not run yet on the page.
    const specsByRef = new Map(["stream:fan_earnings", "stream:stats_snapshot"].map((ref) => [ref, specsOf(ref)] as const));
    const placed = T("2026-10-02T10:09:40Z");
    const row = (extra: Partial<ScheduleRow> = {}): ScheduleRow => ({ createdMs: placed, dueMs: T("2026-10-03T09:40:00Z"), firstAdmittedMs: null, quarantined: false, ...extra });
    const check = (rows: Record<string, ScheduleRow[]>, legacy = new Map([["stream:fan_earnings", 29]])) => legacyCounterparts({
      page: shadowPage("lilly-1"),
      legacy,
      specsByRef,
      shadow: { attempts: new Map(), historyMs: WINDOW.endMs - T("2026-10-02T10:09:35Z"), schedule: { endMs: WINDOW.endMs, rows: new Map(Object.entries(rows)) } },
    });
    const bound = "placed 2026-10-02T10:09:40.000Z + 24 h + 2 min = 2026-10-03T10:11:40.000Z";
    // Due tomorrow 09:40, within its placement + 24 h + 2 min: scheduled.
    expect(check({ "fan-earnings.roster": [row()] })).toEqual({
      lacking: [],
      pending: [],
      scheduled: [{
        ref: "stream:fan_earnings",
        why: `legacy 29 on its A2 basis, the shadow none yet in 2.67 h of shadow history on the page; on its schedule: fan-earnings.roster due 2026-10-03T09:40:00.000Z (${bound})`,
      }],
      onDemand: [],
      notInShadow: [],
    });
    // Due a minute before the window end, waiting for its slot: still on schedule.
    expect(check({ "fan-earnings.roster": [row({ dueMs: WINDOW.endMs - MINUTE })] }).scheduled).toHaveLength(1);
    // Its first read came after the window end, by its bound: on schedule.
    expect(check({ "fan-earnings.roster": [row({ dueMs: T("2026-10-04T09:40:00Z"), firstAdmittedMs: T("2026-10-02T13:40:00Z") })] }).scheduled).toHaveLength(1);
    const pendingWhy = (rows: Record<string, ScheduleRow[]>, legacy?: Map<string, number>) => {
      const result = check(rows, legacy);
      expect(result.scheduled).toEqual([]);
      expect(result.pending).toHaveLength(1);
      return result.pending[0]!.why;
    };
    const notYet = "not yet judgeable: legacy 29 on its A2 basis, the shadow none in 2.67 h of shadow history on the page; its keys' first run is due within 24.03 h of the shadow's start; not on its schedule (rule A1.floor-scheduled): ";
    // No row of the key: the engine holds no read of it.
    expect(pendingWhy({})).toBe(`${notYet}fan-earnings.roster: no shadow work row on the page at the window end`);
    // Due in the window and not admitted by its end: overdue.
    expect(pendingWhy({ "fan-earnings.roster": [row({ dueMs: T("2026-10-02T12:30:00Z") })] }))
      .toBe(`${notYet}fan-earnings.roster: due 2026-10-02T12:30:00.000Z, not admitted by the window end`);
    // Due later than its placement + 24 h + 2 min: late.
    expect(pendingWhy({ "fan-earnings.roster": [row({ dueMs: T("2026-10-03T10:30:00Z") })] }))
      .toBe(`${notYet}fan-earnings.roster: due 2026-10-03T10:30:00.000Z, later than its bound (${bound})`);
    // A standing walk whose plan found nothing due set its re-check past the
    // bound without a read: still not on schedule, and the reason is named.
    expect(pendingWhy({ "fan-earnings.roster": [row({ dueMs: T("2026-10-03T12:34:00Z"), recheckedMs: T("2026-10-02T12:34:00Z") })] }))
      .toBe(`${notYet}fan-earnings.roster: due 2026-10-03T12:34:00.000Z, later than its bound (${bound}); its last plan `
        + "(row updated 2026-10-02T12:34:00.000Z) found nothing due and set a re-check without a read");
    // Its first read after the window end came past the bound: late.
    expect(pendingWhy({ "fan-earnings.roster": [row({ firstAdmittedMs: T("2026-10-03T11:00:00Z") })] }))
      .toBe(`${notYet}fan-earnings.roster: its first read admitted 2026-10-03T11:00:00.000Z, after its bound (${bound})`);
    expect(pendingWhy({ "fan-earnings.roster": [row({ quarantined: true })] })).toBe(`${notYet}fan-earnings.roster: its row is quarantined`);
    // Every recurring key of the stream needs its row: stats.daily's alone does not schedule the 22-hourly stats.hourly.
    expect(pendingWhy({ "stats.daily": [row()] }, new Map([["stream:stats_snapshot", 11]])))
      .toMatch(/^not yet judgeable: .*; not on its schedule \(rule A1\.floor-scheduled\): stats\.hourly: no shadow work row on the page at the window end$/);
    // Past the shortest recurrence the schedule no longer helps: it lacks one.
    expect(legacyCounterparts({
      page: shadowPage("lilly-1"),
      legacy: new Map([["stream:fan_earnings", 29]]),
      specsByRef,
      shadow: { attempts: new Map(), historyMs: 25 * HOUR, schedule: { endMs: WINDOW.endMs, rows: new Map([["fan-earnings.roster", [row()]]]) } },
    })).toMatchObject({ lacking: [{ ref: "stream:fan_earnings" }], pending: [], scheduled: [] });
    // The floor's exception: scheduled holds, a missing or overdue row fails.
    const fixture = lilly2();
    const judge = (counterparts: CounterpartCheck) => demandOfPage(shadowPage("lilly-1"), {
      window: WINDOW, observed: fixture.observed, reads: undefined,
      facts: { runs: fixture.runs, placements: new Map(), firstShadowMs: null }, counterparts,
    });
    expect(judge(check({ "fan-earnings.roster": [row()] }))).toMatchObject({ floor: { below: true, holds: true }, passes: true });
    expect(judge(check({}))).toMatchObject({ floor: { below: true, holds: false }, passes: false });
    expect(judge(check({ "fan-earnings.roster": [row({ dueMs: T("2026-10-02T12:30:00Z") })] }))).toMatchObject({ floor: { below: true, holds: false }, passes: false });
  });

  it("the shadow's timeline estimate is the page size legacy measured (15 posts a page)", () => {
    expect(TIMELINE_PAGE_ESTIMATE).toBe(15);
  });
});
