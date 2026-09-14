// Run serially with other Testcontainers work:
// node --import tsx/esm scripts/benchmark-ops-metrics.mjs [samples-per-series]
// Uses ONLY a disposable PostgreSQL 16 container. No external DB URL is read.
// Default: 20 dense series x 50,000 samples plus two discontinued series.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GenericContainer, Wait } from "testcontainers";

import { createDb, createPool } from "../packages/db/src/client.ts";
import { runMigrations } from "../packages/db/src/migrate-runner.ts";
import { listRecentOpsMetricSamples } from "../packages/db/src/repositories/ops-metrics.ts";

const samplesPerSeries = Number(process.argv[2] ?? 50_000);
if (!Number.isSafeInteger(samplesPerSeries) || samplesPerSeries < 1000 || samplesPerSeries > 100_000
  || process.argv.length > 3) {
  throw new Error("Usage: node --import tsx/esm scripts/benchmark-ops-metrics.mjs [1000..100000]");
}
const perSeries = 30;
const legacy = `
  select metric, quantile, value_ms::text, sampled_at
  from (
    select *, row_number() over (partition by metric, quantile order by sampled_at desc) as rn
    from ops_metric_samples
  ) ranked
  where rn <= $1
  order by metric asc, quantile asc, sampled_at desc
`;

function tableRowsVisited(plan) {
  const own = plan["Relation Name"] === "ops_metric_samples"
    ? ((plan["Actual Rows"] ?? 0) + (plan["Rows Removed by Filter"] ?? 0))
      * (plan["Actual Loops"] ?? 0)
    : 0;
  return own + (plan.Plans ?? []).reduce((total, child) => total + tableRowsVisited(child), 0);
}

const container = await new GenericContainer("postgres:16-alpine")
  .withEnvironment({ POSTGRES_DB: "metrics_benchmark", POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres" })
  .withCommand(["postgres", "-c", "jit=off", "-c", "max_parallel_workers_per_gather=0", "-c", "work_mem=16MB"])
  .withExposedPorts(5432)
  .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
  .withStartupTimeout(120_000)
  .start();
const pool = createPool(`postgres://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/metrics_benchmark`);

try {
  const client = await pool.connect();
  try {
    await runMigrations({
      db: client,
      migrationsDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/db/migrations"),
      through: "0186_ops_metrics_recent_series.sql",
    });
  } finally {
    client.release();
  }
  await pool.query(`
    insert into ops_metric_samples (metric, quantile, value_ms, sampled_at)
    select 'metric_' || lpad(series::text, 2, '0'), quantile, n,
      '2026-09-12T12:00:00Z'::timestamptz - n * interval '1 minute'
    from generate_series(1, 10) series
    cross join (values ('p50'), ('p95')) quantiles(quantile)
    cross join generate_series(1, $1::int) n
  `, [samplesPerSeries]);
  await pool.query(`
    insert into ops_metric_samples (metric, quantile, value_ms, sampled_at)
    values ('retired', 'p95', 9, '2000-01-01'), ('unknown', 'p99', 11, '2001-01-01')
  `);
  await pool.query("vacuum (analyze) ops_metric_samples");

  // Capture the actual repository statement; this benchmark never keeps a
  // second handwritten copy of the optimized query that could silently drift.
  const originalQuery = pool.query.bind(pool);
  let statement;
  pool.query = (config, values, ...rest) => {
    statement = typeof config === "string"
      ? { text: config, values: values ?? [] }
      : { text: config.text, values: values ?? config.values ?? [] };
    return originalQuery(config, values, ...rest);
  };
  let current;
  try {
    current = await listRecentOpsMetricSamples(createDb(pool), { perSeries });
  } finally {
    pool.query = originalQuery;
  }
  assert.ok(statement, "Repository query must reach PostgreSQL");
  const oldResult = await pool.query(legacy, [perSeries]);
  assert.deepEqual(current, oldResult.rows.map((row) => ({
    metric: row.metric, quantile: row.quantile,
    valueMs: Number(row.value_ms), sampledAt: new Date(row.sampled_at),
  })));

  const runs = [];
  // Alternate execution after both reads have warmed caches; report wall time
  // as evidence for this fixture, while assertions use actual logical work.
  for (let pass = 0; pass < 3; pass++) {
    for (const [name, text, values] of [
      ["legacy", legacy, [perSeries]], ["bounded", statement.text, statement.values],
    ]) {
      const result = await pool.query(`explain (analyze, buffers, format json) ${text}`, values);
      const plan = result.rows[0]["QUERY PLAN"][0];
      runs.push({
        name, pass, executionMs: plan["Execution Time"], rowsVisited: tableRowsVisited(plan.Plan),
        sharedHitBlocks: plan.Plan["Shared Hit Blocks"], sharedReadBlocks: plan.Plan["Shared Read Blocks"],
        tempReadBlocks: plan.Plan["Temp Read Blocks"], tempWrittenBlocks: plan.Plan["Temp Written Blocks"],
        plan: plan.Plan,
      });
    }
  }
  const storedSamples = samplesPerSeries * 20 + 2;
  for (const run of runs) {
    if (run.name === "legacy") assert.ok(run.rowsVisited >= storedSamples);
    else assert.ok(run.rowsVisited < 22 * (perSeries + 3), "Reads must scale with series and N");
  }
  const index = await pool.query(`
    select pg_relation_size('ops_metric_samples_series_time_idx')::text as bytes,
      (select indexdef from pg_indexes where indexname = 'ops_metric_samples_series_time_idx') as definition
  `);
  console.log(JSON.stringify({
    fixture: { storedSamples, denseSeries: 20, sparseSeries: 2, perSeries, outputRows: current.length },
    exactResultsMatch: true,
    caveat: "Synthetic local PostgreSQL 16 data; this does not establish production latency or CPU gain.",
    index: index.rows[0], runs,
  }, null, 2));
} finally {
  await pool.end();
  await container.stop();
}
