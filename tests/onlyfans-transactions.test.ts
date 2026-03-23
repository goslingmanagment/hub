import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  deleteTransactionsMissingFromWindow: vi.fn(),
  getCheckpoint: vi.fn(),
  getOldestPendingTransactionAt: vi.fn(),
  mergePageMetadata: vi.fn(),
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

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/services/sync/shared.ts", () => sharedMocks);

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { syncOnlyFansTransactions } from "../apps/runtime/src/services/sync/onlyfans-transactions.ts";

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

async function observeRequest(
  context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
  operation: string,
  pageIndex: number,
) {
  await context.requestObserver?.onRequestEvent({
    requestId: `${operation}:${pageIndex}`,
    operation,
    endpointTemplate: operation,
    method: "GET",
    attemptNumber: 1,
    timestamp: new Date("2026-03-15T00:00:00.000Z"),
    pagination: {
      pageIndex,
      cursorPresent: false,
    },
    requestMetadata: {},
    state: "started",
  });
}

function makeTransaction(id: string, timestamp: string, fanId = "fan-1") {
  return {
    id,
    amount: 10,
    fan: { id: fanId },
    type: "Tip from",
    status: "done",
    timestamp,
  };
}

function makeChargeback(id: string, chargebackTimestamp: string, fanId = "fan-1") {
  return {
    id,
    amount: 10,
    fan: { id: fanId },
    type: "Tip from",
    status: "done",
    chargeback_timestamp: chargebackTimestamp,
    transaction_timestamp: chargebackTimestamp,
  };
}

function makeCursorPage<TItem>(items: TItem[], cursor?: string) {
  return {
    parsed: cursor ? { items, cursor } : { items },
    raw: {
      items,
      cursor,
    },
  };
}

function createAdapter(input: {
  transactionPages: Array<ReturnType<typeof makeCursorPage>>;
  chargebackPages: Array<ReturnType<typeof makeCursorPage>>;
}) {
  const transactionPages = [...input.transactionPages];
  const chargebackPages = [...input.chargebackPages];

  return {
    getTransactionsPage: vi.fn(async (
      context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
      _platformAccountIdValue: string,
      params: {
        start?: Date;
        end?: Date;
        cursor?: string | null;
        limit?: number;
        pageIndex?: number | null;
      },
    ) => {
      await observeRequest(context, "onlymonster_transactions", params.pageIndex ?? 0);
      const page = transactionPages.shift();
      if (!page) {
        throw new Error("Unexpected OnlyFans transactions page request");
      }
      return page;
    }),
    getChargebacksPage: vi.fn(async (
      context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
      _platformAccountIdValue: string,
      params: {
        start?: Date;
        end?: Date;
        cursor?: string | null;
        limit?: number;
        pageIndex?: number | null;
      },
    ) => {
      await observeRequest(context, "onlymonster_chargebacks", params.pageIndex ?? 0);
      const page = chargebackPages.shift();
      if (!page) {
        throw new Error("Unexpected OnlyFans chargebacks page request");
      }
      return page;
    }),
  };
}

