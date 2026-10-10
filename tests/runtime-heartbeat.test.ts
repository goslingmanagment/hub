import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getCaptureCasDualWritePages,
  getCaptureCasPointerOnlyPages,
  resetCaptureCasDualWriteForTests,
} from "../apps/runtime/src/services/capture-cas-dual-write.ts";
import {
  getCaptureCasReadMode,
  resetCaptureCasReadForTests,
} from "../apps/runtime/src/services/payload-reader.ts";

// Shared, hoisted mock state so the vi.mock factories (hoisted above imports) can reference it.
const h = vi.hoisted(() => {
  const calls: string[] = [];
  let releaseUpsert: (() => void) | null = null;
  return {
    calls,
    getReleaseUpsert: () => releaseUpsert,
    setReleaseUpsert: (fn: (() => void) | null) => {
      releaseUpsert = fn;
    },
    // upsert records start/end and blocks until released, so a test can hold a beat in flight.
    upsertInstanceHeartbeat: vi.fn(async () => {
      calls.push("upsert:start");
      await new Promise<void>((resolve) => {
        releaseUpsert = resolve;
      });
      calls.push("upsert:end");
    }),
    removeInstance: vi.fn(async () => {
      calls.push("remove");
    }),
    reapStaleInstances: vi.fn(async () => {
      calls.push("reap");
      return 0;
    }),
    loadEffectiveConfig: vi.fn(async (_db: unknown, config: unknown) => config),
    insertOpsMetricSamples: vi.fn(async () => undefined),
  };
});

vi.mock("@agency_hub_core/db", () => ({
  upsertInstanceHeartbeat: h.upsertInstanceHeartbeat,
  removeInstance: h.removeInstance,
  reapStaleInstances: h.reapStaleInstances,
  insertOpsMetricSamples: h.insertOpsMetricSamples,
}));

vi.mock("../apps/runtime/src/services/effective-config.ts", () => ({
  loadEffectiveConfig: h.loadEffectiveConfig,
  LIVE_CONFIG_KEYS: new Set<string>(),
}));

const makeApp = () =>
  ({ db: {}, config: {}, bootSkipped: [], logger: { warn: vi.fn() } }) as never;

