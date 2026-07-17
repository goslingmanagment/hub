// Stage 16 media-scoped purchase-history regression coverage. Fansly requires
// accountMediaId/accountMediaBundleId; accountIds is only an optional buyer
// filter. Captured DM pages are the durable discovery source.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  findPageById,
  getCheckpoint,
  insertRawPayload,
  startSyncRun,
  upsertCheckpointProgress,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { FanslyPurchaseHistoryContractError } from "../apps/runtime/src/services/sync/errors.ts";
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

async function seedPage() {
  const model = await createModel(appContext.db, { slug: "ph-model", name: "PH" });
  if (!model) {
    throw new Error("failed to create test model");
  }
  const page = await createFanslyPage(appContext.db, { modelId: model.id, label: "ph-fansly" });
  if (!page) {
    throw new Error("failed to create test page");
  }
  await ensurePageSyncStates(appContext.db, { pageId: page.id });
  return page;
}

async function captureDmPage(pageId: number, responsePayload: unknown) {
  await insertRawPayload(appContext.db, {
    platformAccountId: pageId,
    endpoint: "dm_messages",
    requestParams: { groupId: "group-1" },
    responsePayload,
    mapperVersion: "test",
    payloadKind: "dm_messages",
    retainUntil: new Date("2126-01-01T00:00:00Z"),
  });
}

function ppvDmPayload() {
  return {
    messages: [{
      id: "message-1",
      attachments: [
        { contentType: 1, contentId: "media-1" },
        { contentType: 2, contentId: "bundle-1" },
        { contentType: 1, contentId: "free-media" },
      ],
    }],
    accountMedia: [
      { id: "media-1", permissions: { permissionFlags: [{ flags: 1 }] } },
      { id: "free-media", permissions: { permissionFlags: [] } },
    ],
    accountMediaBundles: [
      { id: "bundle-1", permissions: { permissionFlags: [{ flags: 1 }] } },
    ],
    accountMediaOrders: [{
      accountId: "buyer-1",
      accountMediaId: "ordered-media",
      createdAt: 1_780_000_000,
    }],
  };
}

async function buildChunkInput(page: { id: number }, telemetry: ReturnType<typeof fakeTelemetry>) {
  const run = await startSyncRun(appContext.db, {
    platformAccountId: page.id,
    stream: "purchase_history",
    trigger: "manual",
  });
  if (!run) {
    throw new Error("failed to create test sync run");
  }
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

describe("Stage 16 media-scoped purchase-history walk", () => {
  it("discovers PPV media from captured DMs and never sends accountIds", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, ppvDmPayload());

    const requested: Array<Record<string, unknown>> = [];
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage(_requestContext: unknown, params: Record<string, unknown>) {
          requested.push(params);
          return { items: [], raw: { accountMediaOrderHistory: [] } };
        },
      } as never,
    };

    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );

    expect(requested).toEqual([
      { accountMediaBundleId: "bundle-1", limit: 100 },
      { accountMediaId: "media-1", limit: 100 },
      { accountMediaId: "ordered-media", limit: 100 },
    ]);
    expect(requested.every((params) => !("accountIds" in params))).toBe(true);
    expect(result).toMatchObject({
      satisfied: true,
      stats: { targetsFetched: 3, orderRowsCaptured: 0, walkCompleted: true },
    });

    const captures = await testDb.pool.query<{ request_params: Record<string, unknown> }>(
      "select request_params from sync_raw_payloads where endpoint = 'purchase_history' order by id",
    );
    expect(captures.rows.map((row) => row.request_params)).toEqual(requested);

    // The raw-row high-water and target captures make the steady-state pass
    // local and idempotent: no second vendor call for the same media.
    requested.length = 0;
    const second = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );
    expect(second.satisfied).toBe(true);
    expect(requested).toEqual([]);
  });

  it("captures and skips one deleted media target instead of wedging", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, ppvDmPayload());
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage(_context: unknown, params: Record<string, unknown>) {
          if (params.accountMediaBundleId === "bundle-1") {
            throw new FanslyApiError("media gone", 404);
          }
          return { items: [], raw: { accountMediaOrderHistory: [] } };
        },
      } as never,
    };

    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );

    expect(result).toMatchObject({
      satisfied: true,
      stats: { targetsFetched: 2, targetsSkipped: 1, walkCompleted: true },
    });
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "purchase_history_media_rejected",
    }));
    const rejected = await testDb.pool.query<{ status_code: number; error_message: string }>(
      "select status_code, error_message from sync_raw_payloads where endpoint = 'purchase_history' and status_code = 404",
    );
    expect(rejected.rows).toEqual([{ status_code: 404, error_message: "media gone" }]);
  });

  it("prefers bundle evidence and repairs a stale alternate-kind checkpoint locally", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, {
      messages: [{
        id: "message-bundle",
        attachments: [{ contentType: 2, contentId: "shared-content-id" }],
      }],
      accountMedia: [],
      accountMediaBundles: [{
        id: "shared-content-id",
        permissions: { permissionFlags: [{ flags: 1 }] },
      }],
      // Live Fansly payloads sometimes use accountMediaId even though the
      // attachment and metadata identify this exact id as a bundle.
      accountMediaOrders: [{ accountMediaId: "shared-content-id" }],
    });

    const requested: Array<Record<string, unknown>> = [];
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage(_context: unknown, params: Record<string, unknown>) {
          requested.push(params);
          return { items: [], raw: { accountMediaOrderHistory: [] } };
        },
      } as never,
    };

    const first = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(first.satisfied).toBe(true);
    expect(requested).toEqual([{
      accountMediaBundleId: "shared-content-id",
      limit: 100,
    }]);

    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 2,
        rawPayloadCursorId: Number(checkpoint?.state.rawPayloadCursorId ?? 0),
        pendingTargets: [{ kind: "single", contentId: "shared-content-id" }],
      },
    });

    const second = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(second.satisfied).toBe(true);
    expect(requested).toHaveLength(1);
  });

  it("makes zero adapter calls with the feature flag off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = createTestAppContext(testDb, { fanslyPurchaseHistorySyncEnabled: false });
    const page = await seedPage();
    await captureDmPage(page.id, ppvDmPayload());
    const adapterSpy = vi.fn(async () => ({ items: [], raw: {} }));
    appContext = {
      ...appContext,
      adapter: { getMediaOrderHistoryPage: adapterSpy } as never,
    };

    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(result).toMatchObject({ satisfied: true, stats: { skipped: "flag_off" } });
    expect(adapterSpy).not.toHaveBeenCalled();
  });

  it.each([99, 12])("treats Fansly HTTP 400 code %s as systemic contract drift", async (code, context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, ppvDmPayload());
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage() {
          throw new FanslyApiError("invalid params", 400, code);
        },
      } as never,
    };

    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toThrow("invalid params");
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      version: 2,
      pendingTargets: expect.arrayContaining([
        { kind: "bundle", contentId: "bundle-1" },
      ]),
    });
  });

  it("captures but blocks an unknown success shape without refetching it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, {
      messages: [{ attachments: [{ contentType: 1, contentId: "media-1" }] }],
      accountMedia: [{
        id: "media-1",
        permissions: { permissionFlags: [{ flags: 1 }] },
      }],
    });
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage() {
          return { items: [], raw: { unexpected: [] } };
        },
      } as never,
    };

    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toBeInstanceOf(FanslyPurchaseHistoryContractError);
    const captures = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from sync_raw_payloads where endpoint = 'purchase_history'",
    );
    expect(captures.rows).toEqual([{ n: "1" }]);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({ pendingTargets: [] });
  });
});
