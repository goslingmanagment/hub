// Reproduction fixture: copy to tests/sync-monitor-benchmark.integration.test.ts before running.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createFanslyPage, createModel, listSyncMonitorStreamRows, getSyncStreamsForPlatform } from "@agency_hub_core/db";
import { startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase;
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });

it("benchmarks the actual sync monitor SQL against retained history", async () => {
  const model = await createModel(testDb.db, { slug: "benchmark", name: "Benchmark" });
  const pageIds: number[] = [];
  for (let i = 0; i < 6; i++) {
    const page = await createFanslyPage(testDb.db, { modelId: model!.id, label: `benchmark-${i}` });
    pageIds.push(page!.id);
  }
  const streams = getSyncStreamsForPlatform("fansly");
  await testDb.pool.query(`
    insert into sync_runs(id, page_id, stream, outcome, started_at, finished_at)
    select n, ($1::bigint[])[(n-1)%6+1], ($2::sync_stream[])[((n-1)/6)%cardinality($2::sync_stream[])+1], 'succeeded',
           '2026-01-01'::timestamptz + n * interval '1 minute',
           '2026-01-01'::timestamptz + n * interval '1 minute' + interval '30 seconds'
    from generate_series(1, 166280) n
  `, [pageIds, streams]);
  await testDb.pool.query(`
    insert into sync_http_attempts(sync_run_id, page_id, provider, stream, operation,
      logical_request_id, attempt_number, state, http_status, started_at, finished_at)
    select sr.id, sr.page_id, 'fansly', sr.stream, 'fixture',
      n::text, 1, 'success', 200, sr.started_at, sr.finished_at
    from sync_runs sr cross join generate_series(1, 4) n
  `);
  await testDb.pool.query(`
    insert into sync_run_events(sync_run_id, page_id, provider, stream, event_type, severity, message, emitted_at)
    select sr.id, sr.page_id, 'fansly', sr.stream, 'fixture', 'info', 'fixture', sr.finished_at
    from sync_runs sr cross join generate_series(1, 7) n
  `);
  await testDb.pool.query(`
    insert into sync_runs(id, page_id, stream, outcome, started_at)
    select 166280 + n, ($1::bigint[])[n], 'dm_messages', 'running', '2026-09-08T11:59:00Z'::timestamptz from generate_series(1,6) n
  `, [pageIds]);
  await testDb.pool.query(`insert into fans(id, platform, platform_user_id)
    select n, 'fansly', n::text from generate_series(1, 132000) n`);
  await testDb.pool.query(`insert into page_fans(fan_id, platform_account_id)
    select n, ($1::bigint[])[(n-1)%6+1] from generate_series(1,132000) n`, [pageIds]);
  await testDb.pool.query(`insert into page_dm_threads(id, platform_account_id, fan_id,
      platform_conversation_id, message_coverage_status, stored_message_count, metadata)
    select n, ($1::bigint[])[(n-1)%6+1], n, n::text, 'partial_window', 12,
      jsonb_build_object('fixture', repeat(md5(n::text), 16))
    from generate_series(1,48000) n`, [pageIds]);
  await testDb.pool.query(`insert into page_dm_messages(platform_account_id, conversation_id, platform_message_id, created_at)
    select t.platform_account_id, t.id, n::text, '2026-09-08T10:00:00Z'::timestamptz
    from page_dm_threads t cross join generate_series(1,12) n`);
  await testDb.pool.query("analyze");
  const querySpy = vi.spyOn(testDb.pool, "query");
  const started = performance.now();
  const rows = await listSyncMonitorStreamRows(testDb.db, {
    pageIds, now: new Date("2026-09-08T12:00:00Z"),
    windowStart: new Date("2026-09-07T12:00:00Z"), streams,
  });
  const elapsedMs = performance.now() - started;
  const call = querySpy.mock.calls[0]!;
  const query = call[0] as unknown as { text: string };
  const params = call[1] as unknown as unknown[];
  querySpy.mockRestore();
  const plan = await testDb.pool.query(`explain (analyze, buffers, format json) ${query.text}`, params);
  const directory = "investigations/sync-health-query-2026-09-08";
  await mkdir(directory, { recursive: true });
  const tag = process.env.BENCHMARK_TAG ?? "baseline";
  await writeFile(`${directory}/${tag}.json`, JSON.stringify({
    fixture: { pages: 6, streams, runs: 166286, attempts: 665120, events: 1163960, fans: 132000, threads: 48000, messages: 576000 }, elapsedMs, rows,
    sql: query.text, params, plan: plan.rows[0]["QUERY PLAN"],
  }, null, 2));
  console.log(JSON.stringify({ tag, elapsedMs, executionMs: plan.rows[0]["QUERY PLAN"][0]["Execution Time"] }));
  expect(rows).toHaveLength(6 * streams.length);
  if (process.env.BENCHMARK_COMPARE) {
    const baseline = JSON.parse(await readFile(process.env.BENCHMARK_COMPARE, "utf8"));
    expect(JSON.parse(JSON.stringify(rows))).toEqual(baseline.rows);
  }
}, 180_000);
