import type { SyncUxSummary } from "@agency_hub_core/contracts";
import {
  activePageSyncRetryAt,
  getSyncStreamsForPlatform,
  isLegacyExecutorStream,
  listCheckpointStates,
  listPageSyncStates,
  listVisiblePages,
  SYNC_STREAM_POLICY,
  type LegacyExecutorStream,
  type PageSyncState,
  type SyncStream,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  isOfapiAccountHealthEnabled,
  ofapiAuthStatusNeedsAction,
} from "./ofapi-account-health.ts";
import { legacyExecutorPlatforms } from "../sync/onlyfans/boundary.ts";
import { filterOnlyFansAudienceStreams } from "./sync/ofapi-audience-sync.ts";
import { ofapiAudienceQualityHoldFor } from "./sync/cursor-state.ts";
import { isOfapiFanIdentitiesEligiblePage } from "./sync/ofapi-fan-identities.ts";
import { filterOnlyFansDmPollingStreams } from "./sync/onlyfans-dm-polling.ts";
import { filterOnlyFansTopSpendersStreams } from "./sync/onlyfans-top-spenders.ts";
import { buildEnginePageSyncUx, readEngineSummaryFacts, type EngineSummaryFacts } from "./sync-status-engine.ts";
import {
  buildPageSyncUx,
  buildStreamSyncUx,
  type SyncUxStreamLike,
} from "./sync-ux.ts";

type VisiblePage = Awaited<ReturnType<typeof listVisiblePages>>[number];

/** A `page_sync_states` row of a stream the legacy executor runs. */
type LegacyTaskRow = PageSyncState & { stream: LegacyExecutorStream };

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

function progressFor(task: LegacyTaskRow): SyncUxStreamLike["progress"] {
  const label = task.progress.label;
  return typeof label === "string" && label.length > 0
    ? { label }
    : null;
}

function isStalled(task: LegacyTaskRow, now: Date) {
  if (task.status !== "running") {
    return false;
  }

  const policy = SYNC_STREAM_POLICY[task.stream];
  const lastActiveAt = task.progressedAt ?? task.startedAt;
  return lastActiveAt !== null &&
    (now.getTime() - lastActiveAt.getTime()) > policy.progressStallThresholdMs;
}

function toStreamSyncUx(
  task: LegacyTaskRow,
  now: Date,
  qualityHold: string | null,
): SyncUxSummary {
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

/** The summary of a page the legacy executor serves (OnlyFans), from its
 *  legacy stream rows. */
function buildLegacyPageSummarySyncUx(
  app: AppContext,
  page: VisiblePage,
  taskRows: LegacyTaskRow[],
  now: Date,
  audienceQualityHold: string | null,
) {
  const actionRequired = buildOfapiAuthSyncUx(app, page) ?? buildCredentialSyncUx(app, page);
  if (actionRequired) {
    return actionRequired;
  }

  let applicableStreams: SyncStream[] = getSyncStreamsForPlatform(page.platform);
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

  const supportedStreams = new Set(applicableStreams);
  const streamSummaries = taskRows
    .filter((task) => supportedStreams.has(task.stream))
    .map((task) => toStreamSyncUx(task, now, task.stream === "subscribers" ? audienceQualityHold : null));

  return buildPageSyncUx(streamSummaries);
}

/** The summary of a page the legacy executor does not serve (Fansly): the
 *  Fansly Sync Engine's, or "not syncing" when the engine does not own the
 *  page — nothing reads it then. */
function buildEnginePageSummarySyncUx(
  app: AppContext,
  page: VisiblePage,
  engine: EngineSummaryFacts | undefined,
): SyncUxSummary {
  const credentials = buildCredentialSyncUx(app, page);
  if (credentials) {
    return credentials;
  }
  if (engine === undefined) {
    return buildSummary("off", {
      label: "Off",
      headline: "Not syncing",
      detail: "The Fansly Sync Engine does not run this page: nothing reads it.",
    });
  }
  return buildEnginePageSyncUx(engine);
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
  // A page of a platform the legacy executor serves (OnlyFans) is summed up
  // from its legacy stream rows; any other page (Fansly) by the Fansly Sync
  // Engine.
  const legacyPlatforms = legacyExecutorPlatforms();
  const enginePageIds = scopedPages.filter((page) => !legacyPlatforms.includes(page.platform)).map((page) => page.id);
  const [taskRows, checkpoints, engineFacts] = await Promise.all([
    listPageSyncStates(app.db, { platforms: legacyPlatforms }),
    listCheckpointStates(app.db, scopedPageIds, "subscribers"),
    readEngineSummaryFacts(app.db, { pageIds: enginePageIds }),
  ]);
  const audienceHolds = new Map(checkpoints.map((row) => [row.pageId, ofapiAudienceQualityHoldFor(row.state)]));
  const taskRowsByPageId = new Map<number, LegacyTaskRow[]>();
  for (const task of taskRows) {
    // A record row (OnlyFans's retired dm_messages) is no stream of the page.
    if (!scopedPageIds.includes(task.pageId) || !isLegacyExecutorStream(task.stream)) {
      continue;
    }
    const current = taskRowsByPageId.get(task.pageId) ?? [];
    current.push(task as LegacyTaskRow);
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
      syncUx: legacyPlatforms.includes(page.platform)
        ? buildLegacyPageSummarySyncUx(
          app, page, taskRowsByPageId.get(page.id) ?? [], now, audienceHolds.get(page.id) ?? null,
        )
        : buildEnginePageSummarySyncUx(app, page, engineFacts.get(page.id)),
    })),
  };
}
