import { statfs } from "node:fs/promises";

import { sql } from "drizzle-orm";

import { insertOpsMetricSamples, listOpsMetricSamplesSince } from "@agency_hub_core/db";

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

// G1.5 days-to-full. The 80% gauge only fires once the disk is nearly gone;
// the slope of `disk_free_bytes` says WHEN it will be gone, which is the number
// that decides whether a purge can wait for a maintenance window. No config
// knobs: these are containment thresholds, not tuning surface.
const RUNWAY_WARNING_DAYS = 30;
const RUNWAY_CRITICAL_DAYS = 7;
/** Below this arc an hourly gauge series is noise — one restart-sized blip
 * dominates the fit and invents a slope. Under it, runway is UNKNOWN (never a
 * breach, never a resolve). */
const RUNWAY_MIN_SPAN_MS = 6 * 60 * 60 * 1000;
/** The fit window that drives the latches; the 7d pull is a secondary readout
 * printed alongside it (a slow trend that a 24h dip would otherwise hide). */
const RUNWAY_FIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RUNWAY_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const BYTES_PER_GIB = 1024 ** 3;

export interface RunwaySample {
  valueMs: number;
  sampledAt: Date;
}

export interface RunwayEstimate {
  /** Days until free bytes reach zero at the fitted rate. */
  days: number;
  /** Fitted slope of free bytes, always negative here (a shrinking disk). */
  bytesPerDay: number;
}

function validRunwaySamples(samples: readonly RunwaySample[]) {
  return samples.filter((sample) =>
    Number.isFinite(sample.valueMs) && Number.isFinite(sample.sampledAt.getTime())
  );
}

/** Whether the series covers enough time for a slope to mean anything. The
 * caller needs this SEPARATELY from computeRunwayDays: a null estimate means
 * either "no history" (skip the latches entirely) or "not shrinking" (resolve
 * them) — only the span tells the two apart. */
export function hasRunwayHistory(samples: readonly RunwaySample[]): boolean {
  const valid = validRunwaySamples(samples);
  if (valid.length < 2) {
    return false;
  }
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const sample of valid) {
    const time = sample.sampledAt.getTime();
    earliest = Math.min(earliest, time);
    latest = Math.max(latest, time);
  }
  return latest - earliest >= RUNWAY_MIN_SPAN_MS;
}

/**
 * Least-squares fit of free bytes over time; days until the fitted line hits
 * zero, measured from `now` (never Date.now() — the check passes its own
 * clock so a replayed history is deterministic).
 *
 * null means "no runway to report": too short a span, a degenerate fit, or a
 * non-negative slope (a disk that is flat or growing free space has no
 * days-to-full). Time is carried in DAYS so the products stay small — bytes
 * are ~1e11 and a ms-scaled x would push the sums toward the float-precision
 * cliff.
 */
export function computeRunwayDays(
  samples: readonly RunwaySample[],
  now: Date,
): RunwayEstimate | null {
  if (!hasRunwayHistory(samples)) {
    return null;
  }
  const nowMs = now.getTime();
  const points = validRunwaySamples(samples).map((sample) => ({
    x: (sample.sampledAt.getTime() - nowMs) / MS_PER_DAY,
    y: sample.valueMs,
  }));
  const count = points.length;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / count;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / count;
  let covariance = 0;
  let varianceX = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    covariance += dx * (point.y - meanY);
    varianceX += dx * dx;
  }
  if (varianceX <= 0) {
    return null; // every sample landed on the same instant
  }
  const bytesPerDay = covariance / varianceX;
  if (!Number.isFinite(bytesPerDay) || bytesPerDay >= 0) {
    return null; // disk not shrinking
  }
  // Fitted free bytes at x = 0, i.e. at `now` — steadier than the last raw
  // reading, which a single checkpoint burst can spike.
  const freeBytesAtNow = meanY - bytesPerDay * meanX;
  const days = Math.max(0, freeBytesAtNow / -bytesPerDay);
  return Number.isFinite(days) ? { days, bytesPerDay } : null;
}

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

