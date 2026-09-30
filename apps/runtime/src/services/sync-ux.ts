import type { SyncUxSummary } from "@agency_hub_core/contracts";
import type { SyncStream } from "@agency_hub_core/db";

type SyncUxState = SyncUxSummary["state"];

/** Stage 16 bulk enrichment streams (decision #166). They stay VISIBLE with
 *  their own honest per-stream state on the detailed monitor, but they must
 *  never dominate a page or fleet rollup: both ramp flags default to false, so
 *  letting a gated bulk stream vote would make every Fansly page — and the
 *  whole fleet — read "Off" forever on a default configuration. Shared by every
 *  rollup site so the filters cannot drift apart. */
export const BULK_ENRICHMENT_SYNC_STREAMS: readonly SyncStream[] = [
  "fan_earnings",
  "purchase_history",
  // WP-F1: same reasoning, same default. `fanslyStatsSnapshotSyncEnabled`
  // defaults false, so letting this lane vote would make every Fansly page —
  // and the fleet — read "Off" from the deploy that ships it.
  "stats_snapshot",
  // WP-F2: same default, same consequence.
  "notifications",
  // WP-F3: same default, same consequence.
  "catalog",
  // WP-F5: same default, same consequence.
  "post_replies",
  // WP-F7: same default, same consequence.
  "payouts",
  // WP-F4: same default, same consequence.
  "media_stats",
];

export function isBulkEnrichmentSyncStream(stream: string) {
  return (BULK_ENRICHMENT_SYNC_STREAMS as readonly string[]).includes(stream);
}

type SyncMonitorStatus =
  | "idle"
  | "pending"
  | "running"
  | "retrying"
  | "blocked"
  | "paused"

type SyncMonitorRateHealthState = "healthy" | "warning" | "limited";

export interface SyncUxStreamLike {
  stream: string;
  status: SyncMonitorStatus;
  stalled: boolean;
  pending: boolean;
  retryAt: string | null;
  progress: { label: string } | null;
  recentErrors: {
    total429s: number;
    total5xxs: number;
    failedRuns: number;
    failedAttempts: number;
    retryAttempts: number;
  };
  rateHealth: {
    state: SyncMonitorRateHealthState;
    nextAvailableAt: string | null;
  };
  activeRun: {
    startedAt: string;
    lastActivityAt: string;
  } | null;
  lastCompletion: {
    status: "success" | "partial" | "failed" | "skipped";
    finishedAt: string;
  } | null;
  /** The ramp-gate reason recorded by the last completed run (`stats.gatedSkip`),
   *  when that run was a gate skip. This is what "gated off" is keyed on, NOT
   *  the `skipped` outcome: `skipped` is also written by recordSkipped whenever
   *  a worker loses its lease, which happens to perfectly healthy streams. Such
   *  a run can even carry a LATER finished_at than the replacement run that
   *  succeeded, so keying the state on the outcome alone would report a working
   *  stream as gated off until its next run lands — hours, on a daily cadence. */
  lastCompletionGatedSkipReason?: string | null;
  /** Durable checkpoint hold, independent of the latest run's outcome. */
  lastCompletionQualityHold?: string | null;
  /** The end of a policy interval an outstanding request waits out (the daily
   *  followers_reconcile floor). Scheduled work, not a queue or a retry. */
  intervalFloorUntil?: string | null;
  succeededAt: string | null;
  failedAt: string | null;
  lastErrorCode?: string | null;
  blockerKind?: string | null;
  lastErrorSummary: string | null;
  consecutiveFailures: number;
}

export interface SyncUxPageLike {
  syncUx: SyncUxSummary;
}