function createApp(adapter: ReturnType<typeof createAdapter>) {
  return {
    db: {
      transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
    },
    config: {
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
    },
    onlyFansAdapter: adapter,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

async function runOnlyFansTransactionsSync(input?: {
  adapter?: ReturnType<typeof createAdapter>;
  budget?: SyncChunkBudget;
  telemetry?: ReturnType<typeof createTelemetry>;
  checkpoint?: {
    cursorTimestamp?: Date | null;
    state?: Record<string, unknown>;
  } | null;
  pageMetadata?: Record<string, unknown>;
  rescanStart?: Date | null;
}) {
  const adapter = input?.adapter ?? createAdapter({
    transactionPages: [makeCursorPage([])],
    chargebackPages: [makeCursorPage([])],
  });
  const telemetry = input?.telemetry ?? createTelemetry();
  const budget = input?.budget ?? new SyncChunkBudget(10, 60_000);

  dbMocks.getCheckpoint.mockResolvedValueOnce(input?.checkpoint ?? null);

  return syncOnlyFansTransactions(createApp(adapter) as never, {
    pageLabel: "onlyfans-page",
    platformAccountId: 1,
    platformAccountIdValue: "of-1",
    pageMetadata: input?.pageMetadata ?? {},
    commissionRate: 0.2,
    rescanStart: input?.rescanStart ?? null,
    requestContext: {
      auth: { token: "secret" },
      proxy: null,
      requestObserver: budget,
    } as never,
    syncRunId: 123,
    telemetry: telemetry as never,
    budget,
  });
}

describe("syncOnlyFansTransactions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00.000Z"));

    for (const mock of Object.values(dbMocks)) {
      mock.mockReset();
    }
    sharedMocks.persistRawPayload.mockReset();
    sharedMocks.retentionDate.mockReset();

    sharedMocks.persistRawPayload.mockResolvedValue(undefined);
    sharedMocks.retentionDate.mockReturnValue(new Date("2026-09-10T00:00:00.000Z"));

    dbMocks.deleteTransactionsMissingFromWindow.mockResolvedValue(undefined);
    dbMocks.getOldestPendingTransactionAt.mockResolvedValue(null);
    dbMocks.mergePageMetadata.mockResolvedValue(null);
    dbMocks.rebuildSpenderProjections.mockResolvedValue(undefined);
    dbMocks.rebuildRevenueRollups.mockResolvedValue(undefined);
    dbMocks.upsertFanPages.mockResolvedValue(undefined);
    dbMocks.upsertTransaction.mockResolvedValue(undefined);
    dbMocks.upsertFans.mockImplementation(async (_db: unknown, inputs: Array<{ platformUserId: string }>) =>
      inputs.map((input: { platformUserId: string }, index: number) => ({
        id: index + 1,
        platformUserId: input.platformUserId,
      })));
    dbMocks.upsertCheckpointProgress.mockImplementation(async (
      _db: unknown,
      input: {
        cursorText?: string | null;
        cursorTimestamp?: Date | null;
        state?: Record<string, unknown>;
      },
    ) => ({
      cursorText: input.cursorText ?? null,
      cursorTimestamp: input.cursorTimestamp ?? null,
      state: input.state ?? {},
    }));
    dbMocks.upsertCheckpoint.mockImplementation(async (
      _db: unknown,
      input: {
        cursorText?: string | null;
        cursorTimestamp?: Date | null;
        lastSuccessfulRunId?: number | null;
        state?: Record<string, unknown>;
      },
    ) => ({
      cursorText: input.cursorText ?? null,
      cursorTimestamp: input.cursorTimestamp ?? null,
      lastSuccessfulRunId: input.lastSuccessfulRunId ?? null,
      state: input.state ?? {},
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps persisted transaction progress cursorless while continuing live cursors in-memory", async () => {
    const adapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-1", "2026-03-10T00:00:00.000Z")], "cursor-1"),
        makeCursorPage([makeTransaction("tx-2", "2026-03-09T00:00:00.000Z")], "cursor-2"),
        makeCursorPage([makeTransaction("tx-3", "2026-03-08T00:00:00.000Z")], "cursor-3"),
        makeCursorPage([makeTransaction("tx-4", "2026-03-07T00:00:00.000Z")], "cursor-4"),
        makeCursorPage([makeTransaction("tx-5", "2026-03-06T00:00:00.000Z")]),
      ],
      chargebackPages: [makeCursorPage([])],
    });

    const result = await runOnlyFansTransactionsSync({
      adapter,
      budget: new SyncChunkBudget(10, 60_000),
      pageMetadata: {
        transactionBackfillLowerBound: "2026-03-01T00:00:00.000Z",
      },
    });

    const progressStates = dbMocks.upsertCheckpointProgress.mock.calls
      .slice(0, 5)
      .map((call) => call[1].state);
    expect(progressStates.every((state) => state.cursor === null)).toBe(true);
    expect(progressStates[0]?.windowEnd).toBe("2026-03-10T00:00:00.000Z");
    expect(progressStates[1]?.windowEnd).toBe("2026-03-09T00:00:00.000Z");
    expect(progressStates[2]?.windowEnd).toBe("2026-03-08T00:00:00.000Z");
    expect(progressStates[3]?.windowEnd).toBe("2026-03-07T00:00:00.000Z");
    expect(progressStates[3]?.windowPageCount).toBe(0);

    expect(adapter.getTransactionsPage.mock.calls[1]![2].cursor).toBe("cursor-1");
    expect(adapter.getTransactionsPage.mock.calls[2]![2].cursor).toBe("cursor-2");
    expect(adapter.getTransactionsPage.mock.calls[3]![2].cursor).toBe("cursor-3");

    const resumedRequest = adapter.getTransactionsPage.mock.calls[4]![2];
    expect(resumedRequest.cursor).toBeNull();
    expect(resumedRequest.end!.toISOString()).toBe("2026-03-07T00:00:00.000Z");

    expect(result.satisfied).toBe(true);
    expect(result.processedTransactions).toBe(5);
    expect(result.processedChargebacks).toBe(0);
  });

  it("yields after page five with a cursorless narrowed checkpoint and resumes fresh", async () => {
    const firstAdapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-1", "2026-03-10T00:00:00.000Z")], "cursor-1"),
        makeCursorPage([makeTransaction("tx-2", "2026-03-09T00:00:00.000Z")], "cursor-2"),
        makeCursorPage([makeTransaction("tx-3", "2026-03-08T00:00:00.000Z")], "cursor-3"),
        makeCursorPage([makeTransaction("tx-4", "2026-03-07T00:00:00.000Z")], "cursor-4"),
        makeCursorPage([makeTransaction("tx-5", "2026-03-06T00:00:00.000Z")], "cursor-5"),
      ],
      chargebackPages: [makeCursorPage([])],
    });

    const firstResult = await runOnlyFansTransactionsSync({
      adapter: firstAdapter,
      budget: new SyncChunkBudget(5, 60_000),
      pageMetadata: {
        transactionBackfillLowerBound: "2026-03-01T00:00:00.000Z",
      },
    });

    expect(firstResult.satisfied).toBe(false);
    expect(firstResult.yieldReason).toBe("request_budget");
    expect(dbMocks.rebuildSpenderProjections).toHaveBeenCalledWith(
      expect.anything(),
      1,
      new Date("2026-03-06T00:00:00.000Z"),
    );
    expect(dbMocks.rebuildRevenueRollups).toHaveBeenCalledWith(
      expect.anything(),
      1,
      new Date("2026-03-06T00:00:00.000Z"),
    );

    const yieldedState = dbMocks.upsertCheckpointProgress.mock.calls.at(-1)![1].state;
    expect(yieldedState.cursor).toBeNull();
    expect(yieldedState.dirtyFrom).toBeNull();
    expect(yieldedState.windowEnd).toBe("2026-03-06T00:00:00.000Z");
    expect(yieldedState.windowPageCount).toBe(0);
    expect(firstAdapter.getTransactionsPage.mock.calls[4]![2].cursor).toBeNull();
    expect(firstAdapter.getTransactionsPage.mock.calls[4]![2].end!.toISOString()).toBe("2026-03-07T00:00:00.000Z");

    const resumedAdapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-6", "2026-03-05T00:00:00.000Z")]),
      ],
      chargebackPages: [makeCursorPage([])],
    });

    const resumedResult = await runOnlyFansTransactionsSync({
      adapter: resumedAdapter,
      checkpoint: {
        state: yieldedState,
      },
      budget: new SyncChunkBudget(10, 60_000),
      pageMetadata: {
        transactionBackfillLowerBound: "2026-03-01T00:00:00.000Z",
      },
    });

    const resumedRequest = resumedAdapter.getTransactionsPage.mock.calls[0]![2];
    expect(resumedRequest.cursor).toBeNull();
    expect(resumedRequest.end!.toISOString()).toBe("2026-03-06T00:00:00.000Z");
    expect(resumedResult.satisfied).toBe(true);
  });

  it("persists the discovered lower bound when a resumed synthetic backfill finishes on empty windows", async () => {
    const firstAdapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-1", "2026-02-10T00:00:00.000Z")]),
      ],
      chargebackPages: [makeCursorPage([])],
    });

    const firstResult = await runOnlyFansTransactionsSync({
      adapter: firstAdapter,
      budget: new SyncChunkBudget(1, 60_000),
    });

    expect(firstResult.satisfied).toBe(false);
    expect(firstResult.yieldReason).toBe("request_budget");
    expect(dbMocks.mergePageMetadata).not.toHaveBeenCalled();

    const yieldedState = dbMocks.upsertCheckpointProgress.mock.calls.at(-1)![1].state;
    expect(yieldedState.oldestSeenAt).toBe("2026-02-10T00:00:00.000Z");

    const resumedAdapter = createAdapter({
      transactionPages: [
        makeCursorPage([]),
        makeCursorPage([]),
      ],
      chargebackPages: [
        makeCursorPage([]),
        makeCursorPage([]),
      ],
    });

    const resumedResult = await runOnlyFansTransactionsSync({
      adapter: resumedAdapter,
      checkpoint: {
        state: yieldedState,
      },
      budget: new SyncChunkBudget(10, 60_000),
    });

    expect(resumedResult.satisfied).toBe(true);
    expect(dbMocks.mergePageMetadata).toHaveBeenCalledWith(expect.anything(), 1, {
      transactionBackfillLowerBound: "2026-02-03T00:00:00.000Z",
    });
  });

  it("upgrades legacy transaction backfill state without oldestSeenAt by clearing the deep cursor", async () => {
    const adapter = createAdapter({
      transactionPages: [makeCursorPage([])],
      chargebackPages: [makeCursorPage([])],
    });

    const result = await runOnlyFansTransactionsSync({
      adapter,
      checkpoint: {
        state: {
          mode: "backfill",
          completed: false,
          provider: "onlyfans",
          phase: "transactions",
          snapshotEnd: "2026-03-15T00:00:00.000Z",
          newestSeenAt: "2026-03-12T00:00:00.000Z",
          dirtyFrom: "2026-03-10T00:00:00.000Z",
          processedTransactions: 300,
          processedChargebacks: 0,
          transactionPages: 13,
          chargebackPages: 0,
          start: "1970-01-01T00:00:00.000Z",
          fallbackStartUsed: false,
          cursor: "deep-cursor",
        },
      },
      budget: new SyncChunkBudget(10, 60_000),
    });

    const firstRequest = adapter.getTransactionsPage.mock.calls[0]![2];
    expect(firstRequest.cursor).toBeNull();
    expect(firstRequest.end!.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(result.satisfied).toBe(true);
  });

  it("preserves current transaction backfill cursors when modern window state is present", async () => {
    const adapter = createAdapter({
      transactionPages: [makeCursorPage([])],
      chargebackPages: [makeCursorPage([])],
    });

    await runOnlyFansTransactionsSync({
      adapter,
      checkpoint: {
        state: {
          mode: "backfill",
          completed: false,
          provider: "onlyfans",
          phase: "transactions",
          snapshotEnd: "2026-03-15T00:00:00.000Z",
          newestSeenAt: "2026-03-12T00:00:00.000Z",
          oldestSeenAt: "2026-03-09T00:00:00.000Z",
          dirtyFrom: "2026-03-09T00:00:00.000Z",
          processedTransactions: 250,
          processedChargebacks: 0,
          transactionPages: 5,
          chargebackPages: 0,
          start: "2026-03-01T00:00:00.000Z",
          fallbackStartUsed: false,
          cursor: "live-cursor",
          windowEnd: "2026-03-11T00:00:00.000Z",
          windowPageCount: 2,
          emptyWindowCount: 0,
        },
      },
      budget: new SyncChunkBudget(10, 60_000),
    });

    const firstRequest = adapter.getTransactionsPage.mock.calls[0]![2];
    expect(firstRequest.cursor).toBe("live-cursor");
    expect(firstRequest.end!.toISOString()).toBe("2026-03-11T00:00:00.000Z");
  });

  it("persists a cursorless transition into chargebacks and finalizes the checkpoint", async () => {
    const adapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-1", "2026-03-10T00:00:00.000Z")]),
      ],
      chargebackPages: [
        makeCursorPage([makeChargeback("cb-1", "2026-03-09T00:00:00.000Z")]),
      ],
    });

    const result = await runOnlyFansTransactionsSync({
      adapter,
      budget: new SyncChunkBudget(10, 60_000),
      pageMetadata: {
        transactionBackfillLowerBound: "2026-03-01T00:00:00.000Z",
      },
    });

    const transitionState = dbMocks.upsertCheckpointProgress.mock.calls[0]![1].state;
    expect(transitionState.phase).toBe("chargebacks");
    expect(transitionState.cursor).toBeNull();
    expect(transitionState.windowPageCount).toBe(0);
    expect(transitionState.windowEnd).toBe(transitionState.snapshotEnd);
    expect(adapter.getChargebacksPage.mock.calls[0]![2].cursor).toBeNull();
    expect(adapter.getChargebacksPage.mock.calls[0]![2].end!.toISOString()).toBe(transitionState.windowEnd);

    expect(adapter.getChargebacksPage).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 1,
      stream: "transactions",
      cursorTimestamp: new Date("2026-03-10T00:00:00.000Z"),
      lastSuccessfulRunId: 123,
      state: {
        pageLabel: "onlyfans-page",
        processedTransactions: 1,
        processedChargebacks: 1,
      },
    }));
    expect(result.satisfied).toBe(true);
    expect(result.processedTransactions).toBe(1);
    expect(result.processedChargebacks).toBe(1);
  });

  it("persists cursorless chargeback resume state when a chargeback chunk yields", async () => {
    const firstAdapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-1", "2026-03-10T00:00:00.000Z")]),
      ],
      chargebackPages: [
        makeCursorPage([makeChargeback("cb-1", "2026-03-09T00:00:00.000Z")], "cb-cursor-1"),
      ],
    });

    const firstResult = await runOnlyFansTransactionsSync({
      adapter: firstAdapter,
      budget: new SyncChunkBudget(2, 60_000),
      pageMetadata: {
        transactionBackfillLowerBound: "2026-03-01T00:00:00.000Z",
      },
    });

    expect(firstResult.satisfied).toBe(false);
    expect(firstResult.yieldReason).toBe("request_budget");

    const yieldedState = dbMocks.upsertCheckpointProgress.mock.calls.at(-1)![1].state;
    expect(yieldedState.phase).toBe("chargebacks");
    expect(yieldedState.cursor).toBeNull();
    expect(yieldedState.windowEnd).toBe("2026-03-09T00:00:00.000Z");
    expect(yieldedState.windowPageCount).toBe(0);
    expect(yieldedState.dirtyFrom).toBeNull();

    const resumedAdapter = createAdapter({
      transactionPages: [makeCursorPage([])],
      chargebackPages: [
        makeCursorPage([makeChargeback("cb-2", "2026-03-08T00:00:00.000Z")]),
      ],
    });

    const resumedResult = await runOnlyFansTransactionsSync({
      adapter: resumedAdapter,
      checkpoint: {
        state: yieldedState,
      },
      budget: new SyncChunkBudget(10, 60_000),
      pageMetadata: {
        transactionBackfillLowerBound: "2026-03-01T00:00:00.000Z",
      },
    });

    const resumedRequest = resumedAdapter.getChargebacksPage.mock.calls[0]![2];
    expect(resumedRequest.cursor).toBeNull();
    expect(resumedRequest.end!.toISOString()).toBe("2026-03-09T00:00:00.000Z");
    expect(resumedResult.satisfied).toBe(true);
  });

  it("stops synthetic transaction backfill after two empty historical windows and buffers the discovered lower bound", async () => {
    const adapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-1", "2026-02-10T00:00:00.000Z")]),
        makeCursorPage([]),
        makeCursorPage([]),
      ],
      chargebackPages: [
        makeCursorPage([]),
        makeCursorPage([]),
      ],
    });

    const result = await runOnlyFansTransactionsSync({
      adapter,
      budget: new SyncChunkBudget(10, 60_000),
    });

    expect(adapter.getTransactionsPage).toHaveBeenCalledTimes(3);
    expect(adapter.getChargebacksPage).toHaveBeenCalledTimes(2);
    expect(adapter.getTransactionsPage.mock.calls[0]![2].start!.toISOString()).toBe("2025-03-15T00:00:00.000Z");
    expect(adapter.getTransactionsPage.mock.calls[0]![2].end!.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(adapter.getTransactionsPage.mock.calls[1]![2].start!.toISOString()).toBe("2025-02-10T00:00:00.000Z");
    expect(adapter.getTransactionsPage.mock.calls[1]![2].end!.toISOString()).toBe("2026-02-10T00:00:00.000Z");
    expect(adapter.getTransactionsPage.mock.calls[2]![2].start!.toISOString()).toBe("2024-02-11T00:00:00.000Z");
    expect(adapter.getTransactionsPage.mock.calls[2]![2].end!.toISOString()).toBe("2025-02-10T00:00:00.000Z");
    expect(dbMocks.mergePageMetadata).toHaveBeenCalledWith(expect.anything(), 1, {
      transactionBackfillLowerBound: "2026-02-03T00:00:00.000Z",
    });
    expect(result.satisfied).toBe(true);
    expect(result.processedTransactions).toBe(1);
    expect(result.processedChargebacks).toBe(0);
  });

  it("resets empty-window counting when chargebacks begin on synthetic scans", async () => {
    const adapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-1", "2026-02-10T00:00:00.000Z")]),
        makeCursorPage([]),
        makeCursorPage([]),
      ],
      chargebackPages: [
        makeCursorPage([makeChargeback("cb-1", "2026-01-15T00:00:00.000Z")]),
        makeCursorPage([]),
        makeCursorPage([]),
      ],
    });

    await runOnlyFansTransactionsSync({
      adapter,
      budget: new SyncChunkBudget(10, 60_000),
    });

    expect(adapter.getChargebacksPage).toHaveBeenCalledTimes(3);
    expect(adapter.getChargebacksPage.mock.calls[0]![2].start!.toISOString()).toBe("2025-03-15T00:00:00.000Z");
    expect(adapter.getChargebacksPage.mock.calls[0]![2].end!.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(adapter.getChargebacksPage.mock.calls[1]![2].start!.toISOString()).toBe("2025-01-15T00:00:00.000Z");
    expect(adapter.getChargebacksPage.mock.calls[1]![2].end!.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(dbMocks.mergePageMetadata).toHaveBeenCalledWith(expect.anything(), 1, {
      transactionBackfillLowerBound: "2026-01-08T00:00:00.000Z",
    });
  });

  it("completes a synthetic no-data backfill without persisting a discovered lower bound", async () => {
    const adapter = createAdapter({
      transactionPages: [
        makeCursorPage([]),
        makeCursorPage([]),
      ],
      chargebackPages: [
        makeCursorPage([]),
        makeCursorPage([]),
      ],
    });

    const result = await runOnlyFansTransactionsSync({
      adapter,
      budget: new SyncChunkBudget(10, 60_000),
    });

    expect(adapter.getTransactionsPage).toHaveBeenCalledTimes(2);
    expect(adapter.getChargebacksPage).toHaveBeenCalledTimes(2);
    expect(dbMocks.mergePageMetadata).not.toHaveBeenCalled();
    expect(result.satisfied).toBe(true);
    expect(result.processedTransactions).toBe(0);
    expect(result.processedChargebacks).toBe(0);
  });

  it("clamps buffered backfill lower bounds to the synthetic floor", async () => {
    const adapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-1", "2016-01-03T00:00:00.000Z")]),
      ],
      chargebackPages: [
        makeCursorPage([]),
      ],
    });

    await runOnlyFansTransactionsSync({
      adapter,
      budget: new SyncChunkBudget(10, 60_000),
      pageMetadata: {
        transactionBackfillLowerBound: "2016-01-01T00:00:00.000Z",
      },
    });

    expect(dbMocks.mergePageMetadata).toHaveBeenCalledWith(expect.anything(), 1, {
      transactionBackfillLowerBound: "2016-01-01T00:00:00.000Z",
    });
  });

  it("honors manual rescanStart for incremental syncs", async () => {
    const adapter = createAdapter({
      transactionPages: [makeCursorPage([])],
      chargebackPages: [makeCursorPage([])],
    });

    await runOnlyFansTransactionsSync({
      adapter,
      checkpoint: {
        cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
        state: {},
      },
      rescanStart: new Date("2026-03-01T00:00:00.000Z"),
      budget: new SyncChunkBudget(10, 60_000),
    });

    const firstRequest = adapter.getTransactionsPage.mock.calls[0]![2];
    expect(firstRequest.start!.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("applies authoritative empty-window cleanup when the upstream window is empty", async () => {
    const adapter = createAdapter({
      transactionPages: [makeCursorPage([])],
      chargebackPages: [makeCursorPage([])],
    });

    await runOnlyFansTransactionsSync({
      adapter,
      checkpoint: {
        cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
        state: {},
      },
      budget: new SyncChunkBudget(10, 60_000),
    });

    expect(dbMocks.deleteTransactionsMissingFromWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        platformAccountId: 1,
        from: new Date("2026-03-07T00:00:00.000Z"),
        to: new Date("2026-03-15T00:00:00.000Z"),
        cleanupMode: "authoritative_empty",
        keepTransactionIds: [],
      }),
    );
    expect(dbMocks.rebuildSpenderProjections).toHaveBeenCalledWith(
      expect.anything(),
      1,
      new Date("2026-03-07T00:00:00.000Z"),
    );
    expect(dbMocks.rebuildRevenueRollups).toHaveBeenCalledWith(
      expect.anything(),
      1,
      new Date("2026-03-07T00:00:00.000Z"),
    );
  });

  it("rebuilds incremental OnlyFans rollups from the cleanup window start", async () => {
    const adapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-1", "2026-03-10T00:00:00.000Z")]),
      ],
      chargebackPages: [makeCursorPage([])],
    });

    await runOnlyFansTransactionsSync({
      adapter,
      checkpoint: {
        cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
        state: {},
      },
      budget: new SyncChunkBudget(10, 60_000),
    });

    expect(dbMocks.deleteTransactionsMissingFromWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        platformAccountId: 1,
        from: new Date("2026-03-07T00:00:00.000Z"),
        cleanupMode: "keep_set",
        keepTransactionIds: ["tx-1"],
      }),
    );
    expect(dbMocks.rebuildSpenderProjections).toHaveBeenCalledWith(
      expect.anything(),
      1,
      new Date("2026-03-07T00:00:00.000Z"),
    );
    expect(dbMocks.rebuildRevenueRollups).toHaveBeenCalledWith(
      expect.anything(),
      1,
      new Date("2026-03-07T00:00:00.000Z"),
    );
  });

  it("applies keep-set cleanup to chargeback-only incremental windows", async () => {
    const adapter = createAdapter({
      transactionPages: [makeCursorPage([])],
      chargebackPages: [
        makeCursorPage([makeChargeback("cb-1", "2026-03-10T00:00:00.000Z")]),
      ],
    });

    await runOnlyFansTransactionsSync({
      adapter,
      checkpoint: {
        cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
        state: {},
      },
      budget: new SyncChunkBudget(10, 60_000),
    });

    expect(dbMocks.deleteTransactionsMissingFromWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        platformAccountId: 1,
        from: new Date("2026-03-07T00:00:00.000Z"),
        cleanupMode: "keep_set",
        keepTransactionIds: ["cb-1"],
      }),
    );
    expect(dbMocks.rebuildSpenderProjections).toHaveBeenCalledWith(
      expect.anything(),
      1,
      new Date("2026-03-07T00:00:00.000Z"),
    );
    expect(dbMocks.rebuildRevenueRollups).toHaveBeenCalledWith(
      expect.anything(),
      1,
      new Date("2026-03-07T00:00:00.000Z"),
    );
  });

  it("yields and resumes incremental transaction scans with a persisted live cursor", async () => {
    const firstAdapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-1", "2026-03-10T00:00:00.000Z")], "tx-cursor-1"),
      ],
      chargebackPages: [makeCursorPage([])],
    });

    const firstResult = await runOnlyFansTransactionsSync({
      adapter: firstAdapter,
      checkpoint: {
        cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
        state: {},
      },
      budget: new SyncChunkBudget(1, 60_000),
    });

    expect(firstResult.satisfied).toBe(false);
    expect(firstResult.yieldReason).toBe("request_budget");

    const yieldedState = dbMocks.upsertCheckpointProgress.mock.calls.at(-1)![1].state;
    expect(yieldedState.mode).toBe("incremental");
    expect(yieldedState.phase).toBe("transactions");
    expect(yieldedState.cursor).toBe("tx-cursor-1");
    expect(yieldedState.keepTransactionIds).toEqual(["tx-1"]);
    expect(yieldedState.dirtyFrom).toBeNull();

    const resumedAdapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-2", "2026-03-09T00:00:00.000Z")]),
      ],
      chargebackPages: [makeCursorPage([])],
    });

    const resumedResult = await runOnlyFansTransactionsSync({
      adapter: resumedAdapter,
      checkpoint: {
        cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
        state: yieldedState,
      },
      budget: new SyncChunkBudget(10, 60_000),
    });

    expect(resumedAdapter.getTransactionsPage.mock.calls[0]![2].cursor).toBe("tx-cursor-1");
    expect(resumedResult.satisfied).toBe(true);
    expect(dbMocks.deleteTransactionsMissingFromWindow).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        cleanupMode: "keep_set",
        keepTransactionIds: ["tx-1", "tx-2"],
      }),
    );
  });

  it("yields and resumes incremental chargeback scans with a persisted live cursor", async () => {
    const firstAdapter = createAdapter({
      transactionPages: [
        makeCursorPage([makeTransaction("tx-1", "2026-03-10T00:00:00.000Z")]),
      ],
      chargebackPages: [
        makeCursorPage([makeChargeback("cb-1", "2026-03-09T00:00:00.000Z")], "cb-cursor-1"),
      ],
    });

    const firstResult = await runOnlyFansTransactionsSync({
      adapter: firstAdapter,
      checkpoint: {
        cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
        state: {},
      },
      budget: new SyncChunkBudget(2, 60_000),
    });

    expect(firstResult.satisfied).toBe(false);
    expect(firstResult.yieldReason).toBe("request_budget");

    const yieldedState = dbMocks.upsertCheckpointProgress.mock.calls.at(-1)![1].state;
    expect(yieldedState.mode).toBe("incremental");
    expect(yieldedState.phase).toBe("chargebacks");
    expect(yieldedState.cursor).toBe("cb-cursor-1");
    expect(yieldedState.keepTransactionIds).toEqual(["tx-1", "cb-1"]);
    expect(yieldedState.dirtyFrom).toBeNull();

    const resumedAdapter = createAdapter({
      transactionPages: [makeCursorPage([])],
      chargebackPages: [
        makeCursorPage([makeChargeback("cb-2", "2026-03-08T00:00:00.000Z")]),
      ],
    });

    const resumedResult = await runOnlyFansTransactionsSync({
      adapter: resumedAdapter,
      checkpoint: {
        cursorTimestamp: new Date("2026-03-14T00:00:00.000Z"),
        state: yieldedState,
      },
      budget: new SyncChunkBudget(10, 60_000),
    });

    expect(resumedAdapter.getChargebacksPage.mock.calls[0]![2].cursor).toBe("cb-cursor-1");
    expect(resumedResult.satisfied).toBe(true);
    expect(dbMocks.deleteTransactionsMissingFromWindow).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        cleanupMode: "keep_set",
        keepTransactionIds: ["tx-1", "cb-1", "cb-2"],
      }),
    );
  });

  it("rejects manual rescans while an incomplete backfill exists", async () => {
    await expect(runOnlyFansTransactionsSync({
      checkpoint: {
        state: {
          mode: "backfill",
          completed: false,
          provider: "onlyfans",
          phase: "transactions",
          snapshotEnd: "2026-03-15T00:00:00.000Z",
          newestSeenAt: null,
          dirtyFrom: null,
          processedTransactions: 0,
          processedChargebacks: 0,
          transactionPages: 0,
          chargebackPages: 0,
          start: "1970-01-01T00:00:00.000Z",
          fallbackStartUsed: false,
          cursor: null,
          windowEnd: "2026-03-15T00:00:00.000Z",
          windowPageCount: 0,
        },
      },
      rescanStart: new Date("2026-03-01T00:00:00.000Z"),
    })).rejects.toThrow("Manual OnlyFans transaction rescans are not allowed while an incomplete backfill exists");
  });

  it("warns once per run for an unknown transaction type", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorTimestamp: new Date("2026-03-08T00:00:00.000Z"),
      state: {},
    });
    const telemetry = createTelemetry();
    const adapter = createAdapter({
      transactionPages: [
        makeCursorPage([
          {
            ...makeTransaction("tx-unknown-1", "2026-03-10T00:00:00.000Z"),
            type: "mystery",
          },
          {
            ...makeTransaction("tx-unknown-2", "2026-03-09T00:00:00.000Z"),
            type: "mystery",
          },
        ]),
      ],
      chargebackPages: [makeCursorPage([])],
    });
    const app = createApp(adapter);

    await syncOnlyFansTransactions(app as never, {
      pageLabel: "onlyfans-page",
      platformAccountId: 1,
      platformAccountIdValue: "of-1",
      pageMetadata: {},
      commissionRate: 0.2,
      rescanStart: null,
      requestContext: {
        auth: { token: "secret" },
        proxy: null,
        requestObserver: null,
      } as never,
      syncRunId: 123,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(10, 60_000),
    });

    expect(app.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        pageLabel: "onlyfans-page",
        platformAccountId: 1,
        rawType: "mystery",
      }),
      "Unmapped OnlyFans transaction type fell back to other",
    );
    expect(telemetry.addAnomaly).toHaveBeenCalledTimes(1);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "unknown_transaction_type",
      severity: "warn",
      details: expect.objectContaining({
        provider: "onlyfans",
        rawType: "mystery",
      }),
    }));
  });
});
