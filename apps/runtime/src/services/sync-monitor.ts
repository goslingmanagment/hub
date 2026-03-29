import {
  countDistinctFansForPages,
  listSyncMonitorRecentEvents,
  listSyncMonitorRecentRequests,
  listSyncMonitorStreamRows,
  type SyncAuditStream,
  type SyncControlStream,
  type SyncMonitorRecentEventRow,
  type SyncMonitorStreamRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError } from "./errors.ts";
import { parseTransactionBackfillState } from "./sync/transaction-backfill.ts";
import { buildOverallSyncUx, buildPageSyncUx, buildStreamSyncUx } from "./sync-ux.ts";
import type { SyncUxSummary } from "@agency_hub_core/contracts";

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_EVENT_LIMIT = 50;
const DEFAULT_REQUEST_LOOKBACK_MS = 60_000;
const DEFAULT_REQUEST_LIMIT = 100;
const MAX_REQUEST_LIMIT = 500;
const STALLED_THRESHOLD_MS = 45_000;
const RATE_LIMITED_LOOKBACK_MS = 15 * 60 * 1000;
const LEGACY_SYNC_MONITOR_STREAMS = [
  "light",
  "followers",
  "transactions",
  "subscribers",
  "dm_conversations",
  "dm_messages",
  "followers_reconcile",
] as const satisfies readonly SyncControlStream[];
const LEGACY_SYNC_REQUEST_STREAMS = [
  ...LEGACY_SYNC_MONITOR_STREAMS,
  "cleanup",
] as const satisfies readonly SyncAuditStream[];
type LegacySyncMonitorStream = typeof LEGACY_SYNC_MONITOR_STREAMS[number];
type LegacySyncRequestStream = typeof LEGACY_SYNC_REQUEST_STREAMS[number];

function isLegacySyncMonitorStream(stream: SyncControlStream): stream is LegacySyncMonitorStream {
  return (LEGACY_SYNC_MONITOR_STREAMS as readonly string[]).includes(stream);
}

function isLegacySyncRequestStream(stream: SyncAuditStream): stream is LegacySyncRequestStream {
  return (LEGACY_SYNC_REQUEST_STREAMS as readonly string[]).includes(stream);
}

export type SyncMonitorStatus =
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "paused"
  | "auth_failed"
  | "disabled";

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