/**
 * Free bytes on the volume the fact tables grow on — THE one reader.
 *
 * G5's historical rewrite (services/capture-rewrite) needs the same number this
 * gauge has been trending all along, and for a while it had its own private
 * `statfs("/")` beside this one with a comment claiming they agreed. Two
 * implementations of "how much room is left" is one more than a containment
 * project can afford: the day the gauge learns about a second volume, a bind
 * mount, or a reserved-blocks correction, the rewrite's headroom law must learn
 * it in the same commit or it starts admitting runs the alarm would refuse.
 *
 * Node's `statfs` rather than PostgreSQL: `pg_stat_file` and friends need
 * superuser, and this number is about the FILESYSTEM, not the database.
 */
export async function readDiskFreeBytes(
  statfsImpl: (path: string) => Promise<DiskUsageStats> = (path) => statfs(path),
): Promise<number> {
  const stats = await statfsImpl(DISK_USAGE_CHECK_PATH);
  return Number(stats.bavail) * Number(stats.bsize);
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

/** Basis points (percent × 100) so the gauge stays an integer: value_ms is
 * BIGINT and insertOpsMetricSamples rounds, so a fractional percent would be
 * silently truncated to whole percents — too coarse for a days-to-full slope. */
function toBasisPoints(percent: number) {
  return Math.round(percent * 100);
}

/** Capacity history for a later days-to-full slope. Three point gauges per
 * hourly check, all under quantile 'p50' (these are single readings, not
 * distributions). Deliberately alert-free: none of these metrics appears in
 * GOLDEN_SIGNAL_THRESHOLDS_MS, so nothing evaluates or pages on them here.
 * The sampler deadman skips `disk_*` rows (getLatestOpsMetricSampleAt) — an
 * hourly writer must never stand in for the minutely sampler.
 * Best-effort: a failed insert must not cost us the disk alert itself. */
async function persistDiskCapacityGauges(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    checkedAt: Date;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
  },
) {
  try {
    await insertOpsMetricSamples(app.db, [
      {
        metric: "disk_free_bytes",
        quantile: "p50",
        valueMs: Math.round(input.availableBytes),
        sampledAt: input.checkedAt,
      },
      {
        metric: "disk_used_bytes",
        quantile: "p50",
        valueMs: Math.round(input.usedBytes),
        sampledAt: input.checkedAt,
      },
      {
        metric: "disk_used_percent_bp",
        quantile: "p50",
        valueMs: toBasisPoints(input.usedPercent),
        sampledAt: input.checkedAt,
      },
    ]);
  } catch (error) {
    app.logger.warn({ err: error }, "Disk usage check failed to record capacity gauges; continuing");
  }
}

/** Best-effort: a history read that fails leaves runway UNKNOWN (empty series
 * ⇒ no latch is opened and none is resolved), never breaks the disk alert. */
async function loadDiskFreeHistory(
  app: Pick<AppContext, "db" | "logger">,
  checkedAt: Date,
): Promise<RunwaySample[]> {
  try {
    return await listOpsMetricSamplesSince(app.db, {
      metric: "disk_free_bytes",
      quantile: "p50",
      since: new Date(checkedAt.getTime() - RUNWAY_HISTORY_WINDOW_MS),
    });
  } catch (error) {
    app.logger.warn({ err: error }, "Disk usage check failed to read capacity history; runway unknown");
    return [];
  }
}

function formatGibPerDay(bytesPerDay: number) {
  return (bytesPerDay / BYTES_PER_GIB).toFixed(2);
}

function describeRunway(input: {
  hasHistory: boolean;
  runway: RunwayEstimate | null;
  runway7d: RunwayEstimate | null;
}) {
  if (!input.hasHistory) {
    return "runway insufficient history";
  }
  if (!input.runway) {
    return "runway n/a (24h slope flat or free space growing)";
  }
  const secondary = input.runway7d ? `; 7d ~${input.runway7d.days.toFixed(1)} days` : "";
  return `runway ~${input.runway.days.toFixed(1)} days`
    + ` (24h slope ${formatGibPerDay(input.runway.bytesPerDay)} GiB/day${secondary})`;
}

