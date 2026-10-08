import { sql } from "drizzle-orm";

import {
  getNotificationIncidentByKey,
  insertAuditEvent,
  isSyncUrgentWorkWaiting,
  listNotificationIncidents,
  listSyncPages,
  readFanslySendAudit,
  readSyncChatAlertFacts,
  readSyncJournalAlertFacts,
  readSyncLivePathFacts,
  SYNC_ALERTS_ACK_AUDIT_EVENT,
  syncUrgentWaitingSince,
  type Database,
  type FanslyWsLivePayloadResolver,
  type SyncChatAlertFacts,
  type SyncJournalAlertFacts,
  type SyncLivePathFacts,
  type SyncPageRow,
} from "@agency_hub_core/db";

import {
  notifySyncEngineIncident,
  resolveSyncEngineIncident,
  type IncidentApp,
  SYNC_ENGINE_PACE_VIOLATION_SUBKEY,
  syncEngineIncidentKey,
  syncEngineRouteSubKey,
  type SyncEngineAlertSubKey,
  type SyncEngineIncidentSubKey,
} from "../../services/notification-incidents.ts";
import { FANSLY_ROUTES, routeBudget, type FanslyRoute } from "../fansly/routes.ts";
import { moneyFramesMissing, readMoneyFrames } from "../fansly/ws/money-frames.ts";
import { heldByScope, holdSetOf, pageHoldsInForce, type HoldSet } from "./admission.ts";
import type { SyncLogger } from "./commit.ts";
import { NETWORK_ALERT_AFTER_MS, RESOURCE_BREAKER_SUBJECTS, RESOURCE_BREAKER_WINDOW_MS } from "./errors.ts";
import type { AlertSink, SyncAlertInput } from "./ports.ts";
import { effectivePeriodMs, resourceDisabled, type EngineRegistry } from "./resource.ts";
import { routeHoldUntil } from "./route-holds.ts";
import { effectiveRatePerMin, routeAdmissionView, RouteClocks, routeStateOfHolds } from "./route-policy.ts";
import { auditPagePace, auditRouteIntervals } from "./send-audit.ts";
import { noStallTracker, type StallTracker, type StallTracking } from "./watchdog.ts";

// The Fansly Sync Engine's alerts 1–4 (plan §10, design §9.6). Alert 5 (the
// `sync` process is silent) is the api watchdog's: a process cannot report
// its own death. It can report its own stall, and does, on the same latch,
// right before it exits for a restart (`engine/watchdog.ts`, `main.ts`).
//
// One incident kind, `fansly_sync_engine` (0233), one latch per page and
// alert. Two paths open a latch: the actor's capture transaction opens alert 1
// at once on a refused credential, another identity or a pace violation (the
// incident sink below), and the evaluator re-derives every
// condition from the database every 30 s — opening what holds, resolving what
// has stayed clear long enough (alerts 1–3: 10 min; alert 4: at once). The
// evaluator is the only one that resolves, so a latch never flips on one
// path's partial view. Alert 1's pace violation has its own latch
// (`page_stopped:pace_violation`), resolved only by the owner (`pnpm cli sync
// alerts ack`): the send audit (`engine/send-audit.ts`) opens it for two sends
// of a page closer than the later one's pause (I1: on the recorded instants,
// and one owner's pair on its pacer's monotonic gap too) and for two sends of
// a route or family closer than the interval the later one was admitted
// under, or an interval below its ceiling's (I19). A 429 holds one route of a
// page, never the page: its incident is the route's own
// (`route_limited:<route>`, step 3b D5) — opened by the capture on the route's
// first 429, refreshed (never repeated) by the next ones and by the evaluator
// while the route is held, resolved 10 clean minutes after.
//
// Pages: `handover` and `live` page the owner; a page in `off` or `shadow`
// runs no actor and has no alert. On `handover` — a mode nothing reaches since
// step 4 (S4-21), still honoured where a row says it — the ownership alert is
// suppressed (no owner runs there by design); a handover older than 10 min is
// `handover_stuck`.

/** The evaluator's cadence. */
export const SYNC_ALERT_EVAL_INTERVAL_MS = 30_000;
/** Alert 1: a page in the engine without a beating owner for this long (the
 *  host's own waiting alert uses the same bound). */
export const SYNC_OWNERSHIP_UNCONFIRMED_MS = 2 * 60_000;
/** Alerts 1–3 resolve only after their condition has stayed false this long
 *  (alert 1: "hold cleared and 10 min clean"; alerts 2 and 3: "condition false
 *  10 min"), so a condition that comes and goes keeps one standing page. */
export const SYNC_ALERT_CLEAN_MS = 10 * 60_000;
/** Alert 1: a handover older than this is stuck. */
export const SYNC_HANDOVER_STUCK_MS = 10 * 60_000;
/** Alert 2: the page's socket down for longer than this. */
export const SYNC_SOCKET_DOWN_MS = 5 * 60_000;
/** Alert 2: decode debt above this share of the window's receipts. */
export const SYNC_DECODE_DEBT_SHARE = 0.01;
export const SYNC_DECODE_DEBT_WINDOW_MS = 10 * 60_000;
/** Alert 3: a fan message the socket showed, unconfirmed for longer than this
 *  (in a chat Hub knows and Fansly does not refuse, `dmLiveUnconfirmedSql`). */
