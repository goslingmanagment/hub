import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

// Step 4, S4-19: the legacy planner stands on the boundary
// (`apps/runtime/src/sync/onlyfans/boundary.ts`). It scopes every page-sync
// query to the platforms the legacy executor serves and, before the first
// wake-up, asserts that scope on what the listing returned: a page of another
// platform stops the pass with nothing woken. The executor's half is in
// tests/sync-executor.test.ts; the set itself and the ratchet over
// `services/sync/` are in tests/sync-onlyfans-boundary.test.ts.

const dbMocks = vi.hoisted(() => ({
  closeInactiveSyncRuns: vi.fn(),
  ensurePageSyncStates: vi.fn(),
  listRunnableOfapiCapturePages: vi.fn(),
  listRunnablePageSync: vi.fn(),
  markPageSyncEnqueued: vi.fn(),
  recoverStaleOfapiCaptureWork: vi.fn(),
  retireLegacyOnlyFansDmMessages: vi.fn(),
  scheduleDuePageSync: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => ({
  ...await vi.importActual<typeof DbModule>("@agency_hub_core/db"),
  ...dbMocks,
}));
// The real boundary over a registry of the two adapters' declared streams (the
// real registry assembles every handler; the planner reads only the set).
vi.mock("../apps/runtime/src/platforms/registry.ts", () => ({
  appPlatformRegistry: {
    all: () => [
      { key: "fansly", capabilities: { streams: [] } },
      { key: "onlyfans", capabilities: { streams: ["light", "subscribers"] } },
    ],
  },
}));
vi.mock("../apps/runtime/src/services/sync/ofapi-audience-sync.ts", () => ({
  pauseDisabledOnlyFansAudienceForAllPages: async () => 0,
}));
vi.mock("../apps/runtime/src/services/sync/onlyfans-dm-polling.ts", () => ({
  pauseDisabledOnlyFansDmPollingForAllPages: async () => 0,
}));
vi.mock("../apps/runtime/src/services/sync/onlyfans-top-spenders.ts", () => ({
  pauseDisabledOnlyFansTopSpendersForAllPages: async () => 0,
}));
vi.mock("../apps/runtime/src/services/sync/posts.ts", () => ({
  pauseIneligibleOnlyFansPostsForAllPages: async () => 0,
}));
vi.mock("../apps/runtime/src/services/ofapi-capture-jobs.ts", () => ({
  isOfapiBackgroundCaptureRunnable: () => false,
}));
vi.mock("../apps/runtime/src/services/ofapi-capture-transport.ts", () => ({
  recoverExpiredOfapiInteractiveResponses: async () => ({ terminalized: 0, unavailable: 0, errors: 0 }),
}));

import { runSyncPlannerCycle } from "../apps/runtime/src/services/sync/planner.ts";

const NOW = new Date("2026-10-04T09:00:00.000Z");

function runnable(pageId: number, platform: "fansly" | "onlyfans") {
  return { pageId, platform, priority: 30, requestedAt: NOW, egressKey: `proxy-${pageId}` };
}

function rig() {
  const app = { db: {}, config: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never;
  const boss = { send: vi.fn(async () => "job") };
  return { app, boss };
}

beforeEach(() => {
  for (const mock of Object.values(dbMocks)) mock.mockReset();
  dbMocks.closeInactiveSyncRuns.mockResolvedValue({ totalCount: 0, failedCount: 0, partialCount: 0 });
  dbMocks.ensurePageSyncStates.mockResolvedValue([]);
  dbMocks.retireLegacyOnlyFansDmMessages.mockResolvedValue(0);
  dbMocks.scheduleDuePageSync.mockResolvedValue(undefined);
  dbMocks.listRunnablePageSync.mockResolvedValue([]);
  dbMocks.listRunnableOfapiCapturePages.mockResolvedValue([]);
  dbMocks.recoverStaleOfapiCaptureWork.mockResolvedValue({ released: 0, indeterminate: 0, requeued: 0 });
  dbMocks.markPageSyncEnqueued.mockResolvedValue(undefined);
});

describe("the legacy planner on the boundary", () => {
  it("seeds, schedules and lists only the served platforms, and wakes their runnable pages", async () => {
    const { app, boss } = rig();
    dbMocks.listRunnablePageSync.mockResolvedValue([runnable(8, "onlyfans"), runnable(9, "onlyfans")]);

    await runSyncPlannerCycle(app, boss, NOW);

    const scope = { platforms: ["onlyfans"] };
    expect(dbMocks.ensurePageSyncStates).toHaveBeenCalledWith({}, expect.objectContaining(scope));
    expect(dbMocks.scheduleDuePageSync).toHaveBeenCalledWith({}, expect.objectContaining(scope));
    expect(dbMocks.listRunnablePageSync).toHaveBeenCalledWith({}, NOW, scope);
    expect(boss.send.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { platformAccountId: 8 },
      { platformAccountId: 9 },
    ]);
    expect(dbMocks.markPageSyncEnqueued.mock.calls.map((call) => call[1])).toEqual([8, 9]);
  });

  it("stops the pass before the first wake-up when the listing returns a page of a platform it does not serve", async () => {
    const { app, boss } = rig();
    // A broken scope: the listing is asked for the served platforms only.
    dbMocks.listRunnablePageSync.mockResolvedValue([runnable(8, "onlyfans"), runnable(4, "fansly")]);

    await expect(runSyncPlannerCycle(app, boss, NOW)).rejects.toMatchObject({
      name: "LegacyExecutorBoundaryError",
      pageId: 4,
      platform: "fansly",
      site: "planner",
    });

    // Nothing is woken — not the Fansly page, and not the OnlyFans page beside
    // it either: the pass cannot tell what else the broken scope let through.
    expect(boss.send).not.toHaveBeenCalled();
    expect(dbMocks.markPageSyncEnqueued).not.toHaveBeenCalled();
    // The recovery that sends nothing ran before the assertion.
    expect(dbMocks.recoverStaleOfapiCaptureWork).toHaveBeenCalledOnce();
  });
});
