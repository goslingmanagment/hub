import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  LEGACY_EXECUTOR_STREAMS,
  listSyncMonitorStreamRows,
  type SyncStream,
} from "@agency_hub_core/db";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase;
const now = new Date("2026-09-08T12:00:00Z");
const windowStart = new Date("2026-09-07T12:00:00Z");

beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(testDb.pool); });

// The monitor is the legacy page-sync executor's: its pages are OnlyFans's.
async function seedPage(label: string, platform: "fansly" | "onlyfans" = "onlyfans") {
  const model = await createModel(testDb.db, { slug: label, name: label });
  if (!model) throw new Error("test model missing");
  const create = { fansly: createFanslyPage, onlyfans: createOnlyFansPage }[platform];
  const page = await create(testDb.db, { modelId: model.id, label });
  if (!page) throw new Error("test page missing");
  return page.id;
}

async function run(pageId: number, startedAt: string, stream: SyncStream = "dm_conversations", finishedAt: string | null = null) {
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
    select sr.id, sr.page_id, 'onlyfans', sr.stream, 'fixture', $2::text, 1, $4, $2::text::timestamptz, $3
    from sync_runs sr where sr.id = $1
  `, [runId, startedAt, finishedAt, state]);
}

async function event(runId: number, emittedAt: string) {
  await testDb.pool.query(`
    insert into sync_run_events(sync_run_id, page_id, provider, stream, event_type, severity, message, emitted_at)
    select sr.id, sr.page_id, 'onlyfans', sr.stream, 'fixture', 'info', 'fixture', $2
    from sync_runs sr where sr.id = $1
  `, [runId, emittedAt]);
}

function rows(pageId: number, streams: SyncStream[] = ["dm_conversations"]) {
  return listSyncMonitorStreamRows(testDb.db, { pageIds: [pageId], streams, now, windowStart });
}

describe("sync monitor running activity", () => {
  it("selects the latest running run before reading activity, breaking start-time ties by ID", async () => {
    const pageId = await seedPage("activity");
    const old = await run(pageId, "2026-09-08T09:00:00Z");
    const tied = await run(pageId, "2026-09-08T10:00:00Z");
    const current = await run(pageId, "2026-09-08T10:00:00Z");
    const completed = await run(pageId, "2026-09-08T11:00:00Z", "dm_conversations", "2026-09-08T11:59:00Z");
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
    expect(scoped[0]).toMatchObject({ pageId, stream: "dm_conversations", runningLastActivityAt: new Date("2026-09-08T10:10:00Z") });
    expect(await listSyncMonitorStreamRows(testDb.db, { pageIds: [], now })).toEqual([]);
  });

  it("keeps historical physical failure debt even when no run is currently running", async () => {
    const pageId = await seedPage("physical");
    const completed = await run(pageId, "2026-09-01T00:00:00Z", "dm_conversations", "2026-09-01T01:00:00Z");
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

  it("returns identical rows when unrelated streams are excluded, retaining old unresolved debt", async () => {
    const pageId = await seedPage("preview-scope");
    const dmStreams: SyncStream[] = ["dm_conversations", "subscribers"];
    for (const stream of dmStreams) {
      const completed = await run(pageId, "2026-09-01T00:00:00Z", stream, "2026-09-01T01:00:00Z");
      await attempt(completed, "2026-09-01T00:00:00Z");
      await attempt(completed, "2026-09-01T00:01:00Z", null, "failed");
      await attempt(completed, "2026-09-01T00:02:00Z", null, "started");
    }
    const unrelated = await run(pageId, "2026-09-08T10:00:00Z", "transactions", "2026-09-08T11:00:00Z");
    await attempt(unrelated, "2026-09-08T10:01:00Z", null, "failed");
    const all = await listSyncMonitorStreamRows(testDb.db, { pageIds: [pageId], now, windowStart });
    const scoped = await rows(pageId, dmStreams);
    expect(scoped).toHaveLength(2);
    expect(scoped).toEqual(all.filter((row) => dmStreams.includes(row.stream)));
    for (const row of scoped) {
      expect(row).toMatchObject({
        recentPhysicalAttemptCount: 0, recentPhysicalSuccessCount: 0,
        stalePhysicalAttemptCount: 1, physicalAttemptsSinceLastSuccess: 2,
        lastPhysicalSuccessAt: new Date("2026-09-01T00:00:00Z"),
      });
    }
  });
});


// Step 4, S4-24: the monitor lists the legacy executor's pages and streams.
describe("sync monitor scope", () => {
  it("lists an OnlyFans page on the executor's streams and no Fansly page at all, whatever runs and rows it has", async () => {
    const onlyfans = await seedPage("scope-of");
    const fansly = await seedPage("scope-fansly", "fansly");
    // A Fansly page's records: a parked row and an old run of a stream name
    // the executor still runs elsewhere.
    await testDb.pool.query(`
      insert into page_sync_states (page_id, stream, status, cadence_seconds, slot_offset_seconds, blocker_kind)
      values ($1, 'light', 'paused', 3600, 0, 'retired'), ($1, 'followers', 'paused', 3600, 0, 'retired')
    `, [fansly]);
    await run(fansly, "2026-09-08T10:00:00Z", "light", "2026-09-08T10:01:00Z");
    await run(onlyfans, "2026-09-08T10:00:00Z", "light", "2026-09-08T10:01:00Z");

    const all = await listSyncMonitorStreamRows(testDb.db, { now, windowStart });
    expect(new Set(all.map((row) => row.pageId))).toEqual(new Set([onlyfans]));
    expect(all.map((row) => row.stream).sort()).toEqual([...LEGACY_EXECUTOR_STREAMS].sort());
    expect(new Set(all.map((row) => row.platform))).toEqual(new Set(["onlyfans"]));
    // Asked for the Fansly page, or for a stream no executor runs: nothing.
    expect(await listSyncMonitorStreamRows(testDb.db, { pageIds: [fansly], now, windowStart })).toEqual([]);
    expect(await listSyncMonitorStreamRows(testDb.db, { pageLabel: "scope-fansly", now, windowStart })).toEqual([]);
    expect(await listSyncMonitorStreamRows(testDb.db, {
      pageIds: [onlyfans, fansly], streams: ["followers", "dm_messages"], now, windowStart,
    })).toEqual([]);
  });
});

describe("sync monitor completed runs", () => {
  it("selects by finish time and ID across old history before reading the payload", async () => {
    const pageId = await seedPage("completed-order");
    const otherPage = await seedPage("completed-other");
    await run(pageId, "2026-09-01T00:00:00Z", "dm_conversations", "2026-09-02T10:00:00Z");
    const selected = await run(pageId, "2026-09-01T00:00:00Z", "dm_conversations", "2026-09-02T10:00:00Z");
    await run(pageId, "2026-09-02T09:00:00Z", "dm_conversations", "2026-09-02T09:05:00Z");
    await run(pageId, "2026-09-08T10:00:00Z", "light", "2026-09-08T11:00:00Z");
    await run(otherPage, "2026-09-08T10:00:00Z", "dm_conversations", "2026-09-08T11:00:00Z");
    const running = await run(pageId, "2026-09-08T11:00:00Z");
    const unfinished = await run(pageId, "2026-09-08T11:01:00Z");
    await testDb.pool.query(`
      update sync_runs set source = 'anomaly', stats = '{"completed":true}',
        error_summary = 'selected payload' where id = $1
    `, [selected]);
    await testDb.pool.query("update sync_runs set finished_at = $2 where id = $1", [running, now]);
    await testDb.pool.query("update sync_runs set outcome = 'failed' where id = $1", [unfinished]);
    const [row] = await rows(pageId);
    expect(row).toMatchObject({
      lastCompletedRunId: selected,
      lastCompletedTrigger: "anomaly",
      lastCompletedStatus: "success",
      lastCompletedStartedAt: new Date("2026-09-01T00:00:00Z"),
      lastCompletedFinishedAt: new Date("2026-09-02T10:00:00Z"),
      lastCompletedDurationMs: 122_400_000,
      lastCompletedStats: { completed: true },
      lastCompletedErrorSummary: "selected payload",
    });
    expect(await listSyncMonitorStreamRows(testDb.db, {
      pageLabel: "completed-order", streams: ["dm_conversations"], now, windowStart,
    })).toEqual([row]);
  });

  it.each(["succeeded", "partial", "failed", "skipped"] as const)(
    "includes a finished %s run without changing its result fields",
    async (outcome) => {
      const pageId = await seedPage(`completed-${outcome}`);
      const completed = await run(pageId, "2026-09-08T10:00:00Z", "dm_conversations", "2026-09-08T10:00:01Z");
      await testDb.pool.query("update sync_runs set outcome = $2, source = null where id = $1", [completed, outcome]);
      const [row] = await rows(pageId);
      expect(row).toMatchObject({
        lastCompletedRunId: completed,
        lastCompletedTrigger: "scheduled",
        lastCompletedStatus: outcome === "succeeded" ? "success" : outcome,
        lastCompletedDurationMs: 1000,
        lastCompletedStats: {},
        lastCompletedErrorSummary: null,
      });
    },
  );
});
