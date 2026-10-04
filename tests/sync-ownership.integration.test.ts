import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquireSyncPageOwnership,
  getSyncPage,
  listSendsForPaceAudit,
  type Database,
} from "@agency_hub_core/db";

import type { FanslySendOsProbe } from "../apps/runtime/src/services/fansly-send-guard/os-probe.ts";
import { SyncEngineHost, type SyncHostOptions } from "../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import { confirmStoppedSyncOwners } from "../apps/runtime/src/sync/inspect.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  childPollRegistry,
  countRows,
  quietLogger,
  ScriptedLiveTransport,
  seedSyncPage,
  testConfig,
  testOwner,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Page ownership (plan §2.4, §8; design §3.6, I5, I6): one owner at a time; a
// new owner only after the previous one is CONFIRMED stopped — its own safe
// release, an OS proof (pid gone, pid reused, container restarted), or a
// Docker-level confirmation — and then not before 1.2 × S. A lost session
// alone is never a confirmation, and a resumed old owner cannot send.

let testDb: StartedTestDatabase | null = null;
const children: ChildProcess[] = [];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGCONT");
      child.kill("SIGKILL");
    }
  }
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const SETTING_MS = 300;
/** The takeover floor is computed from max(S, the 2 s minimum). */
const TAKEOVER_FLOOR_MS = 2_000 * 1.2;

interface SyncChild {
  process: ChildProcess;
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}

async function spawnSyncHost(env: Record<string, string> = {}): Promise<SyncChild> {
  const child = spawn(process.execPath, ["--import", "tsx/esm", "tests/helpers/sync-engine-child.ts", "host"], {
    env: { ...process.env, DATABASE_URL: testDb!.connectionString, SETTING_MS: String(SETTING_MS), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`sync child exited early: ${output}`);
    return output.includes("ready ") ? true : null;
  }, 30_000, "the sync child");
  return { process: child, pid: child.pid!, exited, output: () => output };
}

async function owner(pageId: number) {
  return (await getSyncPage(db(), pageId))!.owner;
}

/** Every pair of sends of the page, across owners, at least S apart. */
async function assertNoPaceViolation(pageId: number): Promise<number> {
  const sends = await listSendsForPaceAudit(db(), { pageId, since: new Date(0) });
  for (const send of sends) {
    if (send.gapMs !== null) expect(send.gapMs, `attempt ${send.attemptId}`).toBeGreaterThanOrEqual(SETTING_MS);
  }
  return sends.length;
}

async function firstSendOfGeneration(pageId: number, generation: number): Promise<Date> {
  return waitFor(async () => {
    const result = await testDb!.pool.query<{ sent_at: Date | null }>(
      "select min(sent_at) as sent_at from sync_attempts where page_id = $1 and owner_generation = $2 and sent_at is not null",
      [pageId, generation],
    );
    return result.rows[0]?.sent_at ?? null;
  }, 20_000, `the first send of generation ${generation}`);
}

/** A live page the engine owns at the wire (the guard row's owner). */
function seedLivePage() {
  return seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
}

function hostOptions(probe: FanslySendOsProbe, overrides: Partial<SyncHostOptions> = {}): SyncHostOptions {
  return {
    db: db(),
    connectionString: testDb!.connectionString,
    config: testConfig(testDb!.connectionString),
    rawConfig: testConfig(testDb!.connectionString),
    logger: quietLogger,
    registry: childPollRegistry(),
    probe,
    pause: { readSettingMs: async () => SETTING_MS },
    pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
    routeTimeScale: 0,
    liveTransportFactory: async () => {
      const transport = new ScriptedLiveTransport();
      transport.latencyMs = 50;
      return transport;
    },
    liveSocket: () => null,
    modeLoopIntervalMs: 200,
    ...overrides,
  };
}

function stubProbe(overrides: Partial<FanslySendOsProbe> = {}): FanslySendOsProbe {
  return {
    hostname: () => "in-process-host",
    bootId: () => null,
    pidNamespace: () => null,
    containerId: () => null,
    processStartToken: () => "start-token",
    ...overrides,
  };
}

