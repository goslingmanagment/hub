import { beforeEach, describe, expect, it, vi } from "vitest";

const syncMocks = vi.hoisted(() => ({
  runLightSync: vi.fn(),
  runFollowerSync: vi.fn(),
  runAllSync: vi.fn(),
}));

vi.mock("../apps/runtime/src/services/sync.ts", () => ({
  runLightSync: syncMocks.runLightSync,
  runFollowerSync: syncMocks.runFollowerSync,
  runAllSync: syncMocks.runAllSync,
}));

import { processSyncTriggerBatch } from "../apps/runtime/src/worker-sync-trigger.ts";

describe("worker sync trigger batching", () => {
  beforeEach(() => {
    syncMocks.runLightSync.mockReset();
    syncMocks.runFollowerSync.mockReset();
    syncMocks.runAllSync.mockReset();
  });

  it("processes every job in the batch sequentially", async () => {
    const app = {} as never;

    await processSyncTriggerBatch(app, [
      { data: { pageLabel: "alpha", scope: "light" } },
      { data: { pageLabel: "beta", scope: "followers" } },
      { data: { pageLabel: "gamma", scope: "all" } },
    ]);

    expect(syncMocks.runLightSync).toHaveBeenCalledTimes(1);
    expect(syncMocks.runLightSync).toHaveBeenCalledWith(app, "alpha", { trigger: "api" });
    expect(syncMocks.runFollowerSync).toHaveBeenCalledTimes(1);
    expect(syncMocks.runFollowerSync).toHaveBeenCalledWith(app, "beta", "api");
    expect(syncMocks.runAllSync).toHaveBeenCalledTimes(1);
    expect(syncMocks.runAllSync).toHaveBeenCalledWith(app, "gamma", { trigger: "api" });
  });
});
