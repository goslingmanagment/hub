import type { SyncUxSummary } from "@agency_hub_core/contracts";
import {
  ensurePageSyncStates,
  getSyncStreamsForPlatform,
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
import { pageSyncDependencyInput } from "./sync/dependencies.ts";
import { filterOnlyFansAudienceStreams } from "./sync/ofapi-audience-sync.ts";
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

function toStreamSyncUx(task: PageSyncState, now: Date): SyncUxSummary {
  const activeRun = task.status === "running" && task.startedAt
    ? {
      startedAt: task.startedAt.toISOString(),
      lastActivityAt: (task.progressedAt ?? task.startedAt).toISOString(),
    }
    : null;

  return buildStreamSyncUx({
    stream: task.stream,
    status: task.status,
    stalled: isStalled(task, now),
    pending: task.requestSeq > task.appliedSeq || task.status === "pending",
    retryAt: iso(task.retryAt),
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
    failedAt: iso(task.failedAt),
    lastErrorCode: task.lastErrorCode,
    blockerKind: task.blockerKind,
    lastErrorSummary: task.lastErrorSummary ?? task.blockerMessage,
    consecutiveFailures: task.consecutiveFailures,
  });
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
    .map((task) => toStreamSyncUx(task, now));

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

  const dependencyInput = pageSyncDependencyInput(app);
  if (input?.pageIds || input?.pageLabel || scopedPageIds.length === 1) {
    await Promise.all(scopedPageIds.map((pageId) => ensurePageSyncStates(app.db, {
      pageId,
      now,
      ...dependencyInput,
    })));
  } else {
    await ensurePageSyncStates(app.db, { now, ...dependencyInput });
  }

  const taskRows = await listPageSyncStates(app.db);
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
      syncUx: buildPageSummarySyncUx(app, page, taskRowsByPageId.get(page.id) ?? [], now),
    })),
  };
}
