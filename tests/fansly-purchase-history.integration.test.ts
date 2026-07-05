// Stage 16 purchase-history keyset walk (pre-merge review regression
// coverage): per-fan failure isolation — one dead fan account never wedges
// the walk — and flags-off egress inertness for the Monday flags-off deploy.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  findPageById,
  getCheckpoint,
  startSyncRun,
  upsertFanPages,
  upsertFans,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { executePurchaseHistoryChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, { fanslyPurchaseHistorySyncEnabled: true });
});

function fakeTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    getRequestObserver: () => null,
  };
}

async function seedPageWithFans(fanPlatformIds: string[]) {
  const model = await createModel(appContext.db, { slug: "ph-model", name: "PH" });
  const page = await createFanslyPage(appContext.db, { modelId: model.id, label: "ph-fansly" });
  await ensurePageSyncStates(appContext.db, { pageId: page.id });
  const fans = await upsertFans(appContext.db, fanPlatformIds.map((platformUserId) => ({
    platform: "fansly" as const,
    platformUserId,
    username: `u${platformUserId}`,
  })));
  await upsertFanPages(appContext.db, fans.map((fan) => ({
    fanId: fan.id,
    platformAccountId: page.id,
  })));
  return page;
}

async function buildChunkInput(page: { id: number }, telemetry: ReturnType<typeof fakeTelemetry>) {
  const run = await startSyncRun(appContext.db, {
    platformAccountId: page.id,
    stream: "purchase_history",
    trigger: "manual",
  });
  const stored = await findPageById(appContext.db, page.id);
  if (!stored) {
    throw new Error(`page ${page.id} missing`);
  }
  return {
    pageContext: {
      page: stored.page,
      platform: "fansly" as const,
      session: null,
      proxy: null,
      egressKey: "direct",
    } as never,
    streamState: { stream: "purchase_history" } as never,
    syncRunId: run.id,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(10, 60_000),
  };
}

describe("Stage 16 purchase-history walk", () => {
  it("skips a fan-scoped 404 and completes the walk instead of wedging on it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPageWithFans(["ph-1", "ph-2", "ph-3"]);

    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage(
          _requestContext: unknown,
          params: { accountIds: string },
        ) {
          requested.push(params.accountIds);
          if (params.accountIds === "ph-2") {
            throw new FanslyApiError("account gone", 404);
          }
          return { raw: { response: { orders: [] } } };
        },
      } as never,
    };

    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );

    // Every fan attempted; the dead one skipped; the walk COMPLETED.
    expect(requested).toEqual(["ph-1", "ph-2", "ph-3"]);
    expect(result).toMatchObject({
      satisfied: true,
      stats: { fansFetched: 2, walkCompleted: true },
    });
    expect(telemetry.addAnomaly).toHaveBeenCalledTimes(1);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "purchase_history_fan_rejected",
    }));

    // Only successful fetches persisted; completion checkpoint reset.
    const payloads = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from sync_raw_payloads where endpoint = 'purchase_history'",
    );
    expect(payloads.rows).toEqual([{ n: "2" }]);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({ cursorFanId: 0 });
  });

  it("makes zero adapter calls with the flag off (Monday ships flags-off)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = createTestAppContext(testDb, { fanslyPurchaseHistorySyncEnabled: false });
    const page = await seedPageWithFans(["ph-9"]);
    const adapterSpy = vi.fn(async () => ({ raw: {} }));
    appContext = {
      ...appContext,
      adapter: { getMediaOrderHistoryPage: adapterSpy } as never,
    };

    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );
    expect(result).toMatchObject({ satisfied: true, stats: { skipped: "flag_off" } });
    expect(adapterSpy).not.toHaveBeenCalled();
  });

  it("propagates page-scoped auth errors instead of skipping the fan", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPageWithFans(["ph-1"]);
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage() {
          throw new FanslyApiError("session dead", 401);
        },
      } as never,
    };

    const telemetry = fakeTelemetry();
    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, telemetry)),
    ).rejects.toThrow("session dead");
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
  });
});
