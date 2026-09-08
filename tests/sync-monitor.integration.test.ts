import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, listSyncMonitorStreamRows, type SyncStream } from "@agency_hub_core/db";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase;
const now = new Date("2026-09-08T12:00:00Z");
const windowStart = new Date("2026-09-07T12:00:00Z");

beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(testDb.pool); });

async function seedPage(label: string) {
  const model = await createModel(testDb.db, { slug: label, name: label });
  if (!model) throw new Error("test model missing");
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label });
  if (!page) throw new Error("test page missing");
  return page.id;
}

async function run(pageId: number, startedAt: string, stream: SyncStream = "dm_messages", finishedAt: string | null = null) {
  const result = await testDb.pool.query<{ id: bigint }>(`
    insert into sync_runs(page_id, stream, outcome, started_at, finished_at)
    values ($1, $2, $3, $4, $5) returning id
  `, [pageId, stream, finishedAt ? "succeeded" : "running", startedAt, finishedAt]);
  return Number(result.rows[0]!.id);
}

async function attempt(runId: number, startedAt: string, finishedAt: string | null = null, state = "success") {
  await testDb.pool.query(`
    insert into sync_http_attempts(sync_run_id, page_id, provider, stream, operation,
      logical_request_id, attempt_number, state, started_at, finished_at)
    select sr.id, sr.page_id, 'fansly', sr.stream, 'fixture', $2::text, 1, $4, $2::text::timestamptz, $3
    from sync_runs sr where sr.id = $1
  `, [runId, startedAt, finishedAt, state]);
}

async function event(runId: number, emittedAt: string) {
  await testDb.pool.query(`
    insert into sync_run_events(sync_run_id, page_id, provider, stream, event_type, severity, message, emitted_at)
    select sr.id, sr.page_id, 'fansly', sr.stream, 'fixture', 'info', 'fixture', $2
    from sync_runs sr where sr.id = $1
  `, [runId, emittedAt]);
}

function rows(pageId: number, streams: SyncStream[] = ["dm_messages"]) {
  return listSyncMonitorStreamRows(testDb.db, { pageIds: [pageId], streams, now, windowStart });
}

describe("sync monitor running activity", () => {
  it("selects the latest running run before reading activity, breaking start-time ties by ID", async () => {
    const pageId = await seedPage("activity");
    const old = await run(pageId, "2026-09-08T09:00:00Z");
    const tied = await run(pageId, "2026-09-08T10:00:00Z");
    const current = await run(pageId, "2026-09-08T10:00:00Z");
    const completed = await run(pageId, "2026-09-08T11:00:00Z", "dm_messages", "2026-09-08T11:59:00Z");
    for (const id of [old, tied, completed]) {
      await attempt(id, "2026-09-08T11:59:00Z");
      await event(id, "2026-09-08T11:59:00Z");
    }
    // The last finishing attempt can have started before another attempt.
    await attempt(current, "2026-09-08T10:01:00Z", "2026-09-08T11:00:00Z");
    await attempt(current, "2026-09-08T10:30:00Z", "2026-09-08T10:31:00Z");
    await event(current, "2026-09-08T10:45:00Z");
    const [row] = await rows(pageId);
    expect(row).toMatchObject({
      runningRunId: current,
      runningStartedAt: new Date("2026-09-08T10:00:00Z"),
      runningLastActivityAt: new Date("2026-09-08T11:00:00Z"),
      lastCompletedRunId: completed,
      recentSuccessCount: 1,
      recentRunningCount: 3,
    });
  });

  it("handles missing activity, in-flight attempts and event-only progress without leaking scope", async () => {
    const pageId = await seedPage("scoped");
    const otherPage = await seedPage("other");
    const current = await run(pageId, "2026-09-08T10:00:00Z");
    const otherStream = await run(pageId, "2026-09-08T10:00:00Z", "light");
    const otherRun = await run(otherPage, "2026-09-08T10:00:00Z");
    await event(otherStream, "2026-09-08T11:59:00Z");
    await event(otherRun, "2026-09-08T11:59:00Z");
    expect((await rows(pageId))[0]?.runningLastActivityAt).toEqual(new Date("2026-09-08T10:00:00Z"));
    await attempt(current, "2026-09-08T10:05:00Z", null, "started");
    expect((await rows(pageId))[0]?.runningLastActivityAt).toEqual(new Date("2026-09-08T10:05:00Z"));
    await event(current, "2026-09-08T10:10:00Z");
    const scoped = await rows(pageId);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({ pageId, stream: "dm_messages", runningLastActivityAt: new Date("2026-09-08T10:10:00Z") });
    expect(await listSyncMonitorStreamRows(testDb.db, { pageIds: [], now })).toEqual([]);
  });

  it("keeps historical physical failure debt even when no run is currently running", async () => {
    const pageId = await seedPage("physical");
    const completed = await run(pageId, "2026-09-01T00:00:00Z", "dm_messages", "2026-09-01T01:00:00Z");
    await attempt(completed, "2026-09-01T00:00:00Z");
    await attempt(completed, "2026-09-01T00:01:00Z", null, "failed");
    await attempt(completed, "2026-09-01T00:02:00Z", null, "started");
    const [row] = await rows(pageId);
    expect(row).toMatchObject({
      runningRunId: null, runningLastActivityAt: null, lastCompletedRunId: completed,
      recentPhysicalAttemptCount: 0, recentPhysicalSuccessCount: 0,
      stalePhysicalAttemptCount: 1, physicalAttemptsSinceLastSuccess: 2,
      lastPhysicalSuccessAt: new Date("2026-09-01T00:00:00Z"),
    });
  });
});
