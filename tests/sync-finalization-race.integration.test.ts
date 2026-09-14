import { setTimeout as sleep } from "node:timers/promises";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeInactiveSyncRuns,
  closeOrphanedSyncRuns,
  createDb,
  createFanslyPage,
  createModel,
  finishSyncRun,
  getSyncRun,
  insertSyncRunEvent,
  startSyncRun,
  type Database,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

const STARTED_AT = new Date("2026-09-12T10:00:00.000Z");
const CUTOFF = new Date("2026-09-12T11:58:30.000Z");
const CLEANUP_AT = new Date("2026-09-12T12:00:00.000Z");
const FINALIZED_AT = new Date("2026-09-12T12:00:01.000Z");
const CLEANUP_SUMMARY = "Run closed by cleanup";

const cleanups = [
  {
    name: "inactivity cleanup",
    run: (db: Database) => closeInactiveSyncRuns(db, {
      inactiveBefore: CUTOFF,
      finishedAt: CLEANUP_AT,
      errorSummary: CLEANUP_SUMMARY,
    }),
  },
  {
    name: "orphan cleanup",
    run: (db: Database) => closeOrphanedSyncRuns(db, {
      startedBefore: CUTOFF,
      finishedAt: CLEANUP_AT,
      errorSummary: CLEANUP_SUMMARY,
    }),
  },
];

/** Prove the contested UPDATE has reached the other transaction's row lock;
 * elapsed sleeps alone do not establish the interleaving under test. */
async function waitForBlocker(testDb: StartedTestDatabase, waiter: number, blocker: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await testDb.pool.query<{ blocked: boolean }>(
      "select $2::int = any(pg_blocking_pids($1::int)) as blocked",
      [waiter, blocker],
    );
    if (rows[0]?.blocked) return;
    await sleep(20);
  }
  throw new Error(`Backend ${waiter} did not block on backend ${blocker}`);
}

