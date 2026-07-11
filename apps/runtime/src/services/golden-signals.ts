import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import {
  insertOpsMetricSamples,
  listRecentOpsMetricSamples,
  pruneOpsMetricSamples,
  type OpsMetricSampleInput,
  type OpsMetricSampleRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  computeHealthFloorBacklogMs,
  HEALTH_FLOOR_REGISTRY,
  HEALTH_FLOOR_THRESHOLD_MS,
} from "./health-floors.ts";
import {
  notifyOfapiGlobalIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

// Kernel Stage 25: the five golden signals — the acceptance instrument for
// the multi-worker rollout. Sampled minutely (p50/p95 over a trailing
// 10-minute window) into ops_metric_samples, served at
// GET /api/v1/ops/metrics, and alerted through the existing incident
// machinery when a p95 crosses its threshold.
//
// EXECUTION INTERPRETATION (recorded): "SSE delivery" is the smoke
// consumer's checkpoint staleness — append→receipt per frame would need
// receipt stamps the checkpoint deliberately doesn't keep; staleness bounds
// the same failure mode (a wedged consumer) with the data we already have.

export const OPS_METRICS_SAMPLE_QUEUE = "ops.metrics.sample";
const SAMPLE_WINDOW_MINUTES = 10;
// Stage 28: ops telemetry retention — 90 days (was a 14-day stopgap).
const RETENTION_DAYS = 90;

/** p95 alert thresholds (ms). Above = open incident; below = resolve.
 * W5.1 (A25): each metric owns its own incident latch
 * (golden_signal_lag:global:<metric>) — a standing breach on one signal no
 * longer masks the others. A metric that emits no sample this run keeps its
 * latch as-is (absence is never health). */
export const GOLDEN_SIGNAL_THRESHOLDS_MS: Record<string, number> = {
  capture: 60_000,
  canonicalize: 180_000,
  projection: 180_000,
  command_settle: 300_000,
  sse_delivery: 600_000,
  // W5.1 (B8): always-emit wedge gauges. The latency quantiles measure
  // COMPLETED work only — a fully wedged pipeline used to emit no sample and
  // read as healthy. These measure the oldest WAITING row (0 when idle).
  capture_pending_age: 600_000,
  // The W3.2 queued-TTL sweep cancels parked sends at 10 min — so a queued
  // row older than 15 min means the sweep ITSELF is dead (A4 visibility).
  command_queued_age: 900_000,
  // Stage 29 (DP 6 owner note): restricted-class volume guard — a gauge in
  // BYTES riding the p95 slot so the existing breach latch covers it.
  ai_content_bytes: 5_000_000_000,
  // Fast-reply freshness PR3: per-family observation-backlog gauges (health
  // floors) ride the p95 slot so the existing breach latch covers them.
  ...Object.fromEntries(
    HEALTH_FLOOR_REGISTRY.map((floor) => [floor.name, HEALTH_FLOOR_THRESHOLD_MS]),
  ),
};

export async function ensureOpsMetricsQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
): Promise<void> {
  await ensureQueueCreated(boss, OPS_METRICS_SAMPLE_QUEUE, {
    policy: "exclusive",
  }, createdQueues);
}

export async function ensureOpsMetricsSchedule(boss: QueueCreationClient): Promise<void> {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(OPS_METRICS_SAMPLE_QUEUE, "* * * * *", null, { tz: "UTC" });
}

interface QuantilePair {
  p50: number | null;
  p95: number | null;
}

function toSamples(metric: string, pair: QuantilePair): OpsMetricSampleInput[] {
  const samples: OpsMetricSampleInput[] = [];
  if (pair.p50 !== null && Number.isFinite(pair.p50)) {
    samples.push({ metric, quantile: "p50", valueMs: pair.p50 });
  }
  if (pair.p95 !== null && Number.isFinite(pair.p95)) {
    samples.push({ metric, quantile: "p95", valueMs: pair.p95 });
  }
  return samples;
}

async function quantiles(app: Pick<AppContext, "db">, query: ReturnType<typeof sql>): Promise<QuantilePair> {
  const result = await app.db.execute<{ p50: string | null; p95: string | null }>(query);
  const row = result.rows[0];
  return {
    p50: row?.p50 === null || row?.p50 === undefined ? null : Number(row.p50),
    p95: row?.p95 === null || row?.p95 === undefined ? null : Number(row.p95),
  };
}

