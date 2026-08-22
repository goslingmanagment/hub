import {
  countDistinctFansForPages,
  listSyncMonitorRecentEvents,
  listSyncMonitorRecentRequests,
  listSyncMonitorStreamRows,
  type PageSyncStatus,
  type SyncMonitorRecentEventRow,
  type SyncMonitorStreamRow,
  type SyncStream,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError } from "./errors.ts";
import { parseTransactionBackfillState } from "./sync/transaction-backfill.ts";
import {
  parseDmConversationCursorState,
  parseDmMessagesCursorState,
  parseFollowersCursorState,
  parseFollowersReconcileCursorState,
  parseSubscribersCursorState,
} from "./sync/cursor-state.ts";
import {
  buildOverallSyncUx,
  buildPageSyncUx,
  buildStreamSyncUx,
  isBulkEnrichmentSyncStream,
} from "./sync-ux.ts";
import type { SyncUxSummary } from "@agency_hub_core/contracts";

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_EVENT_LIMIT = 50;
const DEFAULT_REQUEST_LOOKBACK_MS = 60_000;
const DEFAULT_REQUEST_LIMIT = 100;
const MAX_REQUEST_LIMIT = 500;
const STALLED_THRESHOLD_MS = 45_000;
const DEEP_BACKFILL_STALLED_THRESHOLD_MS = 60 * 60 * 1000;
const RATE_LIMITED_LOOKBACK_MS = 15 * 60 * 1000;
/** Exported so a pin test can assert MONITORED ⊇ getSyncStreamsForPlatform("fansly").
 *  A Fansly lane the monitor cannot see is a lane that can wedge unobserved —
 *  which is exactly what happened to `fan_earnings` before W8.1, and what was
 *  still true of `posts` until WP-F1 added the pin. */
export const MONITORED_SYNC_STREAMS = [
  "light",
  "fan_identities",
  "followers",
  "transactions",
  "subscribers",
  "dm_conversations",
  "dm_messages",
  "followers_reconcile",
  // W8.1 (A12/A20): the Stage 16/32 ramp-gated streams become VISIBLE in the
  // monitor snapshot/CLI (a wedged fan_earnings walk was previously
  // unobservable). Deliberately still OUT of block health (BLOCK_TASKS /
  // SYNC_DOMAIN_POLICY): a flag-gated stream must not degrade a page's
  // block UX to "catching up" while its ramp gate is off.
  "top_spenders",
  "fan_earnings",
  "purchase_history",
  // WP-F1 adds `stats_snapshot` and repairs the already-missing `posts`; the
  // pin test is what keeps the next one from going missing too. Both stay OUT
  // of block health (BLOCK_TASKS / SYNC_DOMAIN_POLICY) for the same reason the
  // ramp-gated streams do.
  "posts",
  "stats_snapshot",
  // WP-F2. A lane that can wedge unobserved is the one failure this list
  // exists to prevent, and the notification lane is the one whose downtime
  // costs facts rather than freshness.
  "notifications",
  // WP-F3. A wedged catalog sweep is invisible in every other surface — the
  // page keeps syncing DMs and money while its inventory silently ages, and M
  // (the number WP-F4 is sized against) quietly stops moving.
  "catalog",
  // WP-F5. A wedged replies walk is the quietest failure in this tree: the
  // queue keeps its rows, the page keeps syncing everything else, and the
  // comment archive simply stops growing 3 % into a 14-day first pass.
  "post_replies",
  // WP-F7. A wedged payouts lane is invisible everywhere else: two calls a day
  // is a volume no dashboard notices going to zero, and the first thing lost is
  // the payout-request history the money side reconciles against.
  "payouts",
] as const satisfies readonly SyncStream[];
const REQUEST_STREAMS = [
  ...MONITORED_SYNC_STREAMS,
] as const satisfies readonly SyncStream[];

function isRequestedStream(stream: SyncStream) {
  return (REQUEST_STREAMS as readonly string[]).includes(stream);
}

export type SyncMonitorStatus = PageSyncStatus;

export type SyncMonitorRateHealthState = "healthy" | "warning" | "limited";

export interface SyncMonitorProgress {
  label: string;
  current: number;
  total: number | null;
  unit: string;
  percent: number | null;
}

export interface SyncMonitorRateHealth {
  state: SyncMonitorRateHealthState;
  last429At: string | null;
  nextAvailableAt: string | null;
}

export interface SyncMonitorRecentRuns {
  running: number;
  success: number;
  partial: number;
  failed: number;
  skipped: number;
}

