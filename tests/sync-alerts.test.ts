import { describe, expect, it } from "vitest";

import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import {
  incidentTitleForKind,
  resolveMessageForIncident,
  SYNC_ENGINE_PACE_VIOLATION_SUBKEY,
  syncEngineIncidentKey,
  syncEngineRouteSubKey,
} from "../apps/runtime/src/services/notification-incidents.ts";
import { notificationPagingPolicyFor } from "../apps/runtime/src/services/notification-paging-policy.ts";
import {
  evaluatePageAlerts,
  evaluateRouteAlerts,
  SYNC_ALERT_CLEAN_MS,
  SYNC_CHATS_REFUSED_CHATS,
  SYNC_CHATS_REFUSED_WINDOW_MS,
  SYNC_HANDOVER_STUCK_MS,
  SYNC_OWNERSHIP_UNCONFIRMED_MS,
  SYNC_SOCKET_DOWN_MS,
  syncAlertResolveAfterMs,
  type PageAlertFacts,
} from "../apps/runtime/src/sync/engine/alerts.ts";
import {
  NETWORK_ALERT_AFTER_MS,
  RESOURCE_BREAKER_SUBJECTS,
  RESOURCE_BREAKER_WINDOW_MS,
} from "../apps/runtime/src/sync/engine/errors.ts";
import { OWNERSHIP_ALERT_AFTER_MS } from "../apps/runtime/src/sync/engine/host.ts";
import { quantileOf, syncMetricsDue } from "../apps/runtime/src/sync/engine/metrics.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import { moneyFramesMissing } from "../apps/runtime/src/sync/fansly/ws/money-frames.ts";

import { pageHoldRow, resourceBreakerRow, routeHoldRows, routeStateRows } from "./helpers/sync-holds.ts";

// The Fansly Sync Engine's alerts 1–4 (plan §10, design §9.6) as pure rules,
// their incident wiring (titles, keys, paging) and the sampler's pure parts.

