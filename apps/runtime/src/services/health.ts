import {
  countConversationSyncFailuresByAccount,
  countUnresolvedProjectionDebtByAccount,
} from "@agency_hub_core/db";

import { KERNEL_CONTRACT_HASH } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import { listConnectionStatuses } from "./connections.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { PUBLIC_RUNTIME_CAPABILITIES } from "./public-capabilities.ts";
import { getSyncStatusSnapshot, type SyncDomainBlockStatus } from "./sync-status.ts";

type ServiceHealthStatus = "ok" | "degraded";
type SystemCheckStatus = "ok" | "error";

const PUBLIC_DATABASE_CHECK_ERROR = "Database check failed";

// #135 A2b: a stream stuck in a retry loop used to hide inside pendingStreams —
// dm_messages sat at 251-270 consecutive 23514 failures while /health/sync
// said 200/ok. At this streak the retry loop is a wedge, not a transient,
// and the page must degrade exactly like a "failed" stream does.
const RETRY_WEDGED_MIN_CONSECUTIVE_FAILURES = 10;

function ageMinutes(timestamp: string | null, now: Date) {
  if (!timestamp) {
    return null;
  }

  return Math.max(0, Math.floor((now.getTime() - new Date(timestamp).getTime()) / 60_000));
}

function firstErrorSummary(blocks: SyncDomainBlockStatus[]) {
  const first = blocks.find((block) =>
    (block.state === "failed" || block.state === "delayed" || block.needsAttention) &&
    (block.statusReason?.summary || block.error?.summary)
  );
  return first?.statusReason?.summary ?? first?.error?.summary ?? null;
}

function listFailedTaskEntries(blocks: SyncDomainBlockStatus[]) {
  return blocks.flatMap((block) => (block.tasks ?? [])
    .filter((task) => task.state === "failed")
    .map((task) => ({
      blockState: block.state,
      task,
    })));
}

function firstFailedTaskSummary(entries: ReturnType<typeof listFailedTaskEntries>) {
  const first = entries.find(({ task }) => task.statusReason?.summary || task.error?.summary);
  return first?.task.statusReason?.summary ?? first?.task.error?.summary ?? null;
}

