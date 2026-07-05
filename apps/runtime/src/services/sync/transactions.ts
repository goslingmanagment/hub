import {
  assertOwnedPageSyncLease,
  getCheckpoint,
  getOldestPendingTransactionAt,
  PageSyncLeaseLostError,
  recordRunningPageSyncProgress,
  rebuildSpenderProjections,
  rebuildRevenueRollups,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertTransaction,
  withOwnedPageSyncTransaction,
} from "@agency_hub_core/db";
import {
  FANSLY_MAPPER_VERSION,
  isKnownFanslyTransactionType,
  mapFanslyTransactionState,
  mapFanslyTransactionType,
} from "@agency_hub_core/fansly";
import { calculateGrossMillsFromNet, toMills } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { SyncChunkBudget, SyncChunkYieldReason } from "./chunk-budget.ts";
import { lookupHydratedFans, upsertHydratedFansForPage } from "./fan-hydration.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { DAY_MS, persistRawPayload, retentionDate } from "./shared.ts";
import {
  buildBackfillProgressMessage,
  isoDateOrNull,
  parseTransactionBackfillState,
  type FanslyTransactionBackfillState,
} from "./transaction-backfill.ts";

type ActiveSyncLease = {
  requestSeq: number;
  leaseToken: string;
};

type FanslyTransactionSyncResult = {
  satisfied: boolean;
  yieldReason: SyncChunkYieldReason | null;
  processed: number;
  processedTransactions: number;
  newestSeenAt: Date;
};

type FanslyTransactionIncrementalState = {
  mode: "incremental";
  completed: false;
  provider: "fansly";
  phase: "transactions";
  cursorTimestamp: string | null;
  snapshotEnd: string;
  after: string | null;
  lookbackStart: string | null;
  oldestPendingAt: string | null;
  rescanCapStart: string;
  providerReportedTotal: number | null;
  newestSeenAt: string | null;
  oldestSeenAt: string | null;
  dirtyFrom: string | null;
  processedTransactions: number;
  transactionPages: number;
  offset: number;
  olderThanBoundaryItems: number;
  olderThanBoundaryPages: number;
  consecutiveAllOlderPages: number;
  firstPageOlderThanBoundaryItems: number;
  earlyStoppedBeyondBoundary: boolean;
  lastPageTransactionIds?: string[];
};

type FanslyTransactionProgressState =
  | FanslyTransactionBackfillState
  | FanslyTransactionIncrementalState;

type FanslyTransactionPage = Awaited<ReturnType<AppContext["adapter"]["getTransactionsPage"]>>;
type FanslyTransactionItem = FanslyTransactionPage["items"][number];
type FanslyIncrementalInvalidationReason =
  | "incremental_total_changed"
  | "incremental_offset_overlap"
  | "incremental_total_mismatch";