function buildSummary(
  state: SyncUxState,
  input: {
    label: string;
    headline: string;
    detail?: string | null;
    progressLabel?: string | null;
    nextRetryAt?: string | null;
    updatedAt?: string | null;
    requiresAction?: boolean;
  },
): SyncUxSummary {
  return {
    state,
    label: input.label,
    headline: input.headline,
    detail: input.detail ?? null,
    progressLabel: input.progressLabel ?? null,
    nextRetryAt: input.nextRetryAt ?? null,
    updatedAt: input.updatedAt ?? null,
    requiresAction: input.requiresAction ?? false,
  };
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function latestTimestamp(values: Array<string | null | undefined>) {
  let latest: string | null = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (!latest || new Date(value).getTime() > new Date(latest).getTime()) {
      latest = value;
    }
  }

  return latest;
}

function earliestTimestamp(values: Array<string | null | undefined>) {
  let earliest: string | null = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (!earliest || new Date(value).getTime() < new Date(earliest).getTime()) {
      earliest = value;
    }
  }

  return earliest;
}

function firstProgressLabel(values: Array<{ progressLabel: string | null }>) {
  return values.find((value) => value.progressLabel)?.progressLabel ?? null;
}

export function buildStreamSyncUx(stream: SyncUxStreamLike): SyncUxSummary {
  const updatedAt = latestTimestamp([
    stream.activeRun?.lastActivityAt ?? null,
    stream.failedAt,
    stream.succeededAt,
    stream.lastCompletion?.finishedAt ?? null,
  ]);
  const progressLabel = stream.progress?.label ?? null;
  const hasSuccessfulSync = stream.succeededAt !== null || stream.lastCompletion?.status === "success";
  const hasCompletedRun = stream.lastCompletion !== null;
  const repeatedFailures = stream.consecutiveFailures >= 3 ||
    stream.recentErrors.failedRuns >= 3 ||
    stream.recentErrors.failedAttempts >= 3;
  const hasRateLimitFailureEvidence = stream.lastErrorCode === "http_429" || stream.recentErrors.total429s > 0;
  const hasNonRateLimitFailureEvidence = (
    stream.lastErrorCode !== null &&
    stream.lastErrorCode !== undefined &&
    stream.lastErrorCode !== "http_429"
  ) || stream.recentErrors.total5xxs > 0;

  if (stream.status === "paused") {
    return buildSummary("off", {
      label: "Paused",
      headline: "Sync is paused",
      detail: "This sync is paused.",
      updatedAt,
    });
  }

  if (stream.status === "blocked" && stream.blockerKind === "auth") {
    return buildSummary("attention", {
      label: "Reconnect",
      headline: "Reconnect to resume sync",
      detail: "Fresh credentials are required before this sync can continue.",
      progressLabel,
      updatedAt,
      requiresAction: true,
    });
  }

  if (stream.status === "blocked") {
    return buildSummary("attention", {
      label: "Attention",
      headline: "Sync needs attention",
      detail: stream.lastErrorSummary ?? "This sync is blocked until the issue is cleared.",
      progressLabel,
      updatedAt,
    });
  }

  if (stream.stalled) {
    return buildSummary("attention", {
      label: "Attention",
      headline: "Sync needs attention",
      detail: "This sync stopped making progress and needs the worker to recover.",
      progressLabel,
      updatedAt,
    });
  }

  if (stream.activeRun) {
    return buildSummary("syncing", {
      label: "Syncing",
      headline: "Syncing now",
      detail: "This sync is actively processing new work.",
      progressLabel,
      updatedAt: stream.activeRun.lastActivityAt,
    });
  }

  if (stream.intervalFloorUntil) {
    // The held request would only refresh data that is already current.
    return buildSummary("healthy", {
      label: "Up to date",
      headline: "Up to date",
      detail: "The next full check is scheduled; it runs at most once a day.",
      progressLabel,
      updatedAt,
    });
  }

  if (stream.retryAt) {
    if (repeatedFailures && (hasNonRateLimitFailureEvidence || !hasRateLimitFailureEvidence)) {
      return buildSummary("attention", {
        label: "Attention",
        headline: "Sync needs attention",
        detail: stream.lastErrorSummary ?? "Repeated sync failures are blocking progress.",
        progressLabel,
        nextRetryAt: stream.retryAt,
        updatedAt,
      });
    }

    const slowedByRateLimit = stream.rateHealth.state === "limited" && hasRateLimitFailureEvidence;
    return buildSummary("retrying", {
      label: "Retrying",
      headline: "Retrying automatically",
      detail: slowedByRateLimit
        ? "Rate limits slowed this sync. It will resume automatically."
        : "A temporary sync issue occurred. It will retry automatically.",
      progressLabel,
      nextRetryAt: stream.retryAt,
      updatedAt,
    });
  }

  if (stream.pending) {
    if (!hasSuccessfulSync && !hasCompletedRun) {
      return buildSummary("setup", {
        label: "Setting up",
        headline: "Preparing first sync",
        detail: "This sync is building the first local snapshot.",
        progressLabel,
        updatedAt,
      });
    }

    return buildSummary("catching_up", {
      label: "Catching up",
      headline: "Queued to continue",
      detail: "More work is queued and will resume from the last safe checkpoint.",
      progressLabel,
      updatedAt,
    });
  }

  if (stream.lastCompletionQualityHold) {
    return buildSummary("attention", {
      label: "Unverified",
      headline: "Audience data could not be verified",
      detail: "The latest sweep returned no subscribers. Existing data is preserved until the next verified sweep.",
      progressLabel,
      updatedAt,
    });
  }

  if (!hasSuccessfulSync && !hasCompletedRun) {
    return buildSummary("setup", {
      label: "Setting up",
      headline: "Preparing first sync",
      detail: "This sync is waiting for its first successful run.",
      progressLabel,
      updatedAt,
    });
  }

  if (stream.lastCompletion?.status === "partial") {
    return buildSummary("catching_up", {
      label: "Catching up",
      headline: "Queued to continue",
      detail: "This sync will resume from the last safe checkpoint.",
      progressLabel,
      updatedAt,
    });
  }

  if (stream.lastCompletion?.status === "skipped" && stream.lastCompletionGatedSkipReason) {
    // A ramp-gated run did no work. Falling through to "healthy" printed
    // "Up to date" over a stream whose feed was gated off for 13 days: the
    // stale succeeded_at kept hasSuccessfulSync true (see the const above),
    // and nothing else on this row disagreed.
    //
    // The gate reason, not the `skipped` outcome, is the condition. A run
    // skipped because its worker lost the lease is not gated off and must keep
    // falling through to the state the rest of the row describes.
    return buildSummary("off", {
      label: "Not updating",
      headline: "Not updating",
      detail: "This sync is gated off and is not fetching new data.",
      progressLabel,
      updatedAt,
    });
  }

  return buildSummary("healthy", {
    label: "Up to date",
    headline: "Up to date",
    detail: "This sync is current.",
    progressLabel,
    updatedAt,
  });
}

