import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aggregateTransactionTopSpenders,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  findPageById,
  getCheckpoint,
  getEarliestSpenderTransactionAt,
  listPageSyncStates,
  rebuildSpenderProjections,
  startSyncRun,
  upsertFans,
  upsertTransaction,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { executeTopSpendersChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import {
  filterOnlyFansTopSpendersStreams,
  pauseDisabledOnlyFansTopSpendersForPage,
} from "../apps/runtime/src/services/sync/onlyfans-top-spenders.ts";
import { triggerSyncBlock } from "../apps/runtime/src/services/sync-blocks.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

function fakeTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    getRequestObserver: () => null,
  } as never;
}

async function seedPage(label = "lora-of-spenders") {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  await ensurePageSyncStates(appContext.db, { pageId: page.id });
  return page;
}

async function seedFanWithSpend(input: {
  pageId: number;
  platformUserId: string;
  transactions: Array<{ id: string; grossMills: bigint; netMills: bigint; occurredAt: Date }>;
}) {
  const [fan] = await upsertFans(appContext.db, [{
    platform: "onlyfans",
    platformUserId: input.platformUserId,
    username: `fan${input.platformUserId}`,
  }]);
  for (const transaction of input.transactions) {
    await upsertTransaction(appContext.db, {
      platformAccountId: input.pageId,
      source: "onlymonster",
      fanId: fan!.id,
      transactionId: transaction.id,
      correlationAccountId: input.platformUserId,
      rawType: "tip",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "ok",
      grossAmountMills: transaction.grossMills,
      sourceDestinationAmountMills: transaction.grossMills,
      creatorNetAmountMills: transaction.netMills,
      occurredAt: transaction.occurredAt,
    });
  }
  return fan!;
}

async function buildChunkInput(page: { id: number }) {
  const run = await startSyncRun(appContext.db, {
    platformAccountId: page.id,
    stream: "top_spenders",
    trigger: "manual",
  });
  const stored = await findPageById(appContext.db, page.id);
  if (!stored) {
    throw new Error(`page ${page.id} missing`);
  }
  return {
    pageContext: {
      page: stored.page,
      platform: "onlyfans" as const,
      auth: { token: "unused" },
      proxy: null,
      egressKey: "direct",
    } as never,
    streamState: { stream: "top_spenders" } as never,
    syncRunId: run.id,
    telemetry: fakeTelemetry(),
    budget: new SyncChunkBudget(10, 60_000),
  };
}

async function listRankings(pageId: number) {
  const { rows } = await testDb!.pool.query<{
    source_identity_key: string;
    correlation_account_id: string | null;
    fan_id: number | null;
    gross_amount_mills: string;
    creator_net_amount_mills: string;
    source_window_started_at: string;
    source_window_ended_at: string;
  }>(
    `select source_identity_key, correlation_account_id, fan_id::int,
            gross_amount_mills::text, creator_net_amount_mills::text,
            source_window_started_at::text, source_window_ended_at::text
     from page_fan_identities where platform_account_id = $1
     order by source_identity_key`,
    [pageId],
  );
  return rows;
}

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
  appContext = createTestAppContext(testDb, { onlyFansTopSpendersEnabled: true });
});

