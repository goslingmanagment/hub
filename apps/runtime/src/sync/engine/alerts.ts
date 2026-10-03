import { sql } from "drizzle-orm";

import {
  getNotificationIncidentByKey,
  insertAuditEvent,
  listCombinedFanslySendsForPaceAudit,
  listNotificationIncidents,
  listSyncPages,
  readSyncJournalAlertFacts,
  readSyncLivePathFacts,
  SYNC_ALERTS_ACK_AUDIT_EVENT,
  type Database,
  type FanslyWsLivePayloadResolver,
  type SyncJournalAlertFacts,
  type SyncLivePathFacts,
  type SyncPageRow,
} from "@agency_hub_core/db";
import { activeFanslyPageHold } from "@agency_hub_core/shared";

import {
  notifySyncEngineIncident,
  resolveSyncEngineIncident,
  type IncidentApp,
  SYNC_ENGINE_PACE_VIOLATION_SUBKEY,
  syncEngineIncidentKey,
  type SyncEngineAlertSubKey,
  type SyncEngineIncidentSubKey,
} from "../../services/notification-incidents.ts";
import { moneyFramesMissing, readMoneyFrames } from "../fansly/ws/money-frames.ts";
import type { SyncLogger } from "./commit.ts";
import {
  ENDPOINT_RATE_GROUPS,
  LIST_RATE_LIMIT_LADDER_MS,
  NETWORK_ALERT_AFTER_MS,
  resourceFileOf,
  type EndpointRateGroup,
} from "./errors.ts";
import { noopMetrics, type AlertSink, type Metrics, type SyncAlertInput } from "./ports.ts";
import { effectivePeriodMs, resourceDisabled, runsIn, type EngineRegistry } from "./resource.ts";
import { parseRouteState } from "./route-policy.ts";

// The Fansly Sync Engine's alerts 1–4 (plan §10, design §9.6). Alert 5 (the
// `sync` process is silent) is the api watchdog's: a process cannot report
// its own death.
//
// One incident kind, `fansly_sync_engine` (0233), one latch per page and
// alert. Two paths open a latch: the actor's capture transaction opens alert 1
// at once on a 429, a refused credential, another identity or a pace
// violation (the incident sink below), and the evaluator re-derives every
// condition from the database every 30 s — opening what holds, resolving what
// has stayed clear long enough (alerts 1–3: 10 min; alert 4: at once). The
// evaluator is the only one that resolves, so a latch never flips on one
// path's partial view. Alert 1's pace violation has its own latch
// (`page_stopped:pace_violation`), resolved only by the owner (`pnpm cli sync
// alerts ack`).
//
// Pages: `handover` and `live` page the owner. A `shadow` page's alerts are
// metrics only (D14): the golden-signal sampler counts them
// (`sync_shadow_alerts`), the sink logs the actor's. On `handover` the
// ownership alert is suppressed (the switch waits up to 5 min for the legacy
// stop by design); a handover older than 10 min is `handover_stuck`.

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
/** Alert 3: a fan message the socket showed, unconfirmed for longer than this. */
export const SYNC_UNCONFIRMED_MESSAGE_MS = 15 * 60_000;
/** Alert 3: a money frame not in the ledger for longer than this … */
export const SYNC_MONEY_FRAME_MS = 5 * 60_000;
/** … looked for within this window (an older frame no longer counts). */
export const SYNC_MONEY_LOOKBACK_MS = 60 * 60_000;
/** Alert 3: urgent work waiting longer than this. */
export const SYNC_URGENT_WAIT_MS = 2 * 60_000;
/** Alert 4: a request with runnable work and no read for this long. */
export const SYNC_REQUEST_STALL_MS = 30 * 60_000;
/** Alert 4: a poll without its own SLO is stale after this many periods. */
export const SYNC_STALE_PERIODS = 3;
/** The pace backstop re-reads this much of the journal before its last pass
 *  (a send captured after a pass with an earlier send instant). */
const PACE_AUDIT_OVERLAP_MS = 60_000;
/** The pace backstop's first pass reads this far back (and no pass further). */
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
  page: Pick<SyncPageRow, "pageId" | "mode" | "modeChangedAt" | "holdKind" | "holdUntil" | "holdSince" | "holdDetail"
    | "resourceHolds" | "pausedAll" | "pausedRequests" | "pausedResources" | "registryOverrides" | "owner">
    & Partial<Pick<SyncPageRow, "routeState">>;
  journal: SyncJournalAlertFacts;
  live: SyncLivePathFacts;
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

function inForce(until: Date | null, now: Date): boolean {
  return until !== null && until.getTime() > now.getTime();
}

/** An endpoint group's hold at the top of its ladder (alert 1
 *  `rate_limit_list`, `rate_limit_media_stats`). */
