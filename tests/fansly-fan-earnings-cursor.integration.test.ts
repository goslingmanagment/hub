// W8.2 / A43 (decision #133): the fan_earnings cursor is a contiguous
// successful prefix. A fan-scoped rejection stops the walk; no later fan may
// move the durable cursor across it, and the failed run may not stamp success.
// These pages have no shadow receipts; the bounded crossing of a durable
// deterministic rejection is covered by fan-earnings-legacy-crossing.

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
import { executeFanEarningsChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
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
  appContext = createTestAppContext(testDb, { fanslyFanEarningsSyncEnabled: true });
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

async function seedPageWithSpenders(fanPlatformIds: string[]) {
  const model = await createModel(appContext.db, { slug: "fe-model", name: "FE" });
  if (!model) throw new Error("model seed failed");
  const page = await createFanslyPage(appContext.db, { modelId: model.id, label: "fe-fansly" });
  if (!page) throw new Error("page seed failed");
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
  // The fan-earnings walk is SPENDER-scoped (page_fans net > 0).
  await testDb!.pool.query(
    "update page_fans set total_creator_net_mills = 5000 where platform_account_id = $1",
    [page.id],
  );
  return { page, fans };
}

/** Adapter stub: each provider call notifies the request observer (like the
 * real transport) so the chunk budget actually depletes; the listed fan ids
 * reject fan-scoped (HTTP 404). */
function earningsAdapter(rejected: Set<string>, requested: string[]) {
  const call = async (
    requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
    params: { correlationAccountId: string },
  ) => {
    requested.push(params.correlationAccountId);
    await requestContext.requestObserver?.onRequestEvent({ state: "started" });
    if (rejected.has(params.correlationAccountId)) {
      throw new FanslyApiError("account gone", 404);
    }
    return { items: [{ correlationAccountId: params.correlationAccountId, type: 2110, totalGross: 100, totalNet: 80 }] };
  };
  return {
    getEarningsStatsAccountsPage: call,
    getEarningsMonthlyStatsAccountsPage: call,
  } as never;
}

async function buildChunkInput(
  page: { id: number },
  telemetry: ReturnType<typeof fakeTelemetry>,
  budget: SyncChunkBudget,
) {
  const run = await startSyncRun(appContext.db, {
    platformAccountId: page.id,
    stream: "fan_earnings",
    trigger: "manual",
  });
  if (!run) throw new Error("sync run seed failed");
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
    streamState: { stream: "fan_earnings" } as never,
    syncRunId: run.id,
    telemetry: telemetry as never,
    budget,
  };
}