export interface GoldenSignalsComputation {
  samples: OpsMetricSampleInput[];
  /** Health-floor probes that THREW (PR3): each must open/retain the
   * incident latch itself — a failed probe is a blind spot, not a zero. */
  failedProbes: string[];
}

/** Compute the five signals over the trailing window. No-traffic metrics
 * emit no rows (absence is visible on the endpoint as a stale series). */
export async function computeGoldenSignals(
  app: Pick<AppContext, "db">,
): Promise<GoldenSignalsComputation> {
  const windowSql = sql`now() - make_interval(mins => ${SAMPLE_WINDOW_MINUTES})`;

  // 1. Capture: webhook receipt → settled journal row.
  const capture = await quantiles(app, sql`
    select
      percentile_cont(0.5) within group (order by extract(epoch from (processed_at - received_at)) * 1000) as p50,
      percentile_cont(0.95) within group (order by extract(epoch from (processed_at - received_at)) * 1000) as p95
    from ofapi_webhook_events
    where processed_at is not null and processed_at > ${windowSql}
  `);

  // 2. Canonicalization: source observation → domain event append.
  const canonicalize = await quantiles(app, sql`
    select
      percentile_cont(0.5) within group (order by extract(epoch from (de.created_at - o.received_at)) * 1000) as p50,
      percentile_cont(0.95) within group (order by extract(epoch from (de.created_at - o.received_at)) * 1000) as p95
    from domain_events de
    join observations o on o.id = de.observation_id
    where de.observation_id > 0 and de.created_at > ${windowSql}
  `);

  // 3. Projection: backlog age per (projection, account) — the age of the
  // oldest event a projection has not consumed yet (0 when fully caught up).
  const projection = await quantiles(app, sql`
    with backlog as (
      select
        w.projection,
        w.account_id,
        coalesce(extract(epoch from (now() - min(de.created_at))) * 1000, 0) as lag_ms
      from projection_seq_watermarks w
      left join domain_events de
        on de.account_id = w.account_id and de.account_seq > w.high_seq
      group by w.projection, w.account_id
    )
    select
      percentile_cont(0.5) within group (order by lag_ms) as p50,
      percentile_cont(0.95) within group (order by lag_ms) as p95
    from backlog
  `);

  // 4. Command settle: enqueue → finalize.
  const commandSettle = await quantiles(app, sql`
    select
      percentile_cont(0.5) within group (order by extract(epoch from (attempt_finished_at - created_at)) * 1000) as p50,
      percentile_cont(0.95) within group (order by extract(epoch from (attempt_finished_at - created_at)) * 1000) as p95
    from ofapi_commands
    where attempt_finished_at is not null and attempt_finished_at > ${windowSql}
  `);

  // Failed/blind probes accumulate here; each opens/retains its incident
  // latch like a breach (a blind spot is never a silent zero).
  const failedProbes: string[] = [];

  // 5. SSE delivery: smoke-consumer checkpoint staleness (see header note).
  const smoke = await app.db.execute<{ staleness_ms: string | null }>(sql`
    select extract(epoch from (now() - updated_at)) * 1000 as staleness_ms
    from domain_events_smoke_checkpoint
    where id = 1
  `);
  const staleness = smoke.rows[0]?.staleness_ms === null || smoke.rows[0]?.staleness_ms === undefined
    ? null
    : Number(smoke.rows[0].staleness_ms);
  // W5.1 (B8): a MISSING checkpoint row used to yield no sample — invisible.
  // It is a blind spot: latch it via the failed-probe path.
  if (staleness === null) {
    failedProbes.push("sse_delivery");
  }

  // W5.1 (B8) always-emit wedge gauges: oldest waiting row per stage, 0 when
  // the queue is empty — "quiet" and "wedged" become distinguishable by
  // construction (quiet reads 0, wedged reads a growing age).
  const capturePending = await app.db.execute<{ age_ms: string | null }>(sql`
    select coalesce(extract(epoch from (now() - min(received_at))) * 1000, 0) as age_ms
    from ofapi_webhook_events
    where processed_at is null
  `);
  const capturePendingAge = Number(capturePending.rows[0]?.age_ms ?? 0);

  const queuedCommands = await app.db.execute<{ age_ms: string | null }>(sql`
    select coalesce(extract(epoch from (now() - min(created_at))) * 1000, 0) as age_ms
    from ofapi_commands
    where state = 'queued' and attempt_count = 0
  `);
  const commandQueuedAge = Number(queuedCommands.rows[0]?.age_ms ?? 0);

  // W5.5 (D9): acceptance projection liveness — events per trailing hour.
  // Gauge only (no threshold): visibility, not alerting.
  const acceptance = await app.db.execute<{ n: string }>(sql`
    select count(*)::text as n
    from ai_acceptance_events
    where occurred_at > now() - make_interval(hours => 1)
  `);
  const acceptanceEvents1h = Number(acceptance.rows[0]?.n ?? 0);

  // Stage 29: restricted-class capture volume (rows + total relation bytes).
  // Gauges, not latencies — they ride the same sample table; the byte gauge
  // carries the alert threshold.
  const aiVolume = await app.db.execute<{ rows: string; bytes: string }>(sql`
    select count(*)::text as rows,
           pg_total_relation_size('ai_generation_content')::text as bytes
    from ai_generation_content
  `);
  const aiRows = Number(aiVolume.rows[0]?.rows ?? 0);
  const aiBytes = Number(aiVolume.rows[0]?.bytes ?? 0);

  // Fast-reply freshness PR3: per-family observation-backlog gauges from the
  // shared health-floor registry. Per-family try/catch — one failed probe
  // must not suppress the rest, and it surfaces via failedProbes so the
  // latch treats a blind spot as a breach (never a silent zero).
  const floorSamples: OpsMetricSampleInput[] = [];
  for (const floor of HEALTH_FLOOR_REGISTRY) {
    try {
      const backlogMs = await computeHealthFloorBacklogMs(app.db, floor);
      floorSamples.push(...toSamples(floor.name, { p50: backlogMs, p95: backlogMs }));
    } catch {
      failedProbes.push(floor.name);
    }
  }

  return {
    samples: [
      ...toSamples("capture", capture),
      ...toSamples("canonicalize", canonicalize),
      ...toSamples("projection", projection),
      ...toSamples("command_settle", commandSettle),
      ...toSamples("sse_delivery", { p50: staleness, p95: staleness }),
      ...toSamples("capture_pending_age", { p50: capturePendingAge, p95: capturePendingAge }),
      ...toSamples("command_queued_age", { p50: commandQueuedAge, p95: commandQueuedAge }),
      ...toSamples("acceptance_events_1h", { p50: acceptanceEvents1h, p95: acceptanceEvents1h }),
      ...toSamples("ai_content_rows", { p50: aiRows, p95: aiRows }),
      ...toSamples("ai_content_bytes", { p50: aiBytes, p95: aiBytes }),
      ...floorSamples,
    ],
    failedProbes,
  };
}