describe("two sync processes on one page", () => {
  it("only one owns it; killed -9, the other takes over by the OS proof, not before 1.2 × S", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedLivePage();
    const a = await spawnSyncHost();
    await waitFor(async () => ((await owner(pageId)).pid === a.pid ? true : null), 20_000, "process A owns the page");
    const b = await spawnSyncHost();
    await sleep(2_000);
    // B holds no lock and no generation while A lives.
    expect(await owner(pageId)).toMatchObject({ generation: 1n, pid: a.pid });
    await firstSendOfGeneration(pageId, 1);

    a.process.kill("SIGKILL");
    expect(await a.exited).toEqual({ code: null, signal: "SIGKILL" });
    await waitFor(async () => ((await owner(pageId)).pid === b.pid ? true : null), 20_000, "process B takes the page over");
    const taken = await owner(pageId);
    expect(taken.generation).toBe(2n);
    // A died without a release: the takeover came from the OS proof.
    expect(taken.releasedAt).toBeNull();

    const firstSend = await firstSendOfGeneration(pageId, 2);
    expect(firstSend.getTime() - taken.acquiredAt!.getTime()).toBeGreaterThanOrEqual(TAKEOVER_FLOOR_MS - 50);
    await sleep(1_000);
    b.process.kill("SIGTERM");
    expect(await b.exited).toEqual({ code: 0, signal: null });
    expect(await assertNoPaceViolation(pageId)).toBeGreaterThan(2);
    // B's graceful stop released its generation.
    expect(await owner(pageId)).toMatchObject({ generation: 2n, releaseGeneration: 2n });
  }, 120_000);

  it("a stopped owner whose session was cut is not taken over until confirmed; resumed, it cannot send", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedLivePage();
    const a = await spawnSyncHost({ SYNC_TEST_HOSTNAME: "sync-host-a" });
    await waitFor(async () => ((await owner(pageId)).pid === a.pid ? true : null), 20_000, "process A owns the page");
    await firstSendOfGeneration(pageId, 1);

    a.process.kill("SIGSTOP");
    // Its lock session ends (as when a frozen process's connection is dropped).
    await testDb.pool.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'fansly-sync-owner' and datname = current_database()");
    const b = await spawnSyncHost({ SYNC_TEST_HOSTNAME: "sync-host-b" });
    await sleep(6_000);
    // The lock is free, but a lost session is no confirmation: B waits.
    expect(await owner(pageId)).toMatchObject({ generation: 1n, pid: a.pid });

    const confirmed = await confirmStoppedSyncOwners(db(), {
      runningHosts: ["sync-host-b"],
      ownHost: "test-runner",
      confirmedBy: "test",
      dryRun: false,
    });
    expect(confirmed.map((row) => row.pageId)).toEqual([pageId]);
    await waitFor(async () => ((await owner(pageId)).pid === b.pid ? true : null), 20_000, "process B takes the page over");
    const takenAt = (await owner(pageId)).acquiredAt!;

    a.process.kill("SIGCONT");
    await sleep(3_000);
    // The resumed owner's generation is gone: nothing of it after the takeover.
    expect(await countRows(testDb.pool,
      "select count(*)::int as n from sync_attempts where page_id = $1 and owner_generation = 1 and admitted_at >= $2",
      [pageId, takenAt])).toBe(0);
    expect(await owner(pageId)).toMatchObject({ generation: 2n, pid: b.pid });
    await firstSendOfGeneration(pageId, 2);

    b.process.kill("SIGTERM");
    a.process.kill("SIGTERM");
    await Promise.all([a.exited, b.exited]);
    await assertNoPaceViolation(pageId);
  }, 120_000);
});

describe("the previous owner's stop, confirmed in-process", () => {
  it("a graceful stop's safe release hands the page over, with the takeover floor", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedLivePage();
    const first = new SyncEngineHost(hostOptions(stubProbe()));
    await first.start();
    const second = new SyncEngineHost(hostOptions(stubProbe()));
    try {
      await waitFor(() => (first.state(pageId).kind === "running" ? true : null), 10_000, "the first host owns the page");
      await second.start();
      await second.tick();
      expect(second.state(pageId)).toMatchObject({ kind: "waiting", reason: "lock_held_elsewhere" });
      await firstSendOfGeneration(pageId, 1);
      await first.stop();
      expect(await owner(pageId)).toMatchObject({ generation: 1n, releaseGeneration: 1n });
      await waitFor(() => (second.state(pageId).kind === "running" ? true : null), 10_000, "the second host takes over");
      const taken = await owner(pageId);
      expect(taken.generation).toBe(2n);
      const firstSend = await firstSendOfGeneration(pageId, 2);
      expect(firstSend.getTime() - taken.acquiredAt!.getTime()).toBeGreaterThanOrEqual(TAKEOVER_FLOOR_MS - 50);
    } finally {
      await first.stop();
      await second.stop();
    }
    await assertNoPaceViolation(pageId);
  }, 60_000);

  it("D23: an owner recorded as this container under another pid namespace was ended with that namespace", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedLivePage();
    const containerHost = "0123456789ab";
    const previous = await acquireSyncPageOwnership(db(), {
      pageId,
      owner: testOwner({ host: containerHost, pid: 1, pidStart: "11", pidNs: "pid:[4026532001]" }),
    });
    expect(previous.kind).toBe("acquired");

    // The same hostname but not provably this container's id: no proof.
    const unproven = new SyncEngineHost(hostOptions(stubProbe({
      hostname: () => containerHost,
      pidNamespace: () => "pid:[4026532999]",
      containerId: () => null,
    })));
    await unproven.start();
    try {
      await unproven.tick();
      expect(unproven.state(pageId)).toMatchObject({ kind: "waiting", reason: "previous_owner_unconfirmed" });
      expect((await owner(pageId)).generation).toBe(1n);
    } finally {
      await unproven.stop();
    }

    const restarted = new SyncEngineHost(hostOptions(stubProbe({
      hostname: () => containerHost,
      pidNamespace: () => "pid:[4026532999]",
      containerId: () => `${containerHost}${"c".repeat(52)}`,
    })));
    await restarted.start();
    try {
      await waitFor(() => (restarted.state(pageId).kind === "running" ? true : null), 10_000, "the restarted container takes over");
      expect(await owner(pageId)).toMatchObject({ generation: 2n, host: containerHost, pidNs: "pid:[4026532999]" });
    } finally {
      await restarted.stop();
    }
  }, 60_000);

  it("an owner that is neither released nor provably gone keeps the page: the page waits", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedLivePage();
    await acquireSyncPageOwnership(db(), {
      pageId,
      owner: testOwner({ host: "in-process-host", pid: 99_999, pidStart: "alive" }),
    });
    // Same host and pid namespace, the pid alive with the same start token.
    const host = new SyncEngineHost(hostOptions(stubProbe({ processStartToken: () => "alive" })));
    await host.start();
    try {
      await host.tick();
      expect(host.state(pageId)).toMatchObject({ kind: "waiting", reason: "previous_owner_unconfirmed" });
    } finally {
      await host.stop();
    }
    expect((await owner(pageId)).generation).toBe(1n);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts")).toBe(0);
  }, 30_000);
});
