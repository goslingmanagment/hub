import type { AppContext } from "../bootstrap.ts";
import { listConnectionStatuses } from "./connections.ts";
import { getSyncStatusSnapshot } from "./sync-status.ts";

type ServiceHealthStatus = "ok" | "degraded";
type SystemCheckStatus = "ok" | "error";

const PUBLIC_DATABASE_CHECK_ERROR = "Database check failed";

function ageMinutes(timestamp: string | null, now: Date) {
  if (!timestamp) {
    return null;
  }

  return Math.max(0, Math.floor((now.getTime() - new Date(timestamp).getTime()) / 60_000));
}

function firstErrorSummary(
  blocks: Array<{
    statusReason?: {
      summary: string | null;
    } | null;
    error: {
      summary: string | null;
    } | null;
  }>,
) {
  const first = blocks.find((block) => block.statusReason?.summary || block.error?.summary);
  return first?.statusReason?.summary ?? first?.error?.summary ?? null;
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

  try {
    await app.pool.query("select 1");

    return {
      statusCode: 200,
      body: {
        status: "ok" as const,
        timestamp,
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
  const [connections, snapshot] = await Promise.all([
    listConnectionStatuses(app, {
      pageIds: input?.pageIds,
    }),
    getSyncStatusSnapshot(app, {
      now,
      pageIds: input?.pageIds,
    }),
  ]);

  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
  const snapshotPagesById = new Map(snapshot.pages.map((page) => [page.pageId, page]));
  const recentCounters = recentCountersFromSnapshot(snapshot);
  const allPageIds = new Set([
    ...connectionsById.keys(),
    ...snapshotPagesById.keys(),
  ]);
  const thresholds = {
    lightMaxAgeMinutes: app.config.healthSyncLightMaxAgeMinutes,
    followerMaxAgeMinutes: app.config.healthSyncFollowerMaxAgeMinutes,
  };

  const pages = Array.from(allPageIds, (pageId) => {
    const page = snapshotPagesById.get(pageId);
    const connection = connectionsById.get(pageId);
    const blocks = page ? Object.values(page.blocks).filter((block) => block.state !== "not_available") : [];
    const lightAge = ageMinutes(connection?.lastLightSyncAt ?? null, now);
    const followerAge = (page?.platform ?? connection?.platform) === "fansly"
      ? ageMinutes(connection?.lastFollowerSyncAt ?? null, now)
      : null;
    const failedStreams = blocks.filter((block) => block.state === "failed").length;
    const stalledStreams = blocks.filter((block) => block.state === "delayed").length;
    const pendingStreams = blocks.filter((block) =>
      block.state === "scheduled" ||
      block.state === "retrying" ||
      block.state === "syncing" ||
      block.state === "backfilling" ||
      block.state === "not_started"
    ).length;
    const issues: string[] = [];

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

    if (failedStreams > 0) {
      issues.push("failed_streams");
    }

    if (stalledStreams > 0) {
      issues.push("stalled_streams");
    }

    const status: ServiceHealthStatus = issues.length > 0 ? "degraded" : "ok";

    return {
      pageId,
      pageLabel: page?.pageLabel ?? connection?.label ?? "unknown",
      platform: page?.platform ?? connection?.platform ?? "fansly",
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
      lastErrorSummary: firstErrorSummary(blocks) ?? connection?.lastSyncError ?? null,
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
    return count + Object.values(page.blocks).filter((block) => block.state === "delayed").length;
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
