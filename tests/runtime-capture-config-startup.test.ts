import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as HeartbeatModule from "../apps/runtime/src/services/runtime-heartbeat.ts";

import {
  getCaptureCasDualWritePages,
  getCaptureCasPointerOnlyPages,
  resetCaptureCasDualWriteForTests,
} from "../apps/runtime/src/services/capture-cas-dual-write.ts";
import {
  getCaptureCasReadMode,
  resetCaptureCasReadForTests,
} from "../apps/runtime/src/services/payload-reader.ts";

// Post-deploy finding 2026-09-30: the capture seam's CAS settings were
// published only by the runtime heartbeat, which the worker starts AFTER its
// job handlers. A targeted backfill picked up in that window (raw row 3238568,
// ~2.2 s after process start, just before "Worker started") was journaled
// inline with no catalog reference.
// These cases pin that every role that captures publishes the settings before
// it can consume work: the worker before startWorkerServices registers a
// handler, the api before it accepts a request, the sync process before its
// first beat (its page actors, which journal every response, start after it).

const h = vi.hoisted(() => {
  const order: string[] = [];
  const snapshots: Array<{ at: string; dualWrite: string; pointerOnly: string; readMode: string }> = [];
  return {
    order,
    snapshots,
    getConfigOverrides: vi.fn(),
    startWorkerServices: vi.fn(),
    startRuntimeHeartbeat: vi.fn(),
    buildApiServer: vi.fn(),
    startOpsWatchdog: vi.fn(() => ({ stop: vi.fn(async () => undefined) })),
    createAppContext: vi.fn(),
    createSyncContext: vi.fn(),
    PgBoss: vi.fn(function PgBoss(this: { on: () => void }) {
      this.on = vi.fn();
    }),
  };
});

vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  getConfigOverrides: h.getConfigOverrides,
}));
vi.mock("pg-boss", () => ({ PgBoss: h.PgBoss }));
vi.mock("../apps/runtime/src/bootstrap.ts", () => ({ createAppContext: h.createAppContext }));
vi.mock("../apps/runtime/src/sync/context.ts", () => ({ createSyncContext: h.createSyncContext }));
// The engine host needs a database; these cases are about what the process
// published before its first beat, which the host starts after.
vi.mock("../apps/runtime/src/sync/engine/host.ts", () => ({
  SyncEngineHost: vi.fn(function SyncEngineHost(this: { start: () => Promise<void>; stop: () => Promise<void> }) {
    this.start = vi.fn(async () => {
      h.order.push("sync:host");
    });
    this.stop = vi.fn(async () => undefined);
  }),
}));
// So does the alert evaluator, which starts with it.
vi.mock("../apps/runtime/src/sync/engine/alerts.ts", () => ({
  createIncidentAlertSink: vi.fn(() => ({ open: vi.fn(async () => undefined), resolve: vi.fn(async () => undefined) })),
  SyncAlertEvaluator: vi.fn(function SyncAlertEvaluator(this: { start: () => void; runOnce: () => Promise<null>; stop: () => Promise<void> }) {
    this.start = vi.fn();
    this.runOnce = vi.fn(async () => null);
    this.stop = vi.fn(async () => undefined);
  }),
}));
vi.mock("../apps/runtime/src/worker-services.ts", () => ({ startWorkerServices: h.startWorkerServices }));
vi.mock("../apps/runtime/src/api/server.ts", () => ({ buildApiServer: h.buildApiServer }));
vi.mock("../apps/runtime/src/services/ops-watchdog.ts", () => ({ startOpsWatchdog: h.startOpsWatchdog }));
// The real module (the startup publish lives there), with only the periodic
// heartbeat stubbed: these cases are about what a role has published BEFORE
// its first beat, so the beat itself must not run and mask the answer.
vi.mock("../apps/runtime/src/services/runtime-heartbeat.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof HeartbeatModule>()),
  startRuntimeHeartbeat: h.startRuntimeHeartbeat,
}));

/** What the capture seam and the payload readers would act on right now. */
function snapshot(at: string) {
  h.order.push(at);
  h.snapshots.push({
    at,
    dualWrite: getCaptureCasDualWritePages(),
    pointerOnly: getCaptureCasPointerOnlyPages(),
    readMode: getCaptureCasReadMode(),
  });
}

/** Production's settings: every page dual-writes and goes pointer-only, and
 *  reads are served from the catalog — all three as live DB overrides, with the
 *  boot env leaving them at their defaults. */
function productionOverrides() {
  return new Map([
    ["captureCasDualWritePages", { value: "*", version: 1 }],
    ["captureCasPointerOnlyPages", { value: "*", version: 1 }],
    ["captureCasReadMode", { value: "serve", version: 1 }],
  ]);
}

function makeApp() {
  return {
    db: {},
    config: {
      databaseUrl: "postgres://unused/unused",
      apiHost: "127.0.0.1",
      apiPort: 0,
      captureCasDualWritePages: "",
      captureCasPointerOnlyPages: "",
      captureCasReadMode: "inline",
    },
    bootSkipped: [],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    close: vi.fn(async () => undefined),
  };
}

