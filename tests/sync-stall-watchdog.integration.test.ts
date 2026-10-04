import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { GenericContainer, getContainerRuntimeClient, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDb,
  createPool,
  getNotificationIncidentByKey,
  getSyncPage,
  listSendsForPaceAudit,
  listSyncPages,
  readPoolSessionTimeouts,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";
import { FANSLY_PAUSE_MIN_MS } from "@agency_hub_core/shared";

import { syncEngineIncidentKey } from "../apps/runtime/src/services/notification-incidents.ts";
import { createSyncContext, SYNC_POOL_TIMEOUTS } from "../apps/runtime/src/sync/context.ts";
import type { SyncLogger } from "../apps/runtime/src/sync/engine/commit.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import { SyncStallWatchdog, type SyncStall } from "../apps/runtime/src/sync/engine/watchdog.ts";
import { createStallIncidentReport, startSyncRuntime } from "../apps/runtime/src/sync/main.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { acquireTestPrerequisite } from "./helpers/prerequisites.ts";
import {
  containerRunProbe,
  countRows,
  CRASH_READ_KEY,
  crashRegistry,
  makeTestActor,
  quietLogger,
  recordingTransport,
  seedSyncPage,
  testConfig,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Step 4, 4-3 (design S4-01): the `sync` process cannot hang for good.
// Layer 0 — the process's pool bounds every checkout, statement, lock wait and
// idle transaction, so a hung database call is an error the engine handles.
// Layer 1 — the stall watchdog: an actor's step, a pass of the host's mode
// loop, a heartbeat beat or an alert pass that never settles ends the process
// (stderr line, `process` incident, exit 70); a failing one does not. Docker
// restarts the container — node is PID 1 there, so `process.exit` is the way
// out, a SIGKILL to itself is not — and the restarted container takes its pages
// back by the OS proof, its first send ≥ 1.2 × S after every known send.

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const SETTING_MS = 300;
/** The takeover floor is computed from max(S, the 2 s minimum). */
const TAKEOVER_FLOOR_MS = Math.max(SETTING_MS, FANSLY_PAUSE_MIN_MS) * 1.2;
/** Short enough for a test, longer than the takeover floor's first slot wait. */
const TEST_STALL_AFTER_MS = 1_500;

let testDb: StartedTestDatabase | null = null;
const children: ChildProcess[] = [];

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

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function syncEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: testDb!.connectionString,
    APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
    LOG_LEVEL: "silent",
    ...extra,
  };
}

/** A watchdog on a test bound whose exit is recorded, not taken. */
function testWatchdog(options: { report?: (stall: SyncStall) => Promise<void> } = {}) {
  const exits: number[] = [];
  const stalls: SyncStall[] = [];
  const watchdog = new SyncStallWatchdog({
    staleAfterMs: TEST_STALL_AFTER_MS,
    checkEveryMs: 50,
    exit: (code) => exits.push(code),
    writeStderr: (line) => stalls.push(JSON.parse(line) as SyncStall),
    ...(options.report === undefined ? {} : { report: options.report }),
  });
  watchdog.start();
  return { watchdog, exits, stalls };
}

/** The SQLSTATE of a driver error, or of the one a drizzle error wraps. */
function sqlState(error: unknown): string | null {
  const own = (error as { code?: unknown } | null)?.code;
  if (typeof own === "string") return own;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause === undefined ? null : sqlState(cause);
}

/** Holds `lock table … in access exclusive mode` on its own session until released. */
async function lockTable(table: string): Promise<{ release(): Promise<void> }> {
  const client = await testDb!.pool.connect();
  await client.query("begin");
  await client.query(`lock table ${table} in access exclusive mode`);
  return {
    async release() {
      await client.query("rollback").catch(() => undefined);
      client.release();
    },
  };
}

