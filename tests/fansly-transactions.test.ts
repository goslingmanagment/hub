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
  hydrateFans: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/services/sync/shared.ts", () => sharedMocks);
vi.mock("../apps/runtime/src/services/sync/fan-hydration.ts", async () => {
  const actual = await vi.importActual<typeof import("../apps/runtime/src/services/sync/fan-hydration.ts")>(
    "../apps/runtime/src/services/sync/fan-hydration.ts",
  );
  return {
    ...actual,
    hydrateFans: fanHydrationMocks.hydrateFans,
  };
});

import { syncTransactions } from "../apps/runtime/src/services/sync/transactions.ts";

function createTelemetry() {
  return {
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    setBoundarySummary: vi.fn(),
    setScanSummary: vi.fn(),
  };
}

function buildTransaction(transactionId: string, createdAt: string) {
  return {
    transactionId,
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
    createdAt: new Date(createdAt).getTime(),
    updatedAt: null,
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
    fanHydrationMocks.hydrateFans.mockReset();

    sharedMocks.persistRawPayload.mockResolvedValue(undefined);
    sharedMocks.retentionDate.mockReturnValue(new Date("2026-09-10T00:00:00.000Z"));
    fanHydrationMocks.hydrateFans.mockResolvedValue(new Map());
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

    expect(dbMocks.upsertTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rawType: 20001,
        canonicalType: "tip",
      }),
    );
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

  it("early-stops when the upstream after filter is ignored and downgrades a stalled checkpoint", async () => {
    const checkpoint = {
      cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
      state: {},
    };
    dbMocks.getCheckpoint.mockResolvedValue(checkpoint);

    const telemetry = createTelemetry();
    const getTransactionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-1", "2026-03-01T00:00:00.000Z")],
        total: 3,
        done: false,
        raw: {},
      })
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-2", "2026-02-28T00:00:00.000Z")],
        total: 3,
        done: false,
        raw: {},
      })
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-3", "2026-02-27T00:00:00.000Z")],
        total: 3,
        done: false,
        raw: {},
      });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const app = {
      db: {
        transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      },
      config: {
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      adapter: {
        getTransactionsPage,
      },
      logger,
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
      telemetry: telemetry as never,
    });

    expect(getTransactionsPage).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        after: "2026-03-07T00:00:00.000Z",
        pageCount: 2,
        olderThanBoundaryItems: 2,
        olderThanBoundaryPages: 2,
      }),
      "Early-stopping transaction scan: upstream API is not honoring the after filter",
    );
    expect(telemetry.setBoundarySummary).toHaveBeenCalledWith(expect.objectContaining({
      olderThanBoundaryItems: 2,
      olderThanBoundaryPages: 2,
      earlyStoppedBeyondBoundary: true,
    }));
    expect(telemetry.setScanSummary).toHaveBeenCalledWith(expect.objectContaining({
      transactionPages: 2,
      processedTransactions: 2,
      earlyStoppedBeyondBoundary: true,
    }));
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "checkpoint_stalled",
      severity: "warn",
      details: expect.objectContaining({
        checkpointTimestamp: checkpoint.cursorTimestamp.toISOString(),
        newestSeenAt: checkpoint.cursorTimestamp.toISOString(),
        processed: 2,
        earlyStoppedBeyondBoundary: true,
      }),
    }));
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "after_ineffective",
      severity: "warn",
      details: expect.objectContaining({
        earlyStoppedBeyondBoundary: true,
        olderThanBoundaryPages: 2,
      }),
    }));
  });

  it("warns once per run for an unknown transaction type", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorTimestamp: new Date("2026-03-08T00:00:00.000Z"),
      state: {},
    });

    const telemetry = createTelemetry();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
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
          items: [
            {
              ...buildTransaction("tx-unknown-1", "2026-03-10T00:00:00.000Z"),
              type: 999999,
            },
            {
              ...buildTransaction("tx-unknown-2", "2026-03-09T00:00:00.000Z"),
              type: 999999,
            },
          ],
          total: 2,
          done: true,
          raw: {},
        })),
      },
      logger,
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
      telemetry: telemetry as never,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        pageLabel: "fansly-page",
        platformAccountId: 1,
        rawType: 999999,
      }),
      "Unmapped Fansly transaction type fell back to other",
    );
    expect(telemetry.addAnomaly).toHaveBeenCalledTimes(1);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "unknown_transaction_type",
      severity: "warn",
      details: expect.objectContaining({
        provider: "fansly",
        rawType: 999999,
      }),
    }));
  });
});