function chooseSummary(
  state: SyncUxState,
  items: SyncUxSummary[],
  input: {
    label: string;
    headline: string;
    detail: string;
  },
) {
  return buildSummary(state, {
    label: input.label,
    headline: input.headline,
    detail: input.detail,
    progressLabel: firstProgressLabel(items),
    nextRetryAt: earliestTimestamp(items.map((item) => item.nextRetryAt)),
    updatedAt: latestTimestamp(items.map((item) => item.updatedAt)),
    requiresAction: items.some((item) => item.requiresAction),
  });
}

export function buildPageSyncUx(items: SyncUxSummary[]): SyncUxSummary {
  if (items.length === 0) {
    return buildSummary("setup", {
      label: "Setting up",
      headline: "Preparing first sync",
      detail: "This page has not started syncing yet.",
      updatedAt: null,
    });
  }

  const attention = items.filter((item) => item.state === "attention");
  if (attention.length > 0) {
    if (attention.every((item) => item.label === "Unverified")) {
      return chooseSummary("attention", attention, {
        label: "Unverified",
        headline: "Audience data could not be verified",
        detail: "Existing subscriber data is preserved until the next verified sweep.",
      });
    }
    const requiresAction = attention.some((item) => item.requiresAction);
    return chooseSummary("attention", attention, requiresAction
      ? {
        label: "Reconnect",
        headline: "Reconnect to resume sync",
        detail: "One or more syncs are blocked until credentials are updated.",
      }
      : {
        label: "Needs attention",
        headline: "Sync needs attention",
        detail: "One or more syncs need help before they can catch up.",
      });
  }

  const off = items.filter((item) => item.state === "off");
  if (off.length > 0) {
    return chooseSummary("off", off, off.length === items.length
      ? {
        label: "Off",
        headline: "Data updates are paused",
        detail: "All background syncs are off for this page.",
      }
      : {
        label: "Off",
        headline: "Some data updates are paused",
        detail: `${pluralize(off.length, "sync")} are paused on this page.`,
      });
  }

  const syncing = items.filter((item) => item.state === "syncing");
  if (syncing.length > 0) {
    return chooseSummary("syncing", syncing, {
      label: "Syncing",
      headline: "Syncing now",
      detail: `${pluralize(syncing.length, "sync")} actively running.`,
    });
  }

  const retrying = items.filter((item) => item.state === "retrying");
  if (retrying.length > 0) {
    return chooseSummary("retrying", retrying, {
      label: "Retrying",
      headline: "Retrying automatically",
      detail: `${pluralize(retrying.length, "sync")} will resume automatically.`,
    });
  }

  const catchingUp = items.filter((item) => item.state === "catching_up");
  if (catchingUp.length > 0) {
    return chooseSummary("catching_up", catchingUp, {
      label: "Catching up",
      headline: "Queued to continue",
      detail: `${pluralize(catchingUp.length, "sync")} still catching up.`,
    });
  }

  const setup = items.filter((item) => item.state === "setup");
  if (setup.length > 0) {
    return chooseSummary("setup", setup, {
      label: "Setting up",
      headline: "Preparing first sync",
      detail: `${pluralize(setup.length, "sync")} still preparing local data.`,
    });
  }

  return chooseSummary("healthy", items, {
    label: "Up to date",
    headline: "Up to date",
    detail: "All page syncs are current.",
  });
}

