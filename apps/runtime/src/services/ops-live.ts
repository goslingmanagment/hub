// `GET /api/v1/ops/live`: what Hub is doing right now, assembled for an
// operator screen that asks every two seconds — the feed of sent requests,
// each page's holds and why its work waits, the process heartbeats, the job
// queue and the open incidents. Read-only: it writes no row and no metric.
//
// The clock it runs on decides what is read when:
//   - the feed of sent requests is read on every request (an index range of
//     the window, `listOpsLiveAttempts`);
//   - pages, processes and incidents are read at most once in two seconds;
//   - the queue summary — a pass over the whole job table — at most once in
//     thirty seconds.
// Each cached part is read by one request at a time: the others wait for that
// read instead of starting their own.
//
// "Why waiting" is the engine's own answer: `readSyncPageQueue` explains every
// open row with `explainWork`, as the owner's and the agents' sync status do.

import type { OpsLiveAttempt, OpsLivePage, OpsLiveResponse } from "@agency_hub_core/contracts";
import {
  ENGINE_OWNED_SYNC_PAGE_MODES,
  listAllInstances,
  listNotificationIncidents,
  listOpenWorkOfAllPages,
  listOpsLiveAttempts,
  listOpsLivePages,
  listSyncPages,
  readOpsLiveQueueSummary,
  type OpsLiveAttemptRow,
  type OpsLiveQueueSummary,
  type SyncHoldRow,
  type SyncPageRow,
  type SyncWorkStatusFields,
} from "@agency_hub_core/db";
import { isIndefinite } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { effectiveRatePerMin, routeStateOfHolds } from "../sync/engine/route-policy.ts";
import { WORK_CLASSES } from "../sync/engine/scheduler.ts";
import { WAITING_REASONS, type QueueStatus } from "../sync/engine/status.ts";
import { isFanslyRoute, routeBudget } from "../sync/fansly/routes.ts";
import { readPauseSettingMs, readSyncPageQueue } from "../sync/inspect.ts";

/** Without a cursor: every request sent within this window. With one: how
 *  long before the window a request may have been sent and still be reported
 *  when it completes. */
export const OPS_LIVE_FEED_WINDOW_MS = 10 * 60_000;
/** A cursor reaches this far before the instant it was issued: a request sent
 *  or completed by a transaction still open at that instant, or stamped by a
 *  clock a little behind, is in the next answer. */
export const OPS_LIVE_CURSOR_OVERLAP_MS = 30_000;
export const OPS_LIVE_MAX_ATTEMPTS = 2_000;
export const OPS_LIVE_STATE_TTL_MS = 2_000;
export const OPS_LIVE_QUEUE_TTL_MS = 30_000;
export const OPS_LIVE_SUMMARY_MAX_LENGTH = 160;

// ── cursor ──────────────────────────────────────────────────────────────────

const CURSOR_PATTERN = /^t1-([0-9a-z]{1,11})$/;

/** The cursor of an answer generated at `issuedAt`: opaque to the caller. */
export function encodeOpsLiveCursor(issuedAt: Date): string {
  return `t1-${issuedAt.getTime().toString(36)}`;
}

/** When the cursor was issued; null for anything this build did not issue —
 *  answered as if no cursor were given. */
export function decodeOpsLiveCursor(cursor: unknown): Date | null {
  if (typeof cursor !== "string") return null;
  const match = CURSOR_PATTERN.exec(cursor);
  if (match === null) return null;
  const issuedAtMs = Number.parseInt(match[1]!, 36);
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0) return null;
  const issuedAt = new Date(issuedAtMs);
  return Number.isNaN(issuedAt.getTime()) ? null : issuedAt;
}

export interface OpsLiveFeedWindow {
  /** Only requests sent after this instant are read at all. */
  sentAfter: Date;
  /** Of them, those sent or completed after this instant. */
  changedAfter: Date;
}

/**
 * The window of the feed. Without a cursor: the requests sent in the last
 * ten minutes. With one: those sent or completed since 30 seconds before it
 * was issued, as long as they were sent no more than ten minutes before that.
 * A cursor from the future counts as issued now; one so old that its window
 * would reach past the last ten minutes is answered as if it were absent.
 */
export function opsLiveFeedWindow(cursorIssuedAt: Date | null, now: Date): OpsLiveFeedWindow {
  const floorMs = now.getTime() - OPS_LIVE_FEED_WINDOW_MS;
  const sinceMs = cursorIssuedAt === null
    ? floorMs
    : Math.min(cursorIssuedAt.getTime(), now.getTime()) - OPS_LIVE_CURSOR_OVERLAP_MS;
  if (cursorIssuedAt === null || sinceMs <= floorMs) {
    return { sentAfter: new Date(floorMs), changedAfter: new Date(floorMs) };
  }
  return { sentAfter: new Date(sinceMs - OPS_LIVE_FEED_WINDOW_MS), changedAfter: new Date(sinceMs) };
}