export interface SyncMonitorStreamItem {
  stream: SyncControlStream;
  status: SyncMonitorStatus;
  stalled: boolean;
  pending: boolean;
  backoffUntil: string | null;
  progress: SyncMonitorProgress | null;
  recentRuns: SyncMonitorRecentRuns;
  recentErrors: SyncMonitorRecentErrors;
  rateHealth: SyncMonitorRateHealth;
  activeRun: SyncMonitorActiveRun | null;
  lastCompletion: SyncMonitorLastCompletion | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
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
  failedStreams: number;
  stalledStreams: number;
  pendingStreams: number;
  backoffStreams: number;
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
  failedStreams: number;
  stalledStreams: number;
  pendingStreams: number;
  backoffStreams: number;
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
  stream: SyncControlStream;
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
  stream: SyncAuditStream;
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

type SubscribersCheckpointState = {
  revision: number;
  generation: number;
  offset: number;
  pageCount: number;
  providerReportedTotal: number | null;
};

type FollowersCheckpointState = {
  revision: number;
  knownFollowId: string | null;
  newestFollowId: string | null;
  offset: number;
  pageCount: number;
  sourceFollowerCount: number;
};

type FollowersReconcileCheckpointState = {
  revision: number;
  generation: number;
  offset: number;
  pageCount: number;
  sourceFollowerCount: number;
};

type DmConversationCheckpointState = {
  version: 1;
  mode: "full_scan";
  generation: number;
  offset: number;
  pageCount: number;
  providerReportedTotal: number | null;
  unchangedPageStreak: number;
  fullSweepStartedAt: string;
  lastFullSweepCompletedAt: string | null;
};

type DmMessagesCheckpointState = {
  version: 1;
  currentConversationId: number | null;
  currentPlatformConversationId: string | null;
  currentBeforeMessageId: string | null;
  currentMode: "backfill" | "incremental" | null;
};

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

function parseSubscribersCheckpointState(
  value: unknown,
  revision: number | null,
): SubscribersCheckpointState | null {
  if (revision === null) {
    return null;
  }

  const state = asRecord(value);
  if (!state || asNumber(state.revision) !== revision) {
    return null;
  }

  const generation = asNumber(state.generation);
  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const providerReportedTotal = asNullableNumber(state.providerReportedTotal);
  if (
    generation === null ||
    offset === null ||
    pageCount === null ||
    providerReportedTotal === undefined
  ) {
    return null;
  }

  return {
    revision,
    generation,
    offset,
    pageCount,
    providerReportedTotal,
  };
}

function parseFollowersCheckpointState(
  value: unknown,
  revision: number | null,
): FollowersCheckpointState | null {
  if (revision === null) {
    return null;
  }

  const state = asRecord(value);
  if (!state || asNumber(state.revision) !== revision) {
    return null;
  }

  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const sourceFollowerCount = asNumber(state.sourceFollowerCount);
  const knownFollowId = asNullableString(state.knownFollowId);
  const newestFollowId = asNullableString(state.newestFollowId);
  if (
    offset === null ||
    pageCount === null ||
    sourceFollowerCount === null ||
    knownFollowId === undefined ||
    newestFollowId === undefined
  ) {
    return null;
  }

  return {
    revision,
    knownFollowId,
    newestFollowId,
    offset,
    pageCount,
    sourceFollowerCount,
  };
}

function parseFollowersReconcileCheckpointState(
  value: unknown,
  revision: number | null,
): FollowersReconcileCheckpointState | null {
  if (revision === null) {
    return null;
  }

  const state = asRecord(value);
  if (!state || asNumber(state.revision) !== revision) {
    return null;
  }

  const generation = asNumber(state.generation);
  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const sourceFollowerCount = asNumber(state.sourceFollowerCount);
  if (
    generation === null ||
    offset === null ||
    pageCount === null ||
    sourceFollowerCount === null
  ) {
    return null;
  }

  return {
    revision,
    generation,
    offset,
    pageCount,
    sourceFollowerCount,
  };
}

function parseDmConversationCheckpointState(value: unknown) {
  const state = asRecord(value);
  if (!state || asNumber(state.version) !== 1 || state.mode !== "full_scan") {
    return null;
  }

  const generation = asNumber(state.generation);
  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const providerReportedTotal = asNullableNumber(state.providerReportedTotal);
  const unchangedPageStreak = asNumber(state.unchangedPageStreak);
  const fullSweepStartedAt = asNullableString(state.fullSweepStartedAt);
  const lastFullSweepCompletedAt = asNullableString(state.lastFullSweepCompletedAt);
  if (
    generation === null ||
    offset === null ||
    pageCount === null ||
    providerReportedTotal === undefined ||
    unchangedPageStreak === null ||
    !fullSweepStartedAt
  ) {
    return null;
  }

  return {
    version: 1 as const,
    mode: "full_scan" as const,
    generation,
    offset,
    pageCount,
    providerReportedTotal,
    unchangedPageStreak,
    fullSweepStartedAt,
    lastFullSweepCompletedAt,
  } satisfies DmConversationCheckpointState;
}

function parseDmMessagesCheckpointState(value: unknown) {
  const state = asRecord(value);
  if (!state || asNumber(state.version) !== 1) {
    return null;
  }

  const currentConversationId = state.currentConversationId === null
    ? null
    : asNumber(state.currentConversationId);
  const currentPlatformConversationId = asNullableString(state.currentPlatformConversationId);
  const currentBeforeMessageId = asNullableString(state.currentBeforeMessageId);
  const currentMode = state.currentMode === "backfill" || state.currentMode === "incremental"
    ? state.currentMode
    : state.currentMode === null || state.currentMode === undefined
      ? null
      : undefined;

  if (
    currentConversationId === undefined ||
    currentPlatformConversationId === undefined ||
    currentBeforeMessageId === undefined ||
    currentMode === undefined
  ) {
    return null;
  }

  return {
    version: 1 as const,
    currentConversationId,
    currentPlatformConversationId,
    currentBeforeMessageId,
    currentMode,
  } satisfies DmMessagesCheckpointState;
}

function isRunning(row: SyncMonitorStreamRow) {
  return row.runningRunId !== null;
}

function isPending(row: SyncMonitorStreamRow) {
  if (row.targetStatus !== "active") {
    return false;
  }
  if (row.desiredRevision === null || row.satisfiedRevision === null) {
    return false;
  }
  return row.desiredRevision > row.satisfiedRevision && !isRunning(row);
}

function isBackoff(row: SyncMonitorStreamRow, now: Date) {
  return row.targetStatus === "active" &&
    row.backoffUntil !== null &&
    row.backoffUntil.getTime() > now.getTime();
}

function isStalled(row: SyncMonitorStreamRow, now: Date) {
  if (!row.runningLastActivityAt) {
    return false;
  }
  return now.getTime() - row.runningLastActivityAt.getTime() > STALLED_THRESHOLD_MS;
}

function lastSuccessAt(row: SyncMonitorStreamRow) {
  return maxDate(row.checkpointLastSuccessfulAt, row.lastSucceededAt);
}

function lastFailureAt(row: SyncMonitorStreamRow) {
  return row.lastFailedAt;
}

function statusFor(row: SyncMonitorStreamRow, now: Date): SyncMonitorStatus {
  if (row.targetStatus === "paused" || row.targetStatus === "auth_failed" || row.targetStatus === "disabled") {
    return row.targetStatus;
  }

  if (isRunning(row)) {
    return "running";
  }

  const successAt = lastSuccessAt(row);
  const failureAt = lastFailureAt(row);
  if (
    failureAt &&
    (!successAt || failureAt.getTime() > successAt.getTime() || row.lastCompletedStatus === "failed")
  ) {
    return "failed";
  }

  if (successAt && !isPending(row) && !isBackoff(row, now)) {
    return "completed";
  }

  if (row.lastCompletedStatus === "failed") {
    return "failed";
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
  const state = parseSubscribersCheckpointState(
    row.checkpointState,
    row.desiredRevision ?? row.satisfiedRevision,
  );
  if (!state) {
    return null;
  }

  const total = state.providerReportedTotal ?? (status === "completed" ? row.subscriberCount : null);
  const current = status === "completed"
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
  const state = parseFollowersCheckpointState(
    row.checkpointState,
    row.desiredRevision ?? row.satisfiedRevision,
  );
  if (!state) {
    return null;
  }

  const total = state.sourceFollowerCount;
  const current = status === "completed" ? total : clampProgress(state.offset, total);

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
  const state = parseFollowersReconcileCheckpointState(
    row.checkpointState,
    row.desiredRevision ?? row.satisfiedRevision,
  );
  if (!state) {
    return null;
  }

  const total = state.sourceFollowerCount;
  const current = status === "completed" ? total : clampProgress(state.offset, total);

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
  const state = parseDmConversationCheckpointState(row.checkpointState);
  if (!state) {
    return null;
  }

  const total = state.providerReportedTotal ?? (status === "completed" ? row.dmConversationCount : null);
  const current = status === "completed"
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
  const state = parseDmMessagesCheckpointState(row.checkpointState);
  const total = row.dmEligibleConversationCount;
  const current = row.dmBackfillCompleteConversationCount;
  const lagging = row.dmLaggingConversationCount;

  if (total === 0 && !state) {
    return null;
  }

  const baseLabel = total > 0
    ? labelWithTotal(current, total, "conversations", " backfilled")
    : "No eligible conversations";
  const label = lagging > 0 ? `${baseLabel}, ${lagging.toLocaleString()} lagging` : baseLabel;

  return {
    label,
    current,
    total: total || 0,
    unit: "conversations",
    percent: total > 0 ? percent(current, total) : null,
  };
}

function buildTransactionsProgress(row: SyncMonitorStreamRow): SyncMonitorProgress | null {
  const backfill = parseTransactionBackfillState(row.checkpointState);
  if (!backfill) {
    return null;
  }

  const current = backfill.processedTransactions + backfill.processedChargebacks;
  return {
    label: `${current.toLocaleString()} items backfilled`,
    current,
    total: null,
    unit: "items",
    percent: null,
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

function streamItemFor(row: SyncMonitorStreamRow, now: Date): SyncMonitorStreamItem {
  const status = statusFor(row, now);
  const stalled = isStalled(row, now);
  const pending = isPending(row);
  const backoffUntil = isBackoff(row, now) ? row.backoffUntil : null;
  const item = {
    stream: row.stream,
    status,
    stalled,
    pending,
    backoffUntil: iso(backoffUntil),
    progress: progressFor(row, status),
    recentRuns: recentRunsFor(row),
    recentErrors: recentErrorsFor(row),
    rateHealth: rateHealthFor({
      total429s: row.recent429Count,
      last429At: row.last429At,
      nextAvailableAt: row.providerNextAvailableAt,
    }, now),
    activeRun: activeRunFor(row),
    lastCompletion: lastCompletionFor(row),
    lastSuccessAt: iso(lastSuccessAt(row)),
    lastFailureAt: iso(lastFailureAt(row)),
    lastErrorSummary: row.lastErrorSummary ?? row.lastCompletedErrorSummary,
    consecutiveFailures: row.consecutiveFailures,
  } satisfies Omit<SyncMonitorStreamItem, "syncUx">;
  const syncUxInput = {
    ...item,
    lastErrorCode: row.lastErrorCode,
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
    streams: SyncControlStream[];
    windowHours?: number;
    now?: Date;
  },
) {
  if (input.streams.length === 0) {
    return new Map<SyncControlStream, SyncUxSummary>();
  }

  const now = input.now ?? new Date();
  const windowHours = input.windowHours ?? DEFAULT_WINDOW_HOURS;
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const rows = await listSyncMonitorStreamRows(app.db, {
    pageIds: [input.pageId],
    streams: input.streams,
    windowStart,
  });

  return new Map(
    rows.map((row) => {
      const stream = streamItemFor(row, now);
      return [row.stream, stream.syncUx] satisfies [SyncControlStream, SyncUxSummary];
    }),
  );
}

function comparePages(a: SyncMonitorPageItem, b: SyncMonitorPageItem) {
  const score = (page: SyncMonitorPageItem) =>
    page.summary.stalledStreams * 1000 +
    page.summary.failedStreams * 100 +
    page.summary.runningStreams * 10 +
    page.summary.pendingStreams * 5 +
    page.summary.backoffStreams;

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
      streams: [...LEGACY_SYNC_MONITOR_STREAMS],
    }),
    listSyncMonitorRecentEvents(app.db, {
      pageIds: input?.pageIds,
      pageLabel: input?.pageLabel,
      since: windowStart,
      limit: eventLimit,
    }),
  ]);
  const legacyRows = rows.filter((row): row is SyncMonitorStreamRow & { stream: LegacySyncMonitorStream } =>
    isLegacySyncMonitorStream(row.stream)
  );
  const legacyEvents = events.filter(
    (event): event is SyncMonitorRecentEventRow & { stream: LegacySyncRequestStream } =>
      isLegacySyncRequestStream(event.stream),
  );

