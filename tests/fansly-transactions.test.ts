import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as FanHydrationModule from "../apps/runtime/src/services/sync/fan-hydration.ts";

import { PageSyncLeaseLostError } from "@agency_hub_core/db";

const dbMocks = vi.hoisted(() => ({
  countTransactionsBySource: vi.fn(),
  getConfigOverrides: vi.fn(),
  getCheckpoint: vi.fn(),
  getOldestPendingTransactionAt: vi.fn(),
  getPageTransactionsWriterInfo: vi.fn(),
  recordRunningPageSyncProgress: vi.fn(),
  rebuildSpenderProjections: vi.fn(),
  rebuildRevenueRollups: vi.fn(),
  upsertCheckpoint: vi.fn(),
  upsertCheckpointProgress: vi.fn(),
  upsertFanPages: vi.fn(),
  upsertFans: vi.fn(),
  upsertTransaction: vi.fn(),
  upsertFanslyTransactionWithEarningsDirty: vi.fn(),
}));

const sharedMocks = vi.hoisted(() => ({
  DAY_MS: 24 * 60 * 60 * 1000,
  persistRawPayload: vi.fn(),
  retentionDate: vi.fn(() => new Date("2026-09-10T00:00:00.000Z")),
}));

const fanHydrationMocks = vi.hoisted(() => ({
  lookupHydratedFans: vi.fn(),
  upsertHydratedFansForPage: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});
vi.mock("../apps/runtime/src/services/sync/shared.ts", () => sharedMocks);
vi.mock("../apps/runtime/src/services/sync/fan-hydration.ts", async () => {
  const actual = await vi.importActual<typeof FanHydrationModule>(
    "../apps/runtime/src/services/sync/fan-hydration.ts",
  );
  return {
    ...actual,
    lookupHydratedFans: fanHydrationMocks.lookupHydratedFans,
    upsertHydratedFansForPage: fanHydrationMocks.upsertHydratedFansForPage,
  };
});

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
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
    fanHydrationMocks.lookupHydratedFans.mockReset();
    fanHydrationMocks.upsertHydratedFansForPage.mockReset();

    sharedMocks.persistRawPayload.mockResolvedValue(undefined);
    sharedMocks.retentionDate.mockReturnValue(new Date("2026-09-10T00:00:00.000Z"));
    fanHydrationMocks.lookupHydratedFans.mockResolvedValue({
      accounts: [],
      fallbackIds: [],
    });
    fanHydrationMocks.upsertHydratedFansForPage.mockResolvedValue(new Map());
    dbMocks.getOldestPendingTransactionAt.mockResolvedValue(null);
    dbMocks.getConfigOverrides.mockResolvedValue(new Map());
    // Stage 13 single-writer gate: the page under test is Fansly-written.
    dbMocks.getPageTransactionsWriterInfo.mockResolvedValue({
      transactionsWriter: "fansly",
      label: "fansly-page",
      platform: "fansly",
    });
    dbMocks.recordRunningPageSyncProgress.mockResolvedValue(true);
    dbMocks.rebuildSpenderProjections.mockResolvedValue(undefined);
    dbMocks.rebuildRevenueRollups.mockResolvedValue(undefined);
    dbMocks.upsertFanPages.mockResolvedValue(undefined);
    dbMocks.upsertFans.mockResolvedValue([]);
    dbMocks.upsertTransaction.mockResolvedValue(undefined);
    // Default ledger: exactly the rows this test upserted.
    dbMocks.countTransactionsBySource.mockImplementation(async () => new Set([
      ...dbMocks.upsertTransaction.mock.calls,
      ...dbMocks.upsertFanslyTransactionWithEarningsDirty.mock.calls,
    ].map((call) => call[1].transactionId)).size);
    dbMocks.upsertCheckpoint.mockResolvedValue({
      cursorTimestamp: new Date("2026-03-10T00:00:00.000Z"),
      state: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])("preserves incremental rollups with earnings shadow %s", async (shadow) => {
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
        fanslyFanEarningsShadowPageAllowlist: shadow ? "fansly-page" : "none",
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
            newBalance64: 0,
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

    const writer = shadow ? dbMocks.upsertFanslyTransactionWithEarningsDirty : dbMocks.upsertTransaction;
    const unusedWriter = shadow ? dbMocks.upsertTransaction : dbMocks.upsertFanslyTransactionWithEarningsDirty;
    expect(unusedWriter).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rawType: 20001,
        canonicalType: "tip",
        newBalanceMills: 0n,
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

  it("keeps the incremental time boundary local so an Ari-shaped page retains exact totals", async () => {
    const checkpoint = {
      cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
      state: {},
    };
    dbMocks.getCheckpoint.mockResolvedValue(checkpoint);
    const items = [
      buildTransaction("tx-1", "2026-03-14T12:00:00.000Z"),
      buildTransaction("tx-2", "2026-03-13T12:00:00.000Z"),
      buildTransaction("tx-3", "2026-03-12T12:00:00.000Z"),
      buildTransaction("tx-4", "2026-03-11T12:00:00.000Z"),
    ];
    const getTransactionsPage = vi.fn(async (_context: unknown, params: object) => ({
      items,
      // Production evidence: the same four rows carried total=0 only when a
      // non-empty `after` was sent. This test fails if that bound leaks back.
      total: Object.prototype.hasOwnProperty.call(params, "after") ? 0 : items.length,
      done: true,
      raw: { data: items, total: items.length },
    }));
    const telemetry = createTelemetry();
    const app = {
      db: {
        transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      },
      config: {
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      adapter: { getTransactionsPage },
      logger: { info: vi.fn(), warn: vi.fn() },
    } as never;

    const result = await syncTransactions(app, {
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

    expect(result).toMatchObject({ satisfied: true, processedTransactions: 4 });
    expect(getTransactionsPage).toHaveBeenCalledTimes(1);
    expect(getTransactionsPage.mock.calls[0]?.[1]).not.toHaveProperty("after");
    expect(getTransactionsPage.mock.calls[0]?.[1]).not.toHaveProperty("before");
    expect(sharedMocks.persistRawPayload.mock.calls[0]?.[1].requestParams).toEqual({
      after: null,
      localLowerBound: "2026-03-07T00:00:00.000Z",
      offset: 0,
      limit: 100,
    });
    expect(dbMocks.upsertTransaction).toHaveBeenCalledTimes(4);
    expect(telemetry.addAnomaly).not.toHaveBeenCalledWith(expect.objectContaining({
      code: "incremental_total_mismatch",
    }));
  });

  async function runQuietEarlyStoppedScan(ledgerRows: number) {
    const checkpoint = {
      cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
      state: {},
    };
    dbMocks.getCheckpoint.mockResolvedValue(checkpoint);
    dbMocks.countTransactionsBySource.mockResolvedValue(ledgerRows);

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

    const result = await syncTransactions(app, {
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

    return { checkpoint, telemetry, getTransactionsPage, logger, result };
  }

  it("early-stops a quiet hour against the local lower bound without warnings", async () => {
    const { checkpoint, telemetry, getTransactionsPage, logger } = await runQuietEarlyStoppedScan(3);

    expect(getTransactionsPage).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        after: "2026-03-07T00:00:00.000Z",
        pageCount: 2,
        olderThanBoundaryItems: 2,
        olderThanBoundaryPages: 2,
      }),
      "Early-stopping transaction scan beyond the local lower bound",
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(telemetry.setBoundarySummary).toHaveBeenCalledWith(expect.objectContaining({
      olderThanBoundaryItems: 2,
      olderThanBoundaryPages: 2,
      earlyStoppedBeyondBoundary: true,
      boundarySentToProvider: false,
    }));
    expect(telemetry.setScanSummary).toHaveBeenCalledWith(expect.objectContaining({
      transactionPages: 2,
      processedTransactions: 2,
      earlyStoppedBeyondBoundary: true,
    }));
    // A partial head scan never matches the lifetime total, and a quiet page
    // is normal: neither may degrade run health.
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(telemetry.addNote).toHaveBeenCalledWith(
      "Local transaction rescan completed without a newer checkpoint row",
      expect.objectContaining({
        code: "checkpoint_stalled",
        checkpointTimestamp: checkpoint.cursorTimestamp.toISOString(),
        newestSeenAt: checkpoint.cursorTimestamp.toISOString(),
        processed: 2,
        earlyStoppedBeyondBoundary: true,
      }),
    );
    expect(dbMocks.countTransactionsBySource).toHaveBeenCalledWith(expect.anything(), {
      platformAccountId: 1,
      source: "fansly:rest",
    });
  });

  it("reports a ledger hole as an error without withholding the checkpoint", async () => {
    const { checkpoint, telemetry, result } = await runQuietEarlyStoppedScan(2);

    expect(result).toMatchObject({ satisfied: true });
    expect(telemetry.addAnomaly).toHaveBeenCalledTimes(1);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "transactions_ledger_incomplete",
      severity: "error",
      details: {
        providerReportedTotal: 3,
        ledgerRows: 2,
        fetchedRows: 2,
        earlyStoppedBeyondBoundary: true,
      },
    }));
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cursorTimestamp: checkpoint.cursorTimestamp,
        lastSuccessfulRunId: 123,
      }),
    );
  });

  it("notes a ledger surplus without degrading the run", async () => {
    const { telemetry, result } = await runQuietEarlyStoppedScan(5);

    expect(result).toMatchObject({ satisfied: true });
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(telemetry.addNote).toHaveBeenCalledWith(
      "Local Fansly transaction ledger holds more rows than the provider-reported total",
      {
        code: "transactions_ledger_surplus",
        providerReportedTotal: 3,
        ledgerRows: 5,
        fetchedRows: 2,
        earlyStoppedBeyondBoundary: true,
      },
    );
  });

  function buildPagedListing(rows: ReturnType<typeof buildTransaction>[]) {
    return vi.fn(async (_context: unknown, params: { offset: number; limit: number }) => {
      const items = rows.slice(params.offset, params.offset + params.limit);
      return { items, total: rows.length, done: items.length < params.limit, raw: {} };
    });
  }

  function isoAt(time: number) {
    return new Date(time).toISOString();
  }

  it("never lets the rescan cap lift the local lower bound above a stale cursor", async () => {
    const now = new Date("2026-03-15T00:00:00.000Z").getTime();
    const cursorTimestamp = new Date(now - 40 * sharedMocks.DAY_MS);
    dbMocks.getCheckpoint.mockResolvedValue({ cursorTimestamp, state: {} });
    // After a 40-day outage: one fresh row, 400 unseen rows between the cursor
    // and the 30-day cap start, then history the ledger already holds.
    const rows = [buildTransaction("tx-new", isoAt(now - sharedMocks.DAY_MS))];
    for (let i = 0; i < 400; i += 1) {
      rows.push(buildTransaction(`tx-gap-${i}`, isoAt(now - 31 * sharedMocks.DAY_MS - i * 1000)));
    }
    for (let i = 0; i < 300; i += 1) {
      rows.push(buildTransaction(`tx-old-${i}`, isoAt(cursorTimestamp.getTime() - i * 1000)));
    }
    dbMocks.countTransactionsBySource.mockResolvedValue(rows.length);
    const getTransactionsPage = buildPagedListing(rows);
    const telemetry = createTelemetry();
    const app = {
      db: {
        transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      },
      config: {
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      adapter: { getTransactionsPage },
      logger: { info: vi.fn(), warn: vi.fn() },
    } as never;

    const result = await syncTransactions(app, {
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

    const written = new Set(dbMocks.upsertTransaction.mock.calls.map((call) => call[1].transactionId));
    expect(rows.filter((row) => row.transactionId.startsWith("tx-gap-") && !written.has(row.transactionId)))
      .toEqual([]);
    expect(result).toMatchObject({ satisfied: true });
    // Five pages reach the cursor, then two all-older pages stop the scan.
    expect(getTransactionsPage).toHaveBeenCalledTimes(7);
    expect(sharedMocks.persistRawPayload.mock.calls[0]?.[1].requestParams).toMatchObject({
      after: null,
      localLowerBound: new Date(cursorTimestamp.getTime() + 1).toISOString(),
    });
    expect(telemetry.addNote).toHaveBeenCalledWith(
      "Transaction lower bound floored at the checkpoint cursor",
      {
        cursorTimestamp: cursorTimestamp.toISOString(),
        rescanCapStart: isoAt(now - 30 * sharedMocks.DAY_MS),
      },
    );
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cursorTimestamp: new Date(now - sharedMocks.DAY_MS) }),
    );
  });

  it("still stops a dormant page with a stale cursor after two pages", async () => {
    const now = new Date("2026-03-15T00:00:00.000Z").getTime();
    const cursorTimestamp = new Date(now - 40 * sharedMocks.DAY_MS);
    dbMocks.getCheckpoint.mockResolvedValue({ cursorTimestamp, state: {} });
    // The newest listed row IS the cursor row: nothing new since the outage.
    const rows = Array.from({ length: 300 }, (_, i) => (
      buildTransaction(`tx-old-${i}`, isoAt(cursorTimestamp.getTime() - i * 1000))
    ));
    dbMocks.countTransactionsBySource.mockResolvedValue(rows.length);
    const getTransactionsPage = buildPagedListing(rows);
    const telemetry = createTelemetry();
    const app = {
      db: {
        transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      },
      config: {
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      adapter: { getTransactionsPage },
      logger: { info: vi.fn(), warn: vi.fn() },
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
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cursorTimestamp }),
    );
  });

  it("refuses to finalize an incremental Fansly scan when the provider total changes mid-scan", async () => {
    const checkpoint = {
      cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
      state: {},
    };
    dbMocks.getCheckpoint.mockResolvedValue(checkpoint);
    const telemetry = createTelemetry();
    const getTransactionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-1", "2026-03-15T00:00:00.000Z")],
        total: 2,
        done: false,
        raw: { page: 1 },
      })
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-2", "2026-03-14T12:00:00.000Z")],
        total: 3,
        done: true,
        raw: { page: 2 },
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
        getTransactionsPage,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toThrow("Fansly incremental transaction total changed during an offset scan");

    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "incremental_total_changed",
      severity: "error",
    }));
    expect(sharedMocks.persistRawPayload.mock.calls.map((call) => call[1].responsePayload)).toEqual([
      { page: 1 },
      { page: 2 },
    ]);
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.upsertTransaction.mock.calls.map((call) => call[1].transactionId)).toEqual(["tx-1"]);
    const invalidatedProgress = dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1];
    expect(invalidatedProgress).toMatchObject({
      platformAccountId: 1,
      stream: "transactions",
      cursorTimestamp: checkpoint.cursorTimestamp,
      state: {
        pageLabel: "fansly-page",
        invalidatedIncrementalScan: {
          reason: "incremental_total_changed",
        },
      },
    });
    expect(invalidatedProgress?.state).not.toMatchObject({ mode: "incremental" });

    dbMocks.getCheckpoint.mockResolvedValueOnce({
      cursorTimestamp: invalidatedProgress?.cursorTimestamp,
      state: invalidatedProgress?.state,
    });
    getTransactionsPage.mockReset().mockResolvedValueOnce({
      items: [
        buildTransaction("tx-1", "2026-03-15T00:00:00.000Z"),
        buildTransaction("tx-2", "2026-03-14T12:00:00.000Z"),
      ],
      total: 2,
      done: true,
      raw: { page: "retry" },
    });

    await syncTransactions(app, {
      pageLabel: "fansly-page",
      platformAccountId: 1,
      commissionRate: 0,
      requestContext: {
        session: { authorization: "token" },
        proxy: null,
        requestObserver: null,
      } as never,
      syncRunId: 124,
      telemetry: createTelemetry() as never,
    });

    expect(getTransactionsPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ offset: 0 }),
    );
  });

  it("captures and refuses an incremental Fansly page with a missing total", async () => {
    const checkpoint = {
      cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
      state: {},
    };
    dbMocks.getCheckpoint.mockResolvedValue(checkpoint);
    const telemetry = createTelemetry();
    const raw = { data: [buildTransaction("tx-1", "2026-03-15T00:00:00.000Z")] };
    const app = {
      db: {
        transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      },
      config: {
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      adapter: {
        getTransactionsPage: vi.fn().mockResolvedValueOnce({
          items: [],
          total: null,
          done: false,
          contractAccepted: false,
          raw,
        }),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toThrow("Fansly incremental transaction page returned an invalid total");

    expect(sharedMocks.persistRawPayload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ responsePayload: raw }),
      expect.anything(),
    );
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "incremental_total_invalid",
      severity: "error",
    }));
    expect(dbMocks.upsertTransaction).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      platformAccountId: 1,
      stream: "transactions",
      cursorTimestamp: checkpoint.cursorTimestamp,
      state: {
        invalidatedIncrementalScan: {
          reason: "incremental_total_invalid",
        },
      },
    });
  });

  it("invalidates incremental Fansly progress when offset pages overlap", async () => {
    const checkpoint = {
      cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
      state: {},
    };
    dbMocks.getCheckpoint.mockResolvedValue(checkpoint);
    const telemetry = createTelemetry();
    const getTransactionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-1", "2026-03-15T00:00:00.000Z")],
        total: 2,
        done: false,
        raw: { page: 1 },
      })
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-1", "2026-03-15T00:00:00.000Z")],
        total: 2,
        done: true,
        raw: { page: 2 },
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
        getTransactionsPage,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toThrow("Fansly incremental transaction scan saw overlapping rows between offset pages");

    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "incremental_offset_overlap",
      severity: "error",
    }));
    expect(sharedMocks.persistRawPayload.mock.calls.map((call) => call[1].responsePayload)).toEqual([
      { page: 1 },
      { page: 2 },
    ]);
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      platformAccountId: 1,
      stream: "transactions",
      cursorTimestamp: checkpoint.cursorTimestamp,
      state: {
        pageLabel: "fansly-page",
        invalidatedIncrementalScan: {
          reason: "incremental_offset_overlap",
        },
      },
    });
  });

  it("preserves the cursor when invalidating resumed Fansly incremental progress", async () => {
    const cursorTimestamp = new Date("2026-03-14T00:00:00.000Z");
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorTimestamp: null,
      state: {
        mode: "incremental",
        completed: false,
        provider: "fansly",
        phase: "transactions",
        cursorTimestamp: cursorTimestamp.toISOString(),
        snapshotEnd: "2026-03-15T00:00:00.000Z",
        after: "2026-03-07T00:00:00.000Z",
        lookbackStart: "2026-03-07T00:00:00.000Z",
        oldestPendingAt: null,
        rescanCapStart: "2026-02-13T00:00:00.000Z",
        providerReportedTotal: 2,
        newestSeenAt: cursorTimestamp.toISOString(),
        oldestSeenAt: "2026-03-14T12:00:00.000Z",
        dirtyFrom: null,
        processedTransactions: 1,
        transactionPages: 1,
        offset: 1,
        olderThanBoundaryItems: 0,
        olderThanBoundaryPages: 0,
        consecutiveAllOlderPages: 0,
        firstPageOlderThanBoundaryItems: 0,
        earlyStoppedBeyondBoundary: false,
        lastPageTransactionIds: ["tx-1"],
      },
    });
    const getTransactionsPage = vi.fn().mockResolvedValueOnce({
      items: [buildTransaction("tx-2", "2026-03-14T12:00:00.000Z")],
      total: 3,
      done: true,
      raw: { page: "resume" },
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
        getTransactionsPage,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toThrow("Fansly incremental transaction total changed during an offset scan");

    expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      platformAccountId: 1,
      stream: "transactions",
      cursorTimestamp,
      state: {
        pageLabel: "fansly-page",
        invalidatedIncrementalScan: {
          reason: "incremental_total_changed",
        },
      },
    });
  });

  it("resumes legacy Fansly incremental progress without a stored cursor field", async () => {
    const fallbackCursorTimestamp = new Date("2026-03-14T00:00:00.000Z");
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorTimestamp: null,
      state: {
        mode: "incremental",
        completed: false,
        provider: "fansly",
        phase: "transactions",
        snapshotEnd: "2026-03-15T00:00:00.000Z",
        after: "2026-03-07T00:00:00.000Z",
        lookbackStart: "2026-03-07T00:00:00.000Z",
        oldestPendingAt: null,
        rescanCapStart: "2026-02-13T00:00:00.000Z",
        providerReportedTotal: 2,
        newestSeenAt: fallbackCursorTimestamp.toISOString(),
        oldestSeenAt: "2026-03-14T12:00:00.000Z",
        dirtyFrom: null,
        processedTransactions: 1,
        transactionPages: 1,
        offset: 1,
        olderThanBoundaryItems: 0,
        olderThanBoundaryPages: 0,
        consecutiveAllOlderPages: 0,
        firstPageOlderThanBoundaryItems: 0,
        earlyStoppedBeyondBoundary: false,
        lastPageTransactionIds: ["tx-1"],
      },
    });
    const getTransactionsPage = vi.fn().mockResolvedValueOnce({
      items: [buildTransaction("tx-2", "2026-03-14T12:00:00.000Z")],
      total: 2,
      done: true,
      raw: { page: "legacy-resume" },
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
        getTransactionsPage,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    const result = await syncTransactions(app, {
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

    expect(result).toMatchObject({
      satisfied: true,
      processedTransactions: 1,
    });
    expect(getTransactionsPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        offset: 1,
      }),
    );
    expect(getTransactionsPage.mock.calls[0]?.[1]).not.toHaveProperty("after");
    expect(getTransactionsPage.mock.calls[0]?.[1]).not.toHaveProperty("before");
    expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      platformAccountId: 1,
      stream: "transactions",
      cursorTimestamp: fallbackCursorTimestamp,
      state: expect.objectContaining({
        mode: "incremental",
        cursorTimestamp: fallbackCursorTimestamp.toISOString(),
        offset: 2,
      }),
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cursorTimestamp: new Date("2026-03-14T12:00:00.000Z"),
        lastSuccessfulRunId: 123,
      }),
    );
  });

  it("preserves total mismatch errors when Fansly incremental invalidation fails", async () => {
    const checkpoint = {
      cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
      state: {},
    };
    dbMocks.getCheckpoint.mockResolvedValue(checkpoint);
    dbMocks.upsertCheckpointProgress
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("checkpoint write failed"));
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
        getTransactionsPage: vi.fn().mockResolvedValueOnce({
          items: [buildTransaction("tx-1", "2026-03-15T00:00:00.000Z")],
          total: 2,
          done: true,
          raw: { page: 1 },
        }),
      },
      logger,
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toThrow("Fansly incremental transaction total differed from fetched rows");

    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "incremental_total_mismatch",
      severity: "error",
    }));
    expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      platformAccountId: 1,
      stream: "transactions",
      cursorTimestamp: checkpoint.cursorTimestamp,
      state: {
        pageLabel: "fansly-page",
        invalidatedIncrementalScan: {
          reason: "incremental_total_mismatch",
        },
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        originalErr: expect.any(Error),
        provider: "fansly",
        stream: "transactions",
      }),
      "Failed to invalidate unstable Fansly incremental checkpoint progress",
    );
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

  it("looks up incremental Fansly fan hydration before opening the DB transaction", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
      state: {},
    });

    const order: string[] = [];
    const tx = {};
    fanHydrationMocks.lookupHydratedFans.mockImplementation(async () => {
      order.push("lookup");
      return {
        accounts: [],
        fallbackIds: ["fan-1"],
      };
    });
    fanHydrationMocks.upsertHydratedFansForPage.mockImplementation(async (db) => {
      order.push(db === tx ? "upsert-in-transaction" : "upsert-outside-transaction");
      return new Map([["fan-1", 99]]);
    });
    dbMocks.upsertTransaction.mockImplementation(async () => {
      order.push("transaction-write");
    });

    const app = {
      db: {
        transaction: vi.fn(async (callback: (transactionDb: object) => Promise<unknown>) => {
          order.push("transaction-start");
          const result = await callback(tx);
          order.push("transaction-end");
          return result;
        }),
      },
      config: {
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      adapter: {
        getTransactionsPage: vi.fn(async () => ({
          items: [{
            ...buildTransaction("tx-1", "2026-03-10T00:00:00.000Z"),
            correlationAccountId: "fan-1",
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

    expect(order.slice(0, 5)).toEqual([
      "lookup",
      "transaction-start",
      "upsert-in-transaction",
      "transaction-write",
      "transaction-end",
    ]);
    expect(fanHydrationMocks.lookupHydratedFans).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformUserIds: ["fan-1"],
    }));
    expect(fanHydrationMocks.upsertHydratedFansForPage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        platformAccountId: 1,
        fallbackIds: ["fan-1"],
      }),
    );
  });

  it("yields and resumes multi-page incremental Fansly scans from durable page progress", async () => {
    const checkpoint = {
      cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
      state: {},
    };
    dbMocks.getCheckpoint.mockResolvedValue(checkpoint);

    const getTransactionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-1", "2026-03-14T12:00:00.000Z")],
        total: 2,
        done: false,
        raw: { page: 1 },
      })
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-2", "2026-03-13T00:00:00.000Z")],
        total: 2,
        done: true,
        raw: { page: 2 },
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
        getTransactionsPage,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;
    const firstTelemetry = createTelemetry();

    const firstResult = await syncTransactions(app, {
      pageLabel: "fansly-page",
      platformAccountId: 1,
      commissionRate: 0,
      requestContext: {
        session: { authorization: "token" },
        proxy: null,
        requestObserver: null,
      } as never,
      syncRunId: 123,
      telemetry: firstTelemetry as never,
      budget: new SyncChunkBudget(0),
    });

    expect(firstResult).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      processedTransactions: 1,
    });
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(getTransactionsPage).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        offset: 0,
      }),
    );
    expect(getTransactionsPage.mock.calls[0]?.[1]).not.toHaveProperty("after");
    expect(getTransactionsPage.mock.calls[0]?.[1]).not.toHaveProperty("before");
    expect(sharedMocks.persistRawPayload.mock.calls[0]?.[1].requestParams).toEqual({
      after: null,
      localLowerBound: "2026-03-07T00:00:00.000Z",
      offset: 0,
      limit: 100,
    });

    const yieldedProgress = dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1];
    expect(yieldedProgress).toMatchObject({
      cursorTimestamp: checkpoint.cursorTimestamp,
    });
    const yieldedState = yieldedProgress?.state;
    expect(yieldedState).toMatchObject({
      mode: "incremental",
      provider: "fansly",
      offset: 1,
      transactionPages: 1,
      processedTransactions: 1,
      dirtyFrom: null,
      snapshotEnd: "2026-03-15T00:00:00.000Z",
    });

    dbMocks.getCheckpoint.mockResolvedValue({
      cursorTimestamp: checkpoint.cursorTimestamp,
      state: yieldedState,
    });
    dbMocks.upsertCheckpoint.mockClear();
    const secondTelemetry = createTelemetry();

    const secondResult = await syncTransactions(app, {
      pageLabel: "fansly-page",
      platformAccountId: 1,
      commissionRate: 0,
      requestContext: {
        session: { authorization: "token" },
        proxy: null,
        requestObserver: null,
      } as never,
      syncRunId: 124,
      telemetry: secondTelemetry as never,
    });

    expect(secondResult).toMatchObject({
      satisfied: true,
      processedTransactions: 1,
    });
    expect(getTransactionsPage).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        offset: 1,
      }),
    );
    expect(getTransactionsPage.mock.calls[1]?.[1]).not.toHaveProperty("after");
    expect(getTransactionsPage.mock.calls[1]?.[1]).not.toHaveProperty("before");
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cursorTimestamp: new Date("2026-03-14T12:00:00.000Z"),
        lastSuccessfulRunId: 124,
      }),
    );
  });

  it("records runtime progress for each Fansly backfill page while the lease is active", async () => {
    dbMocks.getCheckpoint.mockResolvedValue(null);

    const telemetry = createTelemetry();
    const app = {
      db: {
        transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      },
      config: {
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      adapter: {
        getTransactionsPage: vi
          .fn()
          .mockResolvedValueOnce({
            items: [buildTransaction("tx-1", "2026-03-10T00:00:00.000Z")],
            total: 2,
            done: false,
            raw: {},
          })
          .mockResolvedValueOnce({
            items: [buildTransaction("tx-2", "2026-03-09T00:00:00.000Z")],
            total: 2,
            done: true,
            raw: {},
          }),
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
      telemetry: telemetry as never,
      activeLease: {
        requestSeq: 5,
        leaseToken: "lease-token",
      },
    });

    expect(dbMocks.recordRunningPageSyncProgress).toHaveBeenCalledTimes(2);
    expect(dbMocks.recordRunningPageSyncProgress).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        pageId: 1,
        stream: "transactions",
        requestSeq: 5,
        leaseToken: "lease-token",
        phase: "transactions",
        workClass: "history",
        progress: expect.objectContaining({
          processedTransactions: 1,
          processedTransactionsThisRun: 1,
          transactionPages: 1,
          offset: 1,
        }),
      }),
    );
    expect(dbMocks.recordRunningPageSyncProgress).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        progress: expect.objectContaining({
          processedTransactions: 2,
          processedTransactionsThisRun: 2,
          transactionPages: 2,
          offset: 2,
        }),
      }),
    );
  });

  it("yields and resumes Fansly backfills without sending the unsupported before filter", async () => {
    dbMocks.getCheckpoint.mockResolvedValue(null);

    const liveRows = [
      buildTransaction("tx-1", "2026-03-10T00:00:00.000Z"),
      buildTransaction("tx-2", "2026-03-09T00:00:00.000Z"),
    ];
    const getTransactionsPage = vi.fn(async (
      _requestContext: unknown,
      params: { offset?: number; limit?: number },
    ) => {
      const offset = params.offset ?? 0;
      const visibleRows = liveRows;
      const items = visibleRows[offset] ? [visibleRows[offset]] : [];
      return {
        items,
        total: visibleRows.length,
        done: offset + items.length >= visibleRows.length,
        raw: {
          offset,
        },
      };
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
        getTransactionsPage,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    const firstResult = await syncTransactions(app, {
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
      budget: new SyncChunkBudget(0),
    });

    expect(firstResult).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      processedTransactions: 1,
    });
    expect(getTransactionsPage).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        offset: 0,
      }),
    );
    expect(getTransactionsPage.mock.calls[0]?.[1]).not.toHaveProperty("before");
    expect(sharedMocks.persistRawPayload.mock.calls[0]?.[1].requestParams).toEqual({
      after: null,
      offset: 0,
      limit: 100,
    });

    const yieldedState = dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1].state;
    expect(yieldedState).toMatchObject({
      mode: "backfill",
      provider: "fansly",
      offset: 1,
      transactionPages: 1,
      processedTransactions: 1,
      dirtyFrom: null,
      snapshotEnd: "2026-03-15T00:00:00.000Z",
    });

    dbMocks.getCheckpoint.mockResolvedValue({
      cursorTimestamp: null,
      state: yieldedState,
    });

    const secondResult = await syncTransactions(app, {
      pageLabel: "fansly-page",
      platformAccountId: 1,
      commissionRate: 0,
      requestContext: {
        session: { authorization: "token" },
        proxy: null,
        requestObserver: null,
      } as never,
      syncRunId: 124,
      telemetry: createTelemetry() as never,
    });

    expect(secondResult).toMatchObject({
      satisfied: true,
      processedTransactions: 1,
    });
    expect(getTransactionsPage).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        offset: 1,
      }),
    );
    expect(getTransactionsPage.mock.calls[1]?.[1]).not.toHaveProperty("before");
    expect(dbMocks.upsertTransaction.mock.calls.map((call) => call[1].transactionId)).toEqual([
      "tx-1",
      "tx-2",
    ]);
  });

  it("refuses to finalize a Fansly backfill when the provider total changes mid-scan", async () => {
    dbMocks.getCheckpoint.mockResolvedValue(null);
    const telemetry = createTelemetry();
    const getTransactionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-1", "2026-03-10T00:00:00.000Z")],
        total: 2,
        done: false,
        raw: { page: 1 },
      })
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-2", "2026-03-09T00:00:00.000Z")],
        total: 3,
        done: false,
        raw: { page: 2 },
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
        getTransactionsPage,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toThrow("Fansly transaction backfill total changed during an offset scan");

    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "backfill_total_changed",
      severity: "error",
    }));
    expect(sharedMocks.persistRawPayload.mock.calls.map((call) => call[1].responsePayload)).toEqual([
      { page: 1 },
      { page: 2 },
    ]);
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.upsertTransaction.mock.calls.map((call) => call[1].transactionId)).toEqual(["tx-1"]);

    // The dirty-range flush rewrites the backfill state first; the
    // invalidation must land after it or the frozen snapshot comes back.
    const progressWrites = dbMocks.upsertCheckpointProgress.mock.calls.map((call) => call[1]);
    expect(dbMocks.rebuildSpenderProjections).toHaveBeenCalled();
    expect(progressWrites.at(-2)).toMatchObject({
      state: { mode: "backfill", offset: 1, providerReportedTotal: 2, dirtyFrom: null },
    });
    const invalidatedProgress = progressWrites.at(-1);
    expect(invalidatedProgress).toMatchObject({
      platformAccountId: 1,
      stream: "transactions",
      cursorTimestamp: null,
      state: {
        pageLabel: "fansly-page",
        invalidatedBackfillScan: {
          reason: "backfill_total_changed",
        },
      },
    });
    expect(invalidatedProgress?.state).not.toHaveProperty("mode");

    // The next run starts a fresh snapshot from offset 0 with the new total.
    dbMocks.getCheckpoint.mockResolvedValueOnce({
      cursorTimestamp: invalidatedProgress?.cursorTimestamp,
      state: invalidatedProgress?.state,
    });
    getTransactionsPage.mockReset().mockResolvedValueOnce({
      items: [
        buildTransaction("tx-new", "2026-03-11T00:00:00.000Z"),
        buildTransaction("tx-1", "2026-03-10T00:00:00.000Z"),
        buildTransaction("tx-2", "2026-03-09T00:00:00.000Z"),
      ],
      total: 3,
      done: true,
      raw: { page: "restart" },
    });

    await expect(syncTransactions(app, {
      pageLabel: "fansly-page",
      platformAccountId: 1,
      commissionRate: 0,
      requestContext: {
        session: { authorization: "token" },
        proxy: null,
        requestObserver: null,
      } as never,
      syncRunId: 124,
      telemetry: createTelemetry() as never,
    })).resolves.toMatchObject({ satisfied: true, processedTransactions: 3 });

    expect(getTransactionsPage).toHaveBeenCalledTimes(1);
    expect(getTransactionsPage).toHaveBeenCalledWith(expect.anything(), { limit: 100, offset: 0 });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cursorTimestamp: new Date("2026-03-11T00:00:00.000Z"),
        lastSuccessfulRunId: 124,
      }),
    );
  });

  it("invalidates a resumed Fansly backfill whose provider total grew between chunks", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorTimestamp: null,
      state: {
        mode: "backfill",
        completed: false,
        provider: "fansly",
        phase: "transactions",
        snapshotEnd: "2026-03-14T00:00:00.000Z",
        providerReportedTotal: 2,
        newestSeenAt: "2026-03-10T00:00:00.000Z",
        dirtyFrom: null,
        processedTransactions: 1,
        processedChargebacks: 0,
        transactionPages: 1,
        chargebackPages: 0,
        offset: 1,
        lastPageTransactionIds: ["tx-1"],
      },
    });
    const telemetry = createTelemetry();
    // A new sale shifted every offset by one: offset 1 now holds tx-1 again.
    const getTransactionsPage = vi.fn().mockResolvedValue({
      items: [buildTransaction("tx-1", "2026-03-10T00:00:00.000Z")],
      total: 3,
      done: false,
      raw: { page: "resume" },
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
        getTransactionsPage,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toThrow("Fansly transaction backfill total changed during an offset scan");

    expect(getTransactionsPage).toHaveBeenCalledWith(expect.anything(), { limit: 100, offset: 1 });
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      cursorTimestamp: null,
      state: {
        pageLabel: "fansly-page",
        invalidatedBackfillScan: {
          reason: "backfill_total_changed",
        },
      },
    });
  });

  it.each([
    [
      "an upstream failure",
      () => Promise.reject(new Error("upstream failed")),
      "upstream failed",
    ],
    [
      "an invalid total",
      () => Promise.resolve({ items: [], total: null, done: false, contractAccepted: false, raw: {} }),
      "Fansly transaction backfill page returned an invalid total",
    ],
  ])("keeps Fansly backfill progress resumable after %s", async (_label, secondPage, message) => {
    dbMocks.getCheckpoint.mockResolvedValue(null);
    const getTransactionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-1", "2026-03-10T00:00:00.000Z")],
        total: 2,
        done: false,
        raw: { page: 1 },
      })
      .mockImplementationOnce(secondPage);
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
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toThrow(message);

    expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      cursorTimestamp: null,
      state: {
        mode: "backfill",
        offset: 1,
        providerReportedTotal: 2,
      },
    });
    expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1].state)
      .not.toHaveProperty("invalidatedBackfillScan");
  });

  it("captures and refuses a Fansly backfill page with an unsafe total", async () => {
    dbMocks.getCheckpoint.mockResolvedValue(null);
    const telemetry = createTelemetry();
    const raw = {
      total: Number.MAX_SAFE_INTEGER + 1,
      data: [buildTransaction("tx-1", "2026-03-10T00:00:00.000Z")],
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
        getTransactionsPage: vi.fn().mockResolvedValueOnce({
          items: [],
          total: Number.MAX_SAFE_INTEGER + 1,
          done: false,
          contractAccepted: false,
          raw,
        }),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toThrow("Fansly transaction backfill page returned an invalid total");

    expect(sharedMocks.persistRawPayload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ responsePayload: raw }),
      expect.anything(),
    );
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "backfill_total_invalid",
      severity: "error",
    }));
    expect(dbMocks.upsertTransaction).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  });

  it("refuses to finalize a Fansly backfill when a short last page contradicts a stable total", async () => {
    dbMocks.getCheckpoint.mockResolvedValue(null);
    const telemetry = createTelemetry();
    const getTransactionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-1", "2026-03-10T00:00:00.000Z")],
        total: 3,
        done: false,
        raw: { page: 1 },
      })
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-2", "2026-03-09T00:00:00.000Z")],
        total: 3,
        done: true,
        raw: { page: 2 },
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
        getTransactionsPage,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toThrow("Fansly transaction backfill total differed from fetched rows");

    expect(getTransactionsPage).toHaveBeenCalledTimes(2);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "backfill_total_mismatch",
      severity: "error",
      details: {
        providerReportedTotal: 3,
        fetchedRows: 2,
        pageCount: 2,
      },
    }));
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.upsertTransaction.mock.calls.map((call) => call[1].transactionId)).toEqual([
      "tx-1",
      "tx-2",
    ]);
    // Not drift: a stable total with a short page stays resumable at the
    // processed offset instead of restarting full passes.
    expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      cursorTimestamp: null,
      state: {
        mode: "backfill",
        offset: 2,
        providerReportedTotal: 3,
      },
    });
  });

  it("refuses to finalize a Fansly backfill when adjacent offset pages overlap", async () => {
    dbMocks.getCheckpoint.mockResolvedValue(null);
    const telemetry = createTelemetry();
    const getTransactionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-1", "2026-03-10T00:00:00.000Z")],
        total: 2,
        done: false,
        raw: { page: 1 },
      })
      .mockResolvedValueOnce({
        items: [buildTransaction("tx-1", "2026-03-10T00:00:00.000Z")],
        total: 2,
        done: false,
        raw: { page: 2 },
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
        getTransactionsPage,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toThrow("Fansly transaction backfill saw overlapping rows between offset pages");

    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "backfill_offset_overlap",
      severity: "error",
    }));
    expect(sharedMocks.persistRawPayload.mock.calls.map((call) => call[1].responsePayload)).toEqual([
      { page: 1 },
      { page: 2 },
    ]);
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.upsertTransaction.mock.calls.map((call) => call[1].transactionId)).toEqual(["tx-1"]);
    const invalidatedProgress = dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1];
    expect(invalidatedProgress).toMatchObject({
      platformAccountId: 1,
      stream: "transactions",
      cursorTimestamp: null,
      state: {
        pageLabel: "fansly-page",
        invalidatedBackfillScan: {
          reason: "backfill_offset_overlap",
        },
      },
    });
    expect(invalidatedProgress?.state).not.toHaveProperty("mode");
  });

  it("looks up backfill Fansly fan hydration before opening each DB transaction", async () => {
    dbMocks.getCheckpoint.mockResolvedValue(null);

    const order: string[] = [];
    const tx = {};
    fanHydrationMocks.lookupHydratedFans.mockImplementation(async () => {
      order.push("lookup");
      return {
        accounts: [],
        fallbackIds: ["fan-1"],
      };
    });
    fanHydrationMocks.upsertHydratedFansForPage.mockImplementation(async (db) => {
      order.push(db === tx ? "upsert-in-transaction" : "upsert-outside-transaction");
      return new Map([["fan-1", 99]]);
    });
    dbMocks.upsertTransaction.mockImplementation(async () => {
      order.push("transaction-write");
    });

    const app = {
      db: {
        transaction: vi.fn(async (callback: (transactionDb: object) => Promise<unknown>) => {
          order.push("transaction-start");
          const result = await callback(tx);
          order.push("transaction-end");
          return result;
        }),
      },
      config: {
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      adapter: {
        getTransactionsPage: vi.fn(async () => ({
          items: [{
            ...buildTransaction("tx-1", "2026-03-10T00:00:00.000Z"),
            correlationAccountId: "fan-1",
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
      activeLease: {
        requestSeq: 5,
        leaseToken: "lease-token",
      },
    });

    expect(order.slice(0, 5)).toEqual([
      "lookup",
      "transaction-start",
      "upsert-in-transaction",
      "transaction-write",
      "transaction-end",
    ]);
    expect(fanHydrationMocks.lookupHydratedFans).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformUserIds: ["fan-1"],
    }));
    expect(fanHydrationMocks.upsertHydratedFansForPage).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        platformAccountId: 1,
        fallbackIds: ["fan-1"],
      }),
    );
  });

  it("rethrows lease loss without attempting dirty-range cleanup", async () => {
    dbMocks.getCheckpoint.mockResolvedValue(null);
    const leaseLost = new PageSyncLeaseLostError();
    const app = {
      db: {
        transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      },
      config: {
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      adapter: {
        getTransactionsPage: vi
          .fn()
          .mockResolvedValueOnce({
            items: [buildTransaction("tx-1", "2026-03-10T00:00:00.000Z")],
            total: 2,
            done: false,
            raw: {},
          })
          .mockRejectedValueOnce(leaseLost),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toBe(leaseLost);

    expect(dbMocks.rebuildSpenderProjections).not.toHaveBeenCalled();
    expect(dbMocks.rebuildRevenueRollups).not.toHaveBeenCalled();
  });

  it("preserves the primary backfill error when dirty-range cleanup fails", async () => {
    dbMocks.getCheckpoint.mockResolvedValue(null);
    const primaryError = new Error("upstream failed");
    const cleanupError = new Error("flush failed");
    dbMocks.rebuildSpenderProjections.mockRejectedValueOnce(cleanupError);

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
        getTransactionsPage: vi
          .fn()
          .mockResolvedValueOnce({
            items: [buildTransaction("tx-1", "2026-03-10T00:00:00.000Z")],
            total: 2,
            done: false,
            raw: {},
          })
          .mockRejectedValueOnce(primaryError),
      },
      logger,
    } as never;

    await expect(syncTransactions(app, {
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
    })).rejects.toBe(primaryError);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: cleanupError,
        originalErr: primaryError,
        pageLabel: "fansly-page",
        platformAccountId: 1,
      }),
      "Failed to flush Fansly dirty range after backfill error",
    );
  });
});
