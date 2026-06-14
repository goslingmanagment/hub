import type { SyncUxSummary } from "@agency_hub_core/contracts";
import {
  ensurePageSyncStates,
  getSyncStreamsForPlatform,
  listPageSyncStates,
  listVisiblePages,
  SYNC_STREAM_POLICY,
  type PageSyncState,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  isOfapiAccountHealthEnabled,
  ofapiAuthStatusNeedsAction,
} from "./ofapi-account-health.ts";
import { filterOnlyFansAudienceStreams } from "./sync/ofapi-audience-sync.ts";
import {
  buildPageSyncUx,
  buildStreamSyncUx,
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

function buildCredentialSyncUx(page: VisiblePage): SyncUxSummary | null {
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
  const actionRequired = buildCredentialSyncUx(page) ?? buildOfapiAuthSyncUx(app, page);
  if (actionRequired) {
    return actionRequired;
  }

  const supportedStreams = new Set(filterOnlyFansAudienceStreams(
    page.platform,
    getSyncStreamsForPlatform(page.platform),
    app.config,
    page,
  ));
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

  if (input?.pageIds || input?.pageLabel || scopedPageIds.length === 1) {
    await Promise.all(scopedPageIds.map((pageId) => ensurePageSyncStates(app.db, {
      pageId,
      now,
    })));
  } else {
    await ensurePageSyncStates(app.db, { now });
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