describe("layer 0: the sync process's pool timeouts", () => {
  it("the sync process's pool runs with them, the CLI's without", async (context) => {
    if (!testDb) return context.skip();
    const runtime = await createSyncContext({ env: syncEnv(), poolTimeouts: SYNC_POOL_TIMEOUTS });
    const cli = await createSyncContext({ env: syncEnv() });
    try {
      expect(await readPoolSessionTimeouts(runtime.pool)).toEqual({
        statementTimeout: "1min",
        lockTimeout: "30s",
        idleInTransactionSessionTimeout: "1min",
      });
      expect(runtime.pool.options.connectionTimeoutMillis).toBe(30_000);
      expect(await readPoolSessionTimeouts(cli.pool)).toEqual({
        statementTimeout: "0",
        lockTimeout: "0",
        idleInTransactionSessionTimeout: "0",
      });
    } finally {
      await runtime.close();
      await cli.close();
    }
  });

  it("a lock wait, a long statement and an abandoned transaction become errors", async (context) => {
    if (!testDb) return context.skip();
    const pool = createPool(testDb.connectionString, {
      timeouts: { connectionTimeoutMillis: 1_000, statementTimeoutMs: 300, lockTimeoutMs: 200, idleInTransactionSessionTimeoutMs: 300 },
      onBackgroundError: () => undefined,
    });
    const bounded = createDb(pool) as unknown as Database;
    const lock = await lockTable("sync_pages");
    try {
      // lock_not_available (drizzle wraps the driver's error).
      const refused: unknown = await listSyncPages(bounded).then(() => null, (error: unknown) => error);
      expect(sqlState(refused)).toBe("55P03");
    } finally {
      await lock.release();
    }
    // query_canceled by the statement timeout.
    await expect(pool.query("select pg_sleep(2)")).rejects.toMatchObject({ code: "57014" });
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select 1");
      await sleep(800);
      await expect(client.query("select 1")).rejects.toThrow();
    } finally {
      client.release(true);
      await pool.end();
    }
  });
});

describe("layer 1: what never settles is a stall, what fails is not", () => {
  it("an actor whose step never settles after its admission", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await upsertDemand(db(), { pageId, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });
    const { watchdog, exits, stalls } = testWatchdog();
    try {
      const { actor, stop, abort, generation } = await makeTestActor({
        db: db(),
        pageId,
        registry: crashRegistry(),
        transport: recordingTransport(db()),
        faults: (point) => (point === "after_admit" ? new Promise<never>(() => undefined) : undefined),
      });
      // As the host does: the actor's tracker, from its start.
      actor.deps.stall = watchdog.track({ component: "actor", pageId, generation }, "recover");
      void actor.run({ stop: stop.signal, abort: abort.signal });
      await waitFor(() => watchdog.exiting, 10_000, "the stall");
      await watchdog.exiting;
      expect(exits).toEqual([70]);
      expect(stalls).toEqual([expect.objectContaining({ component: "actor", pageId, generation: String(generation), phase: "admit" })]);
      // Admitted, never sent: what a restart closes as `unknown`.
      expect(await countRows(testDb.pool,
        "select count(*)::int as n from sync_attempts where page_id = $1 and outcome = 'admitted'", [pageId])).toBe(1);
      expect(await countRows(testDb.pool, "select count(*)::int as n from sync_test_hits")).toBe(0);
    } finally {
      watchdog.stop();
    }
  }, 60_000);

  it("the host: a pass of its mode loop that never settles (listSyncPages)", async (context) => {
    if (!testDb) return context.skip();
    const sync = await createSyncContext({ env: syncEnv() });
    const { watchdog, exits, stalls } = testWatchdog({
      report: createStallIncidentReport({ connectionString: testDb.connectionString, logger: quietLogger }),
    });
    const runtime = await startSyncRuntime(sync, { watchdog, heartbeatIntervalMs: 200 });
    // Many passes, no stall.
    await sleep(3 * TEST_STALL_AFTER_MS);
    expect(exits).toEqual([]);
    const lock = await lockTable("sync_pages");
    try {
      await waitFor(() => watchdog.exiting, 15_000, "the stall");
      await watchdog.exiting;
    } finally {
      await lock.release();
    }
    expect(exits).toEqual([70]);
    expect(stalls).toEqual([expect.objectContaining({ component: "host", phase: "list_pages", pageId: null })]);
    // The incident went through a client of its own while the pool's pass hung.
    expect(await getNotificationIncidentByKey(db(), syncEngineIncidentKey({ subKey: "process", pageId: null })))
      .toMatchObject({ status: "open", errorCode: "stalled", errorSummary: expect.stringContaining("the host's mode loop") });
    await runtime.stop();
    await sync.close();
  }, 60_000);

  it("the alert evaluator: a pass that never settles", async (context) => {
    if (!testDb) return context.skip();
    const sync = await createSyncContext({ env: syncEnv() });
    const { watchdog, exits, stalls } = testWatchdog();
    // Before the start: the evaluator's first pass waits on the lock.
    const lock = await lockTable("notification_incidents");
    const started = startSyncRuntime(sync, { watchdog, heartbeatIntervalMs: 200 });
    try {
      await waitFor(() => watchdog.exiting, 15_000, "the stall");
      await watchdog.exiting;
    } finally {
      await lock.release();
    }
    expect(exits).toEqual([70]);
    expect(stalls).toEqual([expect.objectContaining({ component: "alerts", phase: "pages", pageId: null })]);
    await (await started).stop();
    await sync.close();
  }, 60_000);

  it("a heartbeat beat that never settles is a stall; one the pool's lock timeout fails is not", async (context) => {
    if (!testDb) return context.skip();
    // The pool without timeouts: the beat waits on the lock for ever.
    const unbounded = await createSyncContext({ env: syncEnv() });
    const hung = testWatchdog();
    const first = await startSyncRuntime(unbounded, { host: null, watchdog: hung.watchdog, heartbeatIntervalMs: 100 });
    let lock = await lockTable("runtime_instances");
    try {
      await waitFor(() => hung.watchdog.exiting, 15_000, "the stall");
      await hung.watchdog.exiting;
    } finally {
      await lock.release();
    }
    expect(hung.exits).toEqual([70]);
    expect(hung.stalls).toEqual([expect.objectContaining({ component: "heartbeat", phase: "beat" })]);
    await first.stop();
    await unbounded.close();

    // The same lock under a lock timeout: every beat fails, and settles.
    const bounded = await createSyncContext({
      env: syncEnv(),
      poolTimeouts: { ...SYNC_POOL_TIMEOUTS, lockTimeoutMs: 100 },
    });
    const failing = testWatchdog();
    const second = await startSyncRuntime(bounded, { host: null, watchdog: failing.watchdog, heartbeatIntervalMs: 100 });
    lock = await lockTable("runtime_instances");
    try {
      await sleep(4 * TEST_STALL_AFTER_MS);
    } finally {
      await lock.release();
    }
    expect(failing.exits).toEqual([]);
    expect(failing.watchdog.exiting).toBeNull();
    // A stop is not a stall: once the runtime stops, nothing is watched.
    await second.stop();
    expect(failing.watchdog.tracked).toBe(0);
    await bounded.close();
  }, 90_000);
});