// ── the feed ────────────────────────────────────────────────────────────────

const JOURNAL_PREFIX = { engine: "e", legacy: "l" } as const;

/** The newest `OPS_LIVE_MAX_ATTEMPTS` of both journals, oldest first. */
export function opsLiveAttemptsOf(rows: readonly OpsLiveAttemptRow[]): OpsLiveAttempt[] {
  const newestFirst = [...rows].sort((left, right) =>
    right.sentAt.getTime() - left.sentAt.getTime()
    || right.journal.localeCompare(left.journal)
    || right.id - left.id);
  return newestFirst.slice(0, OPS_LIVE_MAX_ATTEMPTS).reverse().map((row) => ({
    id: `${JOURNAL_PREFIX[row.journal]}${row.id}`,
    page: row.pageLabel,
    resource: row.resource,
    operation: row.operation,
    class: row.class,
    sentAt: row.sentAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    failed: row.failed,
    httpStatus: row.httpStatus,
    durationMs: row.durationMs,
    responseBytes: row.responseBytes,
  }));
}

// ── pages ───────────────────────────────────────────────────────────────────

/**
 * The page's holds in force at `now`, by scope and kind — never the hold's
 * key (a route, a resource file).
 *
 * A row with an end is in force until it. A row without one is a route's
 * state after its 429s (`route_budget`): it stays for the ladder's sake, and
 * holds the route back only while its stored rate is below the route's
 * budget — then it is listed, with no `until`, and otherwise not. A
 * credentials hold ends at "infinity" (an identity proof lifts it): no
 * `until` either. A row this build cannot read as a route's state is listed
 * as stored.
 */
export function opsLiveHoldsOf(holds: readonly SyncHoldRow[], now: Date): OpsLivePage["holds"] {
  const routes = routeStateOfHolds(holds);
  return holds
    .filter((hold) => {
      if (hold.until !== null) return hold.until.getTime() > now.getTime();
      if (hold.scope === "route" && hold.kind === "route_budget" && routes.ok && isFanslyRoute(hold.key)) {
        return effectiveRatePerMin(hold.key, routes.state) < routeBudget(hold.key).currentPerMin;
      }
      return true;
    })
    .map((hold) => ({
      scope: hold.scope,
      kind: hold.kind,
      until: hold.until === null || isIndefinite(hold.until) ? null : hold.until.toISOString(),
    }));
}

/** The engine's queue status — per class, by why it waits — as one list over
 *  all classes, in the dictionary's order. */
export function opsLiveWaitingOf(queue: QueueStatus): OpsLivePage["waiting"] {
  const waiting: OpsLivePage["waiting"] = [];
  for (const reason of WAITING_REASONS) {
    let count = 0;
    for (const workClass of WORK_CLASSES) count += queue[workClass].waitingByReason[reason] ?? 0;
    if (count > 0) waiting.push({ reason, count });
  }
  return waiting;
}

function isEngineServed(page: SyncPageRow): boolean {
  return (ENGINE_OWNED_SYNC_PAGE_MODES as readonly string[]).includes(page.mode);
}

async function readPages(app: Pick<AppContext, "db" | "config">): Promise<OpsLivePage[]> {
  const pages = await listOpsLivePages(app.db);
  const syncPages = new Map((await listSyncPages(app.db)).map((page) => [page.pageId, page]));
  const worksByPage = new Map<number, SyncWorkStatusFields[]>();
  for (const work of await listOpenWorkOfAllPages(app.db)) {
    const works = worksByPage.get(work.pageId);
    if (works === undefined) worksByPage.set(work.pageId, [work]);
    else works.push(work);
  }
  // S as the actor reads it: the pacer's part of "why waiting".
  const settingMs = syncPages.size === 0 ? 0 : await readPauseSettingMs(app.db, app.config);

  const answer: OpsLivePage[] = [];
  for (const page of pages) {
    const syncPage = syncPages.get(page.id);
    if (syncPage === undefined) {
      // A page the Fansly Sync Engine has no row for (OnlyFans): no engine
      // pauses, holds or work, and no stored last send — its requests are in
      // the feed.
      answer.push({
        label: page.label,
        platform: page.platform,
        engine: false,
        pausedAll: false,
        pausedRequests: false,
        pausedResources: [],
        holds: [],
        openWork: 0,
        dueNow: 0,
        nextDueAt: null,
        waiting: [],
        lastSentAt: null,
      });
      continue;
    }
    const now = syncPage.dbNow;
    const works = worksByPage.get(page.id) ?? [];
    let dueNow = 0;
    let nextDueAtMs: number | null = null;
    for (const work of works) {
      if (work.state !== "open") continue;
      const dueAtMs = work.dueAt.getTime();
      if (dueAtMs <= now.getTime()) dueNow += 1;
      else if (nextDueAtMs === null || dueAtMs < nextDueAtMs) nextDueAtMs = dueAtMs;
    }
    answer.push({
      label: page.label,
      platform: page.platform,
      engine: isEngineServed(syncPage),
      pausedAll: syncPage.pausedAll,
      pausedRequests: syncPage.pausedRequests,
      pausedResources: [...syncPage.pausedResources],
      holds: opsLiveHoldsOf(syncPage.holds, now),
      openWork: works.length,
      dueNow,
      nextDueAt: nextDueAtMs === null ? null : new Date(nextDueAtMs).toISOString(),
      waiting: works.length === 0
        ? []
        : opsLiveWaitingOf(await readSyncPageQueue(app.db, syncPage, works, settingMs, now)),
      lastSentAt: syncPage.lastSendAt?.toISOString() ?? null,
    });
  }
  return answer;
}

