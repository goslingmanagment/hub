import { afterEach, describe, expect, it, vi } from "vitest";

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
  };
});

vi.mock("@agency_hub_core/db", () => ({
  upsertInstanceHeartbeat: h.upsertInstanceHeartbeat,
  removeInstance: h.removeInstance,
  reapStaleInstances: h.reapStaleInstances,
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
});
