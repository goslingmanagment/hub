import { createDb, createPool, upsertDemand, type Database } from "@agency_hub_core/db";

import { createDefaultFanslySendOsProbe } from "../../apps/runtime/src/services/fansly-send-guard/os-probe.ts";
import { createSyncContext } from "../../apps/runtime/src/sync/context.ts";
import { SyncEngineHost } from "../../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../../apps/runtime/src/sync/engine/pacer.ts";
import { SyncStallWatchdog } from "../../apps/runtime/src/sync/engine/watchdog.ts";
import { FANSLY_WS_SOURCE_TIMING } from "../../apps/runtime/src/sync/fansly/ws/source.ts";
import {
  createStallIncidentReport,
  handleSyncShutdownSignals,
  startSyncRuntime,
} from "../../apps/runtime/src/sync/main.ts";
import { harnessConfig, harnessHostOptions, harnessRng } from "./sync-engine.ts";
import { wsHostOptions } from "./sync-ws.ts";
import {
  childPollRegistry,
  containerRunProbe,
  CRASH_READ_KEY,
  crashRegistry,
  makeTestActor,
  quietLogger,
  recordingTransport,
  ScriptedLiveTransport,
  testConfig,
} from "./sync-engine-host.ts";

// A real process for the Fansly Sync Engine tests that need one (design §10:
// kill -9, SIGSTOP/SIGCONT, two processes on one page). Run as
//   node --import tsx/esm tests/helpers/sync-engine-child.ts <mode>
// with DATABASE_URL set. Modes:
//   host        a SyncEngineHost over a test-only registry (one poll) and a
//               scripted transport that opens no socket (50 ms an answer);
//               SIGTERM stops it gracefully (exit 0). SYNC_TEST_HOSTNAME
//               overrides the OS probe's hostname (two "containers" on one
//               machine).
//   live-crash  one live actor on PAGE_ID that SIGKILLs itself at FAULT_POINT.
//   harness-live a live SyncEngineHost over the physical-request harness
//               (tests/helpers/sync-engine.ts): the harness registry and
//               transport against FANSLY_BASE_URL through the page proxy,
//               S from sync_test_setting, jitter seeded by RNG_SEED. The
//               test kills it.
//   ws-live     the same live host with the page's socket (PAGE_ID) on the
//               fake origin WS_ORIGIN, on the production socket timing (its
//               drains included; only the guard runs every 200 ms); SIGTERM
//               stops it as the `sync` runtime does (host, pool, exit 0).
//   stall-live  a live SyncEngineHost on PAGE_ID (the crash registry, the
//               recording transport, S = SETTING_MS) running as one run of
//               the test container (pid namespace SYNC_TEST_PID_NS), whose
//               step never settles at FAULT_POINT; its stall watchdog
//               (STALL_AFTER_MS) writes the production incident and exits 70.
//   shutdown-cap the `sync` runtime (heartbeat only) over a host whose stop
//               never ends, with the production signal handling at
//               SHUTDOWN_CAP_MS: SIGTERM ends it at the cap.
// Prints "ready <pid>" once running.

