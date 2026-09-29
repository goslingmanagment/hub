import type { SyncUxSummary } from "@agency_hub_core/contracts";
import {
  activePageSyncRetryAt,
  getSyncStreamsForPlatform,
  listCheckpointStates,
  listPageSyncStates,
  listVisiblePages,
  SYNC_STREAM_POLICY,
  type PageSyncState,
  type SyncStream,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  isOfapiAccountHealthEnabled,
  ofapiAuthStatusNeedsAction,
} from "./ofapi-account-health.ts";
import { filterOnlyFansAudienceStreams } from "./sync/ofapi-audience-sync.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { dmFullSweepCompletedAt, dmFullSweepFreshnessSlaSeconds, resolveDmBoundedPolicy } from "./sync/dm-bounded-state.ts";
import { ofapiAudienceQualityHoldFor } from "./sync/cursor-state.ts";
import { isOfapiFanIdentitiesEligiblePage } from "./sync/ofapi-fan-identities.ts";
import { filterOnlyFansDmPollingStreams } from "./sync/onlyfans-dm-polling.ts";
import { filterOnlyFansTopSpendersStreams } from "./sync/onlyfans-top-spenders.ts";
import {
  buildPageSyncUx,
  buildStreamSyncUx,
  isBulkEnrichmentSyncStream,
  type SyncUxStreamLike,
} from "./sync-ux.ts";

type VisiblePage = Awaited<ReturnType<typeof listVisiblePages>>[number];

export interface SyncStatusSummaryPage {
  pageId: number;
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  modelSlug: string;
  modelName: string;
  username: string | null;
  displayName: string | null;
  syncUx: SyncUxSummary;
}