function sustainedGroupHold(page: PageAlertFacts["page"], group: EndpointRateGroup, now: Date): Date | null {
  const hold = page.resourceHolds[group.file];
  if (hold?.kind !== group.kind || !inForce(dateOf(hold.until), now)) return null;
  return hold.step >= LIST_RATE_LIMIT_LADDER_MS.length ? dateOf(hold.since) : null;
}

/** A resource whose work waits for a reason the owner or another alert owns. */
function resourceExplained(page: PageAlertFacts["page"], resource: string, now: Date): boolean {
  if (page.pausedResources.includes(resource) || resourceDisabled(page, resource)) return true;
  const hold = page.resourceHolds[resourceFileOf(resource)];
  return hold !== undefined && inForce(dateOf(hold.until), now);
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
  const shadow = page.mode === "shadow" || page.mode === "off";
  const conditions: Array<SyncAlertCondition | null> = [];

  // 1. The page stopped: the page holds in force by the shared page-hold
  // core (the rule the actor admits by) — a credentials hold, and a 429 or
  // network hold, the page's own or one a credentials hold carries.
  const stopped: SyncAlertCondition["reasons"] = [];
  const held = activeFanslyPageHold(page, now);
  const holdInForce = held !== null;
  if (held?.credentials) stopped.push({ detail: held.credentials.kind, since: held.credentials.since });
  if (held?.timed?.kind === "rate_limit") stopped.push({ detail: "rate_limit", since: held.timed.since });
  for (const group of ENDPOINT_RATE_GROUPS) {
    const groupSince = sustainedGroupHold(page, group, now);
    if (groupSince !== null) stopped.push({ detail: group.kind, since: groupSince });
  }
  // A route state this build cannot read keeps the page's admission closed
  // (`engine/route-policy.ts`).
  const routeState = parseRouteState(page.routeState);
  if (!routeState.ok) stopped.push({ detail: "route_state_unreadable", since: null, context: { diagnostic: routeState.diagnostic } });
  if (held?.timed?.kind === "network") {
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
  // or the owner's own lever), so they do not page twice.
  const late: SyncAlertCondition["reasons"] = [];
  if (live.unconfirmed.count > 0) {
    late.push({ detail: "message_unconfirmed", since: live.unconfirmed.oldestVisibleAt, context: { messages: live.unconfirmed.count } });
  }
  if (facts.money !== null) {
    late.push({ detail: "money_not_in_ledger", since: facts.money.oldestReceivedAt, context: { frames: facts.money.count } });
  }
  if (!page.pausedAll && !holdInForce) {
    const waiting = journal.urgentWaiting.filter((row) =>
      row.waitingReason !== "dependency" && !resourceExplained(page, row.resource, now));
    const oldest = waiting[0];
    if (oldest !== undefined) {
      late.push({
        detail: "urgent_waiting",
        since: oldest.dueAt,
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
      if (spec === null || !runsIn(spec, shadow) || resourceExplained(page, poll.resource, now)) continue;
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

/** Read a page's facts and evaluate it. `money` comes from one window read
 *  over many pages (`readMoneyFrames`); without it the money rule is skipped. */
export async function collectPageAlerts(
  db: Database,
  input: {
    page: SyncPageRow;
    registry: Pick<EngineRegistry, "spec">;
    money?: Map<number, { count: number; oldestReceivedAt: Date }>;
  },
): Promise<SyncAlertCondition[]> {
  const shadow = input.page.mode === "shadow" || input.page.mode === "off";
  const journal = await readSyncJournalAlertFacts(db, {
    pageId: input.page.pageId,
    shadow,
    stopLookbackMs: SYNC_ALERT_CLEAN_MS,
    urgentAfterMs: SYNC_URGENT_WAIT_MS,
    requestStallMs: SYNC_REQUEST_STALL_MS,
  });
  const live = await readSyncLivePathFacts(db, {
    pageId: input.page.pageId,
    decodeWindowMs: SYNC_DECODE_DEBT_WINDOW_MS,
    unconfirmedAfterMs: SYNC_UNCONFIRMED_MESSAGE_MS,
  });
  return evaluatePageAlerts({
    page: input.page,
    journal,
    live,
    money: input.money?.get(input.page.pageId) ?? null,
    now: input.page.dbNow,
  }, input.registry);
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
 * The production `AlertSink` of the engine: a `handover`/`live` page's alert
 * opens its latch at once; a shadow page's is logged and counted (D14).
 * Resolution is the evaluator's alone, so `resolve` only logs.
 */
export function createIncidentAlertSink(input: { db: Database; logger: SyncLogger; metrics?: Metrics }): AlertSink {
  const metrics = input.metrics ?? noopMetrics;
  const app: IncidentApp = { db: input.db, logger: input.logger };
  return {
    async open(alert: SyncAlertInput) {
      const fields = { pageId: alert.pageId, subKey: alert.subKey, detail: alert.detail };
      if (alert.shadow) {
        metrics.increment("sync_shadow_alerts", { subKey: alert.subKey, detail: alert.detail });
        input.logger.info(fields, "Fansly sync shadow alert (metric only)");
        return;
      }
      input.logger.error(fields, "Fansly sync alert");
      const subKey: SyncEngineIncidentSubKey = alert.subKey === "page_stopped" && alert.detail === "pace_violation"
        ? SYNC_ENGINE_PACE_VIOLATION_SUBKEY
        : alert.subKey;
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
  paceViolations: number;
}

export interface SyncAlertEvaluatorOptions {
  db: Database;
  logger: SyncLogger;
  registry: Pick<EngineRegistry, "spec">;
  resolvePayload?: FanslyWsLivePayloadResolver;
  intervalMs?: number;
}

/**
 * The 30-second evaluator of the `sync` process. Each pass: every
 * `handover`/`live` page's alerts 1–4 are derived from the database; a
 * condition that holds opens or refreshes its latch (`last_seen_at`), and a
 * latch whose condition has stayed false for `syncAlertResolveAfterMs` since
 * its `last_seen_at` is resolved — the clean time lives in the latch, so it
 * survives a restart of the evaluator. The latches of every other page are
 * resolved at once (a page set back to `off` or `shadow` pages nothing). The
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
    this.#pass ??= this.#evaluate()
      .catch((error: unknown) => {
        this.#o.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "Fansly sync alerts: evaluation pass failed");
        return null;
      })
      .finally(() => {
        this.#pass = null;
      });
    return this.#pass;
  }

  async #evaluate(): Promise<SyncAlertPassResult> {
    const { db } = this.#o;
    const pages = await listSyncPages(db);
    const result: SyncAlertPassResult = { pages: pages.length, opened: [], resolved: [], paceViolations: 0 };
    // Open latches by key, with the last instant their condition was seen.
    const open = new Map((await listNotificationIncidents(db, { status: "open" }))
      .filter((incident) => incident.kind === "fansly_sync_engine")
      .map((incident) => [incident.incidentKey, incident.lastSeenAt] as const));
    const owned = pages.filter(pagesOwnerAlerts);
    const now = pages[0]?.dbNow ?? new Date();
    const money = await readMissingMoneyFrames(db, {
      pageIds: owned.map((page) => page.pageId),
      now,
      ...(this.#o.resolvePayload === undefined ? {} : { resolvePayload: this.#o.resolvePayload }),
    });
    for (const page of pages) {
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
      if (pagesOwnerAlerts(page)) result.paceViolations += await this.#auditPace(page);
    }
    if (result.opened.length > 0 || result.resolved.length > 0) {
      this.#o.logger.info({ opened: result.opened, resolved: result.resolved }, "Fansly sync alerts: latches changed");
    }
    return result;
  }

  /** The pace backstop: the page's sends since the last pass over BOTH
   *  journals — the engine's live attempts and the legacy send log — so a
   *  pair straddling the handover or a rollback is seen too (step-3 §3.5
   *  item 2, G4, E12). */
  async #auditPace(page: SyncPageRow): Promise<number> {
    // From the last pass (with an overlap), never further back than the first
    // pass reads (a page back in the engine after a while starts there).
    const last = this.#paceAuditedTo.get(page.pageId);
    const since = new Date(Math.max(
      page.dbNow.getTime() - PACE_AUDIT_FIRST_LOOKBACK_MS,
      last === undefined ? Number.NEGATIVE_INFINITY : last.getTime() - PACE_AUDIT_OVERLAP_MS,
    ));
    const sends = await listCombinedFanslySendsForPaceAudit(this.#o.db, { pageId: page.pageId, since });
    const violations = sends.filter((send) => send.violation);
    for (const send of violations) {
      await notifySyncEngineIncident(this.#app, {
        subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY,
        pageId: page.pageId,
        pageLabel: page.pageLabel,
        detail: "pace_violation",
        errorSummary: summaryOf("pace_violation", send.sentAt, {
          journal: send.journal,
          ref: send.ref,
          previous: send.prevJournal,
          gapMs: Math.round(send.gapMs!),
          settingMs: send.settingMs,
        }),
        occurredAt: send.sentAt,
      });
    }
    this.#paceAuditedTo.set(page.pageId, page.dbNow);
    return violations.length;
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
    pageIds: input.pages.filter((page) => page.mode !== "off").map((page) => page.pageId),
    now,
    ...(input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload }),
  });
  const incidents = (await listNotificationIncidents(db, { status: "open" }))
    .filter((incident) => incident.kind === "fansly_sync_engine");
  const statuses = [];
  for (const page of input.pages) {
    const conditions = page.mode === "off" ? [] : await collectPageAlerts(db, { page, registry: input.registry, money });
    statuses.push({
      page: page.pageLabel ?? String(page.pageId),
      mode: page.mode,
      // A shadow page's conditions are metrics; only handover/live page the owner.
      pages: pagesOwnerAlerts(page),
      conditions,
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