class UnstableFanslyIncrementalScanError extends Error {
  constructor(
    message: string,
    readonly reason: FanslyIncrementalInvalidationReason,
  ) {
    super(message);
    this.name = "UnstableFanslyIncrementalScanError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asIsoString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asNullableIsoString(value: unknown) {
  if (value === null) {
    return null;
  }
  return asIsoString(value);
}

function asNonNegativeInt(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function asNullableNonNegativeInt(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  return asNonNegativeInt(value);
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function asStringArray(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function parseFanslyTransactionIncrementalState(value: unknown): FanslyTransactionIncrementalState | null {
  const state = asRecord(value);
  if (
    !state ||
    state.mode !== "incremental" ||
    state.completed !== false ||
    state.provider !== "fansly" ||
    state.phase !== "transactions"
  ) {
    return null;
  }

  const snapshotEnd = asIsoString(state.snapshotEnd);
  const cursorTimestamp = asNullableIsoString(state.cursorTimestamp);
  const after = asNullableIsoString(state.after);
  const lookbackStart = asNullableIsoString(state.lookbackStart);
  const oldestPendingAt = asNullableIsoString(state.oldestPendingAt);
  const rescanCapStart = asIsoString(state.rescanCapStart);
  const providerReportedTotal = asNullableNonNegativeInt(state.providerReportedTotal);
  const newestSeenAt = asNullableIsoString(state.newestSeenAt);
  const oldestSeenAt = asNullableIsoString(state.oldestSeenAt);
  const dirtyFrom = asNullableIsoString(state.dirtyFrom);
  const processedTransactions = asNonNegativeInt(state.processedTransactions);
  const transactionPages = asNonNegativeInt(state.transactionPages);
  const offset = asNonNegativeInt(state.offset);
  const olderThanBoundaryItems = asNonNegativeInt(state.olderThanBoundaryItems);
  const olderThanBoundaryPages = asNonNegativeInt(state.olderThanBoundaryPages);
  const consecutiveAllOlderPages = asNonNegativeInt(state.consecutiveAllOlderPages);
  const firstPageOlderThanBoundaryItems = asNonNegativeInt(state.firstPageOlderThanBoundaryItems);
  const earlyStoppedBeyondBoundary = asBoolean(state.earlyStoppedBeyondBoundary);
  const lastPageTransactionIds = asStringArray(state.lastPageTransactionIds);

  if (
    snapshotEnd === null ||
    cursorTimestamp === undefined ||
    after === undefined ||
    lookbackStart === undefined ||
    oldestPendingAt === undefined ||
    rescanCapStart === null ||
    providerReportedTotal === undefined ||
    newestSeenAt === undefined ||
    oldestSeenAt === undefined ||
    dirtyFrom === undefined ||
    processedTransactions === null ||
    transactionPages === null ||
    offset === null ||
    olderThanBoundaryItems === null ||
    olderThanBoundaryPages === null ||
    consecutiveAllOlderPages === null ||
    firstPageOlderThanBoundaryItems === null ||
    earlyStoppedBeyondBoundary === null ||
    lastPageTransactionIds === null
  ) {
    return null;
  }

  return {
    mode: "incremental",
    completed: false,
    provider: "fansly",
    phase: "transactions",
    cursorTimestamp,
    snapshotEnd,
    after,
    lookbackStart,
    oldestPendingAt,
    rescanCapStart,
    providerReportedTotal,
    newestSeenAt,
    oldestSeenAt,
    dirtyFrom,
    processedTransactions,
    transactionPages,
    offset,
    olderThanBoundaryItems,
    olderThanBoundaryPages,
    consecutiveAllOlderPages,
    firstPageOlderThanBoundaryItems,
    earlyStoppedBeyondBoundary,
    lastPageTransactionIds,
  };
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

function resolveFanslyIncrementalCursorTimestamp(
  checkpoint: Awaited<ReturnType<typeof getCheckpoint>>,
  state: FanslyTransactionIncrementalState | null,
  transactionLookbackDays: number,
) {
  if (checkpoint?.cursorTimestamp) {
    return checkpoint.cursorTimestamp;
  }

  if (state?.cursorTimestamp) {
    return new Date(state.cursorTimestamp);
  }

  if (state?.lookbackStart) {
    return addDays(new Date(state.lookbackStart), transactionLookbackDays);
  }

  return null;
}

function progressCursorTimestamp(state: FanslyTransactionProgressState) {
  if (state.mode !== "incremental" || !state.cursorTimestamp) {
    return null;
  }

  return new Date(state.cursorTimestamp);
}

function resolveFanslyCommissionRate(
  destinationTax: number | null,
  fallbackCommissionRate: number,
) {
  if (
    destinationTax !== null &&
    Number.isInteger(destinationTax) &&
    destinationTax >= 0 &&
    destinationTax <= 10_000
  ) {
    return destinationTax / 10_000;
  }

  return fallbackCommissionRate;
}

function minDate(a: Date | null, b: Date | null) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a <= b ? a : b;
}

function maxDate(a: Date | null, b: Date | null) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a >= b ? a : b;
}

function transactionIdsForPage(items: FanslyTransactionItem[]) {
  return items.map((item) => item.transactionId);
}

function findPageOverlap(
  previousTransactionIds: string[] | undefined,
  items: FanslyTransactionItem[],
) {
  if (!previousTransactionIds || previousTransactionIds.length === 0) {
    return [];
  }

  const previous = new Set(previousTransactionIds);
  return items
    .map((item) => item.transactionId)
    .filter((transactionId) => previous.has(transactionId));
}

async function flushFanslyDirtyRange(
  app: AppContext,
  platformAccountId: number,
  dirtyFrom: Date | null,
) {
  if (!dirtyFrom) {
    return;
  }

  await withOwnedPageSyncTransaction(app.db, async (db) => {
    await rebuildSpenderProjections(db, platformAccountId, dirtyFrom);
    await rebuildRevenueRollups(db, platformAccountId, dirtyFrom);
  });
}

async function recordUnknownFanslyTransactionType(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    telemetry: SyncRunTelemetry;
  },
  rawType: number,
  seenRawTypes: Set<number>,
) {
  if (isKnownFanslyTransactionType(rawType) || seenRawTypes.has(rawType)) {
    return;
  }

  seenRawTypes.add(rawType);
  app.logger.warn({
    pageLabel: input.pageLabel,
    platformAccountId: input.platformAccountId,
    rawType,
  }, "Unmapped Fansly transaction type fell back to other");
  await input.telemetry.addAnomaly({
    code: "unknown_transaction_type",
    severity: "warn",
    message: "Unmapped Fansly transaction type fell back to other",
    details: {
      provider: "fansly",
      rawType,
      pageLabel: input.pageLabel,
      platformAccountId: input.platformAccountId,
    },
  });
}

async function persistFanslyTransactionsPage(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    commissionRate: number;
    requestContext: Parameters<AppContext["adapter"]["getTransactionsPage"]>[0];
    telemetry: SyncRunTelemetry;
    activeLease?: ActiveSyncLease;
  },
  items: FanslyTransactionItem[],
  state: FanslyTransactionProgressState,
  processedTransactionsThisRun: number,
  seenUnknownRawTypes: Set<number>,
) {
  for (const item of items) {
    await recordUnknownFanslyTransactionType(app, input, item.type, seenUnknownRawTypes);
  }

  const hydratedFans = await lookupHydratedFans(app, {
    requestContext: input.requestContext,
    platformUserIds: items
      .map((item) => item.correlationAccountId)
      .filter((value): value is string => Boolean(value)),
    telemetry: input.telemetry,
  });

  await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
    const fanMap = await upsertHydratedFansForPage(dbTx, {
      platformAccountId: input.platformAccountId,
      accounts: hydratedFans.accounts,
      fallbackIds: hydratedFans.fallbackIds,
    });

    for (const item of items) {
      const fanId = item.correlationAccountId
        ? (fanMap.get(item.correlationAccountId) ?? null)
        : null;
      const sourceAmountMills = toMills(item.amount);
      const destinationAmountMills = toMills(item.destinationAmount);
      const creatorNetAmountMills = destinationAmountMills;
      const commissionRate = resolveFanslyCommissionRate(
        item.destinationTax,
        input.commissionRate,
      );
      const grossAmountMills = sourceAmountMills === destinationAmountMills
        ? calculateGrossMillsFromNet(creatorNetAmountMills, commissionRate)
        : sourceAmountMills;

      await upsertTransaction(dbTx, {
        platformAccountId: input.platformAccountId,
        fanId,
        transactionId: item.transactionId,
        walletId: item.walletId,
        accountId: item.accountId,
        correlationId: item.correlationId,
        correlationAccountId: item.correlationAccountId,
        rawType: item.type,
        canonicalType: mapFanslyTransactionType(item.type),
        transactionState: mapFanslyTransactionState(item.status),
        destination: item.destination,
        rawStatus: item.status,
        grossAmountMills,
        sourceDestinationAmountMills: destinationAmountMills,
        creatorNetAmountMills,
        rawDestinationTax: item.destinationTax,
        newBalanceMills: item.newBalance64 !== null && item.newBalance64 !== undefined
          ? toMills(item.newBalance64)
          : null,
        senderId: item.senderId,
        receiverId: item.receiverId,
        occurredAt: new Date(item.createdAt),
        sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
      });
    }

    await upsertCheckpointProgress(dbTx, {
      platformAccountId: input.platformAccountId,
      stream: "transactions",
      cursorTimestamp: progressCursorTimestamp(state),
      state,
    });

    await recordTransactionsRuntimeProgress(dbTx, {
      platformAccountId: input.platformAccountId,
      activeLease: input.activeLease,
    }, state, processedTransactionsThisRun);
  });
}