async function createContenders(testDb: StartedTestDatabase) {
  // One connection per pool keeps BEGIN and repository calls on the same
  // backend without importing Drizzle or copying the production SQL.
  const finalizer = new Pool({ connectionString: testDb.connectionString, max: 1 });
  const reaper = new Pool({ connectionString: testDb.connectionString, max: 1 });
  try {
    await finalizer.query("set statement_timeout = '10s'");
    await reaper.query("set statement_timeout = '10s'");
    const finalizerPid = (await finalizer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    const reaperPid = (await reaper.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    return {
      finalizer,
      reaper,
      finalizerPid,
      reaperPid,
      finalizerDb: createDb(finalizer),
      reaperDb: createDb(reaper),
    };
  } catch (error) {
    await Promise.all([finalizer.end(), reaper.end()]);
    throw error;
  }
}

// Attach rejection handling immediately: an assertion failure must still
// release the blocker and settle the pending UPDATE before closing its pool.
function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe("sync cleanup versus finalization", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    if (testDb) await resetIntegrationDatabase(testDb.pool);
  });

  async function seedRun(checkpoint = false) {
    if (!testDb) throw new Error("Test database is unavailable");
    const model = await createModel(testDb.db, { slug: "sync-finalizer-race", name: "Sync Finalizer Race" });
    if (!model) throw new Error("Expected sync-finalization fixture model");
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "sync-finalizer-race" });
    if (!page) throw new Error("Expected sync-finalization fixture page");
    const run = await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "followers",
      trigger: "worker",
      startedAt: STARTED_AT,
    });
    if (!run) throw new Error("Expected sync-finalization fixture run");
    if (checkpoint) {
      await insertSyncRunEvent(testDb.db, {
        syncRunId: run.id,
        platformAccountId: page.id,
        provider: "fansly",
        stream: "followers",
        eventType: "checkpoint_advanced",
        severity: "info",
        message: "Captured a page before inactivity",
        emittedAt: new Date(STARTED_AT.getTime() + 1_000),
      });
    }
    return run.id;
  }

  describe.each(cleanups)("$name", ({ run: cleanup }) => {
    it.each(["success", "partial", "failed", "skipped"] as const)(
      "preserves a concurrent %s finalization after waiting for its lock",
      async (status) => {
        if (!testDb) throw new Error("Test database is unavailable");
        const runId = await seedRun();
        const sessions = await createContenders(testDb);
        let pending: ReturnType<typeof settle<Awaited<ReturnType<typeof cleanup>>>> | undefined;
        const stats = { captured: 7, terminalSource: "worker" };
        const errorSummary = status === "success" ? null : `Worker result: ${status}`;
        try {
          await sessions.finalizer.query("begin");
          await finishSyncRun(sessions.finalizerDb, runId, {
            status,
            stats,
            errorSummary,
            finishedAt: FINALIZED_AT,
          });
          pending = settle(cleanup(sessions.reaperDb));
          await waitForBlocker(testDb, sessions.reaperPid, sessions.finalizerPid);
          await sessions.finalizer.query("commit");
          const result = await pending;
          if (!result.ok) throw result.error;
          expect(result.value).toEqual({ totalCount: 0, failedCount: 0, partialCount: 0 });
          expect(await getSyncRun(testDb.db, runId)).toMatchObject({
            status, stats, errorSummary, finishedAt: FINALIZED_AT,
          });
        } finally {
          await sessions.finalizer.query("rollback");
          await pending;
          await Promise.all([sessions.finalizer.end(), sessions.reaper.end()]);
        }
      },
    );

    it("still closes a partial run when the competing finalizer rolls back", async () => {
      if (!testDb) throw new Error("Test database is unavailable");
      const runId = await seedRun(true);
      const sessions = await createContenders(testDb);
      let pending: ReturnType<typeof settle<Awaited<ReturnType<typeof cleanup>>>> | undefined;
      try {
        await sessions.finalizer.query("begin");
        await finishSyncRun(sessions.finalizerDb, runId, {
          status: "success", stats: { uncommitted: true }, finishedAt: FINALIZED_AT,
        });
        pending = settle(cleanup(sessions.reaperDb));
        await waitForBlocker(testDb, sessions.reaperPid, sessions.finalizerPid);
        await sessions.finalizer.query("rollback");
        const result = await pending;
        if (!result.ok) throw result.error;
        expect(result.value).toEqual({ totalCount: 1, failedCount: 0, partialCount: 1 });
        expect(await getSyncRun(testDb.db, runId)).toMatchObject({
          status: "partial", stats: {}, errorSummary: CLEANUP_SUMMARY, finishedAt: CLEANUP_AT,
        });
        const events = await testDb.pool.query<{ count: number }>(
          "select count(*)::int as count from sync_run_events where sync_run_id = $1",
          [runId],
        );
        expect(events.rows[0]?.count).toBe(1);
      } finally {
        await sessions.finalizer.query("rollback");
        await pending;
        await Promise.all([sessions.finalizer.end(), sessions.reaper.end()]);
      }
    });

    it("lets the worker finalize when cleanup takes the row lock first", async () => {
      if (!testDb) throw new Error("Test database is unavailable");
      const runId = await seedRun();
      const sessions = await createContenders(testDb);
      let pending: ReturnType<typeof settle<Awaited<ReturnType<typeof finishSyncRun>>>> | undefined;
      try {
        await sessions.reaper.query("begin");
        expect(await cleanup(sessions.reaperDb)).toEqual({ totalCount: 1, failedCount: 1, partialCount: 0 });
        pending = settle(finishSyncRun(sessions.finalizerDb, runId, {
          status: "success", stats: { captured: 7 }, finishedAt: FINALIZED_AT,
        }));
        await waitForBlocker(testDb, sessions.finalizerPid, sessions.reaperPid);
        await sessions.reaper.query("commit");
        const result = await pending;
        if (!result.ok) throw result.error;
        expect(await getSyncRun(testDb.db, runId)).toMatchObject({
          status: "success", stats: { captured: 7 }, errorSummary: null, finishedAt: FINALIZED_AT,
        });
      } finally {
        await sessions.reaper.query("rollback");
        await pending;
        await Promise.all([sessions.finalizer.end(), sessions.reaper.end()]);
      }
    });
  });
});