describe("Stage 16 fan-earnings walk cursor (A43 hold-back)", () => {
  it("captures lifetime stats before a monthly fan-scoped rejection", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page } = await seedPageWithSpenders(["fe-partial"]);
    const statsRow = {
      correlationAccountId: "fe-partial",
      type: 2110,
      totalGross: 100,
      totalNet: 80,
    };
    appContext = {
      ...appContext,
      adapter: {
        async getEarningsStatsAccountsPage(
          requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
        ) {
          await requestContext.requestObserver?.onRequestEvent({ state: "started" });
          return { items: [statsRow], raw: [statsRow] };
        },
        async getEarningsMonthlyStatsAccountsPage(
          requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
        ) {
          await requestContext.requestObserver?.onRequestEvent({ state: "started" });
          throw new FanslyApiError("monthly unavailable", 404);
        },
      } as never,
    };

    await expect(executeFanEarningsChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), new SyncChunkBudget(10, 60_000)),
    )).rejects.toThrow("monthly unavailable");

    const payloads = await testDb.pool.query<{
      endpoint: string;
      request_params: { correlationAccountId?: string };
      response_payload: unknown;
    }>(
      `select endpoint, request_params, response_payload
       from sync_raw_payloads
       where page_id = $1
       order by id`,
      [page.id],
    );
    expect(payloads.rows).toEqual([expect.objectContaining({
      endpoint: "fan_earnings_stats",
      request_params: expect.objectContaining({ correlationAccountId: "fe-partial" }),
      response_payload: [statsRow],
    })]);
  });

  it("stops on the first rejection and persists only the contiguous successful prefix", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, fans } = await seedPageWithSpenders(["fe-1", "fe-2", "fe-3"]);
    const requested: string[] = [];
    appContext = { ...appContext, adapter: earningsAdapter(new Set(["fe-2"]), requested) };

    const telemetry = fakeTelemetry();
    await expect(executeFanEarningsChunk(
      appContext,
      await buildChunkInput(page, telemetry, new SyncChunkBudget(10, 60_000)),
    )).rejects.toThrow("account gone");

    expect(requested).toEqual(["fe-1", "fe-1", "fe-2"]);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "fan_earnings_fan_rejected",
    }));

    // The rejected fan remains the next keyset row. This failed run records
    // progress but never becomes the stream's last successful run.
    const checkpoint = await getCheckpoint(appContext.db, page.id, "fan_earnings");
    expect(checkpoint?.state).toMatchObject({ cursorFanId: fans[0]!.id });
    expect(checkpoint?.cursorLastSucceededRunId ?? null).toBeNull();

    // The successful fan's capture landed (one stats + one monthly journal).
    const payloads = await testDb.pool.query<{ endpoint: string }>(
      "select endpoint from sync_raw_payloads where page_id = $1 order by endpoint",
      [page.id],
    );
    expect(payloads.rows.map((row) => row.endpoint))
      .toEqual(["fan_earnings_monthly", "fan_earnings_stats"]);
  });

  it("leaves the checkpoint untouched when the first fan rejects", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page } = await seedPageWithSpenders(["fe-1", "fe-2"]);
    appContext = { ...appContext, adapter: earningsAdapter(new Set(["fe-1", "fe-2"]), []) };

    await expect(executeFanEarningsChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), new SyncChunkBudget(10, 60_000)),
    )).rejects.toThrow("account gone");
    const checkpoint = await getCheckpoint(appContext.db, page.id, "fan_earnings");
    expect(checkpoint?.state ?? null).toBeNull();
  });

  it("never completes a walk that encountered a rejected fan", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page } = await seedPageWithSpenders(["fe-1", "fe-2", "fe-3"]);
    const requested: string[] = [];
    appContext = { ...appContext, adapter: earningsAdapter(new Set(["fe-2"]), requested) };

    await expect(executeFanEarningsChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), new SyncChunkBudget(10, 60_000)),
    )).rejects.toThrow("account gone");

    expect(requested).toEqual(["fe-1", "fe-1", "fe-2"]);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "fan_earnings");
    expect(checkpoint?.state).toMatchObject({ cursorFanId: expect.any(Number) });
    expect(checkpoint?.state).not.toMatchObject({ cursorFanId: 0 });
    expect(checkpoint?.cursorLastSucceededRunId ?? null).toBeNull();
  });

  it("retries the same rejected head fan on the next invocation", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page } = await seedPageWithSpenders(["fe-1", "fe-2"]);
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: earningsAdapter(new Set(["fe-1", "fe-2"]), requested),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        executeFanEarningsChunk(
          appContext,
          await buildChunkInput(page, fakeTelemetry(), new SyncChunkBudget(10, 60_000)),
        ),
      ).rejects.toThrow("account gone");
    }
    expect(requested).toEqual(["fe-1", "fe-1"]);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "fan_earnings");
    expect(checkpoint?.state ?? null).toBeNull();
  });

  it("stamps completion only after an all-success walk", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page } = await seedPageWithSpenders(["fe-1", "fe-2"]);
    appContext = { ...appContext, adapter: earningsAdapter(new Set(), []) };

    const result = await executeFanEarningsChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), new SyncChunkBudget(10, 60_000)),
    );
    expect(result).toMatchObject({
      satisfied: true,
      stats: { fansFetched: 2, fansSkipped: 0, walkCompleted: true },
    });
    expect((await getCheckpoint(appContext.db, page.id, "fan_earnings"))?.state)
      .toMatchObject({ cursorFanId: 0 });
  });
});