// ── processes, incidents ────────────────────────────────────────────────────

async function readProcesses(app: Pick<AppContext, "db">): Promise<OpsLiveResponse["processes"]> {
  return (await listAllInstances(app.db)).map((instance) => ({
    role: instance.role,
    startedAt: instance.startedAt.toISOString(),
    lastSeenAt: instance.lastSeenAt.toISOString(),
  }));
}

/** At most `OPS_LIVE_SUMMARY_MAX_LENGTH` characters, never half of a
 *  surrogate pair. */
export function opsLiveSummaryOf(summary: string | null): string {
  const text = summary ?? "";
  if (text.length <= OPS_LIVE_SUMMARY_MAX_LENGTH) return text;
  const cut = text.slice(0, OPS_LIVE_SUMMARY_MAX_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

async function readIncidents(app: Pick<AppContext, "db">): Promise<OpsLiveResponse["incidents"]> {
  const open = await listNotificationIncidents(app.db, { status: "open" });
  return open
    .sort((left, right) => right.openedAt.getTime() - left.openedAt.getTime() || right.id - left.id)
    .map((incident) => ({
      id: String(incident.id),
      kind: incident.kind,
      stream: incident.stream,
      openedAt: incident.openedAt.toISOString(),
      summary: opsLiveSummaryOf(incident.errorSummary),
    }));
}

// ── the answer ──────────────────────────────────────────────────────────────

/** The source revision the image was built from (Dockerfile `GIT_SHA`); null
 *  when the build does not say. */
export function opsLiveRevision(env: NodeJS.ProcessEnv = process.env): string | null {
  const revision = env.GIT_SHA?.trim() ?? "";
  return revision === "" || revision === "unknown" ? null : revision;
}

/**
 * A value read at most once per `ttlMs`, by one caller at a time: a caller
 * that arrives during a read waits for it. The age counts from the start of
 * the read (the value is at least that old). A failed read is not kept — the
 * next caller reads again.
 */
export function cachedRead<T>(read: () => Promise<T>, ttlMs: number, nowMs: () => number = Date.now): () => Promise<T> {
  let kept: { value: T; readAtMs: number } | null = null;
  let reading: Promise<T> | null = null;
  return () => {
    if (kept !== null && nowMs() - kept.readAtMs < ttlMs) return Promise.resolve(kept.value);
    if (reading !== null) return reading;
    const readAtMs = nowMs();
    reading = read()
      .then((value) => {
        kept = { value, readAtMs };
        return value;
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  };
}

export interface OpsLiveReaderOptions {
  /** TESTS ONLY: the clock of the two caches. */
  nowMs?: () => number;
}

interface OpsLiveState {
  pages: OpsLivePage[];
  processes: OpsLiveResponse["processes"];
  incidents: OpsLiveResponse["incidents"];
}

/** The reader behind the route: one per API process, with its two caches. */
export function createOpsLiveReader(
  app: Pick<AppContext, "db" | "config">,
  options: OpsLiveReaderOptions = {},
): (cursor: unknown) => Promise<OpsLiveResponse> {
  const nowMs = options.nowMs ?? Date.now;
  // One connection at a time: three short reads in a row, not three at once.
  const state = cachedRead<OpsLiveState>(async () => {
    const pages = await readPages(app);
    const processes = await readProcesses(app);
    const incidents = await readIncidents(app);
    return { pages, processes, incidents };
  }, OPS_LIVE_STATE_TTL_MS, nowMs);
  const queue = cachedRead<OpsLiveQueueSummary>(() => readOpsLiveQueueSummary(app.db), OPS_LIVE_QUEUE_TTL_MS, nowMs);

  return async (cursor) => {
    const generatedAt = new Date();
    const window = opsLiveFeedWindow(decodeOpsLiveCursor(cursor), generatedAt);
    const attempts = await listOpsLiveAttempts(app.db, { ...window, limit: OPS_LIVE_MAX_ATTEMPTS });
    const { pages, processes, incidents } = await state();
    return {
      generatedAt: generatedAt.toISOString(),
      revision: opsLiveRevision(),
      processes,
      pages,
      attempts: opsLiveAttemptsOf(attempts),
      queue: await queue(),
      incidents,
      nextCursor: encodeOpsLiveCursor(generatedAt),
    };
  };
}