async function flushAndClearFanslyDirtyRange<TState extends FanslyTransactionProgressState>(
  app: AppContext,
  platformAccountId: number,
  state: TState,
) {
  const dirtyFrom = state.dirtyFrom ? new Date(state.dirtyFrom) : null;
  await flushFanslyDirtyRange(app, platformAccountId, dirtyFrom);

  if (!dirtyFrom) {
    return state;
  }

  const nextState = {
    ...state,
    dirtyFrom: null,
  } as TState;
  await upsertCheckpointProgress(app.db, {
    platformAccountId,
    stream: "transactions",
    cursorTimestamp: progressCursorTimestamp(nextState),
    state: nextState,
  });

  return nextState;
}

async function invalidateFanslyIncrementalProgress(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
  },
  checkpoint: Awaited<ReturnType<typeof getCheckpoint>>,
  reason: FanslyIncrementalInvalidationReason,
  fallbackCursorTimestamp: Date | null,
) {
  await upsertCheckpointProgress(app.db, {
    platformAccountId: input.platformAccountId,
    stream: "transactions",
    cursorTimestamp: checkpoint?.cursorTimestamp ?? fallbackCursorTimestamp,
    state: {
      pageLabel: input.pageLabel,
      invalidatedIncrementalScan: {
        reason,
        invalidatedAt: new Date().toISOString(),
      },
    },
  });
}

async function safelyInvalidateFanslyIncrementalProgress(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
  },
  checkpoint: Awaited<ReturnType<typeof getCheckpoint>>,
  reason: FanslyIncrementalInvalidationReason,
  fallbackCursorTimestamp: Date | null,
  originalErr: unknown,
) {
  try {
    await invalidateFanslyIncrementalProgress(
      app,
      input,
      checkpoint,
      reason,
      fallbackCursorTimestamp,
    );
  } catch (cleanupError) {
    app.logger.warn({
      err: cleanupError,
      originalErr,
      pageLabel: input.pageLabel,
      platformAccountId: input.platformAccountId,
      provider: "fansly",
      stream: "transactions",
    }, "Failed to invalidate unstable Fansly incremental checkpoint progress");
  }
}

