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
  type PageAlertFacts,
} from "../apps/runtime/src/sync/engine/alerts.ts";
import { LIST_RATE_LIMIT_LADDER_MS, NETWORK_ALERT_AFTER_MS } from "../apps/runtime/src/sync/engine/errors.ts";
import { OWNERSHIP_ALERT_AFTER_MS } from "../apps/runtime/src/sync/engine/host.ts";
import { quantileOf, syncMetricsDue } from "../apps/runtime/src/sync/engine/metrics.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import { moneyFramesMissing } from "../apps/runtime/src/sync/fansly/ws/money-frames.ts";
import { simulateCoalescedReads } from "../apps/runtime/src/sync/report/shadow-window.ts";

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
    const recent = facts({ journal: { lastStopAttempt: { errorClass: "rate_limit", at: at(-SYNC_ALERT_CLEAN_MS + MINUTE) } } });
    expect(evaluate(recent)).toEqual({ page_stopped: "rate_limit" });
    const clean = facts({ journal: { lastStopAttempt: { errorClass: "rate_limit", at: at(-SYNC_ALERT_CLEAN_MS - MINUTE) } } });
    expect(evaluate(clean)).toEqual({});
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

  it("parses the report window", () => {
    expect(parseReportWindow("2026-10-03T09:00:00Z/2026-10-03T10:00:00Z")).toEqual({
      start: new Date("2026-10-03T09:00:00Z"),
      end: new Date("2026-10-03T10:00:00Z"),
    });
    expect(parseReportWindow("2026-10-03T09:00:00Z").end).toEqual(new Date("2026-10-03T10:00:00Z"));
    expect(() => parseReportWindow("2026-10-03T10:00:00Z/2026-10-03T09:00:00Z")).toThrow();
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