export const SYNC_UNCONFIRMED_MESSAGE_MS = 15 * 60_000;
/** Alert 3 (`chats_refused`): this many distinct chats of a page that opened
 *  a chat-unavailability episode … */
export const SYNC_CHATS_REFUSED_CHATS = RESOURCE_BREAKER_SUBJECTS;
/** … within this window: the resource hold's threshold (arena "vanished
 *  chat" plan §4). A lone chat Fansly refuses never pages; Fansly refusing
 *  the page's chats does — `dm-messages.head` is out of the resource hold. */
export const SYNC_CHATS_REFUSED_WINDOW_MS = RESOURCE_BREAKER_WINDOW_MS;
/** Alert 3: a money frame not in the ledger for longer than this … */
export const SYNC_MONEY_FRAME_MS = 5 * 60_000;
/** … looked for within this window (an older frame no longer counts). */
export const SYNC_MONEY_LOOKBACK_MS = 60 * 60_000;
/** Alert 3: urgent work waiting longer than this, from its due time or its
 *  own breaker's end, whichever is later (`syncUrgentWaitingSince`); the
 *  live-hour check's `urgentWaiting` is the same rule. */
export const SYNC_URGENT_WAIT_MS = 2 * 60_000;
/** Alert 4: a request with runnable work and no read for this long. */
export const SYNC_REQUEST_STALL_MS = 30 * 60_000;
/** Alert 4: a poll without its own SLO is stale after this many periods. */
export const SYNC_STALE_PERIODS = 3;
/** The send audit re-reads this much of the journal before its last pass (a
 *  send captured after a pass with an earlier send instant; an unknown send
 *  counted at its upper bound). */
const PACE_AUDIT_OVERLAP_MS = 60_000;
/** The send audit's first pass reads this far back (and no pass further). */
const PACE_AUDIT_FIRST_LOOKBACK_MS = 60 * 60_000;

/** The page alerts (1–4). */
export const SYNC_PAGE_ALERT_SUB_KEYS = ["page_stopped", "live_degraded", "freshness", "stuck"] as const satisfies readonly SyncEngineAlertSubKey[];
export type SyncPageAlertSubKey = (typeof SYNC_PAGE_ALERT_SUB_KEYS)[number];

/** How long a page alert's condition must stay false before the evaluator
 *  resolves its latch (design §9.6): alerts 1–3 after 10 clean minutes, alert
 *  4 as soon as progress resumes. */
export function syncAlertResolveAfterMs(subKey: SyncPageAlertSubKey): number {
  return subKey === "stuck" ? 0 : SYNC_ALERT_CLEAN_MS;
}

/** One alert whose condition holds, with why (`detail`, the closed
 *  vocabulary of design §9.6) and every reason that held. */
export interface SyncAlertCondition {
  subKey: SyncPageAlertSubKey;
  detail: string;
  /** When the condition began, when known. */
  since: Date | null;
  /** The newest instant the condition is known to hold: `now`, except alert
   *  1's clean tail alone (a page-stopping answer after its hold ended), which
   *  holds as of that answer — its latch resolves 10 min after it. */
  seenAt: Date;
  reasons: Array<{ detail: string; since: Date | null; context?: Record<string, unknown> }>;
}

/** Everything one page's evaluation reads. */
export interface PageAlertFacts {
  page: Pick<SyncPageRow, "pageId" | "mode" | "modeChangedAt" | "holds" | "pausedAll" | "pausedRequests"
    | "pausedResources" | "registryOverrides" | "owner">;
  journal: SyncJournalAlertFacts;
  live: SyncLivePathFacts;
  /** The page's chat-unavailability episodes (`chats_refused`). */
  chats: SyncChatAlertFacts;
  money: { count: number; oldestReceivedAt: Date } | null;
  now: Date;
}

