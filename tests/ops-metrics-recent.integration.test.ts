import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listRecentOpsMetricSamples } from "@agency_hub_core/db";

import { startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let harness: StartedTestDatabase;
beforeAll(async () => { harness = await startTestDatabase(); }, 120_000);
afterAll(async () => { await harness?.stop(); });
beforeEach(async () => { await harness.pool.query("truncate ops_metric_samples"); });

const LEGACY_RECENT = `
  select metric, quantile, value_ms::text, sampled_at
  from (
    select *, row_number() over (partition by metric, quantile order by sampled_at desc) as rn
    from ops_metric_samples
  ) ranked
  where rn <= $1
  order by metric asc, quantile asc, sampled_at desc
`;

interface PlanNode {
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
}

function samplesVisited(plan: PlanNode): number {
  const own = plan["Relation Name"] === "ops_metric_samples"
    ? ((plan["Actual Rows"] ?? 0) + (plan["Rows Removed by Filter"] ?? 0))
      * (plan["Actual Loops"] ?? 0)
    : 0;
  return own + (plan.Plans ?? []).reduce((total, child) => total + samplesVisited(child), 0);
}

async function captureRecentStatement() {
  const pool = harness.pool as unknown as {
    query: (config: unknown, values?: unknown) => Promise<unknown>;
  };
  const original = pool.query.bind(pool);
  let statement: { text: string; values: unknown[] } | undefined;
  pool.query = (config, values) => {
    if (typeof config === "string") {
      statement = { text: config, values: (values as unknown[]) ?? [] };
    } else if (config && typeof (config as { text?: unknown }).text === "string") {
      const query = config as { text: string; values?: unknown[] };
      statement = { text: query.text, values: (values as unknown[]) ?? query.values ?? [] };
    }
    return original(config, values);
  };
  try {
    await listRecentOpsMetricSamples(harness.db, { perSeries: 30 });
  } finally {
    pool.query = original;
  }
  if (!statement) throw new Error("Recent-samples query did not reach the pool");
  return statement;
}

async function legacyRecent(perSeries: number) {
  const result = await harness.pool.query<{
    metric: string; quantile: string; value_ms: string; sampled_at: Date;
  }>(LEGACY_RECENT, [perSeries]);
  return result.rows.map((row) => ({
    metric: row.metric, quantile: row.quantile,
    valueMs: Number(row.value_ms), sampledAt: new Date(row.sampled_at),
  }));
}

describe("recent ops samples", () => {
  it("preserves empty and non-positive-limit results", async () => {
    expect(await listRecentOpsMetricSamples(harness.db, { perSeries: 30 })).toEqual([]);
    await harness.pool.query(`
      insert into ops_metric_samples (metric, quantile, value_ms)
      values ('capture', 'p95', 123)
    `);
    for (const perSeries of [0, -1]) {
      expect(await listRecentOpsMetricSamples(harness.db, { perSeries }))
        .toEqual(await legacyRecent(perSeries));
    }
  });

  it("preserves every stored series and SQL collation order without a time cutoff", async () => {
    // Both key columns are non-null TEXT, not enums. Include empty/Unicode
    // names and a new quantile so enumeration cannot depend on today's registry.
    // Vary series sizes and insert in reverse time order to require time ordering.
    await harness.pool.query(`
      insert into ops_metric_samples (metric, quantile, value_ms, sampled_at)
      select metric, quantile, n,
        '2026-09-12T12:00:00Z'::timestamptz - n * interval '1 minute'
      from (values ('capture', 'p50'), ('capture', 'p95'), ('custom', 'p99'),
        ('', ''), ('Å metric', 'quantile'), ('z metric', 'p50')) series(metric, quantile)
      cross join generate_series(1, 65) n;
      insert into ops_metric_samples (metric, quantile, value_ms, sampled_at)
      values ('retired', 'p50', 101, '2000-01-01'),
        ('retired', 'p95', 102, '2000-01-02'),
        ('sparse', 'p50', 103, '2010-01-01'),
        ('sparse', 'p50', 104, '2026-09-12');
    `);
    for (const perSeries of [1, 2, 30, 100]) {
      expect(await listRecentOpsMetricSamples(harness.db, { perSeries }))
        .toEqual(await legacyRecent(perSeries));
    }
  });

  it("keeps timestamp ties without imposing a new tie-break contract", async () => {
    await harness.pool.query(`
      insert into ops_metric_samples (metric, quantile, value_ms, sampled_at)
      select 'ties', 'p95', n, '2026-09-12T12:00:00Z'::timestamptz
      from generate_series(1, 40) n;
      insert into ops_metric_samples (metric, quantile, value_ms, sampled_at)
      values ('ties', 'p95', 1000, '2026-09-12T12:01:00Z'),
        ('ties', 'p95', -1000, '2026-09-12T11:59:00Z');
    `);
    const rows = await listRecentOpsMetricSamples(harness.db, { perSeries: 30 });
    expect(rows).toHaveLength(30);
    expect(rows[0]?.valueMs).toBe(1000);
    expect(new Set(rows.map((row) => row.valueMs)).size).toBe(30);
    expect(rows.slice(1).every((row) => row.valueMs >= 1 && row.valueMs <= 40
      && row.sampledAt.toISOString() === "2026-09-12T12:00:00.000Z")).toBe(true);
    // With the whole tie set included, result membership must match exactly.
    const complete = await listRecentOpsMetricSamples(harness.db, { perSeries: 50 });
    expect(complete.map((row) => row.valueMs).sort((a, b) => a - b))
      .toEqual((await legacyRecent(50)).map((row) => row.valueMs).sort((a, b) => a - b));
  });

  it("enumerates a newly added series and forgets an empty series after retention", async () => {
    await harness.pool.query(`
      insert into ops_metric_samples (metric, quantile, value_ms)
      values ('before', 'p95', 1)
    `);
    expect((await listRecentOpsMetricSamples(harness.db, { perSeries: 30 }))
      .map((row) => row.metric)).toEqual(["before"]);
    // Simulate retention leaving no row of the old series; there is no stale
    // registry to consult or maintain. TRUNCATE is local fixture setup only.
    await harness.pool.query("truncate ops_metric_samples");
    await harness.pool.query(`
      insert into ops_metric_samples (metric, quantile, value_ms)
      values ('after', 'p10', 2)
    `);
    expect((await listRecentOpsMetricSamples(harness.db, { perSeries: 30 }))
      .map((row) => row.metric)).toEqual(["after"]);
  });

  it("bounds PostgreSQL row visits by series and limit instead of retained history", async () => {
    await harness.pool.query(`
      insert into ops_metric_samples (metric, quantile, value_ms, sampled_at)
      select 'metric_' || series, quantile, n,
        '2026-09-12T12:00:00Z'::timestamptz - n * interval '1 minute'
      from generate_series(1, 5) series
      cross join (values ('p50'), ('p95')) quantiles(quantile)
      cross join generate_series(1, 5000) n
    `);
    // Each sparse prefix must stay visible without scanning a later dense
    // series. Include first/middle/last prefixes and a same-metric quantile.
    // Their timestamps are deliberately older than all dense-series samples.
    await harness.pool.query(`
      insert into ops_metric_samples (metric, quantile, value_ms, sampled_at)
      values ('metric_0', 'p50', -1, '2000-01-01'),
        ('metric_3', 'p90', -2, '2000-01-01'),
        ('metric_9', 'p95', -3, '2000-01-01')
    `);
    await harness.pool.query("analyze ops_metric_samples");
    const statement = await captureRecentStatement();
    const explain = async (text: string, values: unknown[]) => {
      const result = await harness.pool.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
        `explain (analyze, buffers, format json) ${text}`, values,
      );
      return result.rows[0]!["QUERY PLAN"][0]!.Plan;
    };
    // No planner switches: this is the path chosen with production indexes.
    const oldPlan = await explain(LEGACY_RECENT, [30]);
    const newPlan = await explain(statement.text, statement.values);
    expect(samplesVisited(oldPlan)).toBeGreaterThanOrEqual(50_003);
    expect(samplesVisited(newPlan)).toBeLessThan(500);
    expect(JSON.stringify(newPlan)).toContain("ops_metric_samples_series_time_idx");
    expect(await listRecentOpsMetricSamples(harness.db, { perSeries: 30 }))
      .toEqual(await legacyRecent(30));
  });
});