export interface SyncMonitorRecentErrors {
  total429s: number;
  total5xxs: number;
  failedRuns: number;
  failedAttempts: number;
  retryAttempts: number;
  last429At: string | null;
  last5xxAt: string | null;
}

export interface SyncMonitorPhysicalHealth {
  state: "healthy" | "failed";
  attempts24h: number;
  successes24h: number;
  attemptsSinceLastSuccess: number;
  staleAttempts: number;
  lastSuccessAt: string | null;
}

export interface SyncMonitorLastCompletion {
  runId: number;
  trigger: string;
  status: "success" | "partial" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  durationMs: number | null;
  errorSummary: string | null;
}

export interface SyncMonitorActiveRun {
  runId: number;
  trigger: string;
  startedAt: string;
  lastActivityAt: string;
}

export interface SyncMonitorDeepBackfill {
  pendingConversations: number;
  pendingPagesEstimate: number;
  spenderPendingConversations: number;
  spenderPendingPagesEstimate: number;
  regularPendingConversations: number;
  regularPendingPagesEstimate: number;
  recentRequests: number;
  lastCompletedAt: string | null;
  liveRequestsSinceDeepBackfill: number;
  active: boolean;
  stalled: boolean;
  stallReason: string | null;
}

export interface SyncMonitorStreamItem {
  stream: SyncStream;
  status: SyncMonitorStatus;
  stalled: boolean;
  pending: boolean;
  retryAt: string | null;
  progress: SyncMonitorProgress | null;
  deepBackfill: SyncMonitorDeepBackfill | null;
  recentRuns: SyncMonitorRecentRuns;
  recentErrors: SyncMonitorRecentErrors;
  physicalHealth: SyncMonitorPhysicalHealth;
  rateHealth: SyncMonitorRateHealth;
  activeRun: SyncMonitorActiveRun | null;
  lastCompletion: SyncMonitorLastCompletion | null;
  succeededAt: string | null;
  failedAt: string | null;
  lastErrorSummary: string | null;
  consecutiveFailures: number;
  syncUx: SyncUxSummary;
}

export interface SyncMonitorPageCounts {
  fans: number;
  followers: number;
  subscribers: number;
  transactions: number;
  conversations: number;
  messages: number;
}

export interface SyncMonitorPageSummary {
  runningStreams: number;
  blockedStreams: number;
  stalledStreams: number;
  pendingStreams: number;
  retryingStreams: number;
}

export interface SyncMonitorPageItem {
  pageId: number;
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  modelSlug: string;
  modelName: string;
  username: string | null;
  displayName: string | null;
  counts: SyncMonitorPageCounts;
  summary: SyncMonitorPageSummary;
  streams: SyncMonitorStreamItem[];
  syncUx: SyncUxSummary;
}

export interface SyncMonitorProviderSummary {
  platform: "fansly" | "onlyfans";
  rateHealth: SyncMonitorRateHealth;
  recent429s: number;
  recent5xxs: number;
}

export interface SyncMonitorOverall {
  pages: number;
  streams: number;
  runningStreams: number;
  blockedStreams: number;
  stalledStreams: number;
  pendingStreams: number;
  retryingStreams: number;
  counts: SyncMonitorPageCounts;
  recentRuns: SyncMonitorRecentRuns;
  recentErrors: SyncMonitorRecentErrors;
  providers: SyncMonitorProviderSummary[];
  syncUx: SyncUxSummary;
}

export interface SyncMonitorRecentEvent {
  id: number;
  runId: number;
  pageId: number;
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  stream: SyncStream;
  eventType: string;
  severity: "info" | "warn" | "error";
  message: string;
  details: Record<string, unknown>;
  emittedAt: string;
}

export interface SyncMonitorRequestItem {
  timestamp: string;
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  stream: SyncStream;
  operation: string;
  endpoint: string;
  method: string;
  attemptNumber: number;
  status: "started" | "success" | "retry" | "failed";
  httpStatusCode: number | null;
  durationMs: number | null;
  rateLimitWaitMs: number | null;
  groupId: string | null;
  partnerUsername: string | null;
  returnedItems: number | null;
  syncDone: boolean | null;
  proxyGapMs: number | null;
}

export interface SyncMonitorSnapshot {
  generatedAt: string;
  window: {
    hours: number;
    startedAt: string;
  };
  overall: SyncMonitorOverall;
  pages: SyncMonitorPageItem[];
  recentEvents: SyncMonitorRecentEvent[];
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableNumber(value: unknown) {
  return value === null ? null : asNumber(value);
}

function asNullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : null;
}