export function buildOverallSyncUx(items: SyncUxSummary[]): SyncUxSummary {
  if (items.length === 0) {
    return buildSummary("setup", {
      label: "Set up sync",
      headline: "Add a page to start syncing",
      detail: "Sync status will appear once a page is connected.",
      updatedAt: null,
    });
  }

  const attention = items.filter((item) => item.state === "attention");
  if (attention.length > 0) {
    const requiresAction = attention.some((item) => item.requiresAction);
    return chooseSummary("attention", attention, requiresAction
      ? {
        label: "Reconnect",
        headline: "Reconnect to resume sync",
        detail: `${pluralize(attention.length, "page")} need fresh credentials or manual attention.`,
      }
      : {
        label: "Needs attention",
        headline: "Sync needs attention",
        detail: `${pluralize(attention.length, "page")} need help before they can catch up.`,
      });
  }

  const off = items.filter((item) => item.state === "off");
  if (off.length > 0) {
    return chooseSummary("off", off, off.length === items.length
      ? {
        label: "Off",
        headline: "Sync is off",
        detail: "All background syncs are currently off.",
      }
      : {
        label: "Off",
        headline: "Some syncs are off",
        detail: `${pluralize(off.length, "page")} have paused syncs.`,
      });
  }

  const syncing = items.filter((item) => item.state === "syncing");
  if (syncing.length > 0) {
    return chooseSummary("syncing", syncing, {
      label: "Syncing",
      headline: "Syncing now",
      detail: `${pluralize(syncing.length, "page")} actively syncing.`,
    });
  }

  const retrying = items.filter((item) => item.state === "retrying");
  if (retrying.length > 0) {
    return chooseSummary("retrying", retrying, {
      label: "Retrying",
      headline: "Retrying automatically",
      detail: `${pluralize(retrying.length, "page")} will resume automatically.`,
    });
  }

  const catchingUp = items.filter((item) => item.state === "catching_up");
  if (catchingUp.length > 0) {
    return chooseSummary("catching_up", catchingUp, {
      label: "Catching up",
      headline: "Queued to continue",
      detail: `${pluralize(catchingUp.length, "page")} still catching up.`,
    });
  }

  const setup = items.filter((item) => item.state === "setup");
  if (setup.length > 0) {
    return chooseSummary("setup", setup, {
      label: "Setting up",
      headline: "Preparing first sync",
      detail: `${pluralize(setup.length, "page")} still preparing local data.`,
    });
  }

  return chooseSummary("healthy", items, {
    label: "Up to date",
    headline: "Up to date",
    detail: "All pages are current.",
  });
}

