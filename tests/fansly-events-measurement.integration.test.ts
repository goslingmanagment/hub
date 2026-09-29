import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFanslyPage, createModel } from "@agency_hub_core/db";

import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { compareHttpSnapshots, parseHttpSnapshot } from "../scripts/fansly-events/compare-http.ts";
import { measurementArtifact } from "./helpers/fansly-http-measurement.ts";

const FROM = "2026-09-01T12:00:00Z";
const TO = "2026-09-01T13:00:00Z";
const CLEAN = { requestTotals: { unrecordedAttempts: 0, unfinishedAttempts: 0 } };

describe("A0/T0 bounded read operations", () => {
  let db: Awaited<ReturnType<typeof startTestDatabase>>;
  let pageId: number;
  beforeAll(async () => { db = await startTestDatabase(); }, INTEGRATION_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => {
    // Physical: cases assert plan nodes and buffers after ANALYZE.
    await resetIntegrationDatabase(db.pool, { physical: true });
    const model = await createModel(db.db, { slug: "measurement", name: "Measurement" });
    const page = await createFanslyPage(db.db, { modelId: model!.id, label: "lilly-2" });
    pageId = page!.id;
  });

  async function run(source: string, start = FROM, stats: object = CLEAN, finish: string | null = TO) {
    const result = await db.pool.query(`insert into sync_runs
      (page_id, stream, source, outcome, started_at, finished_at, stats)
      values ($1, 'dm_conversations', $2, 'succeeded', $3, $4, $5) returning id`,
    [pageId, source, start, finish, stats]);
    return result.rows[0].id;
  }
  async function attempt(runId: number, number = 1, started = FROM) {
    await db.pool.query(`insert into sync_http_attempts
      (page_id, sync_run_id, provider, stream, operation, logical_request_id,
       attempt_number, state, started_at, response_body_bytes)
      values ($1, $2, 'fansly', 'dm_conversations', 'messaging_groups', 'request',
        $3, 'success', $4, 100)`, [pageId, runId, number, started]);
  }
  async function report() {
    return (await db.pool.query("select fansly_events_measurement_report($1, $2) as report", [FROM, TO]))
      .rows[0].report;
  }

  it("counts physical attempts once, including retries, with their actual run source", async () => {
    const manual = await run("manual");
    const scheduled = await run("scheduled");
    await attempt(manual);
    await attempt(manual, 2);
    await attempt(scheduled);
    await attempt(scheduled, 2, TO); // exclusive end
    const result = await report();
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "manual", attempts: 2, retry_attempts: 1 }),
      expect.objectContaining({ source: "scheduled", attempts: 1, retry_attempts: 0 }),
    ]));
  });

  it("compares two real whole-day SQL exports with retry subsets and stable page identity", async () => {
    const first = await run("manual");
    await attempt(first);
    await attempt(first, 2);
    const second = await run("scheduled", "2026-09-02T12:00:00Z", CLEAN, "2026-09-02T13:00:00Z");
    await attempt(second, 1, "2026-09-02T12:00:00Z");
    async function exported(from: string, to: string) {
      const row = (await db.pool.query("select fansly_events_measurement_report($1, $2) as report", [from, to])).rows[0];
      const { bytes, manifest } = measurementArtifact(row.report);
      return parseHttpSnapshot(bytes, manifest);
    }
    const before = await exported("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z");
    const after = await exported("2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z");
    expect(compareHttpSnapshots(before, after, ["lilly-2"])).toMatchObject({
      baseline: { recordedAttempts: 2, retryAttempts: 1 },
      current: { recordedAttempts: 1, retryAttempts: 0 },
      eligibleForObservedCountComparison: true, observedAttemptChangePercent: -50,
      causalSavings: "unverified", readerLatency: "unmeasured",
    });
  });

  it("keeps lost attempts from overlapping runs and old or unfinished telemetry explicit", async () => {
    await run("manual", "2026-09-01T11:59:59Z", {
      requestTotals: { unrecordedAttempts: 1, unfinishedAttempts: 0 },
    });
    await run("scheduled", FROM, {});
    await run("recovery", FROM, CLEAN, null);
    const result = await report();
    expect(result.attempts).toEqual([]);
    expect(result.httpCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "manual", unrecorded_attempts: 1, boundary_runs: 1 }),
      expect.objectContaining({ source: "scheduled", unknown_runs: 1 }),
      expect.objectContaining({ source: "recovery", unknown_runs: 1 }),
    ]));
  });

  it("does not expose raw tables or require write privileges for the bounded report", async () => {
    await db.pool.query("create role a0_report_reader");
    await db.pool.query(`grant usage on schema public to a0_report_reader;
      grant execute on function fansly_events_measurement_report(timestamptz, timestamptz)
      to a0_report_reader`);
    const client = await db.pool.connect();
    try {
      await client.query("begin read only");
      await client.query("set local role a0_report_reader");
      const result = await client.query("select fansly_events_measurement_report($1, $2) as report", [FROM, TO]);
      expect(result.rows[0].report.attempts).toEqual([]);
      await expect(client.query("select * from sync_http_attempts limit 1")).rejects.toThrow("permission denied");
    } finally { await client.query("rollback"); client.release(); }
  });

  it.each([[null, TO], [TO, FROM], [FROM, "2026-10-01T00:00:00Z"]])(
    "rejects an unbounded or reversed read: %s → %s", async (from, to) => {
      await expect(db.pool.query("select fansly_events_measurement_report($1, $2)", [from, to]))
        .rejects.toThrow("ordered report window");
    },
  );

  it("exports retained offsets and head metadata with a capped cursor and no text or credentials", async () => {
    const runId = await run("manual", FROM, { checkpoint: { after: { dm_conversations: { stateScalars: {
      membershipCertified: true, lastFullSweepCompletedAt: TO,
    } } } } });
    const payload = { data: [{ groupId: "g", lastMessageId: "m", unreadCount: 0, flags: 1 }],
      aggregationData: { total: 1, groups: [{ id: "g", lastMessage: {
        id: "m", createdAt: 1234567890000, senderId: "fan", content: "private text",
      } }] } };
    for (const endpoint of ["account_me", "dm_conversations", "dm_conversations"]) {
      await db.pool.query(`insert into sync_raw_payloads
        (page_id, sync_run_id, endpoint, request_params, response_payload,
         mapper_version, payload_kind, captured_at, retain_until)
        values ($1, $2, $3, $4, $5, 'test', 'dm_metadata', $6, $6::timestamptz + interval '100 years')`,
      [pageId, runId, endpoint, { offset: 0, limit: 100, sortOrder: 1, authorization: "secret" }, payload, FROM]);
    }
    const read = async (after = 0, through: number | null = null) => (await db.pool.query(
      "select fansly_dm_shadow_corpus_batch($1, $2, $3, $4, 2) as batch", [FROM, TO, after, through],
    )).rows[0].batch;
    const first = await read();
    expect(first).toMatchObject({ scannedRows: 2, nextId: 2, upperId: 3 });
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toMatchObject({ offset: 0, certifiedAt: TO,
      heads: [expect.objectContaining({ groupId: "g", embeddedId: "m", flags: 1 })] });
    expect(JSON.stringify(first)).not.toMatch(/private text|secret|authorization/);
    expect((await read(first.nextId, first.upperId)).records).toHaveLength(1);
  });

  it("marks duplicate aggregation bindings explicitly instead of selecting a trustworthy-looking head", async () => {
    await db.pool.query(`insert into sync_raw_payloads
      (page_id, endpoint, request_params, response_payload, mapper_version,
       payload_kind, captured_at, retain_until)
      values ($1, 'dm_conversations', '{"offset":0,"limit":100,"sortOrder":1}', $2,
        'test', 'dm_metadata', $3, $3::timestamptz + interval '100 years')`, [pageId, {
      data: [{ groupId: "g", lastMessageId: "m1" }],
      aggregationData: { groups: [
        { id: "g", lastMessage: { id: "m1", createdAt: 1234567890000 } },
        { id: "g", lastMessage: { id: "m2", createdAt: 1234567990000 } },
      ] },
    }, FROM]);
    const result = await db.pool.query("select fansly_dm_shadow_corpus_batch($1, $2) as batch", [FROM, TO]);
    expect(result.rows[0].batch.records[0].heads[0].embeddedMatches).toBe(2);
  });

  it("bounds the actual report runs and receipt joins at telemetry scale", async () => {
    await db.pool.query(`insert into sync_runs
      (page_id, stream, source, outcome, started_at, finished_at, stats)
      select $1, 'dm_conversations', 'scheduled', 'succeeded',
        '2026-08-01'::timestamptz + n * interval '1 minute',
        '2026-08-01'::timestamptz + n * interval '1 minute' + interval '30 seconds', $2
      from generate_series(1, 50000) n`, [pageId, CLEAN]);
    await db.pool.query("analyze sync_runs");
    const source = (await db.pool.query(`select pg_get_functiondef(
      'fansly_events_measurement_report(timestamptz,timestamptz)'::regprocedure) as source`)).rows[0].source;
    const query = source.slice(source.indexOf("with attempts"), source.indexOf("into result;"))
      .replaceAll("window_start", "$1::timestamptz").replaceAll("window_end", "$2::timestamptz");
    const result = await db.pool.query(`explain (analyze, buffers, format json) ${query}`, [FROM, TO]);
    const plan = result.rows[0]["QUERY PLAN"][0];
    expect(JSON.stringify(plan)).toContain("sync_runs_finished_idx");
    const scans = (node: { Plans?: unknown[]; [key: string]: unknown }): unknown[] => [
      ...(node["Relation Name"] === "sync_runs" ? [node] : []),
      ...(node.Plans ?? []).flatMap((child) => scans(child as never)),
    ];
    expect(scans(plan.Plan)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ "Node Type": "Seq Scan" }),
    ]));
    expect(plan["Execution Time"]).toBeLessThan(2000);
  });

  it("uses the time index for a short physical-attempt aggregate at telemetry scale", async () => {
    const id = await run("manual");
    await db.pool.query(`insert into sync_http_attempts
      (page_id, sync_run_id, provider, stream, operation, logical_request_id,
       attempt_number, state, started_at)
      select $1, $2, 'fansly', 'dm_conversations', 'messaging_groups', n::text,
        1, 'success', '2026-08-01'::timestamptz + n * interval '1 minute'
      from generate_series(1, 50000) n`, [pageId, id]);
    await db.pool.query("analyze sync_http_attempts");
    const plan = await db.pool.query(`explain (analyze, buffers, format json)
      select operation, count(*) from sync_http_attempts
      where provider = 'fansly' and started_at >= $1 and started_at < $2 group by operation`, [FROM, TO]);
    expect(JSON.stringify(plan.rows[0])).toContain("sync_http_attempts_retention_idx");
    expect(plan.rows[0]["QUERY PLAN"][0]["Execution Time"]).toBeLessThan(1000);
  });
});