/**
 * One runway threshold = one latch of its own (`db_disk_usage:global:<subKey>`).
 * The plain `db_disk_usage` latch cannot carry these: it is already open at 88%
 * and the incident layer returns 'existing' without re-paging, so runway text
 * appended to that alert reaches nobody.
 *
 * Symmetry: this is called ONLY when the series has enough span, so `runway ===
 * null` here means "measured, and the disk is not shrinking" — which resolves.
 * An open runway_critical therefore clears once the slope flattens instead of
 * standing open forever. Callers skip this entirely on unknown history.
 */
async function driveRunwayLatch(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    subKey: "runway_warning" | "runway_critical";
    thresholdDays: number;
    runway: RunwayEstimate | null;
    context: readonly string[];
    checkedAt: Date;
  },
) {
  if (input.runway && input.runway.days < input.thresholdDays) {
    await notifyOfapiGlobalIncident(app, {
      kind: "db_disk_usage",
      subKey: input.subKey,
      errorSummary: [
        `Disk fills in ~${input.runway.days.toFixed(1)} days`
        + ` (threshold ${input.thresholdDays} days,`
        + ` 24h slope ${formatGibPerDay(input.runway.bytesPerDay)} GiB/day)`,
        ...input.context,
      ].join("; "),
      occurredAt: input.checkedAt,
    });
    return;
  }
  await resolveOfapiGlobalIncident(app, {
    kind: "db_disk_usage",
    subKey: input.subKey,
    recoveredAt: input.checkedAt,
  });
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
      // No reading this pass ⇒ no runway and no latch traffic: the runway
      // latches are driven only from a measured series (see below).
      runwayDays: null,
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
  await persistDiskCapacityGauges(app, {
    checkedAt,
    usedBytes: usage.usedBytes,
    availableBytes: usage.availableBytes,
    usedPercent: usage.usedPercent,
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

  // G1.5: the gauges this check just wrote plus the last 7 days of them.
  const history = await loadDiskFreeHistory(app, checkedAt);
  const fitWindow = history.filter((sample) =>
    sample.sampledAt.getTime() >= checkedAt.getTime() - RUNWAY_FIT_WINDOW_MS
  );
  const hasHistory = hasRunwayHistory(fitWindow);
  const runway = computeRunwayDays(fitWindow, checkedAt);
  const capacityContext = [
    `free ${formatGib(usage.availableBytes)} GiB of ${formatGib(usage.totalBytes)} GiB`,
    ...(databaseBytes !== null ? [`Postgres ${formatGib(databaseBytes)} GiB`] : []),
  ];

  if (usage.breached) {
    await notifyOfapiGlobalIncident(app, {
      kind: "db_disk_usage",
      errorSummary: [
        `Disk ${usage.usedPercent.toFixed(1)}% used (threshold ${thresholdPercent}%)`,
        ...capacityContext,
        // Context only: this latch is already open at this point on most
        // passes, so nothing here pages by itself — the subKey latches below do.
        describeRunway({ hasHistory, runway, runway7d: computeRunwayDays(history, checkedAt) }),
      ].join("; "),
      occurredAt: checkedAt,
    });
  } else {
    await resolveOfapiGlobalIncident(app, {
      kind: "db_disk_usage",
      recoveredAt: checkedAt,
    });
  }

  // Unknown runway is not a state: with too little history neither latch is
  // touched, so a measurement that opened one is never resolved by ignorance
  // (a restarted worker with a pruned series must not silently clear a
  // critical). Warning and critical are independent latches, which costs
  // exactly ONE extra page when a warning escalates to critical (both end up
  // open) — deliberate: a single latch cannot re-page on severity without
  // dropping the latch that keeps it from paging hourly.
  if (hasHistory) {
    await driveRunwayLatch(app, {
      subKey: "runway_warning",
      thresholdDays: RUNWAY_WARNING_DAYS,
      runway,
      context: capacityContext,
      checkedAt,
    });
    await driveRunwayLatch(app, {
      subKey: "runway_critical",
      thresholdDays: RUNWAY_CRITICAL_DAYS,
      runway,
      context: capacityContext,
      checkedAt,
    });
  }

  return {
    healthy: !usage.breached,
    ...usage,
    checkedAt,
    thresholdPercent,
    databaseBytes,
    runwayDays: runway?.days ?? null,
    error: null,
  };
}