let signalListenersBefore: Set<(...args: unknown[]) => unknown>;

beforeEach(() => {
  h.order.length = 0;
  h.snapshots.length = 0;
  resetCaptureCasDualWriteForTests();
  resetCaptureCasReadForTests();
  h.getConfigOverrides.mockImplementation(async () => productionOverrides());
  h.startWorkerServices.mockImplementation(async () => {
    // The first act of startWorkerServices that matters here is registering
    // job handlers (boss.work); from then on pg-boss may run one at any time.
    snapshot("worker:startWorkerServices");
    return { shutdown: vi.fn(async () => undefined) };
  });
  h.startRuntimeHeartbeat.mockImplementation((_app: unknown, role: string) => {
    // The sync process consumes no work before its heartbeat starts: what it
    // has published by then is what its first capture would act on.
    if (role === "sync") snapshot("sync:heartbeat");
    h.order.push(`${role}:heartbeat`);
    return { instanceId: "test", stop: vi.fn(async () => undefined) };
  });
  h.buildApiServer.mockImplementation(async () => ({
    listen: vi.fn(async () => {
      snapshot("api:listen");
    }),
    close: vi.fn(async () => undefined),
  }));
  signalListenersBefore = new Set(process.listeners("SIGTERM") as Array<(...args: unknown[]) => unknown>);
});

afterEach(async () => {
  // Run the shutdown each runtime registered (it clears the api's keep-alive
  // timer) with process.exit stubbed, then drop the signal listeners.
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  try {
    const added = (process.listeners("SIGTERM") as Array<(...args: unknown[]) => unknown>)
      .filter((listener) => !signalListenersBefore.has(listener));
    for (const listener of added) {
      process.removeListener("SIGTERM", listener);
      process.removeListener("SIGINT", listener);
      await listener();
    }
  } finally {
    exit.mockRestore();
    resetCaptureCasDualWriteForTests();
    resetCaptureCasReadForTests();
    vi.clearAllMocks();
  }
});

describe("capture CAS settings at role startup", () => {
  it("worker: publishes the dual-write, pointer-only and read-mode settings before any job handler can run", async () => {
    const app = makeApp();
    h.createAppContext.mockResolvedValue(app);
    const { runWorkerRuntime } = await import("../apps/runtime/src/worker-runtime.ts");

    await runWorkerRuntime();

    expect(h.snapshots).toEqual([
      { at: "worker:startWorkerServices", dualWrite: "*", pointerOnly: "*", readMode: "serve" },
    ]);
    // The heartbeat still starts only after the queue services (it advertises
    // the worker as live) and keeps republishing from there.
    expect(h.order).toEqual(["worker:startWorkerServices", "worker:heartbeat"]);
    expect(app.logger.warn).not.toHaveBeenCalled();
  });

  it("worker: a failed startup config read fails closed (inline) and is logged, and the worker still starts", async () => {
    const app = makeApp();
    h.createAppContext.mockResolvedValue(app);
    const failure = new Error("config_settings unreachable");
    h.getConfigOverrides.mockRejectedValueOnce(failure);
    const { runWorkerRuntime } = await import("../apps/runtime/src/worker-runtime.ts");

    await runWorkerRuntime();

    expect(h.snapshots).toEqual([
      { at: "worker:startWorkerServices", dualWrite: "", pointerOnly: "", readMode: "inline" },
    ]);
    expect(h.order).toEqual(["worker:startWorkerServices", "worker:heartbeat"]);
    expect(app.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure, role: "worker" }),
      expect.stringContaining("capture CAS settings not loaded at startup"),
    );
  });

  it("sync: publishes the settings at startup, before its first beat", async () => {
    const app = makeApp();
    h.createSyncContext.mockResolvedValue(app);
    const { runSyncRuntime } = await import("../apps/runtime/src/sync/main.ts");

    await runSyncRuntime();

    expect(h.snapshots).toEqual([
      { at: "sync:heartbeat", dualWrite: "*", pointerOnly: "*", readMode: "serve" },
    ]);
    expect(h.startRuntimeHeartbeat).toHaveBeenCalledWith(app, "sync", expect.objectContaining({ intervalMs: 30_000 }));
    // The page actors (which journal every response) start only after it.
    expect(h.order.at(-1)).toBe("sync:host");
    expect(app.logger.warn).not.toHaveBeenCalled();
  });

  it("api: publishes the settings before the server accepts a request", async () => {
    const app = makeApp();
    h.createAppContext.mockResolvedValue(app);
    const { runApiRuntime } = await import("../apps/runtime/src/api-runtime.ts");

    await runApiRuntime();

    expect(h.snapshots).toEqual([
      { at: "api:listen", dualWrite: "*", pointerOnly: "*", readMode: "serve" },
    ]);
    expect(h.order).toEqual(["api:listen", "api:heartbeat"]);
    expect(app.logger.warn).not.toHaveBeenCalled();
  });
});