interface Child {
  process: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout(): string;
  stderr(): string;
}

async function spawnChild(mode: string, env: NodeJS.ProcessEnv): Promise<Child> {
  const child = spawn(process.execPath, ["--import", "tsx/esm", "tests/helpers/sync-engine-child.ts", mode], {
    env: { ...process.env, ...syncEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`child exited early (${child.exitCode}): ${stderr}`);
    return stdout.includes("ready ") ? true : null;
  }, 30_000, `the ${mode} child`);
  return { process: child, exited, stdout: () => stdout, stderr: () => stderr };
}

function recordingLogger(): SyncLogger & { infos: Array<{ obj: Record<string, unknown>; msg: string }> } {
  const infos: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    infos,
    debug: () => undefined,
    info: (obj, msg) => infos.push({ obj: obj as Record<string, unknown>, msg: msg ?? "" }),
    warn: () => undefined,
    error: () => undefined,
  };
}

describe("a real process", () => {
  it("stalled after a send, it exits 70; the restarted container takes the page back, not before 1.2 × S", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const child = await spawnChild("stall-live", {
      PAGE_ID: String(pageId),
      FAULT_POINT: "after_send",
      SETTING_MS: String(SETTING_MS),
      STALL_AFTER_MS: String(4_000),
      SYNC_TEST_PID_NS: "pid:[4026532001]",
    });
    const exit = await Promise.race([
      child.exited,
      sleep(30_000).then(() => {
        throw new Error(`the stalled child did not exit; stderr:\n${child.stderr()}`);
      }),
    ]);
    expect(exit, child.stderr()).toEqual({ code: 70, signal: null });
    const line = child.stderr().split("\n").find((entry) => entry.includes("stalled; exiting"));
    expect(JSON.parse(line!)).toMatchObject({ component: "actor", pageId, generation: "1", phase: "commit" });
    expect(await getNotificationIncidentByKey(db(), syncEngineIncidentKey({ subKey: "process", pageId: null })))
      .toMatchObject({ status: "open", errorCode: "stalled", errorSummary: expect.stringContaining(`the actor of page ${pageId}`) });
    // Its request went out; nothing after it was committed, and no safe release.
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_test_hits")).toBe(1);
    const before = (await getSyncPage(db(), pageId))!.owner;
    expect(before).toMatchObject({ generation: 1n, pidNs: "pid:[4026532001]", releasedAt: null });

    // Docker starts the container again: same container id, a new pid namespace.
    const logger = recordingLogger();
    const host = new SyncEngineHost({
      db: db(),
      connectionString: testDb.connectionString,
      config: testConfig(testDb.connectionString),
      rawConfig: testConfig(testDb.connectionString),
      logger,
      registry: crashRegistry(),
      probe: containerRunProbe("pid:[4026532002]"),
      pause: { readSettingMs: async () => SETTING_MS },
      pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
      routeTimeScale: 0,
      modeLoopIntervalMs: 200,
      liveTransportFactory: async () => recordingTransport(db()),
      liveSocket: () => null,
    });
    await host.start();
    try {
      await waitFor(async () => {
        const done = await countRows(testDb!.pool, "select count(*)::int as n from sync_work where page_id = $1 and state = 'done'", [pageId]);
        const pending = await countRows(testDb!.pool,
          "select count(*)::int as n from sync_attempts where page_id = $1 and (outcome in ('admitted','sent') or apply_state in ('captured','deferred'))",
          [pageId]);
        return done === 1 && pending === 0 ? true : null;
      }, 30_000, "the read applied after the restart");
    } finally {
      await host.stop();
    }
    expect(logger.infos.find((entry) => entry.msg === "Fansly sync host: page acquired")?.obj)
      .toMatchObject({ pageId, generation: "2", evidence: "os:pid_namespace_replaced" });
    const attempts = await testDb.pool.query<{ owner_generation: string; outcome: string; apply_state: string; sent_at: Date | null; admitted_at: Date }>(
      "select owner_generation::text, outcome, apply_state, sent_at, admitted_at from sync_attempts where page_id = $1 order by id", [pageId]);
    expect(attempts.rows).toMatchObject([
      { owner_generation: "1", outcome: "unknown", apply_state: "none" },
      { owner_generation: "2", outcome: "response", apply_state: "applied" },
    ]);
    // I5: the first send of the new run waits 1.2 × S after the dead run's send
    // (its upper bound when no send instant was recorded) and after the takeover.
    const dead = attempts.rows[0]!;
    const deadSendMs = dead.sent_at?.getTime() ?? dead.admitted_at.getTime() + 15_000;
    const firstSend = attempts.rows[1]!.sent_at!;
    const taken = (await getSyncPage(db(), pageId))!.owner;
    expect(firstSend.getTime() - deadSendMs).toBeGreaterThanOrEqual(TAKEOVER_FLOOR_MS - 50);
    expect(firstSend.getTime() - taken.acquiredAt!.getTime()).toBeGreaterThanOrEqual(TAKEOVER_FLOOR_MS - 50);
    for (const send of await listSendsForPaceAudit(db(), { pageId, since: new Date(0) })) {
      if (send.gapMs !== null) expect(send.gapMs).toBeGreaterThanOrEqual(TAKEOVER_FLOOR_MS - 50);
    }
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_test_hits")).toBe(2);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_test_effects")).toBe(1);
  }, 120_000);

  it("SIGTERM ends it at the shutdown cap when the stop never finishes", async (context) => {
    if (!testDb) return context.skip();
    const capMs = 1_500;
    const child = await spawnChild("shutdown-cap", { SHUTDOWN_CAP_MS: String(capMs) });
    const signalledAt = Date.now();
    child.process.kill("SIGTERM");
    const exit = await Promise.race([
      child.exited,
      sleep(20_000).then(() => {
        throw new Error(`the child did not exit at its cap; stderr:\n${child.stderr()}`);
      }),
    ]);
    const tookMs = Date.now() - signalledAt;
    expect(exit, child.stderr()).toEqual({ code: 0, signal: null });
    expect(tookMs).toBeGreaterThanOrEqual(capMs - 100);
    expect(child.stderr()).toContain("shutdown cap reached");
  }, 60_000);
});