async function syncTransactionsIncremental(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    commissionRate: number;
    transactionLookbackDays?: number;
    transactionRescanCapDays?: number;
    requestContext: Parameters<AppContext["adapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
    budget?: SyncChunkBudget;
    activeLease?: ActiveSyncLease;
  },
  checkpoint: Awaited<ReturnType<typeof getCheckpoint>>,
  existingState: FanslyTransactionIncrementalState | null,
): Promise<FanslyTransactionSyncResult> {
  // Live effective windowing, with a boot-config fallback for callers (tests) that
  // do not thread the values. Resolved once so all three reads below agree.
  const transactionLookbackDays = input.transactionLookbackDays ?? app.config.transactionLookbackDays;
  const transactionRescanCapDays = input.transactionRescanCapDays ?? app.config.transactionRescanCapDays;
  let state: FanslyTransactionIncrementalState;

  if (existingState) {
    state = existingState;
  } else {
    const oldestPendingAt = await getOldestPendingTransactionAt(app.db, input.platformAccountId);
    const lookbackStart = checkpoint?.cursorTimestamp
      ? new Date(
        checkpoint.cursorTimestamp.getTime() -
          transactionLookbackDays * DAY_MS,
      )
      : null;
    const earliestRescanStart = lookbackStart && oldestPendingAt
      ? (oldestPendingAt < lookbackStart ? oldestPendingAt : lookbackStart)
      : (lookbackStart ?? oldestPendingAt);
    const rescanCapStart = new Date(Date.now() - transactionRescanCapDays * DAY_MS);
    const after = earliestRescanStart && earliestRescanStart < rescanCapStart
      ? rescanCapStart
      : earliestRescanStart;

    if (oldestPendingAt && oldestPendingAt < rescanCapStart) {
      app.logger.warn(
        {
          pageLabel: input.pageLabel,
          platformAccountId: input.platformAccountId,
          oldestPendingAt: oldestPendingAt.toISOString(),
          rescanCapStart: rescanCapStart.toISOString(),
        },
        "Pending transaction is older than transaction rescan cap; clamping rescan window",
      );
      await input.telemetry.addAnomaly({
        code: "rescan_cap_clamped",
        severity: "warn",
        message: "Transaction rescan window was clamped by the configured rescan cap",
        details: {
          oldestPendingAt: oldestPendingAt.toISOString(),
          rescanCapStart: rescanCapStart.toISOString(),
        },
      });
    }

    state = {
      mode: "incremental",
      completed: false,
      provider: "fansly",
      phase: "transactions",
      cursorTimestamp: isoDateOrNull(checkpoint?.cursorTimestamp ?? null),
      snapshotEnd: new Date().toISOString(),
      after: isoDateOrNull(after),
      lookbackStart: isoDateOrNull(lookbackStart),
      oldestPendingAt: isoDateOrNull(oldestPendingAt),
      rescanCapStart: rescanCapStart.toISOString(),
      providerReportedTotal: null,
      newestSeenAt: isoDateOrNull(checkpoint?.cursorTimestamp ?? null),
      oldestSeenAt: null,
      dirtyFrom: null,
      processedTransactions: 0,
      transactionPages: 0,
      offset: 0,
      olderThanBoundaryItems: 0,
      olderThanBoundaryPages: 0,
      consecutiveAllOlderPages: 0,
      firstPageOlderThanBoundaryItems: 0,
      earlyStoppedBeyondBoundary: false,
    };
  }

  const incrementalCursorTimestamp = resolveFanslyIncrementalCursorTimestamp(
    checkpoint,
    state,
    transactionLookbackDays,
  );
  if (state.cursorTimestamp === null && incrementalCursorTimestamp) {
    state = {
      ...state,
      cursorTimestamp: incrementalCursorTimestamp.toISOString(),
    };
  }

  const after = state.after ? new Date(state.after) : null;
  const snapshotEnd = new Date(state.snapshotEnd);
  const lookbackStart = state.lookbackStart ? new Date(state.lookbackStart) : null;
  const oldestPendingAt = state.oldestPendingAt ? new Date(state.oldestPendingAt) : null;
  const rescanCapStart = new Date(state.rescanCapStart);
  let newestSeenAt: Date | null = state.newestSeenAt
    ? new Date(state.newestSeenAt)
    : (checkpoint?.cursorTimestamp ?? null);
  let oldestSeenAt: Date | null = state.oldestSeenAt ? new Date(state.oldestSeenAt) : null;
  let currentRunProcessed = 0;
  const seenUnknownRawTypes = new Set<number>();

  await input.telemetry.addNote(
    existingState
      ? "Resuming incomplete Fansly incremental transaction scan"
      : "Starting Fansly incremental transaction scan",
    {
      snapshotEnd: state.snapshotEnd,
      after: state.after,
      offset: state.offset,
      processedTransactions: state.processedTransactions,
      transactionPages: state.transactionPages,
    },
  );

  input.telemetry.setBoundarySummary({
    kind: "after",
    requestedLowerBound: state.after,
    end: state.snapshotEnd,
    lookbackStart: state.lookbackStart,
    oldestPendingAt: state.oldestPendingAt,
    rescanCapStart: state.rescanCapStart,
    lowerBoundClamped: Boolean(
      after &&
      lookbackStart &&
      after.getTime() !== lookbackStart.getTime() &&
      (!oldestPendingAt || oldestPendingAt >= lookbackStart)
    ),
    olderThanBoundaryItems: state.olderThanBoundaryItems,
    olderThanBoundaryPages: state.olderThanBoundaryPages,
    earlyStoppedBeyondBoundary: state.earlyStoppedBeyondBoundary,
  });
  input.telemetry.setScanSummary({
    transactionPages: state.transactionPages,
    processedTransactions: state.processedTransactions,
    processedTransactionsThisRun: currentRunProcessed,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    mode: "incremental",
    snapshotEnd: state.snapshotEnd,
    earlyStoppedBeyondBoundary: state.earlyStoppedBeyondBoundary,
  });

  try {
    while (true) {
      await assertOwnedPageSyncLease(app.db);
      const requestOffset = state.offset;
      const page = await app.adapter.getTransactionsPage(
        input.requestContext,
        { after, limit: 100, offset: requestOffset },
      );
      if (
        state.providerReportedTotal !== null &&
        page.total !== null &&
        page.total !== state.providerReportedTotal
      ) {
        await input.telemetry.addAnomaly({
          code: "incremental_total_changed",
          severity: "error",
          message: "Fansly incremental transaction total changed during an offset scan",
          details: {
            previousTotal: state.providerReportedTotal,
            currentTotal: page.total,
            page: state.transactionPages,
            offset: requestOffset,
          },
        });
        throw new UnstableFanslyIncrementalScanError(
          "Fansly incremental transaction total changed during an offset scan",
          "incremental_total_changed",
        );
      }

      const overlappingTransactionIds = findPageOverlap(state.lastPageTransactionIds, page.items);
      if (overlappingTransactionIds.length > 0) {
        await input.telemetry.addAnomaly({
          code: "incremental_offset_overlap",
          severity: "error",
          message: "Fansly incremental transaction scan saw overlapping rows between offset pages",
          details: {
            overlappingTransactionIds,
            page: state.transactionPages,
            offset: requestOffset,
          },
        });
        throw new UnstableFanslyIncrementalScanError(
          "Fansly incremental transaction scan saw overlapping rows between offset pages",
          "incremental_offset_overlap",
        );
      }

      await persistRawPayload(app.db, {
        platformAccountId: input.platformAccountId,
        syncRunId: input.syncRunId,
        endpoint: "earnings_transactions",
        requestParams: {
          after: after?.toISOString() ?? null,
          offset: requestOffset,
          limit: 100,
        },
        responsePayload: page.raw,
        mapperVersion: FANSLY_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting earnings_transactions raw payload",
        platform: "fansly",
      });

      const pageOldestSeenAt = page.items.reduce<Date | null>(
        (oldest, item) => minDate(oldest, new Date(item.createdAt)),
        null,
      );
      const pageNewestSeenAt = page.items.reduce<Date | null>(
        (latest, item) => maxDate(latest, new Date(item.createdAt)),
        null,
      );
      oldestSeenAt = minDate(oldestSeenAt, pageOldestSeenAt);
      newestSeenAt = maxDate(newestSeenAt, pageNewestSeenAt);

      let olderThanBoundaryItems = state.olderThanBoundaryItems;
      let olderThanBoundaryPages = state.olderThanBoundaryPages;
      let consecutiveAllOlderPages = state.consecutiveAllOlderPages;
      let firstPageOlderThanBoundaryItems = state.firstPageOlderThanBoundaryItems;
      const nextPageCount = state.transactionPages + 1;
      if (after) {
        const olderItemsInPage = page.items.filter((item) => item.createdAt < after.getTime()).length;
        olderThanBoundaryItems += olderItemsInPage;
        if (nextPageCount === 1) {
          firstPageOlderThanBoundaryItems = olderItemsInPage;
        }
        if (olderItemsInPage > 0 && olderItemsInPage === page.items.length) {
          olderThanBoundaryPages += 1;
          consecutiveAllOlderPages += 1;
        } else {
          consecutiveAllOlderPages = 0;
        }
      }

      const earlyStoppedBeyondBoundary = state.earlyStoppedBeyondBoundary ||
        Boolean(after && consecutiveAllOlderPages >= 2);
      const nextState: FanslyTransactionIncrementalState = {
        ...state,
        providerReportedTotal: state.providerReportedTotal ?? page.total ?? null,
        offset: state.offset + page.items.length,
        transactionPages: nextPageCount,
        processedTransactions: state.processedTransactions + page.items.length,
        newestSeenAt: isoDateOrNull(newestSeenAt),
        oldestSeenAt: isoDateOrNull(oldestSeenAt),
        dirtyFrom: isoDateOrNull(minDate(
          state.dirtyFrom ? new Date(state.dirtyFrom) : null,
          pageOldestSeenAt,
        )),
        olderThanBoundaryItems,
        olderThanBoundaryPages,
        consecutiveAllOlderPages,
        firstPageOlderThanBoundaryItems,
        earlyStoppedBeyondBoundary,
        lastPageTransactionIds: transactionIdsForPage(page.items),
      };

      await persistFanslyTransactionsPage(
        app,
        input,
        page.items,
        nextState,
        currentRunProcessed + page.items.length,
        seenUnknownRawTypes,
      );

      state = nextState;
      currentRunProcessed += page.items.length;

      input.telemetry.setScanSummary({
        transactionPages: state.transactionPages,
        processedTransactions: state.processedTransactions,
        processedTransactionsThisRun: currentRunProcessed,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        newestSeenAt: newestSeenAt?.toISOString() ?? null,
        mode: "incremental",
        snapshotEnd: state.snapshotEnd,
        earlyStoppedBeyondBoundary: state.earlyStoppedBeyondBoundary,
      });

      if (page.done) {
        break;
      }

      // The upstream API returns transactions newest-first. If we see two
      // consecutive full pages where every item is older than the requested
      // lower bound, the API is not honoring the `after` filter and all
      // subsequent pages will only contain even older data. Stop early to
      // avoid exhaustively scanning the full transaction history.
      if (earlyStoppedBeyondBoundary) {
        app.logger.warn(
          {
            pageLabel: input.pageLabel,
            platformAccountId: input.platformAccountId,
            after: after?.toISOString() ?? null,
            pageCount: state.transactionPages,
            olderThanBoundaryItems: state.olderThanBoundaryItems,
            olderThanBoundaryPages: state.olderThanBoundaryPages,
          },
          "Early-stopping transaction scan: upstream API is not honoring the after filter",
        );
        break;
      }

      if (input.budget?.shouldYield()) {
        state = await flushAndClearFanslyDirtyRange(app, input.platformAccountId, state);
        input.telemetry.setBoundarySummary({
          kind: "after",
          requestedLowerBound: state.after,
          end: state.snapshotEnd,
          lookbackStart: state.lookbackStart,
          oldestPendingAt: state.oldestPendingAt,
          rescanCapStart: state.rescanCapStart,
          lowerBoundClamped: Boolean(
            after &&
            lookbackStart &&
            after.getTime() !== lookbackStart.getTime() &&
            (!oldestPendingAt || oldestPendingAt >= lookbackStart)
          ),
          olderThanBoundaryItems: state.olderThanBoundaryItems,
          olderThanBoundaryPages: state.olderThanBoundaryPages,
          earlyStoppedBeyondBoundary: state.earlyStoppedBeyondBoundary,
        });
        return {
          satisfied: false,
          yieldReason: input.budget.resolveYieldReason(),
          processed: currentRunProcessed,
          processedTransactions: currentRunProcessed,
          newestSeenAt: newestSeenAt ?? snapshotEnd,
        };
      }
    }
  } catch (error) {
    if (error instanceof PageSyncLeaseLostError) {
      throw error;
    }

    try {
      state = await flushAndClearFanslyDirtyRange(app, input.platformAccountId, state);
    } catch (cleanupError) {
      app.logger.warn({
        err: cleanupError,
        originalErr: error,
        pageLabel: input.pageLabel,
        platformAccountId: input.platformAccountId,
        provider: "fansly",
        stream: "transactions",
      }, "Failed to flush Fansly dirty range after incremental error");
    }

    if (error instanceof UnstableFanslyIncrementalScanError) {
      await safelyInvalidateFanslyIncrementalProgress(
        app,
        input,
        checkpoint,
        error.reason,
        incrementalCursorTimestamp,
        error,
      );
    }

    throw error;
  }

  await flushFanslyDirtyRange(
    app,
    input.platformAccountId,
    state.dirtyFrom ? new Date(state.dirtyFrom) : null,
  );

  if (
    !state.earlyStoppedBeyondBoundary &&
    state.providerReportedTotal !== null &&
    state.providerReportedTotal !== state.processedTransactions
  ) {
    await input.telemetry.addAnomaly({
      code: "incremental_total_mismatch",
      severity: "error",
      message: "Provider-reported transaction total differed from the fetched transaction rows",
      details: {
        providerReportedTotal: state.providerReportedTotal,
        fetchedRows: state.processedTransactions,
        pageCount: state.transactionPages,
      },
    });
    const error = new UnstableFanslyIncrementalScanError(
      "Fansly incremental transaction total differed from fetched rows",
      "incremental_total_mismatch",
    );
    await safelyInvalidateFanslyIncrementalProgress(
      app,
      input,
      checkpoint,
      error.reason,
      incrementalCursorTimestamp,
      error,
    );
    throw error;
  }

  let checkpointAfter = null;
  if (newestSeenAt) {
    checkpointAfter = await upsertCheckpoint(app.db, {
      platformAccountId: input.platformAccountId,
      stream: "transactions",
      cursorTimestamp: newestSeenAt,
      state: { pageLabel: input.pageLabel },
      lastSuccessfulRunId: input.syncRunId,
    });
  }

  await input.telemetry.recordCheckpointAdvanced("transactions", summarizeCheckpoint(checkpointAfter));
  input.telemetry.setBoundarySummary({
    kind: "after",
    requestedLowerBound: state.after,
    end: state.snapshotEnd,
    lookbackStart: state.lookbackStart,
    oldestPendingAt: state.oldestPendingAt,
    rescanCapStart: state.rescanCapStart,
    lowerBoundClamped: Boolean(
      after &&
      lookbackStart &&
      after.getTime() !== lookbackStart.getTime() &&
      (!oldestPendingAt || oldestPendingAt >= lookbackStart)
    ),
    olderThanBoundaryItems: state.olderThanBoundaryItems,
    olderThanBoundaryPages: state.olderThanBoundaryPages,
    earlyStoppedBeyondBoundary: state.earlyStoppedBeyondBoundary,
  });
  input.telemetry.setScanSummary({
    transactionPages: state.transactionPages,
    processedTransactions: state.processedTransactions,
    processedTransactionsThisRun: currentRunProcessed,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    mode: "incremental",
    snapshotEnd: state.snapshotEnd,
    earlyStoppedBeyondBoundary: state.earlyStoppedBeyondBoundary,
  });

  if (after && lookbackStart && after.getTime() < lookbackStart.getTime() - DAY_MS) {
    await input.telemetry.addAnomaly({
      code: "wide_rescan",
      severity: "warn",
      message: "Transaction scan expanded materially beyond the normal incremental lookback window",
      details: {
        after: after.toISOString(),
        lookbackStart: lookbackStart.toISOString(),
      },
    });
  }

  if (
    checkpoint?.cursorTimestamp &&
    newestSeenAt &&
    newestSeenAt.getTime() <= checkpoint.cursorTimestamp.getTime() &&
    state.processedTransactions > 0
  ) {
    // When the scan was early-stopped because the upstream API ignored the
    // `after` filter, a stalled checkpoint is the expected outcome — all the
    // scanned items were older than the checkpoint so there is nothing to
    // advance. Downgrade to warn so it doesn't page.
    const severity = state.earlyStoppedBeyondBoundary ? "warn" : "error";
    await input.telemetry.addAnomaly({
      code: "checkpoint_stalled",
      severity,
      message: "Transaction checkpoint did not advance despite processing transaction pages",
      details: {
        checkpointTimestamp: checkpoint.cursorTimestamp.toISOString(),
        newestSeenAt: newestSeenAt.toISOString(),
        processed: state.processedTransactions,
        earlyStoppedBeyondBoundary: state.earlyStoppedBeyondBoundary,
      },
    });
  }

  if (
    after &&
    (
      (state.firstPageOlderThanBoundaryItems > 0 && state.olderThanBoundaryItems > 100) ||
      state.olderThanBoundaryPages > 1 ||
      (
        oldestSeenAt &&
        oldestSeenAt.getTime() < after.getTime() &&
        checkpoint?.cursorTimestamp &&
        newestSeenAt &&
        newestSeenAt.getTime() <= checkpoint.cursorTimestamp.getTime()
      )
    )
  ) {
    const severity = state.earlyStoppedBeyondBoundary ? "warn" : "error";
    await input.telemetry.addAnomaly({
      code: "after_ineffective",
      severity,
      message: "The lower-bound transaction filter behaved ineffectively and scanned materially old data",
      details: {
        after: after.toISOString(),
        firstPageOlderThanBoundaryItems: state.firstPageOlderThanBoundaryItems,
        olderThanBoundaryItems: state.olderThanBoundaryItems,
        olderThanBoundaryPages: state.olderThanBoundaryPages,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        earlyStoppedBeyondBoundary: state.earlyStoppedBeyondBoundary,
      },
    });
  }

  if (state.providerReportedTotal !== null && state.providerReportedTotal !== state.processedTransactions) {
    await input.telemetry.addAnomaly({
      code: "transactions_total_mismatch",
      severity: "warn",
      message: "Provider-reported transaction total differed from the fetched transaction rows",
      details: {
        providerReportedTotal: state.providerReportedTotal,
        fetchedRows: state.processedTransactions,
        pageCount: state.transactionPages,
      },
    });
  }

  return {
    satisfied: true,
    yieldReason: null,
    processed: currentRunProcessed,
    processedTransactions: currentRunProcessed,
    newestSeenAt: newestSeenAt ?? snapshotEnd,
  };
}