describe("OnlyFans top spenders (computed from transactions)", () => {
  it("bootstraps month windows from the earliest transaction and ranks per fan", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    const now = Date.now();
    const lastMonth = new Date(now - 35 * 24 * 60 * 60 * 1000);

    // Fan A spent across two months; fan B only recently.
    const fanA = await seedFanWithSpend({
      pageId: page.id,
      platformUserId: "9001",
      transactions: [
        { id: "t-a-1", grossMills: 10_000n, netMills: 8_000n, occurredAt: lastMonth },
        { id: "t-a-2", grossMills: 5_000n, netMills: 4_000n, occurredAt: new Date(now - 2 * 24 * 60 * 60 * 1000) },
      ],
    });
    await seedFanWithSpend({
      pageId: page.id,
      platformUserId: "9002",
      transactions: [
        { id: "t-b-1", grossMills: 20_000n, netMills: 16_000n, occurredAt: new Date(now - 24 * 60 * 60 * 1000) },
      ],
    });

    const earliest = await getEarliestSpenderTransactionAt(appContext.db, page.id);
    expect(earliest?.getTime()).toBe(lastMonth.getTime());

    const result = await executeTopSpendersChunk(appContext, await buildChunkInput(page));
    expect(result.satisfied).toBe(true);
    expect(result.stats).toMatchObject({ mode: "bootstrap" });

    const rankings = await listRankings(page.id);
    expect(rankings).toHaveLength(2);
    const fanARow = rankings.find((row) => row.correlation_account_id === "9001");
    const fanBRow = rankings.find((row) => row.correlation_account_id === "9002");
    // Each identity holds the latest processed window's sums (Fansly semantics):
    // fan A's current-month window has only the recent 5k/4k transaction.
    expect(fanARow).toMatchObject({
      source_identity_key: "fan:9001",
      gross_amount_mills: "5000",
      creator_net_amount_mills: "4000",
    });
    expect(fanARow!.fan_id).toBe(fanA.id);
    expect(fanBRow).toMatchObject({
      source_identity_key: "fan:9002",
      gross_amount_mills: "20000",
      creator_net_amount_mills: "16000",
    });

    const checkpoint = await getCheckpoint(appContext.db, page.id, "top_spenders");
    expect(checkpoint?.state).toMatchObject({ mode: "steady_state", pendingWindows: [] });

    // Acceptance: window sums reconcile with the spenders-v2 projections.
    await rebuildSpenderProjections(appContext.db, page.id);
    const windowRows = await aggregateTransactionTopSpenders(appContext.db, {
      platformAccountId: page.id,
      from: new Date(0),
      to: new Date(),
    });
    const totalGross = windowRows.reduce((sum, row) => sum + row.grossAmountMills, 0n);
    expect(totalGross).toBe(35_000n);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refreshes the trailing week in steady state without re-walking history", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    await seedFanWithSpend({
      pageId: page.id,
      platformUserId: "9003",
      transactions: [
        { id: "t-c-1", grossMills: 7_000n, netMills: 5_600n, occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
      ],
    });

    const first = await executeTopSpendersChunk(appContext, await buildChunkInput(page));
    expect(first.satisfied).toBe(true);
    expect(first.stats).toMatchObject({ mode: "bootstrap" });

    // New spend lands; the steady-state pass folds it in via the 7d window.
    await seedFanWithSpend({
      pageId: page.id,
      platformUserId: "9004",
      transactions: [
        { id: "t-d-1", grossMills: 3_000n, netMills: 2_400n, occurredAt: new Date() },
      ],
    });

    const second = await executeTopSpendersChunk(appContext, await buildChunkInput(page));
    expect(second.satisfied).toBe(true);
    expect(second.stats).toMatchObject({ mode: "steady_state", windowsProcessed: 1 });

    const rankings = await listRankings(page.id);
    expect(rankings.map((row) => row.source_identity_key).sort())
      .toEqual(["fan:9003", "fan:9004"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("completes harmlessly for a page without spender transactions", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    const result = await executeTopSpendersChunk(appContext, await buildChunkInput(page));
    expect(result.satisfied).toBe(true);
    expect(result.stats).toMatchObject({ mode: "empty" });
    expect(await listRankings(page.id)).toHaveLength(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("gates the stream behind ONLYFANS_TOP_SPENDERS_ENABLED", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    expect(filterOnlyFansTopSpendersStreams(
      "onlyfans",
      ["light", "top_spenders"],
      { onlyFansTopSpendersEnabled: false },
    )).toEqual(["light"]);
    expect(filterOnlyFansTopSpendersStreams(
      "onlyfans",
      ["light", "top_spenders"],
      { onlyFansTopSpendersEnabled: true },
    )).toEqual(["light", "top_spenders"]);
    expect(filterOnlyFansTopSpendersStreams(
      "fansly",
      ["top_spenders"],
      { onlyFansTopSpendersEnabled: false },
    )).toEqual(["top_spenders"]);

    const disabledContext = createTestAppContext(testDb, { onlyFansTopSpendersEnabled: false });
    const page = await seedPage("lora-of-gated");
    const paused = await pauseDisabledOnlyFansTopSpendersForPage(disabledContext, page.id);
    expect(paused).toBe(true);
    const states = await listPageSyncStates(disabledContext.db, {
      pageId: page.id,
      streams: ["top_spenders"],
    });
    expect(states[0]?.status).toBe("paused");

    // A manual resume can race one run in before the planner re-pauses; the
    // executor skips gracefully instead of recording a failure.
    const skipped = await executeTopSpendersChunk(disabledContext, await buildChunkInput(page));
    expect(skipped.satisfied).toBe(true);
    expect(skipped.stats).toMatchObject({ skipped: "onlyfans_top_spenders_disabled" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("exposes top_spenders in the financials block for OnlyFans pages", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await seedPage("lora-of-block");
    const boss = { send: vi.fn(async () => "job") };
    const result = await triggerSyncBlock(appContext, boss as never, {
      pageLabel: "lora-of-block",
      block: "financials",
    });
    expect(result.requests.map((request) => request.stream)).toContain("top_spenders");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