function numericMetric(block: SyncDomainBlockStatus, key: string) {
  const value = block.metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isDeepBackfillOnlyDelay(block: SyncDomainBlockStatus) {
  if (
    block.block !== "messages_history" ||
    block.state !== "delayed" ||
    block.statusReason?.code !== "history_incomplete"
  ) {
    return false;
  }

  const eligibleConversations = numericMetric(block, "eligibleConversationCount");
  const readyConversations = numericMetric(block, "readyConversationCount");
  const laggingConversations = numericMetric(block, "laggingConversationCount");
  const pendingDeepPages = numericMetric(block, "deepBackfillPendingPagesEstimate");

  return (
    eligibleConversations !== null &&
    readyConversations !== null &&
    laggingConversations === 0 &&
    pendingDeepPages !== null &&
    pendingDeepPages > 0 &&
    readyConversations >= eligibleConversations
  );
}

function isOfapiMappedConnectionUsable(block: SyncDomainBlockStatus | undefined) {
  const metrics = block?.metrics ?? {};
  if (!block || !Object.prototype.hasOwnProperty.call(metrics, "ofapiAuthStatus")) {
    return false;
  }

  return block.connectionStatus !== "error" && block.statusReason?.code !== "ofapi_auth";
}

/** Streams whose failure streak crossed the wedge threshold. The streak resets
 * only on a success (completePageSync) or a partial yield (yieldPageSync; see
 * the #138 addendum below), so it must degrade health in
 * EVERY active state — a wedged stream that flips retrying → pending/
 * backfilling/syncing between failures is still wedged (prod 2026-07-11:
 * 425-streak dm_messages read as ok the moment its state left retrying).
 * paused is a deliberate operator state and failed already degrades via
 * failedStreams. Uses only data the snapshot already carries: the block's
 * own error plus the per-task errors. */
function retryWedgedStreamNames(block: SyncDomainBlockStatus) {
  if (block.state === "paused" || block.state === "failed") {
    return [];
  }

  const names = new Set<string>();
  if ((block.error?.consecutiveFailures ?? 0) >= RETRY_WEDGED_MIN_CONSECUTIVE_FAILURES) {
    names.add(block.error?.stream ?? block.block);
  }
  for (const task of block.tasks ?? []) {
    if ((task.error?.consecutiveFailures ?? 0) >= RETRY_WEDGED_MIN_CONSECUTIVE_FAILURES) {
      names.add(task.stream);
    }
  }

  return [...names];
}

function recentCountersFromSnapshot(snapshot: Awaited<ReturnType<typeof getSyncStatusSnapshot>>) {
  return snapshot.recentCounters ?? {
    failedRuns: 0,
    http429s: 0,
    http5xxs: 0,
  };
}

export async function getSystemHealth(app: AppContext) {
  const timestamp = new Date().toISOString();
  const startedAt = Date.now();
  // This capability is a production-fleet promise, not merely an API-schema
  // flag. Keep it absent until the preservation-first read-only Desktop and
  // Extension artifacts are shipped and fleet coverage is verifiable.
  const capabilities = [...PUBLIC_RUNTIME_CAPABILITIES];

  try {
    await app.pool.query("select 1");

    return {
      statusCode: 200,
      body: {
        status: "ok" as const,
        timestamp,
        contractHash: KERNEL_CONTRACT_HASH,
        capabilities,
        checks: {
          api: {
            status: "ok" as const,
          },
          database: {
            status: "ok" as SystemCheckStatus,
            latencyMs: Date.now() - startedAt,
            error: null,
          },
        },
      },
    };
  } catch (error) {
    app.logger.error({
      err: error,
    }, "Health check database probe failed");

    return {
      statusCode: 503,
      body: {
        status: "degraded" as const,
        timestamp,
        contractHash: KERNEL_CONTRACT_HASH,
        capabilities,
        checks: {
          api: {
            status: "ok" as const,
          },
          database: {
            status: "error" as SystemCheckStatus,
            latencyMs: Date.now() - startedAt,
            error: PUBLIC_DATABASE_CHECK_ERROR,
          },
        },
      },
    };
  }
}

export async function getPublicSyncHealth(
  app: AppContext,
  input?: {
    now?: Date;
    pageIds?: number[];
  },
) {
  const now = input?.now ?? new Date();
  // One effective-config snapshot for both live health thresholds read below, so the
  // reported `running` values match exactly what this check consumes (no field skew).
  const [connections, snapshot, effective, projectionDebtCounts, coverageDebtCounts] = await Promise.all([
    listConnectionStatuses(app, {
      pageIds: input?.pageIds,
    }),
    getSyncStatusSnapshot(app, {
      now,
      pageIds: input?.pageIds,
    }),
    loadEffectiveConfig(app.db, app.config),
    // #135 A2b: unresolved projection debt is deferred repair work the sweep
    // has not cleared yet — surfaced per page so it cannot rot silently.
    countUnresolvedProjectionDebtByAccount(
      app.db,
      input?.pageIds ? { platformAccountIds: input.pageIds } : undefined,
    ),
    // #138 addendum: conversation-level coverage debt. The page-level failure
    // streak is reset to 0 by every partial yield that read something, and a
    // deferred thread no longer fails the stream, so once the breaker keeps a
    // stream moving the streak can no longer carry the wedge signal — the
    // breaker rows themselves can: they clear only when their conversation
    // actually syncs.
    countConversationSyncFailuresByAccount(
      app.db,
      input?.pageIds ? { platformAccountIds: input.pageIds } : undefined,
    ),
  ]);

  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
  const snapshotPagesById = new Map(snapshot.pages.map((page) => [page.pageId, page]));
  const projectionDebtByPageId = new Map(
    projectionDebtCounts.map((row) => [row.platformAccountId, row.unresolvedCount]),
  );
  const coverageDebtByPageId = new Map(
    coverageDebtCounts.map((row) => [row.platformAccountId, row.failingConversationCount]),
  );
  const recentCounters = recentCountersFromSnapshot(snapshot);
  const allPageIds = new Set([
    ...connectionsById.keys(),
    ...snapshotPagesById.keys(),
  ]);
  const thresholds = {
    lightMaxAgeMinutes: effective.healthSyncLightMaxAgeMinutes,
    followerMaxAgeMinutes: effective.healthSyncFollowerMaxAgeMinutes,
  };

  const pages = Array.from(allPageIds, (pageId) => {
    const page = snapshotPagesById.get(pageId);
    const connection = connectionsById.get(pageId);
    const platform = page?.platform ?? connection?.platform ?? "fansly";
    const blocks = page ? Object.values(page.blocks).filter((block) => block.state !== "not_available") : [];
    const healthBlocks = blocks.filter((block) => !isDeepBackfillOnlyDelay(block));
    const connectionBlock = page?.blocks.connection;
    const hasOfapiConnection = isOfapiMappedConnectionUsable(connectionBlock);
    const allSupportedBlocksPaused = blocks.length > 0 && blocks.every((block) => block.state === "paused");
    const lightAge = ageMinutes(connection?.lastLightSyncAt ?? null, now);
    const followerAge = (page?.platform ?? connection?.platform) === "fansly"
      ? ageMinutes(connection?.lastFollowerSyncAt ?? null, now)
      : null;
    const failedStreams = healthBlocks.filter((block) => block.state === "failed").length;
    const failedTaskEntries = listFailedTaskEntries(blocks);
    // A failed supporting task can be hidden by an up-to-date or paused primary
    // aggregate. Keep failedStreams block-level for compatibility, and surface
    // the otherwise-unrepresented task failure as its own issue.
    const hiddenFailedTaskEntries = failedTaskEntries.filter(({ blockState }) => blockState !== "failed");
    const stalledStreams = healthBlocks.filter((block) => block.state === "delayed").length;
    const pendingStreams = healthBlocks.filter((block) =>
      block.state === "scheduled" ||
      block.state === "retrying" ||
      block.state === "syncing" ||
      block.state === "backfilling" ||
      block.state === "not_started"
    ).length;
    const issues: string[] = [];

    if (connectionBlock?.statusReason?.code === "ofapi_auth") {
      issues.push("connection:ofapi_auth");
    }

    if (!allSupportedBlocksPaused && !hasOfapiConnection) {
      if (!connection || connection.connectionStatus !== "active") {
        issues.push(`connection:${connection?.connectionStatus ?? "missing"}`);
      }

      if (lightAge === null) {
        issues.push("light_sync_missing");
      } else if (lightAge > thresholds.lightMaxAgeMinutes) {
        issues.push("light_sync_stale");
      }

      if ((page?.platform ?? connection?.platform) === "fansly") {
        if (followerAge === null) {
          issues.push("follower_sync_missing");
        } else if (followerAge > thresholds.followerMaxAgeMinutes) {
          issues.push("follower_sync_stale");
        }
      }
    }

    if (failedStreams > 0) {
      issues.push("failed_streams");
    }

    if (hiddenFailedTaskEntries.length > 0) {
      issues.push("failed_tasks");
    }

    if (stalledStreams > 0) {
      issues.push("stalled_streams");
    }

    // #135 A2b (widened by the #137 addendum): any active stream with a wedge-length
    // failure streak degrades the page the same way failed streams do.
    const wedgedStreams = new Set(healthBlocks.flatMap(retryWedgedStreamNames));
    for (const stream of wedgedStreams) {
      issues.push(`${stream}:retry_wedged`);
    }

    if ((projectionDebtByPageId.get(pageId) ?? 0) > 0) {
      issues.push("projection_debt");
    }

    // page_dm_message_sync_health rows of OnlyFans pages are historical, left
    // by the permanently retired legacy dm_messages crawler. They are not
    // mirror coverage debt and must not keep /health/sync at 503 after the
    // retirement fence. The Fansly dm_messages lane writes the table (its
    // per-thread breaker), so a Fansly page stays coverage_degraded while a
    // thread the lane still selects carries failures: until a successful read
    // of that thread clears them, or the thread leaves the lane (excluded,
    // hidden, unbound).
    if (platform !== "onlyfans" && (coverageDebtByPageId.get(pageId) ?? 0) > 0) {
      issues.push("dm_messages:coverage_degraded");
    }

    const status: ServiceHealthStatus = issues.length > 0 ? "degraded" : "ok";

    return {
      pageId,
      pageLabel: page?.pageLabel ?? connection?.label ?? "unknown",
      platform,
      modelSlug: page?.modelSlug ?? connection?.modelSlug ?? "unknown",
      modelName: page?.modelName ?? connection?.modelName ?? "unknown",
      status,
      connectionStatus: connection?.connectionStatus ?? "unverified",
      lastLightSyncAt: connection?.lastLightSyncAt ?? null,
      lightAgeMinutes: lightAge,
      lastFollowerSyncAt: connection?.lastFollowerSyncAt ?? null,
      followerAgeMinutes: followerAge,
      failedStreams,
      stalledStreams,
      pendingStreams,
      lastErrorSummary: firstFailedTaskSummary(hiddenFailedTaskEntries) ??
        firstErrorSummary(healthBlocks) ??
        (hasOfapiConnection ? null : connection?.lastSyncError ?? null),
      issues,
    };
  });

  const unhealthyPageCount = pages.filter((page) => page.status === "degraded").length;
  const runningStreams = snapshot.pages.reduce((count, page) => {
    return count + Object.values(page.blocks).filter((block) =>
      block.state === "syncing" || block.state === "backfilling"
    ).length;
  }, 0);
  const failedStreams = snapshot.pages.reduce((count, page) => {
    return count + Object.values(page.blocks).filter((block) => block.state === "failed").length;
  }, 0);
  const stalledStreams = snapshot.pages.reduce((count, page) => {
    return count + Object.values(page.blocks).filter((block) =>
      block.state === "delayed" && !isDeepBackfillOnlyDelay(block)
    ).length;
  }, 0);
  const pendingStreams = snapshot.pages.reduce((count, page) => {
    return count + Object.values(page.blocks).filter((block) =>
      block.state === "scheduled" ||
      block.state === "retrying" ||
      block.state === "not_started"
    ).length;
  }, 0);
  const status: ServiceHealthStatus = (
    unhealthyPageCount > 0 ||
    failedStreams > 0 ||
    stalledStreams > 0
  )
    ? "degraded"
    : "ok";

  return {
    statusCode: status === "ok" ? 200 : 503,
    body: {
      status,
      timestamp: now.toISOString(),
      thresholds,
      overall: {
        pageCount: pages.length,
        unhealthyPageCount,
        runningStreams,
        failedStreams,
        stalledStreams,
        pendingStreams,
        recentFailedRuns: recentCounters.failedRuns,
        recent429s: recentCounters.http429s,
        recent5xxs: recentCounters.http5xxs,
      },
      pages,
    },
  };
}