describe("startRuntimeHeartbeat", () => {
  afterEach(() => {
    h.calls.length = 0;
    h.setReleaseUpsert(null);
    vi.clearAllMocks();
    resetCaptureCasDualWriteForTests();
    resetCaptureCasReadForTests();
  });

  // Review finding (PR #325): every role now publishes the capture CAS
  // settings once at startup, so a beat that stopped republishing them would
  // go unnoticed — each process would still boot with the right values. A live
  // flip must still reach a running process within one beat, above all the
  // owner's rollback of the pointer-only flag or the read mode.
  it.each([
    {
      flip: "a rollback",
      running: { dualWrite: "*", pointerOnly: "*", readMode: "serve" },
      effective: { dualWrite: "", pointerOnly: "", readMode: "inline" },
    },
    {
      flip: "a ramp",
      running: { dualWrite: "", pointerOnly: "", readMode: "inline" },
      effective: { dualWrite: "*", pointerOnly: "*", readMode: "serve" },
    },
  ] as const)("republishes the capture CAS settings every beat, so $flip reaches a running process", async ({ running, effective }) => {
    // What the process is acting on (its startup publish or an earlier beat).
    resetCaptureCasDualWriteForTests(running.dualWrite, running.pointerOnly);
    resetCaptureCasReadForTests(running.readMode);
    // The owner has since flipped the live overrides.
    h.loadEffectiveConfig.mockImplementationOnce(async (_db: unknown, config: unknown) => ({
      ...(config as object),
      captureCasDualWritePages: effective.dualWrite,
      captureCasPointerOnlyPages: effective.pointerOnly,
      captureCasReadMode: effective.readMode,
    }));

    const { startRuntimeHeartbeat } = await import("../apps/runtime/src/services/runtime-heartbeat.ts");
    const hb = startRuntimeHeartbeat(makeApp(), "worker");

    // The immediate beat is parked inside the upsert, after its publish.
    await vi.waitFor(() => expect(h.calls).toContain("upsert:start"));
    expect({
      dualWrite: getCaptureCasDualWritePages(),
      pointerOnly: getCaptureCasPointerOnlyPages(),
      readMode: getCaptureCasReadMode(),
    }).toEqual(effective);

    h.getReleaseUpsert()!();
    await hb.stop();
  });

  // Design §9.1: the `sync` role beats every 30 s, so a 2-minute liveness
  // alert and a 90 s health-file check both survive one slow or failed beat.
  // Every other role keeps the 60 s default.
  it("beats on the interval it is given (the sync role's 30 s) and every 60 s by default", async () => {
    h.upsertInstanceHeartbeat.mockImplementation(async () => {
      h.calls.push("upsert");
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { HEARTBEAT_INTERVAL_MS, startRuntimeHeartbeat } = await import("../apps/runtime/src/services/runtime-heartbeat.ts");
      const roles = () => h.upsertInstanceHeartbeat.mock.calls
        .map((call) => (call as unknown[])[1] as { role: string })
        .map((input) => input.role)
        .sort();
      const sync = startRuntimeHeartbeat(makeApp(), "sync", { intervalMs: 30_000 });
      const worker = startRuntimeHeartbeat(makeApp(), "worker");

      // Both publish immediately at start.
      await vi.waitFor(() => expect(roles()).toEqual(["sync", "worker"]));
      vi.advanceTimersByTime(30_000);
      await vi.waitFor(() => expect(roles()).toEqual(["sync", "sync", "worker"]));
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 30_000);
      await vi.waitFor(() => expect(roles()).toEqual(["sync", "sync", "sync", "worker", "worker"]));

      await Promise.all([sync.stop(), worker.stop()]);
    } finally {
      vi.useRealTimers();
      // Back to the parking implementation the other cases rely on.
      h.upsertInstanceHeartbeat.mockReset();
    }
  });

  it("records the process's memory as gauges after a beat, at most every 5 minutes", async () => {
    h.upsertInstanceHeartbeat.mockImplementation(async () => {
      h.calls.push("upsert");
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { HEARTBEAT_INTERVAL_MS, RUNTIME_MEMORY_SAMPLE_INTERVAL_MS, startRuntimeHeartbeat } =
        await import("../apps/runtime/src/services/runtime-heartbeat.ts");
      const hb = startRuntimeHeartbeat(makeApp(), "worker");

      await vi.waitFor(() => expect(h.insertOpsMetricSamples).toHaveBeenCalledTimes(1));
      const [, samples] = h.insertOpsMetricSamples.mock.calls[0] as unknown as [unknown, Array<{ metric: string; quantile: string; valueMs: number }>];
      expect(samples.map((sample) => sample.metric)).toEqual([
        "process_rss_bytes_worker",
        "process_heap_used_bytes_worker",
        "process_external_bytes_worker",
      ]);
      for (const sample of samples) {
        expect(sample.quantile).toBe("p50");
        expect(sample.valueMs).toBeGreaterThan(0);
      }
      // The gauge follows the beat's own liveness writes.
      expect(h.calls).toEqual(["upsert", "reap"]);

      // Beats inside the 5 minutes write no gauge; the first one past them does.
      for (let beat = 1; beat * HEARTBEAT_INTERVAL_MS < RUNTIME_MEMORY_SAMPLE_INTERVAL_MS; beat += 1) {
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        await vi.waitFor(() => expect(h.upsertInstanceHeartbeat).toHaveBeenCalledTimes(beat + 1));
      }
      expect(h.insertOpsMetricSamples).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.insertOpsMetricSamples).toHaveBeenCalledTimes(2));

      await hb.stop();
    } finally {
      vi.useRealTimers();
      h.upsertInstanceHeartbeat.mockReset();
    }
  });

  it("keeps beating while a gauge write hangs, and starts no second write beside it", async () => {
    h.upsertInstanceHeartbeat.mockImplementation(async () => {
      h.calls.push("upsert");
    });
    let releaseGauge!: () => void;
    h.insertOpsMetricSamples.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      releaseGauge = () => resolve(undefined);
    }));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { HEARTBEAT_INTERVAL_MS, RUNTIME_MEMORY_SAMPLE_INTERVAL_MS, startRuntimeHeartbeat } =
        await import("../apps/runtime/src/services/runtime-heartbeat.ts");
      const hb = startRuntimeHeartbeat(makeApp(), "worker");
      await vi.waitFor(() => expect(h.insertOpsMetricSamples).toHaveBeenCalledTimes(1));

      // Past the sampling interval with the first write still pending: every
      // beat lands, and none starts a second write.
      const beats = RUNTIME_MEMORY_SAMPLE_INTERVAL_MS / HEARTBEAT_INTERVAL_MS + 1;
      for (let beat = 1; beat <= beats; beat += 1) {
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        await vi.waitFor(() => expect(h.upsertInstanceHeartbeat).toHaveBeenCalledTimes(beat + 1));
      }
      expect(h.insertOpsMetricSamples).toHaveBeenCalledTimes(1);

      // Once it settles, the next beat samples again.
      releaseGauge();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.insertOpsMetricSamples).toHaveBeenCalledTimes(2));

      await hb.stop();
    } finally {
      vi.useRealTimers();
      h.upsertInstanceHeartbeat.mockReset();
    }
  });

  it("never lets a failed gauge write cost the beat its liveness", async () => {
    h.upsertInstanceHeartbeat.mockImplementation(async () => {
      h.calls.push("upsert");
    });
    h.insertOpsMetricSamples.mockRejectedValueOnce(new Error("ops_metric_samples unavailable"));
    const dir = mkdtempSync(join(tmpdir(), "hb-memory-"));
    const healthFilePath = join(dir, "health.json");
    const logger = { warn: vi.fn() };
    try {
      const { startRuntimeHeartbeat } = await import("../apps/runtime/src/services/runtime-heartbeat.ts");
      const hb = startRuntimeHeartbeat(({ db: {}, config: {}, bootSkipped: [], logger }) as never, "api", { healthFilePath });
      await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "api" }),
        "runtime memory gauge write failed",
      ));
      expect(h.calls).toEqual(["upsert", "reap"]);
      expect(existsSync(healthFilePath)).toBe(true);
      await hb.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      h.upsertInstanceHeartbeat.mockReset();
    }
  });

  it("awaits an in-flight beat before removing the instance, so a late upsert can't resurrect the row", async () => {
    const { startRuntimeHeartbeat } = await import("../apps/runtime/src/services/runtime-heartbeat.ts");
    const hb = startRuntimeHeartbeat(makeApp(), "api");

    // The immediate beat is in flight, parked inside upsert (start recorded, not end).
    await vi.waitFor(() => expect(h.calls).toContain("upsert:start"));
    expect(h.removeInstance).not.toHaveBeenCalled();

    // stop() must await the in-flight beat (parked at `await inFlight`) before removing.
    const stopP = hb.stop();
    h.getReleaseUpsert()!();
    await stopP;

    // removeInstance runs strictly AFTER the in-flight beat's upsert completed — no zombie row.
    expect(h.calls.indexOf("remove")).toBeGreaterThan(h.calls.indexOf("upsert:end"));
    expect(h.removeInstance).toHaveBeenCalledTimes(1);
  });

  it("skips the upsert when stop() ran during the config read (no resurrection)", async () => {
    let releaseRead: (() => void) | null = null;
    h.loadEffectiveConfig.mockImplementationOnce(async (_db: unknown, config: unknown) => {
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      return config;
    });

    const { startRuntimeHeartbeat } = await import("../apps/runtime/src/services/runtime-heartbeat.ts");
    const hb = startRuntimeHeartbeat(makeApp(), "api");

    // Beat is parked in loadEffectiveConfig; stop() flips `stopped` while it reads.
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf("function"));
    const stopP = hb.stop();
    releaseRead!();
    await stopP;

    // The beat saw `stopped` after the read and bailed before upserting; only removeInstance ran.
    expect(h.upsertInstanceHeartbeat).not.toHaveBeenCalled();
    expect(h.removeInstance).toHaveBeenCalledTimes(1);
  });

  it("does not hang shutdown forever when an in-flight beat never settles", async () => {
    h.loadEffectiveConfig.mockImplementationOnce(
      () => new Promise<never>(() => undefined),
    );
    const logger = { warn: vi.fn() };
    const app = ({ db: {}, config: {}, bootSkipped: [], logger }) as never;

    const { startRuntimeHeartbeat } = await import("../apps/runtime/src/services/runtime-heartbeat.ts");
    const hb = startRuntimeHeartbeat(app, "api", { stopTimeoutMs: 1 });

    await vi.waitFor(() => expect(h.loadEffectiveConfig).toHaveBeenCalledTimes(1));
    await hb.stop();

    expect(h.upsertInstanceHeartbeat).not.toHaveBeenCalled();
    expect(h.removeInstance).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "api", timeoutMs: 1 }),
      "runtime heartbeat stop timed out waiting for in-flight beat; leaving instance row for TTL cleanup",
    );
  });

  it("does not hang shutdown forever when removing the instance row never settles", async () => {
    const logger = { warn: vi.fn() };
    const app = ({ db: {}, config: {}, bootSkipped: [], logger }) as never;

    const { startRuntimeHeartbeat } = await import("../apps/runtime/src/services/runtime-heartbeat.ts");
    const hb = startRuntimeHeartbeat(app, "api", { stopTimeoutMs: 1 });

    await vi.waitFor(() => expect(h.calls).toContain("upsert:start"));
    h.getReleaseUpsert()!();
    await vi.waitFor(() => expect(h.calls).toContain("reap"));
    await Promise.resolve();

    h.removeInstance.mockImplementationOnce(
      () => new Promise<never>(() => undefined),
    );
    await hb.stop();

    expect(h.removeInstance).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "api", timeoutMs: 1 }),
      "runtime heartbeat stop timed out removing instance row; leaving instance row for TTL cleanup",
    );
  });

  // Review finding: the scheduler container healthcheck watches this file's
  // mtime. It must refresh ONLY after a successful upsert — a wedged event
  // loop or a lost DB both stop the clock.
  it("writes the health file only after a successful heartbeat upsert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-heartbeat-"));
    const healthFilePath = join(dir, "scheduler-health.json");
    try {
      const { startRuntimeHeartbeat } = await import("../apps/runtime/src/services/runtime-heartbeat.ts");
      const hb = startRuntimeHeartbeat(makeApp(), "scheduler", { healthFilePath });

      // The immediate beat is parked inside the upsert — no file yet.
      await vi.waitFor(() => expect(h.calls).toContain("upsert:start"));
      expect(existsSync(healthFilePath)).toBe(false);

      h.getReleaseUpsert()!();
      await vi.waitFor(() => expect(existsSync(healthFilePath)).toBe(true));
      expect(JSON.parse(readFileSync(healthFilePath, "utf8"))).toMatchObject({ status: "ready" });

      await hb.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not write the health file when the upsert fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-heartbeat-"));
    const healthFilePath = join(dir, "scheduler-health.json");
    try {
      h.upsertInstanceHeartbeat.mockImplementationOnce(async () => {
        h.calls.push("upsert:failed");
        throw new Error("db unreachable");
      });
      const logger = { warn: vi.fn() };
      const app = ({ db: {}, config: {}, bootSkipped: [], logger }) as never;

      const { startRuntimeHeartbeat } = await import("../apps/runtime/src/services/runtime-heartbeat.ts");
      const hb = startRuntimeHeartbeat(app, "scheduler", { healthFilePath });

      await vi.waitFor(() => expect(h.calls).toContain("upsert:failed"));
      await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "scheduler" }),
        "runtime heartbeat upsert failed",
      ));
      expect(existsSync(healthFilePath)).toBe(false);

      await hb.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Step 4, 4-3: the `sync` role's stall watchdog watches each beat from its
  // start until it settles. A beat that never settles is a stall (the process
  // exits 70 for a restart); one that fails — the database down — is not.
  describe("watched by the sync role's stall watchdog", () => {
    async function watchedHeartbeat() {
      const { SyncStallWatchdog } = await import("../apps/runtime/src/sync/engine/watchdog.ts");
      const clock = { now: 0, monoNow() { return this.now; } };
      const exits: number[] = [];
      const watchdog = new SyncStallWatchdog({ clock, exit: (code) => exits.push(code), writeStderr: () => undefined });
      const { startRuntimeHeartbeat } = await import("../apps/runtime/src/services/runtime-heartbeat.ts");
      const app = ({ db: {}, config: {}, bootSkipped: [], logger: { warn: vi.fn() } }) as never;
      const hb = startRuntimeHeartbeat(app, "sync", {
        intervalMs: 30_000,
        stopTimeoutMs: 1,
        watchBeat: () => watchdog.track({ component: "heartbeat" }, "beat"),
      });
      return { clock, exits, watchdog, hb };
    }

    it("a beat that never settles is a stall", async () => {
      h.loadEffectiveConfig.mockImplementationOnce(() => new Promise<never>(() => undefined));
      const { clock, exits, watchdog, hb } = await watchedHeartbeat();
      await vi.waitFor(() => expect(h.loadEffectiveConfig).toHaveBeenCalledTimes(1));
      expect(watchdog.tracked).toBe(1);
      clock.now = 120_000;
      expect(watchdog.check()).toMatchObject({ component: "heartbeat", phase: "beat", ageMs: 120_000 });
      await watchdog.exiting;
      expect(exits).toEqual([70]);
      await hb.stop();
    });

    it("a beat that fails is no stall: it settled", async () => {
      h.upsertInstanceHeartbeat.mockImplementationOnce(async () => {
        throw new Error("db unreachable");
      });
      const { clock, exits, watchdog, hb } = await watchedHeartbeat();
      await vi.waitFor(() => expect(h.upsertInstanceHeartbeat).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(watchdog.tracked).toBe(0));
      clock.now = 10 * 120_000;
      expect(watchdog.check()).toBeNull();
      expect(exits).toEqual([]);
      await hb.stop();
    });
  });
});