export function buildConversationHistorySyncUx(input: {
  conversationSyncUx: SyncUxSummary | null;
  messageSyncUx: SyncUxSummary | null;
  pendingMessageBackfillCount: number;
  previewReadyConversationCount: number;
}): SyncUxSummary {
  const items = [
    input.conversationSyncUx,
    input.messageSyncUx,
  ].filter((item): item is SyncUxSummary => item !== null);
  const updatedAt = latestTimestamp(items.map((item) => item.updatedAt));
  const nextRetryAt = earliestTimestamp(items.map((item) => item.nextRetryAt));
  const requiresAction = items.some((item) => item.requiresAction);
  const pendingLabel = input.pendingMessageBackfillCount > 0
    ? `${pluralize(input.pendingMessageBackfillCount, "conversation")} still catching up.`
    : null;

  if (items.some((item) => item.requiresAction)) {
    return buildSummary("attention", {
      label: "Reconnect",
      headline: "Reconnect to resume sync",
      detail: "Fresh credentials are required before conversation history can continue syncing.",
      nextRetryAt,
      updatedAt,
      requiresAction,
    });
  }

  if (items.some((item) => item.state === "attention")) {
    return buildSummary("attention", {
      label: "Needs attention",
      headline: "Conversation history needs attention",
      detail: "Conversation history stopped making progress.",
      nextRetryAt,
      updatedAt,
    });
  }

  if (items.some((item) => item.state === "off")) {
    return buildSummary("off", {
      label: "Off",
      headline: "Conversation history is off",
      detail: "One or more conversation syncs are paused.",
      nextRetryAt,
      updatedAt,
    });
  }

  if (items.some((item) => item.state === "syncing")) {
    return buildSummary("syncing", {
      label: "Syncing",
      headline: "Conversation history is syncing",
      detail: pendingLabel ?? "Conversation history is actively syncing.",
      progressLabel: pendingLabel,
      updatedAt,
    });
  }

  if (items.some((item) => item.state === "retrying")) {
    return buildSummary("retrying", {
      label: "Retrying",
      headline: "Retrying automatically",
      detail: pendingLabel ?? "Conversation history will resume automatically.",
      progressLabel: pendingLabel,
      nextRetryAt,
      updatedAt,
    });
  }

  if (input.pendingMessageBackfillCount > 0 || items.some((item) => item.state === "catching_up")) {
    return buildSummary("catching_up", {
      label: "Catching up",
      headline: "Conversation history is still syncing",
      detail: pendingLabel ?? "Conversation history will resume from the last safe checkpoint.",
      progressLabel: pendingLabel,
      updatedAt,
    });
  }

  if (input.previewReadyConversationCount === 0 && items.some((item) => item.state === "setup")) {
    return buildSummary("setup", {
      label: "Setting up",
      headline: "Preparing conversation history",
      detail: "Conversation previews will appear after the first message sync finishes.",
      updatedAt,
    });
  }

  return buildSummary("healthy", {
    label: "Up to date",
    headline: "Conversation history is ready",
    detail: "Conversation previews are ready to use.",
    updatedAt,
  });
}