const NOW = new Date("2026-10-02T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MINUTE = 60_000;
const registry = createFanslyRegistry();

function facts(overrides: {
  page?: Partial<PageAlertFacts["page"]>;
  journal?: Partial<PageAlertFacts["journal"]>;
  live?: Partial<PageAlertFacts["live"]>;
  chats?: Partial<PageAlertFacts["chats"]>;
  money?: PageAlertFacts["money"];
} = {}): PageAlertFacts {
  return {
    now: NOW,
    page: {
      pageId: 7,
      mode: "live",
      modeChangedAt: at(-24 * 60 * MINUTE),
      holds: [],
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
      unconfirmedWithoutThread: { count: 0, oldestVisibleAt: null },
      ...overrides.live,
    },
    chats: {
      unavailable: 0,
      refused: { chats: 0, firstOpenedAt: null },
      ...overrides.chats,
    },
    money: overrides.money ?? null,
  };
}

/** The page's own hold rows: a credentials hold since a minute ago, the
 *  network hold with what its detail says. */
const credentialsHeld = (kind: "auth" | "identity_mismatch") => pageHoldRow(kind, INDEFINITE_UNTIL, { since: at(-MINUTE) });
const networkHeld = (untilMs: number, detail: Record<string, unknown> = {}) =>
  pageHoldRow("network", at(untilMs), { since: at(-MINUTE), detail });

function evaluate(input: PageAlertFacts) {
  return Object.fromEntries(evaluatePageAlerts(input, registry).map((entry) => [entry.subKey, entry.detail]));
}

describe("alert rules (design §9.6)", () => {
  it("a healthy live page holds no alert", () => {
    expect(evaluatePageAlerts(facts(), registry)).toEqual([]);
  });

  it("alert 1: holds in force, most severe first, with every reason listed", () => {
    expect(evaluate(facts({ page: { holds: [credentialsHeld("auth")] } }))).toEqual({ page_stopped: "auth" });
    expect(evaluate(facts({ page: { holds: [credentialsHeld("identity_mismatch")] } }))).toEqual({ page_stopped: "identity_mismatch" });
    // An ended hold is no hold.
    const long = { networkSince: at(-NETWORK_ALERT_AFTER_MS - MINUTE).toISOString() };
    expect(evaluate(facts({ page: { holds: [networkHeld(-1, long)] } }))).toEqual({});
  });

  it("alert 1: a network hold beside an auth hold is listed too", () => {
    const both = (untilMs: number, detail: Record<string, unknown> = {}) => facts({
      page: { holds: [pageHoldRow("auth", INDEFINITE_UNTIL, { since: at(-MINUTE), detail: { credentialsGeneration: "gen-1" } }), networkHeld(untilMs, detail)] },
    });
    const reasons = (input: PageAlertFacts) => evaluatePageAlerts(input, registry)
      .flatMap((entry) => entry.reasons.map((reason) => reason.detail));
    const long = { networkSince: at(-NETWORK_ALERT_AFTER_MS - MINUTE).toISOString() };
    expect(evaluate(both(MINUTE, long))).toEqual({ page_stopped: "auth" });
    expect(reasons(both(MINUTE, long))).toEqual(["auth", "network"]);
    expect(reasons(both(-1, long))).toEqual(["auth"]);
    expect(reasons(both(MINUTE, { networkSince: at(-MINUTE).toISOString() }))).toEqual(["auth"]);
  });

  it("alert 1: a network hold pages only after 10 min without the network", () => {
    const network = (sinceMs: number) => facts({ page: { holds: [networkHeld(MINUTE, { networkSince: at(-sinceMs).toISOString() })] } });
    expect(evaluate(network(NETWORK_ALERT_AFTER_MS - MINUTE))).toEqual({});
    expect(evaluate(network(NETWORK_ALERT_AFTER_MS + MINUTE))).toEqual({ page_stopped: "network" });
  });

  it("alert 1: a route held by a 429 never stops the page — it is the route's own incident (D5)", () => {
    const held = facts({ page: { holds: routeHoldRows("messaging.groups", { holdUntil: at(300_000).toISOString() }) } });
    expect(evaluate(held)).toEqual({});
  });

  it("alert 1: rows of the hold set this build cannot read stop the page, named by what they are", () => {
    const routeState = facts({ page: { holds: routeHoldRows("messaging.groups", { effectivePerMin: -1 }) } });
    expect(evaluatePageAlerts(routeState, registry)).toEqual([expect.objectContaining({
      subKey: "page_stopped",
      detail: "route_state_unreadable",
      reasons: [{ detail: "route_state_unreadable", since: null, context: { diagnostic: "route_state_entry:messaging.groups" } }],
    })]);
    const unknownKind = (until: Date | null) => facts({ page: { holds: [pageHoldRow("maintenance", until)] } });
    expect(evaluatePageAlerts(unknownKind(at(MINUTE)), registry)).toEqual([expect.objectContaining({
      detail: "hold_set_unreadable",
      reasons: [{ detail: "hold_set_unreadable", since: null, context: { diagnostic: "hold_row:page::maintenance" } }],
    })]);
    // Until its end; for good when it names none.
    expect(evaluate(unknownKind(at(-1)))).toEqual({});
    expect(evaluate(unknownKind(null))).toEqual({ page_stopped: "hold_set_unreadable" });
  });

  it("alert 1: '10 min clean' — a stop answer within the window keeps the alert after its hold ended", () => {
    const answeredAt = at(-SYNC_ALERT_CLEAN_MS + MINUTE);
    const recent = facts({ journal: { lastStopAttempt: { errorClass: "auth", at: answeredAt } } });
    expect(evaluate(recent)).toEqual({ page_stopped: "auth" });
    // It holds as of the answer, not now: the latch resolves 10 min after it.
    expect(evaluatePageAlerts(recent, registry)).toEqual([expect.objectContaining({ subKey: "page_stopped", seenAt: answeredAt })]);
    // A hold in force holds now, whatever the journal says.
    const held = facts({
      page: { holds: [credentialsHeld("identity_mismatch")] },
      journal: { lastStopAttempt: { errorClass: "auth", at: answeredAt } },
    });
    expect(evaluatePageAlerts(held, registry)).toEqual([expect.objectContaining({ detail: "identity_mismatch", seenAt: NOW })]);
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
    const waiting = { urgentWaiting: [{ resource: "dm-messages.head", subject: "1", dueAt: at(-3 * MINUTE), breakerUntil: null, waitingReason: null }] };
    expect(evaluate(facts({ journal: waiting }))).toEqual({ freshness: "urgent_waiting" });
    // A held, paused or not-implemented wait is explained elsewhere.
    expect(evaluate(facts({ journal: waiting, page: { pausedAll: true } }))).toEqual({});
    expect(evaluate(facts({ journal: waiting, page: { pausedResources: ["dm-messages.head"] } }))).toEqual({});
    expect(evaluate(facts({
      journal: { urgentWaiting: [{ ...waiting.urgentWaiting[0]!, waitingReason: "dependency" }] },
    }))).toEqual({});
    // Every route it reads held by a 429: the route's own incident pages, not alert 3.
    const routeHeld = (until: Date) => routeHoldRows("messages.page", { holdUntil: until.toISOString() });
    expect(evaluate(facts({ journal: waiting, page: { holds: routeHeld(at(MINUTE)) } }))).toEqual({});
    expect(evaluate(facts({ journal: waiting, page: { holds: routeHeld(at(-1)) } }))).toEqual({ freshness: "urgent_waiting" });
    // A key with another route open is not explained by one held route.
    const find = { urgentWaiting: [{ resource: "dm-conversations.find", subject: "1", dueAt: at(-3 * MINUTE), breakerUntil: null, waitingReason: null }] };
    const listHeld = routeHoldRows("messaging.groups", { holdUntil: at(MINUTE).toISOString() });
    expect(evaluate(facts({ journal: find, page: { holds: listHeld } }))).toEqual({ freshness: "urgent_waiting" });
    // Its file's breaker explains the wait of every key the breaker stops —
    // never of the live confirmations, which it does not stop.
    const breaker = [resourceBreakerRow("dm-messages", at(MINUTE), { since: at(-MINUTE) })];
    const catchup = { urgentWaiting: [{ resource: "dm-messages.catchup", subject: "g1", dueAt: at(-3 * MINUTE), breakerUntil: null, waitingReason: null }] };
    expect(evaluate(facts({ journal: catchup, page: { holds: breaker } }))).toEqual({});
    expect(evaluate(facts({ journal: catchup, page: { holds: [resourceBreakerRow("dm-messages", at(-1))] } }))).toEqual({ freshness: "urgent_waiting" });
    expect(evaluate(facts({ journal: waiting, page: { holds: breaker } }))).toEqual({ freshness: "urgent_waiting" });
  });

  it("alert 3: a row its own subject breaker holds is explained; it waits from the breaker's end", () => {
    const row = (breakerUntil: Date, waitingReason: string, dueAt = at(-3 * MINUTE)) => ({
      resource: "dm-messages.head", subject: "g1", dueAt, breakerUntil, waitingReason,
    });
    const freshness = (rows: PageAlertFacts["journal"]["urgentWaiting"]) =>
      evaluatePageAlerts(facts({ journal: { urgentWaiting: rows } }), registry).find((entry) => entry.subKey === "freshness");
    // The subject breaker's ladder: due long ago, held for another minute.
    expect(freshness([row(at(MINUTE), "subject_breaker")])).toBeUndefined();
    // Ended a minute ago: within the 2 minutes a pick has.
    expect(freshness([row(at(-MINUTE), "subject_breaker")])).toBeUndefined();
    // Ended 3 minutes ago and no pick took it: waiting, since the breaker's end
    // (not the older due time), whatever reason the row still stores.
    expect(freshness([row(at(-3 * MINUTE), "subject_breaker", at(-10 * MINUTE))]))
      .toMatchObject({ detail: "urgent_waiting", since: at(-3 * MINUTE), reasons: [expect.objectContaining({ context: { works: 1, resources: ["dm-messages.head"] } })] });
    // The vendor's block (row 362195's shape): a signal pulled the due time to
    // a first-signal cap five days old, the daily probe is 16 h ahead.
    const capFiveDaysOld = at(-5 * 24 * 60 * MINUTE);
    expect(freshness([row(at(16 * 60 * MINUTE), "blocked_by_vendor", capFiveDaysOld)])).toBeUndefined();
    // Its probe 3 minutes overdue: a genuinely stuck runnable row still pages.
    expect(freshness([row(at(-3 * MINUTE), "blocked_by_vendor", capFiveDaysOld)]))
      .toMatchObject({ detail: "urgent_waiting", since: at(-3 * MINUTE) });
    // Beside a waiting row the held one neither counts nor sets the date.
    const plain = { ...row(at(-3 * MINUTE), "subject_breaker", at(-4 * MINUTE)), breakerUntil: null, subject: "g2" };
    expect(freshness([row(at(16 * 60 * MINUTE), "blocked_by_vendor", capFiveDaysOld), plain]))
      .toMatchObject({ since: at(-4 * MINUTE), reasons: [expect.objectContaining({ context: { works: 1, resources: ["dm-messages.head"] } })] });
  });

  it("the route incident (D5): held routes, and a 429 within the clean window; an unreadable state is alert 1's", () => {
    const holds = routeStateRows({
      "messaging.groups": { holdUntil: at(5_000).toISOString(), last429At: at(-1_000).toISOString(), effectivePerMin: 6 },
      "media.offer_stats": { holdUntil: at(-1).toISOString(), last429At: at(-SYNC_ALERT_CLEAN_MS + MINUTE).toISOString(), effectivePerMin: 2.5 },
      "transactions.page": { holdUntil: at(-1).toISOString(), last429At: at(-SYNC_ALERT_CLEAN_MS - MINUTE).toISOString(), effectivePerMin: 8.5 },
      "account.me": { holdUntil: at(MINUTE).toISOString() },
    });
    expect(evaluateRouteAlerts({ holds }, NOW)).toEqual([
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
    expect(evaluateRouteAlerts({ holds: [] }, NOW)).toEqual([]);
    const unreadable = routeHoldRows("messaging.groups", { holdUntil: at(MINUTE).toISOString(), effectivePerMin: -1 });
    expect(evaluateRouteAlerts({ holds: unreadable }, NOW)).toEqual([]);
    expect(evaluate(facts({ page: { holds: unreadable } }))).toEqual({ page_stopped: "route_state_unreadable" });
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

  it("alert 3: a lone chat Fansly refuses never pages; five chats refused within ten minutes do (chats_refused)", () => {
    // The thresholds are the resource hold's.
    expect(SYNC_CHATS_REFUSED_CHATS).toBe(RESOURCE_BREAKER_SUBJECTS);
    expect(SYNC_CHATS_REFUSED_WINDOW_MS).toBe(RESOURCE_BREAKER_WINDOW_MS);
    // Established chats and messages of chats Hub has no thread for are counted, not paged.
    expect(evaluate(facts({
      chats: { unavailable: 3, refused: { chats: 1, firstOpenedAt: at(-MINUTE) } },
      live: { unconfirmedWithoutThread: { count: 4, oldestVisibleAt: at(-60 * MINUTE) } },
    }))).toEqual({});
    expect(evaluate(facts({ chats: { refused: { chats: SYNC_CHATS_REFUSED_CHATS - 1, firstOpenedAt: at(-9 * MINUTE) } } }))).toEqual({});
    const refused = evaluatePageAlerts(facts({ chats: { refused: { chats: SYNC_CHATS_REFUSED_CHATS, firstOpenedAt: at(-9 * MINUTE) } } }), registry);
    expect(refused).toEqual([expect.objectContaining({
      subKey: "freshness",
      detail: "chats_refused",
      since: at(-9 * MINUTE),
      reasons: [{ detail: "chats_refused", since: at(-9 * MINUTE), context: { chats: SYNC_CHATS_REFUSED_CHATS } }],
    })]);
    // Beside an unconfirmed message it is listed too; the message is the detail.
    expect(evaluatePageAlerts(facts({
      live: { unconfirmed: { count: 1, oldestVisibleAt: at(-16 * MINUTE) } },
      chats: { refused: { chats: 6, firstOpenedAt: at(-2 * MINUTE) } },
    }), registry)[0]!.reasons.map((reason) => reason.detail)).toEqual(["message_unconfirmed", "chats_refused"]);
    // Neither a pause of the page nor a page hold explains it.
    expect(evaluate(facts({
      page: { pausedAll: true },
      chats: { refused: { chats: 5, firstOpenedAt: at(-MINUTE) } },
    }))).toEqual({ freshness: "chats_refused" });
  });

  it("several alerts at once, one condition each", () => {
    expect(evaluate(facts({
      page: { holds: [credentialsHeld("auth")] },
      live: { socket: { up: false, lastAliveAt: null }, unconfirmed: { count: 1, oldestVisibleAt: at(-16 * MINUTE) } },
      journal: { ledgerIncomplete: { missing: 1, at: at(-MINUTE) } },
    }))).toEqual({
      page_stopped: "auth",
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

describe("the sampler's pure parts", () => {
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
