import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertDemand, type Database } from "@agency_hub_core/db";

import { PgWake } from "../apps/runtime/src/sync/engine/host-ports.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import type { ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { fixedShadowLatency } from "../apps/runtime/src/sync/engine/shadow.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  countRows,
  quietLogger,
  seedSyncPage,
  testConfig,
  testRegistry,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// A lost NOTIFY costs at most the actor's re-read (≤ 1 s, plan §8): work
// written without `pg_notify` is still picked within about a second, and a
// killed LISTEN connection reconnects while the re-read keeps serving.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const PICK_BOUND_MS = 1_200;

function readRegistry() {
  const read: ResourceModule = {
    plan: async (work) => ({ kind: "request", request: { spec: "post.replies", params: { postId: work.subject, before: null } } }),
    apply: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
    shadow: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
  };
  return testRegistry([testSpec("notify.read", read)]);
}

/** Work written the way a writer that forgot its NOTIFY would. */
async function insertSilently(pageId: number, subject: string): Promise<void> {
  await testDb!.pool.query(
    "insert into sync_work (page_id, shadow, resource, subject, kind, class) values ($1, true, 'notify.read', $2, 'trigger', 'urgent')",
    [pageId, subject],
  );
}

/** Admission instant minus creation instant, both by the database clock. */
async function pickLatencyMs(subject: string): Promise<number> {
  return waitFor(async () => {
    const result = await testDb!.pool.query<{ ms: number | null }>(`
      select extract(epoch from (a.admitted_at - w.created_at)) * 1000 as ms
        from sync_work w join sync_attempts a on a.work_id = w.id
       where w.subject = $1
       order by a.id limit 1`, [subject]);
    const ms = result.rows[0]?.ms;
    return ms === undefined || ms === null ? null : Number(ms);
  }, 10_000, `the admission of ${subject}`);
}

describe("lost NOTIFY", () => {
  it("work written without NOTIFY is picked within the re-read; a killed LISTEN reconnects", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "shadow" });
    const wake = new PgWake({ connectionString: testDb.connectionString, logger: quietLogger });
    const host = new SyncEngineHost({
      db: db(),
      connectionString: testDb.connectionString,
      config: testConfig(testDb.connectionString),
      rawConfig: testConfig(testDb.connectionString),
      logger: quietLogger,
      registry: readRegistry(),
      wake,
      pause: { readSettingMs: async () => 50 },
      pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
      routeTimeScale: 0,
      shadowLatency: () => fixedShadowLatency(0),
      modeLoopIntervalMs: 200,
    });
    await host.start();
    try {
      // Past the takeover floor, the page idles.
      await upsertDemand(db(), { pageId, shadow: true, resource: "notify.read", subject: "warmup", kind: "trigger", class: "urgent" });
      await pickLatencyMs("warmup");

      for (const subject of ["silent-1", "silent-2", "silent-3"]) {
        await sleep(300 + Math.floor(Math.random() * 700));
        await insertSilently(pageId, subject);
        expect(await pickLatencyMs(subject)).toBeLessThanOrEqual(PICK_BOUND_MS);
      }

      // With NOTIFY the wake-up is the notification itself.
      const before = wake.notifications;
      await sleep(400);
      await upsertDemand(db(), { pageId, shadow: true, resource: "notify.read", subject: "notified", kind: "trigger", class: "urgent" });
      expect(await pickLatencyMs("notified")).toBeLessThanOrEqual(PICK_BOUND_MS);
      expect(wake.notifications).toBeGreaterThan(before);

      // Kill the LISTEN connection: the re-read keeps serving meanwhile…
      const killed = await testDb.pool.query<{ pid: number }>(
        "select pg_terminate_backend(pid), pid from pg_stat_activity where application_name = 'fansly-sync-wake' and datname = current_database()",
      );
      expect(killed.rows).toHaveLength(1);
      await insertSilently(pageId, "while-down");
      expect(await pickLatencyMs("while-down")).toBeLessThanOrEqual(PICK_BOUND_MS);
      // …and the listener comes back.
      await waitFor(async () => (
        await countRows(testDb!.pool,
          "select count(*)::int as n from pg_stat_activity where application_name = 'fansly-sync-wake' and datname = current_database() and pid <> $1",
          [killed.rows[0]!.pid]) === 1 && wake.listening ? true : null
      ), 10_000, "the LISTEN connection back");
      const afterReconnect = wake.notifications;
      await upsertDemand(db(), { pageId, shadow: true, resource: "notify.read", subject: "after-reconnect", kind: "trigger", class: "urgent" });
      expect(await pickLatencyMs("after-reconnect")).toBeLessThanOrEqual(PICK_BOUND_MS);
      await waitFor(() => (wake.notifications > afterReconnect ? true : null), 5_000, "a notification after the reconnect");
    } finally {
      await host.stop();
    }
  }, 60_000);
});
