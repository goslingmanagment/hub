import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getCheckpoint: vi.fn(),
  getOldestPendingTransactionAt: vi.fn(),
  rebuildSpenderProjections: vi.fn(),
  rebuildRevenueRollups: vi.fn(),
  upsertCheckpoint: vi.fn(),
  upsertCheckpointProgress: vi.fn(),
  upsertFanPages: vi.fn(),
  upsertFans: vi.fn(),
  upsertTransaction: vi.fn(),
}));

const sharedMocks = vi.hoisted(() => ({
  DAY_MS: 24 * 60 * 60 * 1000,
  persistRawPayload: vi.fn(),
  retentionDate: vi.fn(() => new Date("2026-09-10T00:00:00.000Z")),
}));

const fanHydrationMocks = vi.hoisted(() => ({
  prepareHydratedFans: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/services/sync/shared.ts", () => sharedMocks);
vi.mock("../apps/runtime/src/services/sync/fan-hydration.ts", () => fanHydrationMocks);

import { syncTransactions } from "../apps/runtime/src/services/sync/transactions.ts";

function createTelemetry() {
  return {
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    setBoundarySummary: vi.fn(),
    setScanSummary: vi.fn(),
  };
}

describe("syncTransactions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00.000Z"));

    for (const mock of Object.values(dbMocks)) {
      mock.mockReset();
    }
    sharedMocks.persistRawPayload.mockReset();
    sharedMocks.retentionDate.mockReset();
    fanHydrationMocks.prepareHydratedFans.mockReset();

    sharedMocks.persistRawPayload.mockResolvedValue(undefined);
    sharedMocks.retentionDate.mockReturnValue(new Date("2026-09-10T00:00:00.000Z"));
    fanHydrationMocks.prepareHydratedFans.mockResolvedValue([]);
    dbMocks.getOldestPendingTransactionAt.mockResolvedValue(null);
    dbMocks.rebuildSpenderProjections.mockResolvedValue(undefined);
    dbMocks.rebuildRevenueRollups.mockResolvedValue(undefined);
    dbMocks.upsertFanPages.mockResolvedValue(undefined);
    dbMocks.upsertFans.mockResolvedValue([]);
    dbMocks.upsertTransaction.mockResolvedValue(undefined);
    dbMocks.upsertCheckpoint.mockResolvedValue({
      cursorTimestamp: new Date("2026-03-10T00:00:00.000Z"),
      state: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebuilds incremental Fansly rollups from the oldest changed transaction", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
      state: {},
    });

    const app = {
      db: {
        transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      },
      config: {
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      adapter: {
        getTransactionsPage: vi.fn(async () => ({
          items: [{
            transactionId: "tx-1",
            walletId: null,
            accountId: null,
            correlationId: null,
            correlationAccountId: null,
            type: 20001,
            status: 2,
            destination: null,
            amount: 10,
            destinationAmount: 10,
            destinationTax: null,
            newBalance64: null,
            senderId: null,
            receiverId: null,
            createdAt: new Date("2026-03-10T00:00:00.000Z").getTime(),
            updatedAt: null,
          }],
          total: 1,
          done: true,
          raw: {},
        })),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await syncTransactions(app, {
      pageLabel: "fansly-page",
      platformAccountId: 1,
      commissionRate: 0,
      requestContext: {
        session: { authorization: "token" },
        proxy: null,
        requestObserver: null,
      } as never,
      syncRunId: 123,
      telemetry: createTelemetry() as never,
    });

    expect(dbMocks.rebuildSpenderProjections).toHaveBeenCalledWith(
      expect.anything(),
      1,
      new Date("2026-03-10T00:00:00.000Z"),
    );
    expect(dbMocks.rebuildRevenueRollups).toHaveBeenCalledWith(
      expect.anything(),
      1,
      new Date("2026-03-10T00:00:00.000Z"),
    );
  });
});
