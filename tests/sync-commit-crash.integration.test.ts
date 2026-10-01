import { spawn } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSyncPage, upsertDemand, type Database } from "@agency_hub_core/db";

import { SyncCrashFault, type SyncFaultPoint } from "../apps/runtime/src/sync/engine/commit.ts";
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
  recordingTransport,
  seedSyncPage,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Kill at every transaction boundary of a live step (plan §8, design §3.7,
// I8): admit → HTTP → capture → apply. A crash before the capture leaves the
// attempt `unknown` and the read is repeated as a new, counted attempt; a
// crash after the capture applies from the journal WITHOUT a new request; a
// crash inside the apply rolls it back and it is applied exactly once.

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
    mode: "live",
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
    await upsertDemand(db(), { pageId, shadow: false, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });

    const first = await makeTestActor({
      db: db(),
      pageId,
      mode: "live",
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
