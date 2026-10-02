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
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import { moneyFramesMissing } from "../apps/runtime/src/sync/fansly/ws/money-frames.ts";
import { routeThreadAt } from "../apps/runtime/src/sync/fansly/ws/route-receipt.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { REPLAY_EXCUSED_REASONS, scoreReplayKind } from "../apps/runtime/src/sync/report/shadow-journal.ts";
import { isOneTimeWalk, SHADOW_SETTLE_MS, shadowWindowCoverage, simulateCoalescedReads } from "../apps/runtime/src/sync/report/shadow-window.ts";

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
    // The recurring walks count in the 40–100/h band.
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
