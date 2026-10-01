import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getSyncPage,
  listSendsForPaceAudit,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";

import { SyncCrashFault } from "../apps/runtime/src/sync/engine/commit.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import { fixedShadowLatency } from "../apps/runtime/src/sync/engine/shadow.ts";
import type { ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  changedTables,
  makeTestActor,
  pollsRequest,
  quietLogger,
  RecordingMetrics,
  seedSyncPage,
  tableCounts,
  testConfig,
  testRegistry,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Shadow (design §3.12, I14): the actor runs the scheduler, the pacer and the
// ownership for real, journals every simulated step in sync_attempts and
// advances sync_work — and nothing else: no observation, no domain table, no
// page send facts, no transport.

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

function handles() {
  return { db: db(), pool: testDb!.pool };
}

const SETTING_MS = 100;

function shadowRegistry(metrics?: RecordingMetrics) {
  let polled = 0;
  const poll: ResourceModule = {
    plan: async () => ({ kind: "request", request: pollsRequest }),
    apply: async () => {
      throw new Error("a shadow page never applies");
    },
    shadow: async () => {
      polled += 1;
      return {
        work: { satisfiesRevision: true },
        followups: [{ resource: "shadowtest.read", subject: `post-${polled}`, demand: { reason: "poll" } }],
        counters: { queue_write: 1 },
      };
    },
  };
  const read: ResourceModule = {
    plan: async (work) => ({ kind: "request", request: { spec: "post.replies", params: { postId: work.subject, before: null } } }),
    apply: async () => {
      throw new Error("a shadow page never applies");
    },
    shadow: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
  };
  return testRegistry([
    testSpec("shadowtest.poll", poll, { kind: "poll", class: "planned", period: { everyMs: 150 } }),
    testSpec("shadowtest.read", read, { evidence: true }),
  ], metrics);
}

describe("a page in shadow", () => {
  it("is owned and paced for real, journals its simulated steps, and writes nothing else", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage(handles(), { mode: "shadow" });
    const before = await tableCounts(testDb.pool);
    const metrics = new RecordingMetrics();
    let liveTransports = 0;
    const host = new SyncEngineHost({
      db: db(),
      connectionString: testDb.connectionString,
      config: testConfig(testDb.connectionString),
      rawConfig: testConfig(testDb.connectionString),
      logger: quietLogger,
      registry: shadowRegistry(metrics),
      metrics,
      pause: { readSettingMs: async () => SETTING_MS },
      pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
      shadowLatency: () => fixedShadowLatency(40),
      liveTransportFactory: async () => {
        liveTransports += 1;
        throw new Error("a shadow page never builds a live transport");
      },
      modeLoopIntervalMs: 200,
    });
    await host.start();
    try {
      // The takeover floor (1.2 × the 2 s minimum) passes, then the poll and
      // the reads it asks for alternate on the page's one pacer.
      await waitFor(async () => {
        const result = await testDb!.pool.query<{ n: number }>(
          "select count(*)::int as n from sync_attempts where outcome = 'shadow'",
        );
        return Number(result.rows[0]?.n ?? 0) >= 8 ? true : null;
      }, 30_000, "eight simulated steps");
    } finally {
      await host.stop();
    }

    expect(liveTransports).toBe(0);
    expect(changedTables(before, await tableCounts(testDb.pool))).toEqual(["sync_attempts", "sync_work"]);

    const attempts = await testDb.pool.query<{
      shadow: boolean; outcome: string; send_mark: string; apply_state: string; evidence: boolean;
      sent_at: Date | null; observation_id: string | null; resource: string; owner_generation: string;
    }>("select shadow, outcome, send_mark, apply_state, evidence, sent_at, observation_id, resource, owner_generation::text from sync_attempts order by id");
    expect(attempts.rows.length).toBeGreaterThanOrEqual(8);
    for (const row of attempts.rows) {
      expect(row).toMatchObject({ shadow: true, outcome: "shadow", send_mark: "shadow", apply_state: "skipped", evidence: false, observation_id: null });
      expect(row.sent_at).not.toBeNull();
      expect(row.owner_generation).toBe("1");
    }
    expect(new Set(attempts.rows.map((row) => row.resource))).toEqual(new Set(["shadowtest.poll", "shadowtest.read"]));

    // The page's live send facts are the takeover truth of live owners only.
    const page = await getSyncPage(db(), pageId);
    expect(page!.lastSendAt).toBeNull();
    expect(page!.lastCompletedAt).toBeNull();
    expect(page!.owner.generation).toBe(1n);
    // The safe release of the shutdown.
    expect(page!.owner.releaseGeneration).toBe(1n);
    expect(page!.owner.releasedAt).not.toBeNull();

    // Simulated sends keep the owner's pause too.
    const sends = await listSendsForPaceAudit(db(), { pageId, since: new Date(0), shadow: true });
    expect(sends.length).toBe(attempts.rows.length);
    for (const send of sends) {
      if (send.gapMs !== null) expect(send.gapMs).toBeGreaterThanOrEqual(SETTING_MS);
    }
    // Effects that are not work are counted, never written.
    expect(metrics.get("sync_shadow_effect")).toBeGreaterThan(0);
    const shadowWork = await testDb.pool.query<{ shadow: boolean }>("select distinct shadow from sync_work");
    expect(shadowWork.rows).toEqual([{ shadow: true }]);
  }, 60_000);

  it("a shadow actor that dies mid-step leaves its admitted attempt; the next start closes it as shadow", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage(handles(), { mode: "shadow" });
    const registry = shadowRegistry();
    await upsertDemand(db(), { pageId, shadow: true, resource: "shadowtest.read", subject: "post-1", kind: "trigger", class: "urgent" });

    const first = await makeTestActor({
      db: db(),
      pageId,
      mode: "shadow",
      registry,
      faults: (point) => {
        if (point === "after_admit") throw new SyncCrashFault(point);
      },
    });
    await expect(first.actor.run({ stop: first.stop.signal, abort: first.abort.signal })).rejects.toBeInstanceOf(SyncCrashFault);
    const orphan = await testDb.pool.query<{ id: string; outcome: string; completed_at: Date | null }>(
      "select id::text, outcome, completed_at from sync_attempts",
    );
    expect(orphan.rows).toMatchObject([{ outcome: "admitted", completed_at: null }]);

    const second = await makeTestActor({ db: db(), pageId, mode: "shadow", registry });
    const run = second.actor.run({ stop: second.stop.signal, abort: second.abort.signal });
    try {
      await waitFor(async () => {
        const rows = await testDb!.pool.query<{ n: number }>(
          "select count(*)::int as n from sync_attempts where owner_generation = 2 and outcome = 'shadow'",
        );
        return Number(rows.rows[0]?.n ?? 0) >= 1 ? true : null;
      }, 10_000, "the second actor's simulated step");
    } finally {
      second.stop.abort();
      await run;
    }
    const recovered = await testDb.pool.query<{ outcome: string; send_mark: string; apply_state: string; sent_at: Date | null; completed_at: Date | null }>(
      "select outcome, send_mark, apply_state, sent_at, completed_at from sync_attempts where id = $1",
      [orphan.rows[0]!.id],
    );
    // Nothing was sent for it: closed as shadow, no send instant, prunable.
    expect(recovered.rows[0]).toMatchObject({ outcome: "shadow", send_mark: "shadow", apply_state: "skipped", sent_at: null });
    expect(recovered.rows[0]!.completed_at).not.toBeNull();
    const work = await testDb.pool.query<{ state: string; close_reason: string | null }>(
      "select state, close_reason from sync_work where resource = 'shadowtest.read' and subject = 'post-1'",
    );
    expect(work.rows).toEqual([{ state: "done", close_reason: null }]);
  }, 60_000);
});