async function runHost(): Promise<void> {
  const connectionString = process.env.DATABASE_URL!;
  const pool = createPool(connectionString);
  const db = createDb(pool) as unknown as Database;
  const settingMs = Number(process.env.SETTING_MS ?? "300");
  const base = createDefaultFanslySendOsProbe();
  const hostName = process.env.SYNC_TEST_HOSTNAME;
  const probe = hostName === undefined ? base : { ...base, hostname: () => hostName };
  const host = new SyncEngineHost({
    db,
    connectionString,
    config: testConfig(connectionString),
    rawConfig: testConfig(connectionString),
    logger: quietLogger,
    registry: childPollRegistry(),
    probe,
    pause: { readSettingMs: async () => settingMs },
    pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
    routeTimeScale: 0,
    liveTransportFactory: async () => {
      const transport = new ScriptedLiveTransport();
      transport.latencyMs = 50;
      return transport;
    },
    liveSocket: () => null,
    modeLoopIntervalMs: 250,
  });
  await host.start();
  const stop = async () => {
    await host.stop();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  console.log(`ready ${process.pid}`);
}

async function runLiveCrash(): Promise<void> {
  const pool = createPool(process.env.DATABASE_URL!);
  const db = createDb(pool) as unknown as Database;
  const pageId = Number(process.env.PAGE_ID);
  const faultPoint = process.env.FAULT_POINT;
  await upsertDemand(db, { pageId, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });
  const { actor, stop, abort } = await makeTestActor({
    db,
    pageId,
    registry: crashRegistry(),
    transport: recordingTransport(db),
    faults: (point) => {
      if (point === faultPoint) process.kill(process.pid, "SIGKILL");
    },
  });
  console.log(`ready ${process.pid}`);
  await actor.run({ stop: stop.signal, abort: abort.signal });
  await pool.end();
}

async function runHarnessLive(): Promise<void> {
  const connectionString = process.env.DATABASE_URL!;
  const pool = createPool(connectionString);
  const db = createDb(pool) as unknown as Database;
  const base = createDefaultFanslySendOsProbe();
  const hostName = process.env.SYNC_TEST_HOSTNAME;
  const host = new SyncEngineHost(harnessHostOptions({
    db,
    pool,
    connectionString,
    config: harnessConfig(connectionString, process.env.FANSLY_BASE_URL!),
    rng: harnessRng(Number(process.env.RNG_SEED ?? "1")),
    ...(hostName === undefined ? {} : { probe: { ...base, hostname: () => hostName } }),
  }));
  await host.start();
  console.log(`ready ${process.pid}`);
}

async function runWsLive(): Promise<void> {
  const connectionString = process.env.DATABASE_URL!;
  const pool = createPool(connectionString);
  const db = createDb(pool) as unknown as Database;
  const pageId = Number(process.env.PAGE_ID);
  let host: SyncEngineHost | null = null;
  host = new SyncEngineHost(wsHostOptions({
    db,
    pool,
    connectionString,
    config: harnessConfig(connectionString, process.env.FANSLY_BASE_URL!),
    rng: harnessRng(Number(process.env.RNG_SEED ?? "1")),
    wsOrigin: process.env.WS_ORIGIN!,
    sourceOf: () => host?.wsSource(pageId) ?? null,
    timing: { ...FANSLY_WS_SOURCE_TIMING, checkMs: 200 },
  }));
  await host.start();
  const stop = async () => {
    await host?.stop();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  console.log(`ready ${process.pid}`);
}

async function runStallLive(): Promise<void> {
  const connectionString = process.env.DATABASE_URL!;
  const pool = createPool(connectionString);
  const db = createDb(pool) as unknown as Database;
  const pageId = Number(process.env.PAGE_ID);
  const settingMs = Number(process.env.SETTING_MS ?? "300");
  const faultPoint = process.env.FAULT_POINT;
  const watchdog = new SyncStallWatchdog({
    staleAfterMs: Number(process.env.STALL_AFTER_MS),
    checkEveryMs: 100,
    report: createStallIncidentReport({ connectionString, logger: quietLogger }),
  });
  watchdog.start();
  await upsertDemand(db, { pageId, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });
  const host = new SyncEngineHost({
    db,
    connectionString,
    config: testConfig(connectionString),
    rawConfig: testConfig(connectionString),
    logger: quietLogger,
    registry: crashRegistry(),
    probe: containerRunProbe(process.env.SYNC_TEST_PID_NS!),
    pause: { readSettingMs: async () => settingMs },
    pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
    routeTimeScale: 0,
    modeLoopIntervalMs: 250,
    liveTransportFactory: async () => recordingTransport(db),
    liveSocket: () => null,
    faults: (point) => (point === faultPoint ? new Promise<never>(() => undefined) : undefined),
    watchdog,
  });
  await host.start();
  console.log(`ready ${process.pid}`);
}

async function runShutdownCap(): Promise<void> {
  const context = await createSyncContext({ env: process.env });
  const host = { start: async () => undefined, stop: () => new Promise<void>(() => undefined) };
  const runtime = await startSyncRuntime(context, { host, alerts: null, watchdog: null, heartbeatIntervalMs: 200 });
  handleSyncShutdownSignals(context, runtime, { capMs: Number(process.env.SHUTDOWN_CAP_MS) });
  console.log(`ready ${process.pid}`);
}

const mode = process.argv[2];
if (mode === "host") {
  await runHost();
} else if (mode === "live-crash") {
  await runLiveCrash();
} else if (mode === "harness-live") {
  await runHarnessLive();
} else if (mode === "ws-live") {
  await runWsLive();
} else if (mode === "stall-live") {
  await runStallLive();
} else if (mode === "shutdown-cap") {
  await runShutdownCap();
} else if (mode !== undefined) {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