function msSince(at: Date | null, now: Date): number {
  return at === null ? Number.POSITIVE_INFINITY : now.getTime() - at.getTime();
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A resource whose work waits for a reason the owner or another alert owns:
 *  a pause, a switch-off, its file's breaker, or a hold on every route it
 *  reads (the route's own incident pages for that) — the last two by the hold
 *  evaluator, over the route holds alone (no send is counted: a budget's
 *  interval explains no wait this long). */
function resourceExplained(
  page: PageAlertFacts["page"],
  holds: HoldSet,
  resource: string,
  now: Date,
  registry: Pick<EngineRegistry, "spec">,
): boolean {
  if (page.pausedResources.includes(resource) || resourceDisabled(page, resource)) return true;
  const spec = registry.spec(resource);
  const routes = !holds.routes.ok || spec === null
    ? null
    : routeAdmissionView(new RouteClocks({ sends: [], state: holds.routes.state }), [spec], now);
  const held = heldByScope(holds, routes, { work: { resource } }, now);
  return held.resource !== null || held.route?.scope === "route_hold";
}

function condition(
  subKey: SyncPageAlertSubKey,
  reasons: SyncAlertCondition["reasons"],
  seenAt: Date,
): SyncAlertCondition | null {
  const first = reasons[0];
  return first === undefined ? null : { subKey, detail: first.detail, since: first.since, seenAt, reasons };
}

/**
 * Alerts 1–4 of one page from its facts (pure). At most one condition per
 * alert; its `detail` is the most severe reason, `reasons` lists them all.
 */
export function evaluatePageAlerts(facts: PageAlertFacts, registry: Pick<EngineRegistry, "spec">): SyncAlertCondition[] {
  const { page, journal, live, now } = facts;
  const conditions: Array<SyncAlertCondition | null> = [];

  // 1. The page stopped: what holds the page itself by the hold evaluator
  // (the rule the actor admits by) — a credentials hold, a network hold
  // (alone or beside it), rows of its hold set this build cannot read.
  const stopped: SyncAlertCondition["reasons"] = [];
  const holds = holdSetOf(page.holds);
  const held = pageHoldsInForce(holds, now);
  const holdInForce = held !== null;
  if (held?.credentials) stopped.push({ detail: held.credentials.kind, since: held.credentials.since });
  // Rows this build cannot read keep the page's admission closed: a route's
  // state (`engine/route-policy.ts`), or a row of a kind it does not know.
  if (held?.unreadable) {
    stopped.push({
      detail: held.unreadable.routeState ? "route_state_unreadable" : "hold_set_unreadable",
      since: null,
      context: { diagnostic: held.unreadable.diagnostic },
    });
  }
  if (held?.timed) {
    const networkSince = dateOf(held.timed.detail.networkSince) ?? held.timed.since;
    if (msSince(networkSince, now) > NETWORK_ALERT_AFTER_MS) stopped.push({ detail: "network", since: networkSince });
  }
  if (page.mode === "handover") {
    if (msSince(page.modeChangedAt, now) > SYNC_HANDOVER_STUCK_MS) stopped.push({ detail: "handover_stuck", since: page.modeChangedAt });
  } else if (page.mode !== "off") {
    // An owner must be beating (a page just put in its mode is given the
    // alert's own grace to be taken).
    const heartbeat = page.owner.heartbeatAt;
    const alive = heartbeat !== null && msSince(heartbeat, now) <= SYNC_OWNERSHIP_UNCONFIRMED_MS;
    if (!alive && msSince(page.modeChangedAt, now) > SYNC_OWNERSHIP_UNCONFIRMED_MS) {
      stopped.push({ detail: "ownership_unconfirmed", since: heartbeat ?? page.modeChangedAt });
    }
  }
  // "Hold cleared and 10 min clean": a page-stopping answer within the window
  // keeps the alert although its hold has ended (and opens it when the
  // capture path's own open was lost). It holds as of the answer, so the
  // latch resolves 10 min after the later of the hold's end and the answer.
  let stoppedSeenAt = now;
  if (stopped.length === 0 && journal.lastStopAttempt !== null && msSince(journal.lastStopAttempt.at, now) <= SYNC_ALERT_CLEAN_MS) {
    stopped.push({ detail: journal.lastStopAttempt.errorClass, since: journal.lastStopAttempt.at, context: { clean: false } });
    stoppedSeenAt = journal.lastStopAttempt.at;
  }
  conditions.push(condition("page_stopped", stopped, stoppedSeenAt));

  // 2. The live path degraded.
  const degraded: SyncAlertCondition["reasons"] = [];
  if (!live.socket.up && msSince(live.socket.lastAliveAt, now) > SYNC_SOCKET_DOWN_MS) {
    degraded.push({ detail: "socket_down", since: live.socket.lastAliveAt });
  }
  if (live.decode.debt > 0 && live.decode.debt > SYNC_DECODE_DEBT_SHARE * live.decode.receipts) {
    degraded.push({ detail: "protocol_changed", since: null, context: { ...live.decode } });
  }
  const quarantined = Object.entries(journal.quarantined);
  if (quarantined.length > 0) {
    degraded.push({ detail: "quarantined", since: null, context: { byResource: Object.fromEntries(quarantined) } });
  }
  conditions.push(condition("live_degraded", degraded, now));

  // 3. Freshness. The owner's pause and a page hold explain a wait (alert 1
  // or the owner's own lever), so they do not page twice. A message of a chat
  // Fansly refuses to the page is not late (the chat's episode answers for
  // it), and one of a chat Hub has no thread for is counted, not paged
  // (`dmLiveUnconfirmedSql`); several chats refused at once page.
  const late: SyncAlertCondition["reasons"] = [];
  if (live.unconfirmed.count > 0) {
    late.push({ detail: "message_unconfirmed", since: live.unconfirmed.oldestVisibleAt, context: { messages: live.unconfirmed.count } });
  }
  if (facts.chats.refused.chats >= SYNC_CHATS_REFUSED_CHATS) {
    late.push({ detail: "chats_refused", since: facts.chats.refused.firstOpenedAt, context: { chats: facts.chats.refused.chats } });
  }
  if (facts.money !== null) {
    late.push({ detail: "money_not_in_ledger", since: facts.money.oldestReceivedAt, context: { frames: facts.money.count } });
  }
  if (!page.pausedAll && !holdInForce) {
    // A row its own subject breaker holds (the vendor's block too) is
    // explained until the breaker ends; it waits from then on.
    const waiting = journal.urgentWaiting.filter((row) =>
      isSyncUrgentWorkWaiting(row, now, SYNC_URGENT_WAIT_MS) &&
      row.waitingReason !== "dependency" && !resourceExplained(page, holds, row.resource, now, registry));
    const since = waiting.map(syncUrgentWaitingSince).sort((a, b) => a.getTime() - b.getTime())[0];
    if (since !== undefined) {
      late.push({
        detail: "urgent_waiting",
        since,
        context: { works: waiting.length, resources: [...new Set(waiting.map((row) => row.resource))] },
      });
    }
  }
  conditions.push(condition("freshness", late, now));

  // 4. Stuck.
  const stuck: SyncAlertCondition["reasons"] = [];
  if (!page.pausedAll && !page.pausedRequests && journal.stalledRequests.length > 0) {
    stuck.push({
      detail: "request_stalled",
      since: journal.stalledRequests[0]!.lastServedAt ?? journal.stalledRequests[0]!.createdAt,
      context: { requests: journal.stalledRequests.map((row) => row.requestRef) },
    });
  }
  if (!page.pausedAll && !holdInForce) {
    const stale: Array<{ resource: string; since: Date }> = [];
    for (const poll of journal.polls) {
      const spec = registry.spec(poll.resource);
      if (spec === null || resourceExplained(page, holds, poll.resource, now, registry)) continue;
      const periodMs = effectivePeriodMs(spec, page);
      const staleAfterMs = spec.slo?.staleAfterMs ?? (periodMs === null ? null : SYNC_STALE_PERIODS * periodMs);
      const since = poll.lastServedAt ?? poll.createdAt;
      if (staleAfterMs !== null && msSince(since, now) > staleAfterMs) stale.push({ resource: poll.resource, since });
    }
    stale.sort((a, b) => a.since.getTime() - b.since.getTime());
    if (stale.length > 0) {
      stuck.push({ detail: "planned_stale", since: stale[0]!.since, context: { resources: stale.map((row) => row.resource) } });
    }
  }
  if (journal.ledgerIncomplete !== null) {
    stuck.push({
      detail: "transactions_ledger_incomplete",
      since: journal.ledgerIncomplete.at,
      context: { missing: journal.ledgerIncomplete.missing },
    });
  }
  conditions.push(condition("stuck", stuck, now));

  return conditions.filter((entry): entry is SyncAlertCondition => entry !== null);
}

/** A route of a page whose own incident holds (step 3b D5, `route_limited:<route>`). */
export interface SyncRouteAlertCondition {
  route: FanslyRoute;
  /** `route_held` while a 429's (or a 5xx's `Retry-After`) hold keeps the
   *  route closed; `rate_limit` for the clean window after its newest 429. */
  detail: "route_held" | "rate_limit";
  /** The newest instant the condition is known to hold. */
  seenAt: Date;
  holdUntil: Date | null;
  last429At: Date | null;
  /** The page's rate on the route after its slowdowns, and the table's. */
  effectivePerMin: number;
  currentPerMin: number;
}

/**
 * The route incidents of one page (pure): every route held now, and every
 * route whose newest 429 came within the clean window ("hold cleared and 10
 * min clean", as alert 1) — so the latch the capture opened stands until the
 * route has been clean for 10 minutes. An unreadable route state is alert 1's.
 */
export function evaluateRouteAlerts(page: Pick<SyncPageRow, "holds">, now: Date): SyncRouteAlertCondition[] {
  const read = routeStateOfHolds(page.holds);
  if (!read.ok) return [];
  const conditions: SyncRouteAlertCondition[] = [];
  for (const route of (Object.keys(read.state.routes) as FanslyRoute[]).sort()) {
    const entry = read.state.routes[route]!;
    const holdUntil = routeHoldUntil(read.state, route, now);
    const last429At = entry.last429At === null ? null : new Date(entry.last429At);
    const recent429 = last429At !== null && msSince(last429At, now) <= SYNC_ALERT_CLEAN_MS;
    if (holdUntil === null && !recent429) continue;
    conditions.push({
      route,
      detail: holdUntil !== null ? "route_held" : "rate_limit",
      seenAt: holdUntil !== null || last429At === null ? now : last429At,
      holdUntil,
      last429At,
      effectivePerMin: effectiveRatePerMin(route, read.state),
      currentPerMin: routeBudget(route).currentPerMin,
    });
  }
  return conditions;
}

function routeAlertContext(condition: SyncRouteAlertCondition): Record<string, unknown> {
  return {
    route: condition.route,
    holdUntil: condition.holdUntil?.toISOString() ?? null,
    last429At: condition.last429At?.toISOString() ?? null,
    effectivePerMin: condition.effectivePerMin,
    currentPerMin: condition.currentPerMin,
  };
}

/** Read a page's alert facts. `money` comes from one window read over many
 *  pages (`readMoneyFrames`); without it the money rule is skipped. */
export async function readPageAlertFacts(
  db: Database,
  input: { page: SyncPageRow; money?: Map<number, { count: number; oldestReceivedAt: Date }> },
): Promise<PageAlertFacts> {
  const journal = await readSyncJournalAlertFacts(db, {
    pageId: input.page.pageId,
    stopLookbackMs: SYNC_ALERT_CLEAN_MS,
    urgentAfterMs: SYNC_URGENT_WAIT_MS,
    requestStallMs: SYNC_REQUEST_STALL_MS,
  });
  const live = await readSyncLivePathFacts(db, {
    pageId: input.page.pageId,
    decodeWindowMs: SYNC_DECODE_DEBT_WINDOW_MS,
    unconfirmedAfterMs: SYNC_UNCONFIRMED_MESSAGE_MS,
  });
  const chats = await readSyncChatAlertFacts(db, { pageId: input.page.pageId, refusedWindowMs: SYNC_CHATS_REFUSED_WINDOW_MS });
  return {
    page: input.page,
    journal,
    live,
    chats,
    money: input.money?.get(input.page.pageId) ?? null,
    now: input.page.dbNow,
  };
}

/** Read a page's facts and evaluate it (`readPageAlertFacts`). */
export async function collectPageAlerts(
  db: Database,
  input: {
    page: SyncPageRow;
    registry: Pick<EngineRegistry, "spec">;
    money?: Map<number, { count: number; oldestReceivedAt: Date }>;
  },
): Promise<SyncAlertCondition[]> {
  return evaluatePageAlerts(await readPageAlertFacts(db, input), input.registry);
}

/** The money frames of the pages in the trailing window, missing per page. */
export async function readMissingMoneyFrames(
  db: Database,
  input: { pageIds: readonly number[]; now: Date; resolvePayload?: FanslyWsLivePayloadResolver },
): Promise<Map<number, { count: number; oldestReceivedAt: Date }>> {
  if (input.pageIds.length === 0) return new Map();
  const frames = await readMoneyFrames(db, {
    from: new Date(input.now.getTime() - SYNC_MONEY_LOOKBACK_MS),
    to: new Date(input.now.getTime() - SYNC_MONEY_FRAME_MS),
    pageIds: input.pageIds,
    ...(input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload }),
  });
  return moneyFramesMissing(frames, input.now, SYNC_MONEY_FRAME_MS);
}

/** Pages whose alerts page the owner (`handover`, `live`). */
export function pagesOwnerAlerts(page: Pick<SyncPageRow, "mode">): boolean {
  return page.mode === "handover" || page.mode === "live";
}

function summaryOf(detail: string, since: Date | null, context: Readonly<Record<string, unknown>> | undefined): string {
  const parts = [detail];
  if (since !== null) parts.push(`since ${since.toISOString()}`);
  if (context !== undefined && Object.keys(context).length > 0) parts.push(JSON.stringify(context));
  return parts.join(" · ");
}

/**
 * The production `AlertSink` of the engine: an alert opens its latch at once.
 * Resolution is the evaluator's alone, so `resolve` only logs.
 */
export function createIncidentAlertSink(input: { db: Database; logger: SyncLogger }): AlertSink {
  const app: IncidentApp = { db: input.db, logger: input.logger };
  return {
    async open(alert: SyncAlertInput) {
      const fields = { pageId: alert.pageId, subKey: alert.subKey, detail: alert.detail, ...(alert.route === undefined ? {} : { route: alert.route }) };
      input.logger.error(fields, "Fansly sync alert");
      let subKey: SyncEngineIncidentSubKey;
      if (alert.subKey === "route_limited") {
        if (alert.route === undefined) {
          input.logger.warn(fields, "Fansly sync alert: a route incident without its route was not opened");
          return;
        }
        subKey = syncEngineRouteSubKey(alert.route);
      } else {
        subKey = alert.subKey === "page_stopped" && alert.detail === "pace_violation" ? SYNC_ENGINE_PACE_VIOLATION_SUBKEY : alert.subKey;
      }
      await notifySyncEngineIncident(app, {
        subKey,
        pageId: alert.pageId,
        pageLabel: alert.pageId === null ? null : await pageLabelOf(input.db, alert.pageId),
        detail: alert.detail,
        errorSummary: summaryOf(alert.detail, null, alert.context),
        occurredAt: alert.occurredAt ?? new Date(),
      });
    },
    async resolve(alert) {
      input.logger.info({ pageId: alert.pageId, subKey: alert.subKey },
        "Fansly sync alert condition cleared (the evaluator resolves the latch)");
    },
  };
}

async function pageLabelOf(db: Database, pageId: number): Promise<string | null> {
  const page = (await listSyncPages(db)).find((row) => row.pageId === pageId);
  return page?.pageLabel ?? null;
}

export interface SyncAlertPassResult {
  pages: number;
  opened: Array<{ pageId: number; subKey: SyncEngineIncidentSubKey; detail: string }>;
  resolved: Array<{ pageId: number; subKey: SyncEngineIncidentSubKey }>;
  /** I1: pairs of the page's sends closer than the later one's pause. */
  paceViolations: number;
  /** I19: pairs of a route's (or family's) sends closer than the interval the
   *  later one was admitted under, and intervals below their ceiling's. */
  routeIntervalViolations: number;
  /** Pairs the audit could not judge (no recorded pause or interval). */
  inconclusivePairs: number;
}

export interface SyncAlertEvaluatorOptions {
  db: Database;
  logger: SyncLogger;
  registry: Pick<EngineRegistry, "spec">;
  resolvePayload?: FanslyWsLivePayloadResolver;
  intervalMs?: number;
  /** The process's stall watchdog: every pass is watched, page by page. */
  watchdog?: StallTracking;
}

/**
 * The 30-second evaluator of the `sync` process. Each pass: every
 * `handover`/`live` page's alerts 1–4 are derived from the database; a
 * condition that holds opens or refreshes its latch (`last_seen_at`), and a
 * latch whose condition has stayed false for `syncAlertResolveAfterMs` since
 * its `last_seen_at` is resolved — the clean time lives in the latch, so it
 * survives a restart of the evaluator. The latches of every other page are
 * resolved at once (a page in `off` or `shadow` pages nothing). The
 * pace backstop re-reads the journal's new sends (a violation the capture
 * path could not report, e.g. across a crash, still opens the pace latch).
 */
export class SyncAlertEvaluator {
  readonly #o: SyncAlertEvaluatorOptions;
  readonly #app: IncidentApp;
  readonly #paceAuditedTo = new Map<number, Date>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #pass: Promise<SyncAlertPassResult | null> | null = null;

  constructor(options: SyncAlertEvaluatorOptions) {
    this.#o = options;
    this.#app = { db: options.db, logger: options.logger };
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.runOnce(), this.#o.intervalMs ?? SYNC_ALERT_EVAL_INTERVAL_MS);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#pass?.catch(() => undefined);
  }

  /** One pass; a pass already running is joined (never two at once). */
  runOnce(): Promise<SyncAlertPassResult | null> {
    if (this.#pass === null) {
      const pass = this.#o.watchdog?.track({ component: "alerts" }, "pages") ?? noStallTracker;
      this.#pass = this.#evaluate(pass)
        .catch((error: unknown) => {
          this.#o.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "Fansly sync alerts: evaluation pass failed");
          return null;
        })
        .finally(() => {
          pass.done();
          this.#pass = null;
        });
    }
    return this.#pass;
  }

  async #evaluate(pass: StallTracker): Promise<SyncAlertPassResult> {
    const { db } = this.#o;
    const pages = await listSyncPages(db);
    const result: SyncAlertPassResult = {
      pages: pages.length, opened: [], resolved: [], paceViolations: 0, routeIntervalViolations: 0, inconclusivePairs: 0,
    };
    // Open latches by key, with the last instant their condition was seen.
    const open = new Map((await listNotificationIncidents(db, { status: "open" }))
      .filter((incident) => incident.kind === "fansly_sync_engine")
      .map((incident) => [incident.incidentKey, incident.lastSeenAt] as const));
    const owned = pages.filter(pagesOwnerAlerts);
    const now = pages[0]?.dbNow ?? new Date();
    pass.progress("money_frames");
    const money = await readMissingMoneyFrames(db, {
      pageIds: owned.map((page) => page.pageId),
      now,
      ...(this.#o.resolvePayload === undefined ? {} : { resolvePayload: this.#o.resolvePayload }),
    });
    for (const page of pages) {
      pass.progress("page");
      const conditions = pagesOwnerAlerts(page)
        ? await collectPageAlerts(db, { page, registry: this.#o.registry, money })
        : [];
      const holding = new Map(conditions.map((entry) => [entry.subKey, entry]));
      for (const subKey of SYNC_PAGE_ALERT_SUB_KEYS) {
        const held = holding.get(subKey);
        const key = syncEngineIncidentKey({ subKey, pageId: page.pageId });
        const lastSeenAt = open.get(key);
        if (held !== undefined) {
          await notifySyncEngineIncident(this.#app, {
            subKey,
            pageId: page.pageId,
            pageLabel: page.pageLabel,
            detail: held.detail,
            errorSummary: summaryOf(held.detail, held.since, { reasons: held.reasons.map((reason) => reason.detail) }),
            occurredAt: held.seenAt,
          });
          if (lastSeenAt === undefined) result.opened.push({ pageId: page.pageId, subKey, detail: held.detail });
        } else if (lastSeenAt !== undefined) {
          const cleanMs = pagesOwnerAlerts(page) ? syncAlertResolveAfterMs(subKey) : 0;
          if (page.dbNow.getTime() - lastSeenAt.getTime() < cleanMs) continue;
          await resolveSyncEngineIncident(this.#app, { subKey, pageId: page.pageId, pageLabel: page.pageLabel, recoveredAt: page.dbNow });
          result.resolved.push({ pageId: page.pageId, subKey });
        }
      }
      await this.#evaluateRoutes(page, open, result);
      if (pagesOwnerAlerts(page)) {
        const audited = await this.#auditSends(page);
        result.paceViolations += audited.pace;
        result.routeIntervalViolations += audited.intervals;
        result.inconclusivePairs += audited.inconclusive;
      }
    }
    if (result.opened.length > 0 || result.resolved.length > 0) {
      this.#o.logger.info({ opened: result.opened, resolved: result.resolved }, "Fansly sync alerts: latches changed");
    }
    return result;
  }

  /** The page's route incidents (D5): one latch per route held or within its
   *  clean window; a latch of a route without its condition resolves after
   *  10 clean minutes (at once on a page that pages nobody). */
  async #evaluateRoutes(page: SyncPageRow, open: ReadonlyMap<string, Date>, result: SyncAlertPassResult): Promise<void> {
    const conditions = pagesOwnerAlerts(page) ? evaluateRouteAlerts(page, page.dbNow) : [];
    const holding = new Map(conditions.map((entry) => [entry.route, entry]));
    for (const route of FANSLY_ROUTES.keys()) {
      const subKey = syncEngineRouteSubKey(route);
      const key = syncEngineIncidentKey({ subKey, pageId: page.pageId });
      const lastSeenAt = open.get(key);
      const held = holding.get(route);
      if (held !== undefined) {
        await notifySyncEngineIncident(this.#app, {
          subKey,
          pageId: page.pageId,
          pageLabel: page.pageLabel,
          detail: held.detail,
          errorSummary: summaryOf(held.detail, held.last429At, routeAlertContext(held)),
          occurredAt: held.seenAt,
        });
        if (lastSeenAt === undefined) result.opened.push({ pageId: page.pageId, subKey, detail: held.detail });
      } else if (lastSeenAt !== undefined) {
        const cleanMs = pagesOwnerAlerts(page) ? SYNC_ALERT_CLEAN_MS : 0;
        if (page.dbNow.getTime() - lastSeenAt.getTime() < cleanMs) continue;
        await resolveSyncEngineIncident(this.#app, { subKey, pageId: page.pageId, pageLabel: page.pageLabel, recoveredAt: page.dbNow });
        result.resolved.push({ pageId: page.pageId, subKey });
      }
    }
  }

  /** The send audit (I1, I19): the page's sends since the last pass over BOTH
   *  journals — the engine's live attempts and the legacy send log — so a
   *  pair straddling a page's hand-over to the engine is seen too (step-3
   *  §3.5 item 2, G4, E12). Every violation opens (refreshes) the permanent pace
   *  latch as of its send; an acknowledged one never reopens it. A pair it
   *  cannot judge (an attempt admitted before 0237, two clocks that disagree,
   *  a send never recorded that its admission does not prove) pages nobody:
   *  it is counted, and no acceptance passes on it. */
  async #auditSends(page: SyncPageRow): Promise<{ pace: number; intervals: number; inconclusive: number }> {
    // From the last pass (with an overlap), never further back than the first
    // pass reads (a page back in the engine after a while starts there).
    const last = this.#paceAuditedTo.get(page.pageId);
    const since = new Date(Math.max(
      page.dbNow.getTime() - PACE_AUDIT_FIRST_LOOKBACK_MS,
      last === undefined ? Number.NEGATIVE_INFINITY : last.getTime() - PACE_AUDIT_OVERLAP_MS,
    ));
    const rows = await readFanslySendAudit(this.#o.db, { pageId: page.pageId, since });
    const window = { start: since, until: null };
    const pace = auditPagePace(rows, window);
    const intervals = auditRouteIntervals(rows, window);
    const latch = async (detail: string, at: Date, context: Record<string, unknown>) => {
      await notifySyncEngineIncident(this.#app, {
        subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY,
        pageId: page.pageId,
        pageLabel: page.pageLabel,
        detail,
        errorSummary: summaryOf(detail, at, context),
        occurredAt: at,
      });
    };
    for (const pair of pace.violations) {
      await latch("pace_violation", pair.sentAt, {
        journal: pair.journal,
        ref: pair.ref,
        previous: pair.prevJournal,
        previousRef: pair.prevRef,
        gapMs: Math.round(pair.gapMs * 10) / 10,
        clock: pair.clock,
        wallGapMs: Math.round(pair.wallGapMs * 10) / 10,
        pauseMs: pair.pauseMs,
      });
    }
    for (const pair of intervals.violations) {
      await latch("route_interval_violation", pair.at, {
        [pair.kind]: pair.scope,
        journal: pair.journal,
        ref: pair.ref,
        previous: pair.prevJournal,
        previousRef: pair.prevRef,
        gapMs: Math.round(pair.gapMs),
        intervalMs: pair.intervalMs,
      });
    }
    for (const breach of intervals.ceiling) {
      await latch("route_interval_below_ceiling", breach.at, {
        [breach.kind]: breach.scope,
        ref: breach.ref,
        intervalMs: breach.intervalMs,
        ceilingIntervalMs: breach.ceilingIntervalMs,
      });
    }
    this.#paceAuditedTo.set(page.pageId, page.dbNow);
    return {
      pace: pace.violations.length,
      intervals: intervals.violations.length + intervals.ceiling.length,
      inconclusive: pace.inconclusive.length + intervals.inconclusive.length,
    };
  }
}

/**
 * `pnpm cli sync alerts ack`: the owner has looked at a page's pace
 * violations. Resolves the page's pace latch (a violation sent before this
 * instant never reopens it) and records who acknowledged.
 */
export async function acknowledgeSyncPaceViolations(
  app: IncidentApp,
  input: { page: Pick<SyncPageRow, "pageId" | "pageLabel">; actor: string; note?: string | null },
): Promise<{ wasOpen: boolean; acknowledgedAt: Date }> {
  const key = syncEngineIncidentKey({ subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY, pageId: input.page.pageId });
  const incident = await getNotificationIncidentByKey(app.db, key);
  // The database clock: the violations it closes carry their send instants
  // from the same clock (`sync_attempts.sent_at`).
  const clock = await app.db.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  const acknowledgedAt = new Date(clock.rows[0]!.now);
  await resolveSyncEngineIncident(app, {
    subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY,
    pageId: input.page.pageId,
    pageLabel: input.page.pageLabel,
    recoveredAt: acknowledgedAt,
  });
  await insertAuditEvent(app.db, {
    platformAccountId: input.page.pageId,
    source: "cli",
    eventType: SYNC_ALERTS_ACK_AUDIT_EVENT,
    metadata: {
      actor: input.actor,
      subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY,
      wasOpen: incident?.status === "open",
      lastSummary: incident?.errorSummary ?? null,
      ...(input.note === undefined || input.note === null ? {} : { note: input.note }),
    },
  });
  return { wasOpen: incident?.status === "open", acknowledgedAt };
}

/** `pnpm cli sync alerts status`: per page, what holds now and its latches. */
export async function readSyncAlertStatus(
  db: Database,
  input: { registry: Pick<EngineRegistry, "spec">; pages: readonly SyncPageRow[]; resolvePayload?: FanslyWsLivePayloadResolver },
) {
  const now = input.pages[0]?.dbNow ?? new Date();
  const money = await readMissingMoneyFrames(db, {
    pageIds: input.pages.filter(pagesOwnerAlerts).map((page) => page.pageId),
    now,
    ...(input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload }),
  });
  const incidents = (await listNotificationIncidents(db, { status: "open" }))
    .filter((incident) => incident.kind === "fansly_sync_engine");
  const statuses = [];
  for (const page of input.pages) {
    // Only handover/live page the owner: no other page has a condition.
    const pagesOwner = pagesOwnerAlerts(page);
    const facts = pagesOwner ? await readPageAlertFacts(db, { page, money }) : null;
    statuses.push({
      page: page.pageLabel ?? String(page.pageId),
      mode: page.mode,
      pages: pagesOwner,
      conditions: facts === null ? [] : evaluatePageAlerts(facts, input.registry),
      // What alert 3 counts and never pages (arena "vanished chat" plan §4):
      // chats Fansly does not serve to the page (`sync chats unavailable`),
      // the chats that opened an episode within the `chats_refused` window,
      // and fan messages awaited in chats Hub has no thread for.
      chats: facts === null
        ? null
        : {
          unavailable: facts.chats.unavailable,
          refusedRecently: facts.chats.refused.chats,
          unconfirmedWithoutThread: facts.live.unconfirmedWithoutThread,
        },
      // The routes held now or within their clean window (D5).
      routes: pagesOwner ? evaluateRouteAlerts(page, page.dbNow) : [],
      // A latch whose condition no longer holds resolves 10 clean minutes
      // after `lastSeenAt` (alert 4 at once).
      openLatches: incidents
        .filter((incident) => incident.platformAccountId === page.pageId)
        .map((incident) => ({
          key: incident.incidentKey,
          openedAt: incident.openedAt,
          lastSeenAt: incident.lastSeenAt,
          summary: incident.errorSummary,
        })),
    });
  }
  return {
    pages: statuses,
    global: incidents
      .filter((incident) => incident.platformAccountId === null)
      .map((incident) => ({ key: incident.incidentKey, openedAt: incident.openedAt, summary: incident.errorSummary })),
  };
}