  const pageMap = new Map<number, SyncMonitorPageItem>();
  for (const row of legacyRows) {
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
        failedStreams: 0,
        stalledStreams: 0,
        pendingStreams: 0,
        backoffStreams: 0,
      },
      streams: [],
      syncUx: buildPageSyncUx([]),
    };

    const stream = streamItemFor(row, now);
    page.streams.push(stream);
    if (stream.status === "running") {
      page.summary.runningStreams += 1;
    }
    if (stream.status === "failed" || stream.status === "auth_failed") {
      page.summary.failedStreams += 1;
    }
    if (stream.stalled) {
      page.summary.stalledStreams += 1;
    }
    if (stream.pending) {
      page.summary.pendingStreams += 1;
    }
    if (stream.backoffUntil) {
      page.summary.backoffStreams += 1;
    }

    pageMap.set(row.pageId, page);
  }

  const pages = Array.from(pageMap.values())
    .map((page) => ({
      ...page,
      syncUx: buildPageSyncUx(page.streams.map((stream) => stream.syncUx)),
    }))
    .sort(comparePages);
  const visiblePageIds = pages.map((page) => page.pageId);
  const distinctFans = await countDistinctFansForPages(app.db, visiblePageIds);

  const overall = pages.reduce<SyncMonitorOverall>((acc, page) => {
    acc.pages += 1;
    acc.streams += page.streams.length;
    acc.runningStreams += page.summary.runningStreams;
    acc.failedStreams += page.summary.failedStreams;
    acc.stalledStreams += page.summary.stalledStreams;
    acc.pendingStreams += page.summary.pendingStreams;
    acc.backoffStreams += page.summary.backoffStreams;
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
    failedStreams: 0,
    stalledStreams: 0,
    pendingStreams: 0,
    backoffStreams: 0,
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
  for (const row of legacyRows) {
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
    recentEvents: legacyEvents.map((event) => eventItemFor(event)),
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
  const legacyRows = rows.filter((row): row is typeof row & { stream: LegacySyncRequestStream } =>
    isLegacySyncRequestStream(row.stream)
  );

  const previousRequestAtByEgressKey = new Map<string, Date>();
  return legacyRows.map((row) => {
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
