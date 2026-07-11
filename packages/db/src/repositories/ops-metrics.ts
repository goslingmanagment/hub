import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Kernel Stage 25: golden-signal sample store. The sampler appends p50/p95
// rows minutely; retention is a rolling prune until Stage 28's tiering.

export interface OpsMetricSampleInput {
  metric: string;
  quantile: "p50" | "p95";
  valueMs: number;
}

export async function insertOpsMetricSamples(
  db: Database,
  samples: readonly OpsMetricSampleInput[],
): Promise<void> {
  if (samples.length === 0) {
    return;
  }
  const values = samples.map((sample) =>
    sql`(${sample.metric}, ${Math.round(sample.valueMs)}, ${sample.quantile})`,
  );
  await db.execute(sql`
    insert into ops_metric_samples (metric, value_ms, quantile)
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
 * across every series; null when the table is empty. */
export async function getLatestOpsMetricSampleAt(db: Database): Promise<Date | null> {
  const result = await db.execute<{ latest: Date | string | null }>(sql`
    select max(sampled_at) as latest from ops_metric_samples
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

/** Latest N samples per (metric, quantile), newest first. */
export async function listRecentOpsMetricSamples(
  db: Database,
  input: { perSeries: number },
): Promise<OpsMetricSampleRow[]> {
  const result = await db.execute<{ metric: string; quantile: string; value_ms: string; sampled_at: Date }>(sql`
    select metric, quantile, value_ms::text, sampled_at
    from (
      select *, row_number() over (partition by metric, quantile order by sampled_at desc) as rn
      from ops_metric_samples
    ) ranked
    where rn <= ${input.perSeries}
    order by metric asc, quantile asc, sampled_at desc
  `);
  return result.rows.map((row) => ({
    metric: row.metric,
    quantile: row.quantile,
    valueMs: Number(row.value_ms),
    sampledAt: new Date(row.sampled_at),
  }));
}