function maxDate(a: Date | null, b: Date | null) {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function parseOptionalTimestamp(value: string | undefined, field: string) {
  if (value === undefined) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`Invalid \`${field}\` timestamp`);
  }

  return parsed;
}

function clampProgress(current: number, total: number | null) {
  if (total === null) {
    return current;
  }
  return Math.min(current, total);
}

function percent(current: number, total: number | null) {
  if (total === null || total <= 0) {
    return null;
  }
  return Math.round((current / total) * 1000) / 10;
}

function labelWithTotal(current: number, total: number | null, unit: string, suffix = "") {
  if (total === null) {
    return `${current.toLocaleString()} ${unit}${suffix}`.trim();
  }
  return `${current.toLocaleString()}/${total.toLocaleString()} ${unit}${suffix}`.trim();
}

function isRunning(row: SyncMonitorStreamRow) {
  return row.runningRunId !== null;
}

function isPending(row: SyncMonitorStreamRow) {
  if (row.requestSeq === null || row.appliedSeq === null) {
    return false;
  }
  return row.requestSeq > row.appliedSeq && row.status === "pending" && !isRunning(row);
}

function isRetrying(row: SyncMonitorStreamRow, now: Date) {
  return row.status === "retrying" &&
    row.retryAt !== null &&
    row.retryAt.getTime() > now.getTime();
}

function isStalled(row: SyncMonitorStreamRow, now: Date) {
  if (!row.runningLastActivityAt) {
    return false;
  }
  return now.getTime() - row.runningLastActivityAt.getTime() > STALLED_THRESHOLD_MS;
}

function latestSuccessTimestamp(row: SyncMonitorStreamRow) {
  return maxDate(row.cursorLastSucceededAt, row.succeededAt);
}

function failedTimestamp(row: SyncMonitorStreamRow) {
  return row.failedAt;
}

function statusFor(row: SyncMonitorStreamRow, now: Date): SyncMonitorStatus {
  if (isRunning(row)) {
    return "running";
  }

  if (row.status === "retrying" && isRetrying(row, now)) {
    return "retrying";
  }

  if (row.status === "blocked") {
    return "blocked";
  }

  if (row.status === "paused") {
    return "paused";
  }

  if (isPending(row)) {
    return "pending";
  }

  return "idle";
}

function recentRunsFor(row: SyncMonitorStreamRow): SyncMonitorRecentRuns {
  return {
    running: row.recentRunningCount,
    success: row.recentSuccessCount,
    partial: row.recentPartialCount,
    failed: row.recentFailedCount,
    skipped: row.recentSkippedCount,
  };
}

function recentErrorsFor(row: SyncMonitorStreamRow): SyncMonitorRecentErrors {
  return {
    total429s: row.recent429Count,
    total5xxs: row.recent5xxCount,
    failedRuns: row.recentFailedCount,
    failedAttempts: row.recentFailedAttemptCount,
    retryAttempts: row.recentRetryCount,
    last429At: iso(row.last429At),
    last5xxAt: iso(row.last5xxAt),
  };
}

function rateHealthFor(input: {
  total429s: number;
  last429At: Date | null;
  nextAvailableAt: Date | null;
}, now: Date): SyncMonitorRateHealth {
  const limitedByRateLimit = input.nextAvailableAt !== null &&
    input.nextAvailableAt.getTime() > now.getTime();
  const limitedByRecent429 = input.last429At !== null &&
    now.getTime() - input.last429At.getTime() <= RATE_LIMITED_LOOKBACK_MS;

  return {
    state: limitedByRateLimit || limitedByRecent429
      ? "limited"
      : input.total429s > 0
        ? "warning"
        : "healthy",
    last429At: iso(input.last429At),
    nextAvailableAt: iso(input.nextAvailableAt),
  };
}

function lastCompletionFor(row: SyncMonitorStreamRow): SyncMonitorLastCompletion | null {
  if (
    row.lastCompletedRunId === null ||
    row.lastCompletedTrigger === null ||
    row.lastCompletedStatus === null ||
    row.lastCompletedStartedAt === null ||
    row.lastCompletedFinishedAt === null
  ) {
    return null;
  }

  return {
    runId: row.lastCompletedRunId,
    trigger: row.lastCompletedTrigger,
    status: row.lastCompletedStatus,
    startedAt: row.lastCompletedStartedAt.toISOString(),
    finishedAt: row.lastCompletedFinishedAt.toISOString(),
    durationMs: row.lastCompletedDurationMs,
    errorSummary: row.lastCompletedErrorSummary,
  };
}

