import { statfs } from "node:fs/promises";

import { sql } from "drizzle-orm";

import type { AppContext } from "../bootstrap.ts";
import {
  notifyOfapiGlobalIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

// Stage 1 retention stand-down containment: fact tables now grow forever, so
// the worker checks server disk usage hourly and pages the owner (via the
// notification-incident layer — one alert per state change) when the volume
// crosses the configured threshold.
export const DB_DISK_USAGE_CHECK_QUEUE = "db.disk-usage.check";

// The worker's root filesystem lives on the same VPS disk as the Postgres
// volume, so statfs("/") reflects the disk the fact tables grow on.
const DISK_USAGE_CHECK_PATH = "/";

const DEFAULT_DISK_USAGE_ALERT_PERCENT = 80;

export function resolveDiskUsageAlertPercent(
  config?: Pick<AppContext["config"], "diskUsageAlertPercent">,
) {
  return config?.diskUsageAlertPercent ?? DEFAULT_DISK_USAGE_ALERT_PERCENT;
}

export interface DiskUsageStats {
  bsize: number;
  blocks: number;
  bavail: number;
}

export function evaluateDiskUsage(stats: DiskUsageStats, thresholdPercent: number) {
  const totalBytes = stats.blocks * stats.bsize;
  const availableBytes = stats.bavail * stats.bsize;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const usedPercent = totalBytes > 0
    ? (1 - availableBytes / totalBytes) * 100
    : 0;
  return {
    usedPercent,
    usedBytes,
    totalBytes,
    availableBytes,
    breached: usedPercent >= thresholdPercent,
  };
}

export async function ensureDbDiskUsageQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, DB_DISK_USAGE_CHECK_QUEUE, {
    policy: "standard",
  }, createdQueues);
}

export async function ensureDbDiskUsageSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  // Hourly at :15, clear of the 02:00/02:30 cleanup slots.
  await boss.schedule(DB_DISK_USAGE_CHECK_QUEUE, "15 * * * *", null, { tz: "UTC" });
}

function formatGib(bytes: number) {
  return (bytes / (1024 ** 3)).toFixed(1);
}

async function persistStorageHealthSample(
  app: Pick<AppContext, "db">,
  input: {
    healthy: boolean;
    breached: boolean;
    checkedAt: Date;
    usedBytes: number | null;
    freeBytes: number | null;
    totalBytes: number | null;
    error: string | null;
  },
) {
  await app.db.execute(sql`
    insert into ofapi_storage_health_state (
      id, healthy, breached, checked_at,
      used_bytes, free_bytes, total_bytes, error, updated_at
    ) values (
      1, ${input.healthy}, ${input.breached}, ${input.checkedAt},
      ${input.usedBytes}, ${input.freeBytes}, ${input.totalBytes}, ${input.error}, ${input.checkedAt}
    )
    on conflict (id) do update set
      healthy = excluded.healthy,
      breached = excluded.breached,
      checked_at = excluded.checked_at,
      used_bytes = excluded.used_bytes,
      free_bytes = excluded.free_bytes,
      total_bytes = excluded.total_bytes,
      error = excluded.error,
      updated_at = excluded.updated_at
  `);
}

export async function runDbDiskUsageCheck(
  app: Pick<AppContext, "config" | "db" | "logger">,
  options?: {
    now?: Date;
    statfsImpl?: (path: string) => Promise<DiskUsageStats>;
  },
) {
  const checkedAt = options?.now ?? new Date();
  const thresholdPercent = resolveDiskUsageAlertPercent(app.config);
  const statfsImpl = options?.statfsImpl ?? ((path: string) => statfs(path));

  let stats: DiskUsageStats;
  try {
    stats = await statfsImpl(DISK_USAGE_CHECK_PATH);
  } catch (error) {
    const errorSummary = error instanceof Error ? error.message : String(error);
    await persistStorageHealthSample(app, {
      healthy: false,
      breached: false,
      checkedAt,
      usedBytes: null,
      freeBytes: null,
      totalBytes: null,
      error: errorSummary,
    });
    app.logger.warn({ err: error }, "Disk usage check failed to stat the filesystem");
    await notifyOfapiGlobalIncident(app, {
      kind: "db_disk_usage",
      errorSummary: `Disk health unavailable: ${errorSummary}`,
      occurredAt: checkedAt,
    });
    return {
      healthy: false,
      breached: false,
      checkedAt,
      usedBytes: null,
      totalBytes: null,
      availableBytes: null,
      usedPercent: null,
      thresholdPercent,
      databaseBytes: null,
      error: errorSummary,
    };
  }

  const usage = evaluateDiskUsage(stats, thresholdPercent);
  await persistStorageHealthSample(app, {
    healthy: !usage.breached,
    breached: usage.breached,
    checkedAt,
    usedBytes: usage.usedBytes,
    freeBytes: usage.availableBytes,
    totalBytes: usage.totalBytes,
    error: null,
  });

  // Postgres size is context for the alert text only; best-effort.
  let databaseBytes: number | null = null;
  try {
    const result = await app.db.execute<{ bytes: string }>(
      sql`select pg_database_size(current_database())::text as bytes`,
    );
    const raw = result.rows[0]?.bytes;
    databaseBytes = raw == null ? null : Number(raw);
  } catch (error) {
    app.logger.warn({ err: error }, "Disk usage check failed to read pg_database_size; continuing");
  }

  if (usage.breached) {
    await notifyOfapiGlobalIncident(app, {
      kind: "db_disk_usage",
      errorSummary: [
        `Disk ${usage.usedPercent.toFixed(1)}% used (threshold ${thresholdPercent}%)`,
        `free ${formatGib(usage.availableBytes)} GiB of ${formatGib(usage.totalBytes)} GiB`,
        ...(databaseBytes !== null ? [`Postgres ${formatGib(databaseBytes)} GiB`] : []),
      ].join("; "),
      occurredAt: checkedAt,
    });
  } else {
    await resolveOfapiGlobalIncident(app, {
      kind: "db_disk_usage",
      recoveredAt: checkedAt,
    });
  }

  return {
    healthy: !usage.breached,
    ...usage,
    checkedAt,
    thresholdPercent,
    databaseBytes,
    error: null,
  };
}