describe("node as PID 1 in a container (the production base image)", () => {
  // The facts the exit rests on (design §1, I-C §3.3): a SIGKILL node sends to
  // itself as PID 1 is ignored by the kernel; `process.exit(70)` ends the
  // container with 70, which `restart: unless-stopped` restarts.
  it("ignores a SIGKILL to itself and exits with the code it asks for", async () => {
    const image = /^ARG NODE_BASE_IMAGE=(\S+)$/m.exec(readFileSync("Dockerfile", "utf8"))?.[1];
    expect(image).toBeDefined();
    const script = [
      "console.log('pid=' + process.pid);",
      "console.log('ready');",
      "setTimeout(() => {",
      "  process.kill(process.pid, 'SIGKILL');",
      "  setTimeout(() => { console.log('alive after SIGKILL'); process.exit(70); }, 500);",
      "}, 300);",
    ].join(" ");
    const started = await acquireTestPrerequisite(
      () => new GenericContainer(image!)
        .withCommand(["node", "-e", script])
        .withWaitStrategy(Wait.forLogMessage("ready"))
        .start(),
      { prerequisite: "Docker", reason: "The PID-1 facts are checked in a real container." },
    );
    if (started === null) return;
    try {
      const docker = (await getContainerRuntimeClient()).container.dockerode.getContainer(started.getId());
      const state = await waitFor(async () => {
        const info = await docker.inspect();
        return info.State.Running ? null : info.State;
      }, 30_000, "the container's exit");
      const logs = (await docker.logs({ stdout: true, stderr: true })).toString();
      expect(logs).toContain("pid=1");
      expect(logs).toContain("alive after SIGKILL");
      expect(state.ExitCode).toBe(70);
    } finally {
      await started.stop().catch(() => undefined);
    }
  }, 180_000);
});
