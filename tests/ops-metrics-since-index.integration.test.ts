import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listOpsMetricSamplesSince } from "@agency_hub_core/db";

import { startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// 0266 dropped ops_metric_samples_metric_time_idx (metric, sampled_at desc):
// its only reader, listOpsMetricSamplesSince (the disk alert's series fit),
// filters by metric AND quantile, which 0186's series index answers with all
// three keys and value_ms included.

let harness: StartedTestDatabase;

beforeAll(async () => {
  harness = await startTestDatabase();
  // 10 series x 2 quantiles x 3 000 minutes, as the minutely sampler writes.
  await harness.pool.query(`
    insert into ops_metric_samples (metric, quantile, value_ms, sampled_at)
    select 'metric_' || series, quantile, n,
      '2026-10-10T12:00:00Z'::timestamptz - n * interval '1 minute'
    from generate_series(1, 10) series
    cross join (values ('p50'), ('p95')) quantiles(quantile)
    cross join generate_series(1, 3000) n
  `);
  await harness.pool.query("vacuum analyze ops_metric_samples");
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

describe("ops_metric_samples indexes after 0266", () => {
  it("no longer carries the (metric, sampled_at) index", async () => {
    const result = await harness.pool.query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'ops_metric_samples' order by 1",
    );
    expect(result.rows.map((row) => row.indexname)).toEqual([
      "ops_metric_samples_pkey",
      "ops_metric_samples_sampled_at_idx",
      "ops_metric_samples_series_time_idx",
    ]);
  });

  it("serves one series since a cutoff from the series index, in time order", async () => {
    const since = new Date("2026-10-10T10:00:00Z");
    const rows = await listOpsMetricSamplesSince(harness.db, { metric: "metric_3", quantile: "p95", since });
    expect(rows).toHaveLength(120);
    expect(rows.every((row) => row.metric === "metric_3" && row.quantile === "p95")).toBe(true);
    expect(rows[0]!.sampledAt.toISOString()).toBe("2026-10-10T10:00:00.000Z");
    expect(rows.at(-1)!.sampledAt.toISOString()).toBe("2026-10-10T11:59:00.000Z");

    const plan = await harness.pool.query<{ "QUERY PLAN": string }>(`
      explain (analyze)
      select metric, quantile, value_ms::text, sampled_at
      from ops_metric_samples
      where metric = 'metric_3' and quantile = 'p95' and sampled_at >= '2026-10-10T10:00:00Z'
      order by sampled_at asc
    `);
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("Index Only Scan Backward using ops_metric_samples_series_time_idx");
    expect(text).not.toContain("Rows Removed by Filter");
  });
});
