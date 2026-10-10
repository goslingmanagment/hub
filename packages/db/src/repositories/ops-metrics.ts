import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Kernel Stage 25: golden-signal sample store. The sampler appends p50/p95
// rows minutely; retention is a rolling prune until Stage 28's tiering.

export interface OpsMetricSampleInput {
  metric: string;
  quantile: "p50" | "p95";
  valueMs: number;
  /** Explicit sample time; omitted = now() (the minutely sampler's default).
   * Set by writers that sample on their own clock (the hourly disk check
   * stamps every gauge with the timestamp of the check that produced it). */
  sampledAt?: Date;
}

export async function insertOpsMetricSamples(
  db: Database,
  samples: readonly OpsMetricSampleInput[],
): Promise<void> {
  if (samples.length === 0) {
    return;
  }
  const values = samples.map((sample) =>
    sql`(${sample.metric}, ${Math.round(sample.valueMs)}, ${sample.quantile}, ${
      sample.sampledAt ?? sql`now()`
    })`,
  );
  await db.execute(sql`
    insert into ops_metric_samples (metric, value_ms, quantile, sampled_at)
    values ${sql.join(values, sql`, `)}
  `);
}

export async function pruneOpsMetricSamples(db: Database, retentionDays: number): Promise<number> {
  const result = await db.execute(sql`
    delete from ops_metric_samples
    where sampled_at < now() - make_interval(days => ${retentionDays})
  `);
  return result.rowCount ?? 0;
}

/** W5.2 (A53): the ops watchdog's sampler deadman — newest sample timestamp
 * across every series; null when the table is empty.
 *
 * `disk_*` gauges are EXCLUDED on purpose: they are written HOURLY by the disk
 * check (db-disk-alert.ts), not by the minutely golden-signal sampler. Counting
 * them would let a dead sampler read as alive for up to an hour after every
 * disk row, making ops_sampler_silent flap hourly instead of latching. The
 * `process_*` memory gauges are excluded for the same reason: every role's
 * heartbeat writes them (runtime-heartbeat.ts), sampler or not. The
 * `\_` escape keeps the underscore literal (LIKE treats a bare `_` as a
 * wildcard); the sampled_at index still serves this as a backward index scan
 * with a filter, and sampler rows are ~11/min, so the first row matches at
 * once. */
export async function getLatestOpsMetricSampleAt(db: Database): Promise<Date | null> {
  const result = await db.execute<{ latest: Date | string | null }>(sql`
    select max(sampled_at) as latest from ops_metric_samples
    where metric not like 'disk\\_%' and metric not like 'process\\_%'
  `);
  const latest = result.rows[0]?.latest;
  return latest ? new Date(latest) : null;
}

export interface OpsMetricSampleRow {
  metric: string;
  quantile: string;
  valueMs: number;
  sampledAt: Date;
}

/** G1.5: one series' history since a cutoff, OLDEST first — the shape a
 * least-squares days-to-full fit consumes (db-disk-alert.ts). Served by
 * ops_metric_samples_metric_time_idx (metric, sampled_at DESC); the DESC index
 * scans an ascending range just as well. `since` is exclusive of nothing —
 * the boundary sample is included so a 24h window keeps its oldest point. */
export async function listOpsMetricSamplesSince(
  db: Database,
  input: { metric: string; quantile: "p50" | "p95"; since: Date },
): Promise<OpsMetricSampleRow[]> {
  const result = await db.execute<
    { metric: string; quantile: string; value_ms: string; sampled_at: Date }
  >(sql`
    select metric, quantile, value_ms::text, sampled_at
    from ops_metric_samples
    where metric = ${input.metric}
      and quantile = ${input.quantile}
      and sampled_at >= ${input.since}
    order by sampled_at asc
  `);
  return result.rows.map((row) => ({
    metric: row.metric,
    quantile: row.quantile,
    valueMs: Number(row.value_ms),
    sampledAt: new Date(row.sampled_at),
  }));
}

/** Latest N samples per (metric, quantile), newest first.
 *
 * Enumerate the stored series by jumping to the next index prefix, then read
 * only N rows per series. DISTINCT/window ranking would still visit the entire
 * retained history. The recursive scan needs migration 0186's series/time
 * index; unlike a registry or a time cutoff it also finds old/unknown series.
 * Both phases share one statement snapshot, including concurrent prune/insert.
 * Equal timestamps retain the previous query's unspecified tie order. */
export async function listRecentOpsMetricSamples(
  db: Database,
  input: { perSeries: number },
): Promise<OpsMetricSampleRow[]> {
  if (input.perSeries <= 0) {
    return [];
  }
  const result = await db.execute<{ metric: string; quantile: string; value_ms: string; sampled_at: Date }>(sql`
    with recursive series (metric, quantile) as (
      (
        select s.metric, s.quantile
        from ops_metric_samples s
        order by s.metric asc, s.quantile asc
        limit 1
      )
      union all
      select next_series.metric, next_series.quantile
      from series previous
      cross join lateral (
        select s.metric, s.quantile
        from ops_metric_samples s
        where (s.metric, s.quantile) > (previous.metric, previous.quantile)
        order by s.metric asc, s.quantile asc
        limit 1
      ) next_series
    )
    select series.metric, series.quantile, sample.value_ms::text, sample.sampled_at
    from series
    cross join lateral (
      -- Keep the full index order meaningful: equality inside this subquery
      -- lets PostgreSQL choose the global time index and filter other series.
      -- The requested prefix comes first; LIMIT bounds the read even when it
      -- has fewer than N rows. Filter spillover only OUTSIDE this limit.
      select s.metric, s.quantile, s.value_ms, s.sampled_at
      from ops_metric_samples s
      where (s.metric, s.quantile) >= (series.metric, series.quantile)
      order by s.metric asc, s.quantile asc, s.sampled_at desc
      limit ${input.perSeries}
    ) sample
    where sample.metric = series.metric and sample.quantile = series.quantile
    order by series.metric asc, series.quantile asc, sample.sampled_at desc
  `);
  return result.rows.map((row) => ({
    metric: row.metric,
    quantile: row.quantile,
    valueMs: Number(row.value_ms),
    sampledAt: new Date(row.sampled_at),
  }));
}