export interface SyncStatusSummarySnapshot {
  generatedAt: string;
  pages: SyncStatusSummaryPage[];
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function buildSummary(state: SyncUxSummary["state"], input: {
  label: string;
  headline: string;
  detail?: string | null;
  progressLabel?: string | null;
  nextRetryAt?: string | null;
  updatedAt?: string | null;
  requiresAction?: boolean;
}): SyncUxSummary {
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

function progressFor(task: PageSyncState): SyncUxStreamLike["progress"] {
  const label = task.progress.label;
  return typeof label === "string" && label.length > 0
    ? { label }
    : null;
}

function isStalled(task: PageSyncState, now: Date) {
  if (task.status !== "running") {
    return false;
  }

  const policy = SYNC_STREAM_POLICY[task.stream];
  const lastActiveAt = task.progressedAt ?? task.startedAt;
  return lastActiveAt !== null &&
    (now.getTime() - lastActiveAt.getTime()) > policy.progressStallThresholdMs;
}

function toStreamSyncUx(
  task: PageSyncState,
  now: Date,
  qualityHold: string | null,
  fullCompletedAt: string | null | undefined,
  fullSlaSeconds?: number | null,
): SyncUxSummary {
  if (fullCompletedAt !== undefined) {
    task = { ...task, succeededAt: fullCompletedAt === null ? null : new Date(fullCompletedAt) };
  }
  const activeRun = task.status === "running" && task.startedAt
    ? {
      startedAt: task.startedAt.toISOString(),
      lastActivityAt: (task.progressedAt ?? task.startedAt).toISOString(),
    }
    : null;

  const summary = buildStreamSyncUx({
    stream: task.stream,
    status: task.status,
    stalled: isStalled(task, now),
    pending: task.requestSeq > task.appliedSeq || task.status === "pending",
    retryAt: iso(activePageSyncRetryAt(task.retryAt, now)),
    progress: progressFor(task),
    recentErrors: {
      total429s: 0,
      total5xxs: 0,
      failedRuns: 0,
      failedAttempts: 0,
      retryAttempts: 0,
    },
    rateHealth: {
      state: "healthy",
      nextAvailableAt: null,
    },
    activeRun,
    lastCompletion: task.succeededAt
      ? {
        status: "success",
        finishedAt: task.succeededAt.toISOString(),
      }
      : null,
    succeededAt: iso(task.succeededAt),
    lastCompletionQualityHold: qualityHold,
    failedAt: iso(task.failedAt),
    lastErrorCode: task.lastErrorCode,
    blockerKind: task.blockerKind,
    lastErrorSummary: task.lastErrorSummary ?? task.blockerMessage,
    consecutiveFailures: task.consecutiveFailures,
  });
  // A bounded run cannot renew full-list freshness. Keep pause/auth/retry and
  // active-work precedence from the shared UX, including on lightweight reads.
  const slaSeconds = fullSlaSeconds !== undefined ? fullSlaSeconds : SYNC_STREAM_POLICY[task.stream].freshnessSlaSeconds;
  const fullIsStale = fullCompletedAt === null || (fullCompletedAt !== undefined &&
    slaSeconds !== null && now.getTime() - Date.parse(fullCompletedAt) > slaSeconds * 1000);
  if (fullIsStale && (summary.state === "healthy" ||
    (summary.state === "setup" && task.status === "idle" && task.requestSeq <= task.appliedSeq))) {
    return buildSummary("attention", {
      label: fullCompletedAt === null ? "Full scan unverified" : "Delayed",
      headline: "Full dialog scan needs to catch up",
      detail: fullCompletedAt === null
        ? "No confirmed full dialog scan is available."
        : "The last full dialog scan is older than the freshness target.",
      updatedAt: fullCompletedAt,
    });
  }
  return summary;
}

function hasUsableOfapiConnection(app: AppContext, page: VisiblePage) {
  return isOfapiAccountHealthEnabled(app.config) &&
    page.platform === "onlyfans" &&
    page.ofapiAccountId !== null &&
    !ofapiAuthStatusNeedsAction(page.ofapiAuthStatus);
}

function buildCredentialSyncUx(app: AppContext, page: VisiblePage): SyncUxSummary | null {
  if (hasUsableOfapiConnection(app, page)) {
    return null;
  }

  if (!page.hasCredentials) {
    return buildSummary("attention", {
      label: "Reconnect",
      headline: "Reconnect to resume sync",
      detail: "Fresh credentials are required before sync can continue.",
      requiresAction: true,
    });
  }

  return null;
}

function buildOfapiAuthSyncUx(app: AppContext, page: VisiblePage): SyncUxSummary | null {
  if (
    !isOfapiAccountHealthEnabled(app.config) ||
    page.platform !== "onlyfans" ||
    page.ofapiAccountId === null ||
    !ofapiAuthStatusNeedsAction(page.ofapiAuthStatus)
  ) {
    return null;
  }

  return buildSummary("attention", {
    label: "Reconnect",
    headline: "Reconnect to resume sync",
    detail: `OFAPI reports the OnlyFans account needs attention (${page.ofapiAuthStatus}).`,
    updatedAt: iso(page.ofapiAuthChangedAt),
    requiresAction: true,
  });
}

function buildPageSummarySyncUx(
  app: AppContext,
  page: VisiblePage,
  taskRows: PageSyncState[],
  now: Date,
  audienceQualityHold: string | null,
  dmCheckpoint: unknown,
  dmFullSweepSlaSeconds: number | null | undefined,
) {
  const actionRequired = buildOfapiAuthSyncUx(app, page) ?? buildCredentialSyncUx(app, page);
  if (actionRequired) {
    return actionRequired;
  }

  let applicableStreams: SyncStream[] = getSyncStreamsForPlatform(page.platform)
    // Stage 16 bulk enrichment streams remain visible on the detailed sync
    // monitor, but never make an otherwise-current page look broken/off. The
    // membership list moved to sync-ux.ts so this filter and the monitor's page
    // rollup, which needs the identical rule, cannot drift apart.
    .filter((stream) => !isBulkEnrichmentSyncStream(stream));
  applicableStreams = filterOnlyFansAudienceStreams(
    page.platform,
    applicableStreams,
    app.config,
    page,
  );
  applicableStreams = filterOnlyFansDmPollingStreams(
    page.platform,
    applicableStreams,
    app.config,
    page,
  );
  applicableStreams = filterOnlyFansTopSpendersStreams(
    page.platform,
    applicableStreams,
    app.config,
  );
  if (page.platform !== "fansly") {
    applicableStreams = applicableStreams.filter((stream) => {
      // These rows are compatibility placeholders: OnlyFans identity metadata
      // is static and transaction truth arrives through captured webhooks.
      if (stream === "light" || stream === "transactions") {
        return false;
      }
      if (stream === "fan_identities") {
        return isOfapiFanIdentitiesEligiblePage(app.config, page);
      }
      return true;
    });
  }

  const supportedStreams = new Set(applicableStreams);
  const streamSummaries = taskRows
    .filter((task) => supportedStreams.has(task.stream))
    .map((task) => toStreamSyncUx(
      task, now, task.stream === "subscribers" ? audienceQualityHold : null,
      task.stream === "dm_conversations" ? dmFullSweepCompletedAt(dmCheckpoint, now) : undefined,
      task.stream === "dm_conversations" ? dmFullSweepSlaSeconds : undefined,
    ));

  return buildPageSyncUx(streamSummaries);
}

export async function getSyncStatusSummarySnapshot(
  app: AppContext,
  input?: {
    pageIds?: number[];
    pageLabel?: string;
    now?: Date;
  },
): Promise<SyncStatusSummarySnapshot> {
  const now = input?.now ?? new Date();
  const allVisiblePages = await listVisiblePages(app.db);
  const scopedPages = (() => {
    const pageIds = input?.pageIds ? new Set(input.pageIds) : null;
    return allVisiblePages.filter((page) => {
      if (pageIds && !pageIds.has(page.id)) {
        return false;
      }
      if (input?.pageLabel && page.label !== input.pageLabel) {
        return false;
      }
      return true;
    });
  })();
  const scopedPageIds = scopedPages.map((page) => page.id);
  if (scopedPageIds.length === 0) {
    return {
      generatedAt: now.toISOString(),
      pages: [],
    };
  }

  // Read paths never seed. This snapshot serves GET /overview (and, through
  // listConnectionStatuses, the Sidebar's /admin/connections on every page), so
  // seeding here meant an INSERT/UPDATE storm on `page_sync_states` per
  // dashboard load. Seeding and legacy repair stay where they already run: the
  // sync planner tick, the executor, and the explicit admin paths
  // (sync-control.ts, sync-blocks.ts). A page with no state rows is reported as
  // such — buildPageSummarySyncUx already handles an empty row list.
  const fanslyPageIds = scopedPages.filter((page) => page.platform === "fansly").map((page) => page.id);
  const [taskRows, checkpoints, dmCheckpoints, effectiveConfig] = await Promise.all([
    listPageSyncStates(app.db),
    listCheckpointStates(app.db, scopedPageIds, "subscribers"),
    listCheckpointStates(app.db, fanslyPageIds, "dm_conversations"),
    // The live A1 policy decides each Fansly page's full-list freshness target.
    fanslyPageIds.length > 0 ? loadEffectiveConfig(app.db, app.config) : Promise.resolve(null),
  ]);
  const dmCheckpointByPage = new Map(dmCheckpoints.map((row) => [row.pageId, row.state]));
  const dmFullSweepSlaByPage = new Map(scopedPages
    .filter((page) => fanslyPageIds.includes(page.id))
    .map((page) => [page.id, dmFullSweepFreshnessSlaSeconds(
      effectiveConfig ? resolveDmBoundedPolicy(effectiveConfig, page.label) : null,
      SYNC_STREAM_POLICY.dm_conversations.freshnessSlaSeconds,
    )] as const));
  const audienceHolds = new Map(checkpoints.map((row) => [row.pageId, ofapiAudienceQualityHoldFor(row.state)]));
  const taskRowsByPageId = new Map<number, PageSyncState[]>();
  for (const task of taskRows) {
    if (!scopedPageIds.includes(task.pageId)) {
      continue;
    }
    const current = taskRowsByPageId.get(task.pageId) ?? [];
    current.push(task);
    taskRowsByPageId.set(task.pageId, current);
  }

  return {
    generatedAt: now.toISOString(),
    pages: scopedPages.map((page) => ({
      pageId: page.id,
      pageLabel: page.label,
      platform: page.platform,
      modelSlug: page.modelSlug,
      modelName: page.modelName,
      username: page.username,
      displayName: page.displayName,
      syncUx: buildPageSummarySyncUx(
        app, page, taskRowsByPageId.get(page.id) ?? [], now,
        audienceHolds.get(page.id) ?? null, dmCheckpointByPage.get(page.id), dmFullSweepSlaByPage.get(page.id),
      ),
    })),
  };
}