/** `stats.gatedSkip` of the last completed run, when that run was a ramp-gate
 *  skip. Read from stats rather than error_summary because it must be a
 *  structured marker, not free text: the OTHER writer of the `skipped` outcome
 *  is recordSkipped on a lost lease, which is not a gate and whose summary is
 *  human prose. Stats and lastCompletion come from the same run row, so they
 *  cannot disagree. */
function gatedSkipReasonFor(row: SyncMonitorStreamRow): string | null {
  if (row.lastCompletedStatus !== "skipped") {
    return null;
  }
  const reason = row.lastCompletedStats?.gatedSkip;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

function activeRunFor(row: SyncMonitorStreamRow): SyncMonitorActiveRun | null {
  if (
    row.runningRunId === null ||
    row.runningTrigger === null ||
    row.runningStartedAt === null ||
    row.runningLastActivityAt === null
  ) {
    return null;
  }

  return {
    runId: row.runningRunId,
    trigger: row.runningTrigger,
    startedAt: row.runningStartedAt.toISOString(),
    lastActivityAt: row.runningLastActivityAt.toISOString(),
  };
}

function buildSubscribersProgress(
  row: SyncMonitorStreamRow,
  status: SyncMonitorStatus,
): SyncMonitorProgress | null {
  const state = parseSubscribersCursorState(
    row.checkpointState,
    row.requestSeq ?? row.appliedSeq,
  );
  if (!state) {
    return null;
  }

  const completed = status === "idle" && row.requestSeq === row.appliedSeq;
  const total = state.providerReportedTotal ?? (completed ? row.subscriberCount : null);
  const current = completed
    ? (total ?? row.subscriberCount)
    : clampProgress(state.offset, total);

  return {
    label: labelWithTotal(current, total, "subscribers"),
    current,
    total,
    unit: "subscribers",
    percent: percent(current, total),
  };
}

function buildFollowersProgress(
  row: SyncMonitorStreamRow,
  status: SyncMonitorStatus,
): SyncMonitorProgress | null {
  const state = parseFollowersCursorState(
    row.checkpointState,
    row.requestSeq ?? row.appliedSeq,
  );
  if (!state) {
    return null;
  }

  const total = state.sourceFollowerCount;
  const completed = status === "idle" && row.requestSeq === row.appliedSeq;
  const current = completed ? total : clampProgress(state.offset, total);

  return {
    label: labelWithTotal(current, total, "followers"),
    current,
    total,
    unit: "followers",
    percent: percent(current, total),
  };
}

function buildFollowersReconcileProgress(
  row: SyncMonitorStreamRow,
  status: SyncMonitorStatus,
): SyncMonitorProgress | null {
  const state = parseFollowersReconcileCursorState(
    row.checkpointState,
    row.requestSeq ?? row.appliedSeq,
  );
  if (!state) {
    return null;
  }

  const total = state.sourceFollowerCount;
  const completed = status === "idle" && row.requestSeq === row.appliedSeq;
  const current = completed ? total : clampProgress(state.offset, total);

  return {
    label: labelWithTotal(current, total, "followers"),
    current,
    total,
    unit: "followers",
    percent: percent(current, total),
  };
}

function buildDmConversationProgress(
  row: SyncMonitorStreamRow,
  status: SyncMonitorStatus,
): SyncMonitorProgress | null {
  const state = parseDmConversationCursorState(row.checkpointState);
  if (!state) {
    return null;
  }

  const completed = status === "idle" && row.requestSeq === row.appliedSeq;
  const total = state.providerReportedTotal ?? (completed ? row.dmConversationCount : null);
  const current = completed
    ? (total ?? row.dmConversationCount)
    : clampProgress(state.offset, total);

  return {
    label: labelWithTotal(current, total, "conversations"),
    current,
    total,
    unit: "conversations",
    percent: percent(current, total),
  };
}

function buildDmMessagesProgress(row: SyncMonitorStreamRow): SyncMonitorProgress | null {
  const state = parseDmMessagesCursorState(row.checkpointState);
  const total = row.dmEligibleConversationCount;
  const current = row.dmBackfillCompleteConversationCount;
  const lagging = row.dmLaggingConversationCount;

  if (total === 0 && !state) {
    return null;
  }

  const baseLabel = total > 0
    ? labelWithTotal(current, total, "conversations", " backfilled")
    : "No eligible conversations";
  const labelParts = [baseLabel];
  if (lagging > 0) {
    labelParts.push(`${lagging.toLocaleString()} lagging`);
  }
  if (row.dmDeepBackfillPendingPageEstimate > 0) {
    labelParts.push(`${row.dmDeepBackfillPendingPageEstimate.toLocaleString()} deep pages`);
  }

  return {
    label: labelParts.join(", "),
    current,
    total: total || 0,
    unit: "conversations",
    percent: total > 0 ? percent(current, total) : null,
  };
}

function buildDmMessagesDeepBackfill(
  row: SyncMonitorStreamRow,
  status: SyncMonitorStatus,
  now: Date,
  enabled: boolean,
): SyncMonitorDeepBackfill | null {
  if (row.platform !== "fansly" || row.stream !== "dm_messages") {
    return null;
  }

  const state = parseDmMessagesCursorState(row.checkpointState);
  const active = status === "running" && state?.currentMode === "deep_backfill";
  const blockedOrWaiting = status === "blocked" ||
    status === "paused" ||
    status === "pending" ||
    status === "retrying" ||
    active;
  const lastCompletedAt = row.dmDeepBackfillLastCompletedAt;
  const fallbackProgressAt = latestSuccessTimestamp(row) ?? row.lastFinishedAt ?? row.requestedAt;
  const lastProgressAt = lastCompletedAt ?? fallbackProgressAt;
  const progressAgeMs = lastProgressAt ? now.getTime() - lastProgressAt.getTime() : null;
  const hasBacklog = row.dmDeepBackfillPendingPageEstimate > 0;
  const stalled = enabled &&
    hasBacklog &&
    !blockedOrWaiting &&
    (
      progressAgeMs === null ||
      progressAgeMs > DEEP_BACKFILL_STALLED_THRESHOLD_MS
    );

  return {
    pendingConversations: row.dmDeepBackfillPendingConversationCount,
    pendingPagesEstimate: row.dmDeepBackfillPendingPageEstimate,
    spenderPendingConversations: row.dmDeepBackfillSpenderPendingConversationCount,
    spenderPendingPagesEstimate: row.dmDeepBackfillSpenderPendingPageEstimate,
    regularPendingConversations: row.dmDeepBackfillRegularPendingConversationCount,
    regularPendingPagesEstimate: row.dmDeepBackfillRegularPendingPageEstimate,
    recentRequests: row.dmDeepBackfillRecentRequestCount,
    lastCompletedAt: iso(lastCompletedAt),
    liveRequestsSinceDeepBackfill: Math.max(
      0,
      Math.floor(state?.liveMessageRequestsSinceDeepBackfill ?? 0),
    ),
    active,
    stalled,
    stallReason: stalled
      ? lastCompletedAt
        ? "deep_progress_stale"
        : "no_deep_progress"
      : null,
  };
}

function buildTransactionsProgress(row: SyncMonitorStreamRow): SyncMonitorProgress | null {
  const backfill = parseTransactionBackfillState(row.checkpointState);
  if (!backfill) {
    return null;
  }

  const total = typeof backfill.providerReportedTotal === "number"
    ? Math.max(backfill.providerReportedTotal, 0)
    : null;
  const current = clampProgress(
    backfill.processedTransactions + backfill.processedChargebacks,
    total,
  );
  return {
    label: labelWithTotal(current, total, "items", " backfilled"),
    current,
    total,
    unit: "items",
    percent: percent(current, total),
  };
}

function progressFor(
  row: SyncMonitorStreamRow,
  status: SyncMonitorStatus,
): SyncMonitorProgress | null {
  switch (row.stream) {
    case "subscribers":
      return buildSubscribersProgress(row, status);
    case "followers":
      return buildFollowersProgress(row, status);
    case "followers_reconcile":
      return buildFollowersReconcileProgress(row, status);
    case "dm_conversations":
      return buildDmConversationProgress(row, status);
    case "dm_messages":
      return buildDmMessagesProgress(row);
    case "transactions":
      return buildTransactionsProgress(row);
    case "light":
    default:
      return null;
  }
}

function streamItemFor(
  row: SyncMonitorStreamRow,
  now: Date,
  options?: {
    deepBackfillEnabled?: boolean;
  },
): SyncMonitorStreamItem {
  const status = statusFor(row, now);
  const physicalFailed = row.stalePhysicalAttemptCount > 0 ||
    row.physicalAttemptsSinceLastSuccess >= 3;
  const stalled = isStalled(row, now) || physicalFailed;
  const pending = isPending(row);
  const retryAt = isRetrying(row, now) ? row.retryAt : null;
  const deepBackfill = buildDmMessagesDeepBackfill(
    row,
    status,
    now,
    options?.deepBackfillEnabled === true,
  );
  const item = {
    stream: row.stream,
    status,
    stalled,
    pending,
    retryAt: iso(retryAt),
    progress: progressFor(row, status),
    deepBackfill,
    recentRuns: recentRunsFor(row),
    recentErrors: recentErrorsFor(row),
    physicalHealth: {
      state: physicalFailed ? "failed" : "healthy",
      attempts24h: row.recentPhysicalAttemptCount,
      successes24h: row.recentPhysicalSuccessCount,
      attemptsSinceLastSuccess: row.physicalAttemptsSinceLastSuccess,
      staleAttempts: row.stalePhysicalAttemptCount,
      lastSuccessAt: iso(row.lastPhysicalSuccessAt),
    },
    rateHealth: rateHealthFor({
      total429s: row.recent429Count,
      last429At: row.last429At,
      nextAvailableAt: row.providerNextAvailableAt,
    }, now),
    activeRun: activeRunFor(row),
    lastCompletion: lastCompletionFor(row),
    succeededAt: iso(latestSuccessTimestamp(row)),
    failedAt: iso(failedTimestamp(row)),
    lastErrorSummary: row.lastErrorSummary ?? row.lastCompletedErrorSummary ?? (
      physicalFailed
        ? row.stalePhysicalAttemptCount > 0
          ? `${row.stalePhysicalAttemptCount} sync HTTP attempt(s) are stuck`
          : `${row.physicalAttemptsSinceLastSuccess} sync HTTP attempts completed without a success`
        : null
    ),
    consecutiveFailures: Math.max(
      row.consecutiveFailures,
      row.physicalAttemptsSinceLastSuccess,
    ),
  } satisfies Omit<SyncMonitorStreamItem, "syncUx">;
  const syncUxInput = {
    ...item,
    lastErrorCode: row.lastErrorCode,
    blockerKind: row.blockerKind,
    lastCompletionGatedSkipReason: gatedSkipReasonFor(row),
  };

  return {
    ...item,
    syncUx: buildStreamSyncUx(syncUxInput),
  };
}

export async function getPageStreamSyncUxByStream(
  app: AppContext,
  input: {
    pageId: number;
    streams: SyncStream[];
    windowHours?: number;
    now?: Date;
  },
) {
  if (input.streams.length === 0) {
    return new Map<SyncStream, SyncUxSummary>();
  }

  const now = input.now ?? new Date();
  const windowHours = input.windowHours ?? DEFAULT_WINDOW_HOURS;
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const rows = await listSyncMonitorStreamRows(app.db, {
    pageIds: [input.pageId],
    streams: input.streams,
    windowStart,
    now,
  });

  return new Map(
    rows.map((row) => {
      const stream = streamItemFor(row, now, {
        deepBackfillEnabled: app.config.fanslyDmDeepBackfillEnabled === true,
      });
      return [row.stream, stream.syncUx] satisfies [SyncStream, SyncUxSummary];
    }),
  );
}

function comparePages(a: SyncMonitorPageItem, b: SyncMonitorPageItem) {
  const score = (page: SyncMonitorPageItem) =>
    page.summary.stalledStreams * 1000 +
    page.summary.blockedStreams * 100 +
    page.summary.runningStreams * 10 +
    page.summary.pendingStreams * 5 +
    page.summary.retryingStreams;

  const diff = score(b) - score(a);
  if (diff !== 0) {
    return diff;
  }
  return a.pageLabel.localeCompare(b.pageLabel);
}

function eventItemFor(row: SyncMonitorRecentEventRow): SyncMonitorRecentEvent {
  return {
    id: row.id,
    runId: row.runId,
    pageId: row.pageId,
    pageLabel: row.pageLabel,
    platform: row.provider,
    stream: row.stream,
    eventType: row.eventType,
    severity: row.severity,
    message: row.message,
    details: row.details,
    emittedAt: row.emittedAt.toISOString(),
  };
}

function requestItemFor(
  row: Awaited<ReturnType<typeof listSyncMonitorRecentRequests>>[number],
  proxyGapMs: number | null,
): SyncMonitorRequestItem {
  const requestShape = asRecord(row.requestShape);

  return {
    timestamp: row.startedAt.toISOString(),
    pageLabel: row.pageLabel,
    platform: row.provider,
    stream: row.stream,
    operation: row.operation,
    endpoint: asNullableString(requestShape?.endpointTemplate) ?? "unknown",
    method: asNullableString(requestShape?.method) ?? "GET",
    attemptNumber: row.attemptNumber,
    status: row.state,
    httpStatusCode: row.httpStatus,
    durationMs: row.durationMs,
    rateLimitWaitMs: asNullableNumber(requestShape?.rateLimitWaitMs) ?? null,
    groupId: asNullableString(requestShape?.groupId),
    partnerUsername: row.partnerUsername,
    returnedItems: row.returnedItems,
    syncDone: row.syncDone,
    proxyGapMs,
  };
}

export async function getSyncMonitorSnapshot(
  app: AppContext,
  input?: {
    pageIds?: number[];
    pageLabel?: string;
    windowHours?: number;
    eventLimit?: number;
    now?: Date;
  },
): Promise<SyncMonitorSnapshot> {
  const now = input?.now ?? new Date();
  const windowHours = input?.windowHours ?? DEFAULT_WINDOW_HOURS;
  const eventLimit = input?.eventLimit ?? DEFAULT_EVENT_LIMIT;
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const [rows, events] = await Promise.all([
    listSyncMonitorStreamRows(app.db, {
      pageIds: input?.pageIds,
      pageLabel: input?.pageLabel,
      windowStart,
      now,
      streams: [...MONITORED_SYNC_STREAMS],
    }),
    listSyncMonitorRecentEvents(app.db, {
      pageIds: input?.pageIds,
      pageLabel: input?.pageLabel,
      since: windowStart,
      limit: eventLimit,
    }),
  ]);
  const monitorRows = rows.filter((row) => isRequestedStream(row.stream));
  const monitorEvents = events.filter((event) => isRequestedStream(event.stream));

  const pageMap = new Map<number, SyncMonitorPageItem>();
  for (const row of monitorRows) {
    const page = pageMap.get(row.pageId) ?? {
      pageId: row.pageId,
      pageLabel: row.pageLabel,
      platform: row.platform,
      modelSlug: row.modelSlug,
      modelName: row.modelName,
      username: row.username,
      displayName: row.displayName,
      counts: {
        fans: row.fanCount,
        followers: row.followerCount,
        subscribers: row.subscriberCount,
        transactions: row.transactionCount,
        conversations: row.dmConversationCount,
        messages: row.dmMessageCount,
      },
      summary: {
        runningStreams: 0,
        blockedStreams: 0,
        stalledStreams: 0,
        pendingStreams: 0,
        retryingStreams: 0,
      },
      streams: [],
      syncUx: buildPageSyncUx([]),
    };

    const stream = streamItemFor(row, now, {
      deepBackfillEnabled: app.config.fanslyDmDeepBackfillEnabled === true,
    });
    page.streams.push(stream);
    if (stream.status === "running") {
      page.summary.runningStreams += 1;
    }
    if (stream.status === "blocked") {
      page.summary.blockedStreams += 1;
    }
    if (stream.stalled) {
      page.summary.stalledStreams += 1;
    }
    if (stream.pending) {
      page.summary.pendingStreams += 1;
    }
    if (stream.retryAt) {
      page.summary.retryingStreams += 1;
    }

    pageMap.set(row.pageId, page);
  }

  const pages = Array.from(pageMap.values())
    .map((page) => ({
      ...page,
      // Decision #166, the same filter sync-summary applies: the bulk
      // enrichment streams keep their own honest entry in `page.streams`, but
      // they do not get a vote in the page verdict — and, through it, the fleet
      // verdict. Both ramp flags default to false, so without this every Fansly
      // page would read "Off" from its first daily run onwards.
      syncUx: buildPageSyncUx(
        page.streams
          .filter((stream) => !isBulkEnrichmentSyncStream(stream.stream))
          .map((stream) => stream.syncUx),
      ),
    }))
    .sort(comparePages);
  const visiblePageIds = pages.map((page) => page.pageId);
  const distinctFans = await countDistinctFansForPages(app.db, visiblePageIds);

  const overall = pages.reduce<SyncMonitorOverall>((acc, page) => {
    acc.pages += 1;
    acc.streams += page.streams.length;
    acc.runningStreams += page.summary.runningStreams;
    acc.blockedStreams += page.summary.blockedStreams;
    acc.stalledStreams += page.summary.stalledStreams;
    acc.pendingStreams += page.summary.pendingStreams;
    acc.retryingStreams += page.summary.retryingStreams;
    acc.counts.followers += page.counts.followers;
    acc.counts.subscribers += page.counts.subscribers;
    acc.counts.transactions += page.counts.transactions;
    acc.counts.conversations += page.counts.conversations;
    acc.counts.messages += page.counts.messages;
    for (const stream of page.streams) {
      acc.recentRuns.running += stream.recentRuns.running;
      acc.recentRuns.success += stream.recentRuns.success;
      acc.recentRuns.partial += stream.recentRuns.partial;
      acc.recentRuns.failed += stream.recentRuns.failed;
      acc.recentRuns.skipped += stream.recentRuns.skipped;
      acc.recentErrors.total429s += stream.recentErrors.total429s;
      acc.recentErrors.total5xxs += stream.recentErrors.total5xxs;
      acc.recentErrors.failedRuns += stream.recentErrors.failedRuns;
      acc.recentErrors.failedAttempts += stream.recentErrors.failedAttempts;
      acc.recentErrors.retryAttempts += stream.recentErrors.retryAttempts;
      const last429At = stream.recentErrors.last429At ? new Date(stream.recentErrors.last429At) : null;
      const last5xxAt = stream.recentErrors.last5xxAt ? new Date(stream.recentErrors.last5xxAt) : null;
      acc.recentErrors.last429At = iso(maxDate(
        acc.recentErrors.last429At ? new Date(acc.recentErrors.last429At) : null,
        last429At,
      ));
      acc.recentErrors.last5xxAt = iso(maxDate(
        acc.recentErrors.last5xxAt ? new Date(acc.recentErrors.last5xxAt) : null,
        last5xxAt,
      ));
    }
    return acc;
  }, {
    pages: 0,
    streams: 0,
    runningStreams: 0,
    blockedStreams: 0,
    stalledStreams: 0,
    pendingStreams: 0,
    retryingStreams: 0,
    counts: {
      fans: 0,
      followers: 0,
      subscribers: 0,
      transactions: 0,
      conversations: 0,
      messages: 0,
    },
    recentRuns: {
      running: 0,
      success: 0,
      partial: 0,
      failed: 0,
      skipped: 0,
    },
    recentErrors: {
      total429s: 0,
      total5xxs: 0,
      failedRuns: 0,
      failedAttempts: 0,
      retryAttempts: 0,
      last429At: null,
      last5xxAt: null,
    },
    providers: [],
    syncUx: buildOverallSyncUx([]),
  });
  overall.counts.fans = distinctFans;

  const providerMap = new Map<"fansly" | "onlyfans", {
    total429s: number;
    total5xxs: number;
    last429At: Date | null;
    nextAvailableAt: Date | null;
  }>();
  for (const row of monitorRows) {
    const provider = providerMap.get(row.platform) ?? {
      total429s: 0,
      total5xxs: 0,
      last429At: null,
      nextAvailableAt: null,
    };
    provider.total429s += row.recent429Count;
    provider.total5xxs += row.recent5xxCount;
    provider.last429At = maxDate(provider.last429At, row.last429At);
    provider.nextAvailableAt = maxDate(provider.nextAvailableAt, row.providerNextAvailableAt);
    providerMap.set(row.platform, provider);
  }

  overall.providers = (["fansly", "onlyfans"] as const)
    .filter((platform) => providerMap.has(platform))
    .map((platform) => {
      const provider = providerMap.get(platform)!;
      return {
        platform,
        rateHealth: rateHealthFor(provider, now),
        recent429s: provider.total429s,
        recent5xxs: provider.total5xxs,
      };
    });
  overall.syncUx = buildOverallSyncUx(pages.map((page) => page.syncUx));

  return {
    generatedAt: now.toISOString(),
    window: {
      hours: windowHours,
      startedAt: windowStart.toISOString(),
    },
    overall,
    pages,
    recentEvents: monitorEvents.map((event) => eventItemFor(event)),
  };
}

export async function getSyncMonitorRecentRequests(
  app: AppContext,
  input?: {
    pageIds?: number[];
    since?: string;
    limit?: number;
    now?: Date;
  },
): Promise<SyncMonitorRequestItem[]> {
  const now = input?.now ?? new Date();
  const since = parseOptionalTimestamp(input?.since, "since") ??
    new Date(now.getTime() - DEFAULT_REQUEST_LOOKBACK_MS);
  const limit = Math.min(input?.limit ?? DEFAULT_REQUEST_LIMIT, MAX_REQUEST_LIMIT);

  const rows = await listSyncMonitorRecentRequests(app.db, {
    pageIds: input?.pageIds,
    since,
    limit,
  });
  const previousRequestAtByEgressKey = new Map<string, Date>();
  return rows
    .filter((row) => isRequestedStream(row.stream))
    .map((row) => {
    const requestShape = asRecord(row.requestShape);
    const egressKey = asNullableString(requestShape?.egressKey);
    const previousRequestAt = egressKey ? previousRequestAtByEgressKey.get(egressKey) ?? null : null;
    const proxyGapMs = previousRequestAt
      ? Math.max(0, previousRequestAt.getTime() - row.startedAt.getTime())
      : null;

    if (egressKey) {
      previousRequestAtByEgressKey.set(egressKey, row.startedAt);
    }

      return requestItemFor(row, proxyGapMs);
    });
}
