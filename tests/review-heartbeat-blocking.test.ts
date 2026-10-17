import { afterEach, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";

const state = vi.hoisted(() => ({
  upsert: vi.fn(async () => undefined),
  memory: vi.fn(async () => undefined),
}));
vi.mock("@agency_hub_core/db", () => ({
  upsertInstanceHeartbeat: state.upsert,
  insertOpsMetricSamples: state.memory,
  reapStaleInstances: async () => 0,
  removeInstance: async () => undefined,
}));
vi.mock("../apps/runtime/src/services/effective-config.ts", () => ({
  loadEffectiveConfig: async (_db: unknown, config: unknown) => config,
  LIVE_CONFIG_KEYS: new Set(),
}));
import { startRuntimeHeartbeat as candidate } from "../apps/runtime/src/services/runtime-heartbeat.ts";
import { startRuntimeHeartbeat as baseline } from "../apps/runtime/src/services/review-baseline-runtime-heartbeat.ts";

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it.each([
  { label: "main", start: baseline, expectedBeats: 6 },
  { label: "PR553", start: candidate, expectedBeats: 1 },
])("$label: beats while only the metrics write stays pending", async ({ label, start, expectedBeats }) => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  let release!: () => void;
  state.memory.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const heartbeat = start({ db: {}, config: {}, bootSkipped: [], logger: { warn: vi.fn() } } as never, "worker");
  const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
  try {
    await flush();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
    }
    console.log(JSON.stringify({ label, elapsedMs: 300000, beats: state.upsert.mock.calls.length, memoryWrites: state.memory.mock.calls.length }));
    writeFileSync(`/tmp/hub-pr-verification-20261010/heartbeat-${label}.json`, JSON.stringify({ label, elapsedMs: 300000, beats: state.upsert.mock.calls.length, memoryWrites: state.memory.mock.calls.length }));
    expect(state.upsert).toHaveBeenCalledTimes(expectedBeats);
  } finally {
    release?.();
    await flush();
    await heartbeat.stop();
  }
});