async function recordTransactionsRuntimeProgress(
  db: AppContext["db"],
  input: {
    platformAccountId: number;
    activeLease?: ActiveSyncLease;
  },
  state: FanslyTransactionProgressState,
  processedTransactionsThisRun: number,
) {
  if (!input.activeLease) {
    return;
  }

  await recordRunningPageSyncProgress(db, {
    pageId: input.platformAccountId,
    stream: "transactions",
    requestSeq: input.activeLease.requestSeq,
    leaseToken: input.activeLease.leaseToken,
    progressedAt: new Date(),
    phase: state.phase,
    workClass: state.mode === "backfill" ? "history" : "live",
    progress: {
      ...state,
      processedTransactionsThisRun,
    },
  });
}

async function syncTransactionsBackfill(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    commissionRate: number;
    requestContext: Parameters<AppContext["adapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
    budget?: SyncChunkBudget;
    activeLease?: ActiveSyncLease;
  },
  checkpoint: Awaited<ReturnType<typeof getCheckpoint>>,
  existingState: FanslyTransactionBackfillState | null,
): Promise<FanslyTransactionSyncResult> {
  let state: FanslyTransactionBackfillState = existingState ?? {
    mode: "backfill",
    completed: false,
    provider: "fansly",
    phase: "transactions",
    snapshotEnd: new Date().toISOString(),
    providerReportedTotal: null,
    newestSeenAt: null,
    dirtyFrom: null,
    processedTransactions: 0,
    processedChargebacks: 0,
    transactionPages: 0,
    chargebackPages: 0,
    offset: 0,
  };

  const snapshotEnd = new Date(state.snapshotEnd);
  let oldestSeenAt: Date | null = null;
  let newestSeenAt = state.newestSeenAt ? new Date(state.newestSeenAt) : null;
  let currentRunProcessed = 0;
  const seenUnknownRawTypes = new Set<number>();
  let providerReportedTotal: number | null = state.providerReportedTotal ?? null;

  await input.telemetry.addNote(
    existingState
      ? "Resuming incomplete Fansly transaction backfill"
      : "Starting Fansly full-history transaction backfill",
    {
      snapshotEnd: state.snapshotEnd,
      offset: state.offset,
      processedTransactions: state.processedTransactions,
    },
  );

  input.telemetry.setBoundarySummary({
    kind: "backfill",
    strategy: "offset_head_scan",
    snapshotEnd: state.snapshotEnd,
    requestedLowerBound: null,
    resumeOffset: state.offset,
  });
  input.telemetry.setScanSummary({
    mode: "backfill",
    strategy: "offset_head_scan",
    phase: "transactions",
    transactionPages: state.transactionPages,
    processedTransactions: state.processedTransactions,
    processedTransactionsThisRun: currentRunProcessed,
    oldestSeenAt: null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
  });

  try {
    while (true) {
      await assertOwnedPageSyncLease(app.db);
      const page = await app.adapter.getTransactionsPage(
        input.requestContext,
        {
          limit: 100,
          offset: state.offset,
        },
      );
      providerReportedTotal ??= page.total ?? null;

      if (
        providerReportedTotal !== null &&
        page.total !== null &&
        page.total !== providerReportedTotal
      ) {
        await input.telemetry.addAnomaly({
          code: "backfill_total_changed",
          severity: "error",
          message: "Fansly transaction backfill total changed during an offset scan",
          details: {
            initialTotal: providerReportedTotal,
            currentTotal: page.total,
            offset: state.offset,
            snapshotEnd: state.snapshotEnd,
          },
        });
        throw new Error("Fansly transaction backfill total changed during an offset scan");
      }

      if (page.items.length === 0 && !page.done) {
        await input.telemetry.addAnomaly({
          code: "backfill_empty_page_before_done",
          severity: "error",
          message: "Fansly transaction backfill returned an empty page before completion",
          details: {
            total: page.total,
            offset: state.offset,
            snapshotEnd: state.snapshotEnd,
          },
        });
        throw new Error("Fansly transaction backfill returned an empty page before completion");
      }

      if (
        state.transactionPages === 0 &&
        state.offset === 0 &&
        page.items.length === 0 &&
        (page.total ?? 0) > 0
      ) {
        await input.telemetry.addAnomaly({
          code: "backfill_empty_head_page",
          severity: "error",
          message: "Fansly head-scan backfill returned an empty first page despite a non-zero total",
          details: {
            total: page.total,
            snapshotEnd: state.snapshotEnd,
          },
        });
        throw new Error("Fansly transaction backfill returned an empty first page despite a non-zero total");
      }

      const overlappingIds = findPageOverlap(state.lastPageTransactionIds, page.items);
      if (overlappingIds.length > 0) {
        await input.telemetry.addAnomaly({
          code: "backfill_offset_overlap",
          severity: "error",
          message: "Fansly transaction backfill saw overlapping rows between offset pages",
          details: {
            offset: state.offset,
            overlappingTransactionIds: overlappingIds.slice(0, 10),
            overlapCount: overlappingIds.length,
            snapshotEnd: state.snapshotEnd,
          },
        });
        throw new Error("Fansly transaction backfill saw overlapping rows between offset pages");
      }

      await persistRawPayload(app.db, {
        platformAccountId: input.platformAccountId,
        syncRunId: input.syncRunId,
        endpoint: "earnings_transactions",
        requestParams: {
          after: null,
          offset: state.offset,
          limit: 100,
        },
        responsePayload: page.raw,
        mapperVersion: FANSLY_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting earnings_transactions raw payload",
        platform: "fansly",
      });

      const pageOldestSeenAt = page.items.reduce<Date | null>(
        (oldest, item) => minDate(oldest, new Date(item.createdAt)),
        null,
      );
      const pageNewestSeenAt = page.items.reduce<Date | null>(
        (latest, item) => maxDate(latest, new Date(item.createdAt)),
        null,
      );
      oldestSeenAt = minDate(oldestSeenAt, pageOldestSeenAt);
      newestSeenAt = maxDate(newestSeenAt, pageNewestSeenAt);

      const nextState: FanslyTransactionBackfillState = {
        ...state,
        providerReportedTotal: state.providerReportedTotal ?? page.total ?? null,
        offset: state.offset + page.items.length,
        transactionPages: state.transactionPages + 1,
        processedTransactions: state.processedTransactions + page.items.length,
        newestSeenAt: isoDateOrNull(newestSeenAt),
        lastPageTransactionIds: transactionIdsForPage(page.items),
        dirtyFrom: isoDateOrNull(minDate(
          state.dirtyFrom ? new Date(state.dirtyFrom) : null,
          pageOldestSeenAt,
        )),
      };

      await persistFanslyTransactionsPage(
        app,
        input,
        page.items,
        nextState,
        currentRunProcessed + page.items.length,
        seenUnknownRawTypes,
      );

      state = nextState;
      currentRunProcessed += page.items.length;

      const progressMessage = buildBackfillProgressMessage({
        provider: "fansly",
        phase: "transactions",
        page: state.transactionPages,
        processedTransactions: state.processedTransactions,
        oldestSeenAt,
        newestSeenAt,
      });
      await input.telemetry.addNote(progressMessage, {
        page: state.transactionPages,
        processedTransactions: state.processedTransactions,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        newestSeenAt: newestSeenAt?.toISOString() ?? null,
        phase: "transactions",
      });
      app.logger.info({
        pageLabel: input.pageLabel,
        platformAccountId: input.platformAccountId,
        provider: "fansly",
        stream: "transactions",
        phase: "transactions",
        page: state.transactionPages,
        processedTransactions: state.processedTransactions,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        newestSeenAt: newestSeenAt?.toISOString() ?? null,
      }, progressMessage);
      input.telemetry.setScanSummary({
        mode: "backfill",
        strategy: "offset_head_scan",
        phase: "transactions",
        transactionPages: state.transactionPages,
        processedTransactions: state.processedTransactions,
        processedTransactionsThisRun: currentRunProcessed,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        newestSeenAt: newestSeenAt?.toISOString() ?? null,
      });

      if (page.done) {
        break;
      }

      if (input.budget?.shouldYield()) {
        state = await flushAndClearFanslyDirtyRange(app, input.platformAccountId, state);
        input.telemetry.setScanSummary({
          mode: "backfill",
          strategy: "offset_head_scan",
          phase: "transactions",
          transactionPages: state.transactionPages,
          processedTransactions: state.processedTransactions,
          processedTransactionsThisRun: currentRunProcessed,
          oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
          newestSeenAt: newestSeenAt?.toISOString() ?? null,
          snapshotEnd: snapshotEnd.toISOString(),
        });
        return {
          satisfied: false,
          yieldReason: input.budget.resolveYieldReason(),
          processed: currentRunProcessed,
          processedTransactions: currentRunProcessed,
          newestSeenAt: newestSeenAt ?? snapshotEnd,
        };
      }
    }
  } catch (error) {
    if (error instanceof PageSyncLeaseLostError) {
      throw error;
    }

    try {
      state = await flushAndClearFanslyDirtyRange(app, input.platformAccountId, state);
    } catch (cleanupError) {
      app.logger.warn({
        err: cleanupError,
        originalErr: error,
        pageLabel: input.pageLabel,
        platformAccountId: input.platformAccountId,
        provider: "fansly",
        stream: "transactions",
      }, "Failed to flush Fansly dirty range after backfill error");
    }

    throw error;
  }

  await flushFanslyDirtyRange(
    app,
    input.platformAccountId,
    state.dirtyFrom ? new Date(state.dirtyFrom) : null,
  );

  const checkpointAfter = await upsertCheckpoint(app.db, {
    platformAccountId: input.platformAccountId,
    stream: "transactions",
    cursorTimestamp: newestSeenAt ?? snapshotEnd,
    state: { pageLabel: input.pageLabel },
    lastSuccessfulRunId: input.syncRunId,
  });

  await input.telemetry.recordCheckpointAdvanced("transactions", summarizeCheckpoint(checkpointAfter));
  input.telemetry.setScanSummary({
    mode: "backfill",
    strategy: "offset_head_scan",
    phase: "transactions",
    transactionPages: state.transactionPages,
    processedTransactions: state.processedTransactions,
    processedTransactionsThisRun: currentRunProcessed,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    snapshotEnd: snapshotEnd.toISOString(),
  });

  if (providerReportedTotal !== null && state.processedTransactions !== providerReportedTotal) {
    await input.telemetry.addAnomaly({
      code: "transactions_total_mismatch",
      severity: "warn",
      message: "Provider-reported transaction total differed from the fetched transaction rows",
      details: {
        providerReportedTotal,
        fetchedRows: state.processedTransactions,
        pageCount: state.transactionPages,
      },
    });
  }

  return {
    satisfied: true,
    yieldReason: null,
    processed: currentRunProcessed,
    processedTransactions: currentRunProcessed,
    newestSeenAt: newestSeenAt ?? snapshotEnd,
  };
}

