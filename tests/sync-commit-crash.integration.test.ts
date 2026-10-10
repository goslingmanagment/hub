import { spawn } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSyncPage, upsertDemand, type Database } from "@agency_hub_core/db";

import { SyncCrashFault, type SyncFaultPoint } from "../apps/runtime/src/sync/engine/commit.ts";
import type { ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  countRows,
  CRASH_READ_KEY,
  crashRegistry,
  makeTestActor,
  pollsRequest,
  RecordingAlerts,
  recordingTransport,
  seedSyncPage,
  testRegistry,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Kill at every transaction boundary of a live step (plan §8, design §3.7,
// I8): admit → HTTP → capture → apply. A crash before the capture leaves the
// attempt `unknown` and the read is repeated as a new, counted attempt; a
// crash after the capture applies from the journal WITHOUT a new request; a
// crash inside the apply rolls it back and it is applied exactly once.
// Two crashes before the capture of one work within 10 min (bug hunt Д3):
// the third owner's recovery quarantines it instead of reading it a third
// time (`unknown_repeated`, alert 2).

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  await testDb?.pool.query(`
    create table if not exists sync_test_effects (observation_id bigint primary key, attempt_id bigint not null);
    create table if not exists sync_test_hits (id bigserial primary key, pid int not null, at timestamptz not null default clock_timestamp());
  `);
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

interface AttemptView {
  owner_generation: string;
  outcome: string;
  apply_state: string;
  observation_id: string | null;
}

async function attempts(): Promise<AttemptView[]> {
  const result = await testDb!.pool.query<AttemptView>(
    "select owner_generation::text, outcome, apply_state, observation_id::text from sync_attempts order by id",
  );
  return result.rows;
}

/** The restarted owner: a new generation (the dead one's stop confirmed),
 *  runs until the read is applied and nothing is left to apply. */
async function restartUntilApplied(pageId: number): Promise<void> {
  const { actor, stop, abort } = await makeTestActor({
    db: db(),
    pageId,
    registry: crashRegistry(),
    transport: recordingTransport(db()),
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => {
      const done = await countRows(testDb!.pool, "select count(*)::int as n from sync_work where state = 'done'");
      const pending = await countRows(testDb!.pool,
        "select count(*)::int as n from sync_attempts where outcome in ('admitted','sent') or apply_state in ('captured','deferred')");
      return done === 1 && pending === 0 ? true : null;
    }, 20_000, "the read applied after the restart");
  } finally {
    stop.abort();
    await run;
  }
}

const EXPECTED: Record<SyncFaultPoint, { hits: number; attempts: Array<Partial<AttemptView>> }> = {
  // Nothing was sent: the attempt is unknown, the read happens once, later.
  after_admit: { hits: 1, attempts: [{ owner_generation: "1", outcome: "unknown", apply_state: "none" }, { owner_generation: "2", outcome: "response", apply_state: "applied" }] },
  // Sent but not captured: unknown, and repeated as a new counted attempt.
  after_send: { hits: 2, attempts: [{ owner_generation: "1", outcome: "unknown", apply_state: "none" }, { owner_generation: "2", outcome: "response", apply_state: "applied" }] },
  // Captured: applied from the journal, no new request.
  after_capture: { hits: 1, attempts: [{ owner_generation: "1", outcome: "response", apply_state: "applied" }] },
  // The apply rolled back: applied once from the journal.
  in_apply: { hits: 1, attempts: [{ owner_generation: "1", outcome: "response", apply_state: "applied" }] },
  // Applied before the crash: nothing to do again.
  after_apply: { hits: 1, attempts: [{ owner_generation: "1", outcome: "response", apply_state: "applied" }] },
};

describe("a crash at every boundary of a live step", () => {
  for (const point of Object.keys(EXPECTED) as SyncFaultPoint[]) it(point, async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await upsertDemand(db(), { pageId, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });

    const first = await makeTestActor({
      db: db(),
      pageId,
      registry: crashRegistry(),
      transport: recordingTransport(db()),
      faults: (at) => {
        if (at === point) throw new SyncCrashFault(at);
      },
    });
    await expect(first.actor.run({ stop: first.stop.signal, abort: first.abort.signal })).rejects.toBeInstanceOf(SyncCrashFault);
    await restartUntilApplied(pageId);

    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_test_hits")).toBe(EXPECTED[point].hits);
    expect(await attempts()).toMatchObject(EXPECTED[point].attempts);
    // Exactly one effect, from the observation of the applied attempt.
    const effects = await testDb.pool.query<{ observation_id: string; attempt_id: string }>(
      "select observation_id::text, attempt_id::text from sync_test_effects",
    );
    expect(effects.rows).toHaveLength(1);
    const applied = (await attempts()).find((row) => row.apply_state === "applied")!;
    expect(effects.rows[0]!.observation_id).toBe(applied.observation_id);
    // Every observation journaled belongs to an attempt (capture before parse).
    expect(await countRows(testDb.pool, "select count(*)::int as n from observations where producer = 'fansly-sync:crash.read'"))
      .toBe((await attempts()).filter((row) => row.observation_id !== null).length);
  }, 60_000);
});

describe("a real process killed (SIGKILL) at a boundary", () => {
  async function killAt(point: SyncFaultPoint): Promise<number> {
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const child = spawn(process.execPath, ["--import", "tsx/esm", "tests/helpers/sync-engine-child.ts", "live-crash"], {
      env: { ...process.env, DATABASE_URL: testDb!.connectionString, PAGE_ID: String(pageId), FAULT_POINT: point },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    expect(exit, stderr).toEqual({ code: null, signal: "SIGKILL" });
    return pageId;
  }

  it("after the send: the dead process's request is unknown and read again once", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await killAt("after_send");
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_test_hits")).toBe(1);
    await restartUntilApplied(pageId);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_test_hits")).toBe(2);
    expect(await attempts()).toMatchObject(EXPECTED.after_send.attempts);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_test_effects")).toBe(1);
    expect((await getSyncPage(db(), pageId))!.owner.generation).toBe(2n);
  }, 90_000);

  it("inside the apply: the captured answer is applied once from the journal, without a request", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await killAt("in_apply");
    await restartUntilApplied(pageId);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_test_hits")).toBe(1);
    expect(await attempts()).toMatchObject(EXPECTED.in_apply.attempts);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_test_effects")).toBe(1);
  }, 90_000);
});

describe("the request limiter: two crashes before the capture of one work (bug hunt Д3)", () => {
  /** An owner whose `n`-th send crashes the process right after it (the
   *  attempt is left to the next owner's recovery). */
  async function crashOnSend(pageId: number, n = 1, registry = crashRegistry()): Promise<void> {
    let sends = 0;
    const owner = await makeTestActor({
      db: db(),
      pageId,
      registry,
      transport: recordingTransport(db()),
      faults: (at) => {
        if (at !== "after_send") return;
        sends += 1;
        if (sends === n) throw new SyncCrashFault(at);
      },
    });
    await expect(owner.actor.run({ stop: owner.stop.signal, abort: owner.abort.signal })).rejects.toBeInstanceOf(SyncCrashFault);
  }

  const hits = () => countRows(testDb!.pool, "select count(*)::int as n from sync_test_hits");

  it("two crashes after the send on one work within 10 min quarantine it, alert 2", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await upsertDemand(db(), { pageId, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });
    await crashOnSend(pageId);
    await crashOnSend(pageId);
    expect(await hits()).toBe(2);

    const alerts = new RecordingAlerts();
    const third = await makeTestActor({ db: db(), pageId, registry: crashRegistry(), transport: recordingTransport(db()), alerts });
    const run = third.actor.run({ stop: third.stop.signal, abort: third.abort.signal });
    try {
      await waitFor(async () => (
        await countRows(testDb!.pool, "select count(*)::int as n from sync_work where state = 'quarantined'") === 1 ? true : null
      ), 20_000, "the quarantine");
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      third.stop.abort();
      await run;
    }

    // No third read.
    expect(await hits()).toBe(2);
    expect(await attempts()).toMatchObject([
      { owner_generation: "1", outcome: "unknown", apply_state: "none" },
      { owner_generation: "2", outcome: "unknown", apply_state: "none" },
    ]);
    const work = await testDb.pool.query<{ state: string; last_error_class: string; reason: string; attempts: number[] }>(
      `select state, last_error_class, result -> 'quarantine' ->> 'reason' as reason,
              array(select jsonb_array_elements_text(result -> 'quarantine' -> 'detail' -> 'attempts')::bigint)::int[] as attempts
         from sync_work`,
    );
    const ids = await testDb.pool.query<{ id: number }>("select id::int from sync_attempts order by id desc");
    expect(work.rows).toEqual([{
      state: "quarantined",
      last_error_class: "unknown_repeated",
      reason: "unknown_repeated",
      attempts: ids.rows.map((row) => row.id),
    }]);
    expect(alerts.opened).toEqual([expect.objectContaining({
      subKey: "live_degraded",
      detail: "quarantined",
      context: expect.objectContaining({ resource: CRASH_READ_KEY, reason: "unknown_repeated" }),
    })]);
  }, 60_000);

  it("an applied answer between two crashes keeps it open", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await upsertDemand(db(), { pageId, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });
    // A read whose apply leaves the work open (due again at once) until the
    // test lets it close.
    let close = false;
    const read: ResourceModule = {
      plan: async () => ({ kind: "request", request: pollsRequest }),
      apply: async () => ({ work: { satisfiesRevision: true, ...(close ? { close: "done" as const } : {}) }, followups: [] }),
    };
    const registry = testRegistry([testSpec(CRASH_READ_KEY, read)]);
    await crashOnSend(pageId, 1, registry);
    // The next owner reads once (applied), then crashes on its second send.
    await crashOnSend(pageId, 2, registry);
    expect(await hits()).toBe(3);

    close = true;
    const third = await makeTestActor({ db: db(), pageId, registry, transport: recordingTransport(db()) });
    const run = third.actor.run({ stop: third.stop.signal, abort: third.abort.signal });
    try {
      await waitFor(async () => (
        await countRows(testDb!.pool, "select count(*)::int as n from sync_work where state = 'done'") === 1 ? true : null
      ), 20_000, "the read applied");
    } finally {
      third.stop.abort();
      await run;
    }

    // The newest two attempts were not both unknown: read again, never quarantined.
    expect(await hits()).toBe(4);
    expect(await attempts()).toMatchObject([
      { owner_generation: "1", outcome: "unknown" },
      { owner_generation: "2", outcome: "response", apply_state: "applied" },
      { owner_generation: "2", outcome: "unknown" },
      { owner_generation: "3", outcome: "response", apply_state: "applied" },
    ]);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_work where last_error_class = 'unknown_repeated'")).toBe(0);
  }, 60_000);

  it("a second crash older than 10 min keeps it open", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await upsertDemand(db(), { pageId, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });
    await crashOnSend(pageId);
    await crashOnSend(pageId);
    // The first of the two was admitted 11 minutes ago: two unrelated crashes.
    await testDb.pool.query(
      "update sync_attempts set admitted_at = admitted_at - interval '11 minutes' where id = (select min(id) from sync_attempts)",
    );
    await restartUntilApplied(pageId);

    expect(await hits()).toBe(3);
    expect(await attempts()).toMatchObject([
      { owner_generation: "1", outcome: "unknown" },
      { owner_generation: "2", outcome: "unknown" },
      { owner_generation: "3", outcome: "response", apply_state: "applied" },
    ]);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_test_effects")).toBe(1);
  }, 60_000);
});
