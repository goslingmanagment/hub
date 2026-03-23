import type { AppContext } from "../bootstrap.ts";
import { listConnectionStatuses } from "./connections.ts";
import { getSyncMonitorSnapshot } from "./sync-monitor.ts";

type ServiceHealthStatus = "ok" | "degraded";
type SystemCheckStatus = "ok" | "error";

function serializeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ageMinutes(timestamp: string | null, now: Date) {
  if (!timestamp) {
    return null;
  }

  return Math.max(0, Math.floor((now.getTime() - new Date(timestamp).getTime()) / 60_000));
}

function firstErrorSummary(
  streams: Array<{
    lastErrorSummary: string | null;
  }>,
) {
  return streams.find((stream) => stream.lastErrorSummary)?.lastErrorSummary ?? null;
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
            error: serializeError(error),
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
  },
) {
  const now = input?.now ?? new Date();
  const [connections, snapshot] = await Promise.all([
    listConnectionStatuses(app),
    getSyncMonitorSnapshot(app, { now }),
  ]);

  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
  const thresholds = {
    lightMaxAgeMinutes: app.config.healthSyncLightMaxAgeMinutes,
    followerMaxAgeMinutes: app.config.healthSyncFollowerMaxAgeMinutes,
  };

  const pages = snapshot.pages.map((page) => {
    const connection = connectionsById.get(page.pageId);
    const lightAge = ageMinutes(connection?.lastLightSyncAt ?? null, now);
    const followerAge = page.platform === "fansly"
      ? ageMinutes(connection?.lastFollowerSyncAt ?? null, now)
      : null;
    const issues: string[] = [];

    if (!connection || connection.connectionStatus !== "active") {
      issues.push(`connection:${connection?.connectionStatus ?? "missing"}`);
    }

    if (lightAge === null) {
      issues.push("light_sync_missing");
    } else if (lightAge > thresholds.lightMaxAgeMinutes) {
      issues.push("light_sync_stale");
    }

    if (page.platform === "fansly") {
      if (followerAge === null) {
        issues.push("follower_sync_missing");
      } else if (followerAge > thresholds.followerMaxAgeMinutes) {
        issues.push("follower_sync_stale");
      }
    }

    if (page.summary.failedStreams > 0) {
      issues.push("failed_streams");
    }

    if (page.summary.stalledStreams > 0) {
      issues.push("stalled_streams");
    }

    const status: ServiceHealthStatus = issues.length > 0 ? "degraded" : "ok";

    return {
      pageId: page.pageId,
      pageLabel: page.pageLabel,
      platform: page.platform,
      modelSlug: page.modelSlug,
      modelName: page.modelName,
      status,
      connectionStatus: connection?.connectionStatus ?? "unverified",
      lastLightSyncAt: connection?.lastLightSyncAt ?? null,
      lightAgeMinutes: lightAge,
      lastFollowerSyncAt: connection?.lastFollowerSyncAt ?? null,
      followerAgeMinutes: followerAge,
      failedStreams: page.summary.failedStreams,
      stalledStreams: page.summary.stalledStreams,
      pendingStreams: page.summary.pendingStreams,
      lastErrorSummary: firstErrorSummary(page.streams) ?? connection?.lastSyncError ?? null,
      issues,
    };
  });

  const unhealthyPageCount = pages.filter((page) => page.status === "degraded").length;
  const status: ServiceHealthStatus = (
    unhealthyPageCount > 0 ||
    snapshot.overall.failedStreams > 0 ||
    snapshot.overall.stalledStreams > 0
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
        pageCount: snapshot.overall.pages,
        unhealthyPageCount,
        runningStreams: snapshot.overall.runningStreams,
        failedStreams: snapshot.overall.failedStreams,
        stalledStreams: snapshot.overall.stalledStreams,
        pendingStreams: snapshot.overall.pendingStreams,
        recentFailedRuns: snapshot.overall.recentRuns.failed,
        recent429s: snapshot.overall.recentErrors.total429s,
        recent5xxs: snapshot.overall.recentErrors.total5xxs,
      },
      pages,
    },
  };
}