export async function syncTransactions(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    commissionRate: number;
    // Live effective windowing (Stage B1). Resolved once per chunk by the executor
    // and threaded down so the whole chunk uses one window; omitted callers fall back
    // to the boot config so existing call sites are unaffected.
    transactionLookbackDays?: number;
    transactionRescanCapDays?: number;
    requestContext: Parameters<AppContext["adapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
    budget?: SyncChunkBudget;
    activeLease?: ActiveSyncLease;
  },
): Promise<FanslyTransactionSyncResult> {
  const checkpoint = await getCheckpoint(app.db, input.platformAccountId, "transactions");
  await input.telemetry.recordCheckpointLoaded("transactions", summarizeCheckpoint(checkpoint));

  const backfillState = parseTransactionBackfillState(checkpoint?.state);
  if (backfillState?.provider === "fansly") {
    return syncTransactionsBackfill(app, input, checkpoint, backfillState);
  }

  const incrementalState = parseFanslyTransactionIncrementalState(checkpoint?.state);
  if (incrementalState) {
    return syncTransactionsIncremental(app, input, checkpoint, incrementalState);
  }

  if (checkpoint?.cursorTimestamp) {
    return syncTransactionsIncremental(app, input, checkpoint, null);
  }

  return syncTransactionsBackfill(app, input, checkpoint, null);
}
