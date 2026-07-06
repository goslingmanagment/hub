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

/** p95 alert thresholds (ms). Above = open incident; below = resolve. */
export const GOLDEN_SIGNAL_THRESHOLDS_MS: Record<string, number> = {
  capture: 60_000,
  canonicalize: 180_000,
  projection: 180_000,
  command_settle: 300_000,
  sse_delivery: 600_000,
  // Stage 29 (DP 6 owner note): restricted-class volume guard — a gauge in
  // BYTES riding the p95 slot so the existing breach latch covers it.
  ai_content_bytes: 5_000_000_000,
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

/** Compute the five signals over the trailing window. No-traffic metrics
 * emit no rows (absence is visible on the endpoint as a stale series). */
export async function computeGoldenSignals(
  app: Pick<AppContext, "db">,
): Promise<OpsMetricSampleInput[]> {
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

  // 5. SSE delivery: smoke-consumer checkpoint staleness (see header note).
  const smoke = await app.db.execute<{ staleness_ms: string | null }>(sql`
    select extract(epoch from (now() - updated_at)) * 1000 as staleness_ms
    from domain_events_smoke_checkpoint
    where id = 1
  `);
  const staleness = smoke.rows[0]?.staleness_ms === null || smoke.rows[0]?.staleness_ms === undefined
    ? null
    : Number(smoke.rows[0].staleness_ms);

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

  return [
    ...toSamples("capture", capture),
    ...toSamples("canonicalize", canonicalize),
    ...toSamples("projection", projection),
    ...toSamples("command_settle", commandSettle),
    ...toSamples("sse_delivery", { p50: staleness, p95: staleness }),
    ...toSamples("ai_content_rows", { p50: aiRows, p95: aiRows }),
    ...toSamples("ai_content_bytes", { p50: aiBytes, p95: aiBytes }),
  ];
}

export interface GoldenSignalRunResult {
  sampled: number;
  pruned: number;
  breaches: string[];
}

/** The minutely job: sample, prune, and flip the threshold incident. */
export async function runGoldenSignalSample(
  app: Pick<AppContext, "db" | "config" | "logger">,
): Promise<GoldenSignalRunResult> {
  const samples = await computeGoldenSignals(app);
  await insertOpsMetricSamples(app.db, samples);
  const pruned = await pruneOpsMetricSamples(app.db, RETENTION_DAYS);

  const breaches = samples
    .filter((sample) => sample.quantile === "p95")
    .filter((sample) => {
      const threshold = GOLDEN_SIGNAL_THRESHOLDS_MS[sample.metric];
      return threshold !== undefined && sample.valueMs > threshold;
    })
    .map((sample) => sample.metric);

  if (breaches.length > 0) {
    await notifyOfapiGlobalIncident(app, {
      kind: "golden_signal_lag",
      errorSummary: `Golden-signal p95 over threshold: ${breaches.join(", ")}`,
    });
  } else {
    await resolveOfapiGlobalIncident(app, { kind: "golden_signal_lag" });
  }

  return { sampled: samples.length, pruned, breaches };
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
