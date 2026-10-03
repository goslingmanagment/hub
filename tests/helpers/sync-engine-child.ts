import { createDb, createPool, upsertDemand, type Database } from "@agency_hub_core/db";

import { createDefaultFanslySendOsProbe } from "../../apps/runtime/src/services/fansly-send-guard/os-probe.ts";
import { SyncEngineHost } from "../../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../../apps/runtime/src/sync/engine/pacer.ts";
import { fixedShadowLatency } from "../../apps/runtime/src/sync/engine/shadow.ts";
import { FANSLY_WS_SOURCE_TIMING } from "../../apps/runtime/src/sync/fansly/ws/source.ts";
import { harnessConfig, harnessHostOptions, harnessRng } from "./sync-engine.ts";
import { wsHostOptions } from "./sync-ws.ts";
import {
  childShadowRegistry,
  CRASH_READ_KEY,
  crashRegistry,
  makeTestActor,
  quietLogger,
  recordingTransport,
  testConfig,
} from "./sync-engine-host.ts";

// A real process for the Fansly Sync Engine tests that need one (design §10:
// kill -9, SIGSTOP/SIGCONT, two processes on one page). Run as
//   node --import tsx/esm tests/helpers/sync-engine-child.ts <mode>
// with DATABASE_URL set. Modes:
//   host        a SyncEngineHost over a test-only shadow registry; SIGTERM
//               stops it gracefully (exit 0). SYNC_TEST_HOSTNAME overrides the
//               OS probe's hostname (two "containers" on one machine).
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
    registry: childShadowRegistry(),
    probe,
    pause: { readSettingMs: async () => settingMs },
    pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
    routeTimeScale: 0,
    shadowLatency: () => fixedShadowLatency(50),
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
  await upsertDemand(db, { pageId, shadow: false, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });
  const { actor, stop, abort } = await makeTestActor({
    db,
    pageId,
    mode: "live",
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

const mode = process.argv[2];
if (mode === "host") {
  await runHost();
} else if (mode === "live-crash") {
  await runLiveCrash();
} else if (mode === "harness-live") {
  await runHarnessLive();
} else if (mode === "ws-live") {
  await runWsLive();
} else if (mode !== undefined) {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