export interface GoldenSignalRunResult {
  sampled: number;
  pruned: number;
  breaches: string[];
  resolved: string[];
}

// W5.4 (A14): the retention prune is no longer on the minutely tick — every
// N-th run is plenty for a 90-day window (first run of a fresh process still
// prunes, so a restart never postpones retention by more than an hour).
const PRUNE_EVERY_RUNS = 60;
let pruneTick = 0;

/** Test hook: make the next run a pruning run. */
export function resetGoldenSignalPruneTick() {
  pruneTick = 0;
}

/** The minutely job: sample, prune (hourly), and flip per-signal incidents.
 *
 * W5.1 (B8+A25) latch semantics, per metric that carries a threshold:
 * - sample over threshold, or a failed probe → open/retain
 *   `golden_signal_lag:global:<metric>`;
 * - sample under threshold → resolve that metric's incident;
 * - NO sample this run → leave the latch exactly as it is. Absence is never
 *   health: the old shared latch resolved on "no breaches", so a pipeline
 *   that died completely sent a false "✅ Resolved". */
export async function runGoldenSignalSample(
  app: Pick<AppContext, "db" | "config" | "logger">,
): Promise<GoldenSignalRunResult> {
  const { samples, failedProbes } = await computeGoldenSignals(app);
  await insertOpsMetricSamples(app.db, samples);
  const pruned = pruneTick++ % PRUNE_EVERY_RUNS === 0
    ? await pruneOpsMetricSamples(app.db, RETENTION_DAYS)
    : 0;

  const p95ByMetric = new Map<string, number>();
  for (const sample of samples) {
    if (sample.quantile === "p95") {
      p95ByMetric.set(sample.metric, sample.valueMs);
    }
  }

  const failed = new Set(failedProbes);
  const breaches: string[] = [];
  const healthy: string[] = [];
  for (const [metric, threshold] of Object.entries(GOLDEN_SIGNAL_THRESHOLDS_MS)) {
    // A failed probe is a blind spot: it opens/retains the incident exactly
    // like a threshold breach (PR3), even when no sample was emitted.
    if (failed.has(metric)) {
      breaches.push(metric);
      continue;
    }
    const value = p95ByMetric.get(metric);
    if (value === undefined) {
      continue; // absent: leave the latch as-is
    }
    (value > threshold ? breaches : healthy).push(metric);
  }
  // A failed probe for a metric outside the threshold registry still latches.
  for (const probe of failed) {
    if (GOLDEN_SIGNAL_THRESHOLDS_MS[probe] === undefined) {
      breaches.push(probe);
    }
  }

  for (const metric of breaches) {
    const threshold = GOLDEN_SIGNAL_THRESHOLDS_MS[metric];
    const value = p95ByMetric.get(metric);
    await notifyOfapiGlobalIncident(app, {
      kind: "golden_signal_lag",
      subKey: metric,
      errorSummary: failed.has(metric) && value === undefined
        ? `Golden-signal probe '${metric}' failed — blind spot, treated as a breach`
        : `Golden-signal ${metric} p95 ${Math.round(value ?? 0)}ms over threshold ${threshold}ms`,
    });
  }
  for (const metric of healthy) {
    await resolveOfapiGlobalIncident(app, { kind: "golden_signal_lag", subKey: metric });
  }

  // One-time migration: retire the legacy SHARED latch key
  // (`golden_signal_lag:global`) so a pre-W5 incident row can't sit open
  // forever now that nothing ever resolves it. Idempotent no-op afterwards.
  await resolveOfapiGlobalIncident(app, { kind: "golden_signal_lag" });

  return { sampled: samples.length, pruned, breaches, resolved: healthy };
}

