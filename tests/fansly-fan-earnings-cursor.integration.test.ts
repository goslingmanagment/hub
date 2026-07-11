// W8.2 / A43 (decision #133): the fan_earnings walk used to ADVANCE AND
// PERSIST its cursor past skipped fans — a run that ended on skips sealed
// them in (and defused the mass-skip breaker). It now copies
// purchase_history's hold-back discipline: the persisted cursor moves only
// past SUCCESSFUL fans, and a zero-success chunk leaves the checkpoint
// untouched entirely.

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
  it("holds the persisted cursor at the last SUCCESS when the chunk ends on a skip", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, fans } = await seedPageWithSpenders(["fe-1", "fe-2", "fe-3"]);
    const requested: string[] = [];
    appContext = { ...appContext, adapter: earningsAdapter(new Set(["fe-2"]), requested) };

    // Budget for 4 calls: fe-1 succeeds (2 calls), fe-2 rejects on its first
    // call (1 call, fan-scoped skip), then the 2-call reservation no longer
    // fits — the chunk ends ON the skip.
    const telemetry = fakeTelemetry();
    const result = await executeFanEarningsChunk(
      appContext,
      await buildChunkInput(page, telemetry, new SyncChunkBudget(4, 60_000)),
    );

    expect(requested).toEqual(["fe-1", "fe-1", "fe-2"]);
    expect(result).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { fansFetched: 1, fansSkipped: 1 },
    });
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "fan_earnings_fan_rejected",
    }));

    // THE FIX: the persisted cursor resumes from fe-1 (last success), not
    // from the skipped fe-2 — pre-A43 this read { cursorFanId: fans[1].id }.
    const checkpoint = await getCheckpoint(appContext.db, page.id, "fan_earnings");
    expect(checkpoint?.state).toMatchObject({ cursorFanId: fans[0]!.id });

    // The successful fan's capture landed (one stats + one monthly journal).
    const payloads = await testDb.pool.query<{ endpoint: string }>(
      "select endpoint from sync_raw_payloads where page_id = $1 order by endpoint",
      [page.id],
    );
    expect(payloads.rows.map((row) => row.endpoint))
      .toEqual(["fan_earnings_monthly", "fan_earnings_stats"]);
  });

  it("leaves the checkpoint UNTOUCHED when a budget-bounded chunk fetched nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page } = await seedPageWithSpenders(["fe-1", "fe-2"]);
    appContext = { ...appContext, adapter: earningsAdapter(new Set(["fe-1", "fe-2"]), []) };

    // Budget for 2 calls: fe-1 rejects (1 call), the next 2-call unit no
    // longer fits — zero-success chunk, NOT a completed walk (so the
    // mass-skip breaker stays armed for a full walk).
    const result = await executeFanEarningsChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), new SyncChunkBudget(2, 60_000)),
    );

    expect(result).toMatchObject({
      satisfied: false,
      stats: { fansFetched: 0, fansSkipped: 1 },
    });
    // No zero-capture "progress" stamped: the next run retries fe-1.
    const checkpoint = await getCheckpoint(appContext.db, page.id, "fan_earnings");
    expect(checkpoint?.state ?? null).toBeNull();
  });

  it("still stamps the completion reset when the walk finishes (skips included)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page } = await seedPageWithSpenders(["fe-1", "fe-2", "fe-3"]);
    const requested: string[] = [];
    appContext = { ...appContext, adapter: earningsAdapter(new Set(["fe-2"]), requested) };

    const result = await executeFanEarningsChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), new SyncChunkBudget(10, 60_000)),
    );

    expect(result).toMatchObject({
      satisfied: true,
      stats: { fansFetched: 2, fansSkipped: 1, walkCompleted: true },
    });
    const checkpoint = await getCheckpoint(appContext.db, page.id, "fan_earnings");
    expect(checkpoint?.state).toMatchObject({ cursorFanId: 0 });
  });

  it("refuses to stamp completion when EVERY fan was skipped (mass-skip breaker, unchanged)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page } = await seedPageWithSpenders(["fe-1", "fe-2"]);
    appContext = { ...appContext, adapter: earningsAdapter(new Set(["fe-1", "fe-2"]), []) };

    await expect(
      executeFanEarningsChunk(
        appContext,
        await buildChunkInput(page, fakeTelemetry(), new SyncChunkBudget(10, 60_000)),
      ),
    ).rejects.toThrow("skipped all 2 fans");
    const checkpoint = await getCheckpoint(appContext.db, page.id, "fan_earnings");
    expect(checkpoint?.state ?? null).toBeNull();
  });
});
