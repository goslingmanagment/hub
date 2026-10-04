import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSyncPage, listSendsForPaceAudit, type Database } from "@agency_hub_core/db";

import { SyncEngineHost, type SyncHostOptions } from "../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import type { ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  countRows,
  FakeOwnershipSession,
  makeTestActor,
  pollsRequest,
  quietLogger,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  testConfig,
  testRegistry,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Loss of the lock session (design §3.6 "Ownership loss", SK4): the actor
// admits nothing new, the request in flight completes and is committed through
// the pool, the safe release is written, and the host re-acquires the page
// through that release (new generation, takeover floor). A slow ping alone is
// not a loss: it skips one admission and nothing else.

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

const SETTING_MS = 200;
const TAKEOVER_FLOOR_MS = 2_000 * 1.2;

function pollRegistry() {
  const poll: ResourceModule = {
    plan: async () => ({ kind: "request", request: pollsRequest }),
    apply: async () => ({ work: { satisfiesRevision: true }, followups: [] }),
  };
  return testRegistry([testSpec("loss.poll", poll, { kind: "poll", class: "planned", period: { everyMs: 100 } })]);
}

function hostOptions(overrides: Partial<SyncHostOptions>): SyncHostOptions {
  return {
    db: db(),
    connectionString: testDb!.connectionString,
    config: testConfig(testDb!.connectionString),
    rawConfig: testConfig(testDb!.connectionString),
    logger: quietLogger,
    registry: pollRegistry(),
    pause: { readSettingMs: async () => SETTING_MS },
    pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
    routeTimeScale: 0,
    modeLoopIntervalMs: 200,
    ...overrides,
  };
}

/** An attempt in flight: past its send check (the best-effort send mark). */
async function inFlightAttempt(pageId: number): Promise<number> {
  return waitFor(async () => {
    const result = await testDb!.pool.query<{ id: string }>(
      "select a.id::text as id from sync_attempts a where a.page_id = $1 and a.completed_at is null and a.outcome = 'sent' order by a.id desc limit 1",
      [pageId],
    );
    return result.rows[0] ? Number(result.rows[0].id) : null;
  }, 20_000, "a request in flight");
}

async function assertGaps(pageId: number): Promise<void> {
  const sends = await listSendsForPaceAudit(db(), { pageId, since: new Date(0) });
  expect(sends.length).toBeGreaterThan(1);
  for (const send of sends) {
    if (send.gapMs !== null) expect(send.gapMs, `attempt ${send.attemptId}`).toBeGreaterThanOrEqual(SETTING_MS);
  }
}

describe("the lock session ends mid-request", () => {
  it("the request in flight is captured and applied, the release is written, and the new generation waits the floor", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const transport = new ScriptedLiveTransport();
    transport.latencyMs = 600;
    const metrics = new RecordingMetrics();
    const host = new SyncEngineHost(hostOptions({
      liveLoopEnabled: true,
      liveTransportFactory: async () => transport,
      liveSocket: () => null,
      metrics,
    }));
    await host.start();
    try {
      const attemptId = await inFlightAttempt(pageId);
      await testDb.pool.query("select pg_terminate_backend($1)", [host.session!.backendPid!]);
      await waitFor(async () => ((await getSyncPage(db(), pageId))!.owner.generation === 2n ? true : null),
        30_000, "the page re-acquired");
      const attempt = await testDb.pool.query<{ outcome: string; apply_state: string; sent_at: Date }>(
        "select outcome, apply_state, sent_at from sync_attempts where id = $1", [attemptId],
      );
      // Settled by the actor that sent it (recovery would leave it unknown).
      expect(attempt.rows[0]).toMatchObject({ outcome: "response", apply_state: "applied" });
      expect(metrics.get("sync_ownership_session_lost")).toBe(1);
      const page = (await getSyncPage(db(), pageId))!;
      const firstOfNew = await waitFor(async () => {
        const result = await testDb!.pool.query<{ sent_at: Date | null }>(
          "select min(sent_at) as sent_at from sync_attempts where owner_generation = 2", [],
        );
        return result.rows[0]?.sent_at ?? null;
      }, 20_000, "the first send of generation 2");
      // I5: ≥ 1.2 × S after the takeover and after the last recorded send.
      expect(firstOfNew.getTime() - page.owner.acquiredAt!.getTime()).toBeGreaterThanOrEqual(TAKEOVER_FLOOR_MS - 50);
      expect(firstOfNew.getTime() - attempt.rows[0]!.sent_at.getTime()).toBeGreaterThanOrEqual(TAKEOVER_FLOOR_MS - 50);
    } finally {
      await host.stop();
    }
    // Every captured answer was applied; nothing is left half-done.
    expect(await countRows(testDb.pool,
      "select count(*)::int as n from sync_attempts where outcome in ('admitted','sent') or apply_state in ('captured','deferred')")).toBe(0);
    await assertGaps(pageId);
  }, 60_000);
});

describe("a slow ping", () => {
  it("skips one admission and nothing else: no exit, no write", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const ownership = new FakeOwnershipSession();
    ownership.pings = ["timeout"];
    const metrics = new RecordingMetrics();
    const transport = new ScriptedLiveTransport();
    const { actor, stop, abort } = await makeTestActor({
      db: db(),
      pageId,
      registry: pollRegistry(),
      transport,
      ownership,
      metrics,
    });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => (
        await countRows(testDb!.pool, "select count(*)::int as n from sync_attempts where apply_state = 'applied'") >= 2 ? true : null
      ), 15_000, "two applied steps after the slow ping");
    } finally {
      stop.abort();
      expect(await run).toEqual({ kind: "stopped" });
    }
    expect(metrics.get("sync_ping_timeouts")).toBe(1);
    expect(ownership.pingCalls).toBeGreaterThanOrEqual(3);
    // The skipped admission wrote nothing: every attempt was sent and applied.
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts where apply_state <> 'applied'")).toBe(0);
    expect(transport.hits.length).toBe(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts"));
  }, 30_000);
});