export interface GoldenSignalsReport {
  samples: Array<Omit<OpsMetricSampleRow, "sampledAt"> & { sampledAt: string }>;
  thresholdsMs: Record<string, number>;
  smoke: { framesSeen: number; gapCount: number; duplicateCount: number; updatedAt: string | null } | null;
}

export async function getGoldenSignalsReport(
  app: Pick<AppContext, "db">,
): Promise<GoldenSignalsReport> {
  const rows = await listRecentOpsMetricSamples(app.db, { perSeries: 30 });
  const samples = rows.map((sample) => ({ ...sample, sampledAt: sample.sampledAt.toISOString() }));
  const smoke = await app.db.execute<{
    frames_seen: string;
    gap_count: string;
    duplicate_count: string;
    updated_at: Date;
  }>(sql`
    select frames_seen::text, gap_count::text, duplicate_count::text, updated_at
    from domain_events_smoke_checkpoint
    where id = 1
  `);
  const row = smoke.rows[0];
  return {
    samples,
    thresholdsMs: GOLDEN_SIGNAL_THRESHOLDS_MS,
    smoke: row
      ? {
        framesSeen: Number(row.frames_seen),
        gapCount: Number(row.gap_count),
        duplicateCount: Number(row.duplicate_count),
        updatedAt: new Date(row.updated_at).toISOString(),
      }
      : null,
  };
}

export function startGoldenSignalWorker(
  app: Pick<AppContext, "db" | "config" | "logger">,
  boss: Pick<PgBoss, "work">,
): Promise<string> {
  return boss.work(OPS_METRICS_SAMPLE_QUEUE, { batchSize: 1 }, async () => {
    const result = await runGoldenSignalSample(app);
    if (result.breaches.length > 0) {
      app.logger.warn({ breaches: result.breaches }, "golden-signal p95 over threshold");
    }
  });
}
