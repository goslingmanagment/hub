import {
  assertOwnedPageSyncLease,
  countTransactionsBySource,
  getCheckpoint,
  getOldestPendingTransactionAt,
  PageSyncLeaseLostError,
  recordRunningPageSyncProgress,
  rebuildSpenderProjections,
  rebuildRevenueRollups,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertTransaction,
  upsertFanslyTransactionWithEarningsDirty,
  withOwnedPageSyncTransaction,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION, isKnownFanslyTransactionType } from "@agency_hub_core/fansly";

import type { AppContext } from "../../bootstrap.ts";
import type { SyncChunkBudget, SyncChunkYieldReason } from "./chunk-budget.ts";
import {
  FANSLY_TRANSACTION_ITEM_CONTRACT_REJECTED,
  FanslyTransactionsItemContractError,
} from "./errors.ts";
import { upsertHydratedFansForPage } from "../../sync/fansly/lib/fan-hydration.ts";
import {
  findTransactionPageOverlap,
  inWindowItemsAfterOlder,
  mapFanslyTransactionItem,
} from "../../sync/fansly/lib/money-rules.ts";
import { lookupHydratedFans } from "./fan-hydration.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { assertPageTransactionsWriter } from "../transactions-writer-gate.ts";
import { DAY_MS, persistRawPayload, retentionDate } from "./shared.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { isPageAllowlisted } from "./fansly-stream-gate.ts";
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
  | "incremental_total_invalid"
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

// Offset drift (a sale landing between pages shifts every later offset) makes
// the persisted backfill snapshot unresumable: every retry would re-read the
// same offset against the frozen total and fail again. A short final page with
// a stable total (backfill_total_mismatch) is NOT drift and stays resumable.
type FanslyBackfillInvalidationReason =
  | "backfill_total_changed"
  | "backfill_offset_overlap";

class UnstableFanslyBackfillScanError extends Error {
  constructor(
    message: string,
    readonly reason: FanslyBackfillInvalidationReason,
  ) {
    super(message);
    this.name = "UnstableFanslyBackfillScanError";
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
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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

// A page item that failed the adapter's item contract (a fractional amount, a
// createdAt in seconds) must not reach the ledger. The page is journaled by
// now; the typed error keeps the scan's progress, so a retry re-reads this
// offset instead of re-walking from offset 0, and the executor parks the lane
// as provider_bad_data once the rejection repeats (classifyTaskFailure).
async function rejectFanslyTransactionItemViolation(
  telemetry: SyncRunTelemetry,
  page: FanslyTransactionPage,
  details: Record<string, unknown>,
) {
  if (!page.itemViolation) {
    return;
  }

  await telemetry.addAnomaly({
    code: FANSLY_TRANSACTION_ITEM_CONTRACT_REJECTED,
    severity: "error",
    message: "Fansly transaction page carried an item that failed the item contract",
    details: {
      ...details,
      total: page.total,
      itemViolation: page.itemViolation,
    },
  });
  throw new FanslyTransactionsItemContractError({ field: page.itemViolation.field });
}

async function persistFanslyTransactionsPage(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    commissionRate: number;
    requestContext: Parameters<AppContext["adapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
    activeLease?: ActiveSyncLease;
  },
  items: FanslyTransactionItem[],
  state: FanslyTransactionProgressState,
  processedTransactionsThisRun: number,
  seenUnknownRawTypes: Set<number>,
  notedCommissionFallbackIds: Set<string>,
) {
  const effective = await loadEffectiveConfig(app.db, app.config);
  const earningsShadow = isPageAllowlisted(
    effective.fanslyFanEarningsShadowPageAllowlist, input.pageLabel,
  );
  for (const item of items) {
    await recordUnknownFanslyTransactionType(app, input, item.type, seenUnknownRawTypes);
  }

  // A fan looked up through this page within the day (an earlier page of this
  // walk, or an earlier run) is not sent again; its stored row gives fan_id.
  const hydratedFans = await lookupHydratedFans(app, {
    requestContext: input.requestContext,
    platformAccountId: input.platformAccountId,
    platformUserIds: items
      .map((item) => item.correlationAccountId)
      .filter((value): value is string => Boolean(value)),
    telemetry: input.telemetry,
    capture: { platformAccountId: input.platformAccountId, syncRunId: input.syncRunId },
  });

  const commissionFallbacks = new Map<string, number | null>();
  await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
    const fanMap = await upsertHydratedFansForPage(dbTx, {
      platformAccountId: input.platformAccountId,
      accounts: hydratedFans.accounts,
      fallbackIds: hydratedFans.fallbackIds,
      reusedIds: hydratedFans.reusedIds,
      lookup: hydratedFans.lookup,
    });

    for (const item of items) {
      const fanId = item.correlationAccountId
        ? (fanMap.get(item.correlationAccountId) ?? null)
        : null;
      const { row, commissionFellBack } = mapFanslyTransactionItem(item, input.commissionRate);
      if (commissionFellBack) {
        commissionFallbacks.set(item.transactionId, item.destinationTax);
      }

      const writeTransaction = earningsShadow ? upsertFanslyTransactionWithEarningsDirty : upsertTransaction;
      await writeTransaction(dbTx, {
        platformAccountId: input.platformAccountId,
        source: "fansly:rest",
        fanId,
        ...row,
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

  // A note, not a warn anomaly: the row stays in the 7-day rescan, and a warn
  // would degrade every hourly run for a week. Once per transaction per run.
  const unnotedFallbacks = [...commissionFallbacks]
    .filter(([transactionId]) => !notedCommissionFallbackIds.has(transactionId));
  if (unnotedFallbacks.length > 0) {
    for (const [transactionId] of unnotedFallbacks) {
      notedCommissionFallbackIds.add(transactionId);
    }
    await input.telemetry.addNote(
      "Fansly transaction gross used the configured commission: destinationTax was null or out of range",
      {
        code: "transaction_commission_fallback",
        fallbackCommissionRate: input.commissionRate,
        transactionIds: unnotedFallbacks.map(([transactionId]) => transactionId),
        rawDestinationTaxes: unnotedFallbacks.map(([, destinationTax]) => destinationTax),
      },
    );
  }
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

async function safelyInvalidateFanslyBackfillProgress(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
  },
  reason: FanslyBackfillInvalidationReason,
  originalErr: unknown,
) {
  try {
    // A literal null cursor: the next run must restart the backfill from
    // offset 0 with a fresh total, never fall through to the incremental path
    // and silently abandon the unscanned tail of history.
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.platformAccountId,
      stream: "transactions",
      cursorTimestamp: null,
      state: {
        pageLabel: input.pageLabel,
        invalidatedBackfillScan: {
          reason,
          invalidatedAt: new Date().toISOString(),
        },
      },
    });
  } catch (cleanupError) {
    app.logger.warn({
      err: cleanupError,
      originalErr,
      pageLabel: input.pageLabel,
      platformAccountId: input.platformAccountId,
      provider: "fansly",
      stream: "transactions",
    }, "Failed to invalidate unstable Fansly backfill checkpoint progress");
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
    let after = earliestRescanStart && earliestRescanStart < rescanCapStart
      ? rescanCapStart
      : earliestRescanStart;

    // The cap limits how far a rescan reaches back; it must never lift the
    // bound above the cursor. After an outage longer than the cap, rows between
    // the cursor and the cap start are unseen, and the early stop would count
    // them as older and skip them for good. cursor+1ms keeps the cursor row
    // itself older, so a dormant page still stops at the page holding it.
    if (after && checkpoint?.cursorTimestamp && after > checkpoint.cursorTimestamp) {
      after = new Date(checkpoint.cursorTimestamp.getTime() + 1);
      await input.telemetry.addNote("Transaction lower bound floored at the checkpoint cursor", {
        cursorTimestamp: checkpoint.cursorTimestamp.toISOString(),
        rescanCapStart: rescanCapStart.toISOString(),
      });
    }

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
  let newestSeenAt: Date | null = state.newestSeenAt
    ? new Date(state.newestSeenAt)
    : (checkpoint?.cursorTimestamp ?? null);
  let oldestSeenAt: Date | null = state.oldestSeenAt ? new Date(state.oldestSeenAt) : null;
  let currentRunProcessed = 0;
  const seenUnknownRawTypes = new Set<number>();
  const notedCommissionFallbackIds = new Set<string>();

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
    boundarySentToProvider: false,
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
        // `after` is a LOCAL boundary only. Fansly's own client never sends a
        // non-empty bound on this route, and live A/B evidence shows that one
        // makes `total` disagree with (or even suppress) the returned rows.
        // The unbounded offset shape is also what the backfill path uses.
        { limit: 100, offset: requestOffset },
      );

      await persistRawPayload(app.db, {
        platformAccountId: input.platformAccountId,
        syncRunId: input.syncRunId,
        endpoint: "earnings_transactions",
        requestParams: {
          after: null,
          localLowerBound: after?.toISOString() ?? null,
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

      await rejectFanslyTransactionItemViolation(input.telemetry, page, {
        page: state.transactionPages,
        offset: requestOffset,
      });

      const pageTotal = page.total;
      if (!isNonNegativeSafeInteger(pageTotal)) {
        await input.telemetry.addAnomaly({
          code: "incremental_total_invalid",
          severity: "error",
          message: "Fansly incremental transaction page omitted a valid non-negative safe-integer total",
          details: {
            currentTotal: pageTotal ?? null,
            page: state.transactionPages,
            offset: requestOffset,
          },
        });
        throw new UnstableFanslyIncrementalScanError(
          "Fansly incremental transaction page returned an invalid total",
          "incremental_total_invalid",
        );
      }

      if (
        state.providerReportedTotal !== null &&
        pageTotal !== state.providerReportedTotal
      ) {
        await input.telemetry.addAnomaly({
          code: "incremental_total_changed",
          severity: "error",
          message: "Fansly incremental transaction total changed during an offset scan",
          details: {
            previousTotal: state.providerReportedTotal,
            currentTotal: pageTotal,
            page: state.transactionPages,
            offset: requestOffset,
          },
        });
        throw new UnstableFanslyIncrementalScanError(
          "Fansly incremental transaction total changed during an offset scan",
          "incremental_total_changed",
        );
      }

      const overlappingTransactionIds = findTransactionPageOverlap(state.lastPageTransactionIds, page.items);
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
      // No longer decides the stop; kept so the persisted state keeps its shape.
      let consecutiveAllOlderPages = state.consecutiveAllOlderPages;
      let firstPageOlderThanBoundaryItems = state.firstPageOlderThanBoundaryItems;
      let olderItemsInPage = 0;
      const nextPageCount = state.transactionPages + 1;
      if (after) {
        olderItemsInPage = page.items.filter((item) => item.createdAt < after.getTime()).length;
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

        const lateInWindowItems = inWindowItemsAfterOlder(page.items, after);
        const [firstLateItem] = lateInWindowItems;
        if (firstLateItem) {
          await input.telemetry.addAnomaly({
            code: "incremental_listing_unordered",
            severity: "warn",
            message: "Fansly transaction listing put a row inside the local lower bound after an older row",
            details: {
              page: state.transactionPages,
              offset: requestOffset,
              localLowerBound: after.toISOString(),
              transactionId: firstLateItem.transactionId,
              createdAt: new Date(firstLateItem.createdAt).toISOString(),
              inWindowAfterOlderItems: lateInWindowItems.length,
            },
          });
        }
      }

      // A short last page that reaches the bound is a full read, not an early
      // stop: the fetched==total check below still applies to it.
      const earlyStoppedBeyondBoundary = state.earlyStoppedBeyondBoundary ||
        (olderItemsInPage > 0 && !page.done);
      const nextState: FanslyTransactionIncrementalState = {
        ...state,
        providerReportedTotal: state.providerReportedTotal ?? pageTotal,
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
        notedCommissionFallbackIds,
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

      // The upstream API returns transactions newest-first, so once a page
      // reaches below our LOCAL lower bound every later page lies wholly below
      // it. Stop here: reading those pages would only fetch, hydrate and
      // re-upsert rows the rescan window no longer covers.
      if (earlyStoppedBeyondBoundary) {
        app.logger.info(
          {
            pageLabel: input.pageLabel,
            platformAccountId: input.platformAccountId,
            after: after?.toISOString() ?? null,
            pageCount: state.transactionPages,
            olderThanBoundaryItems: state.olderThanBoundaryItems,
            olderThanBoundaryPages: state.olderThanBoundaryPages,
          },
          "Early-stopping transaction scan beyond the local lower bound",
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
          boundarySentToProvider: false,
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
    boundarySentToProvider: false,
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

  // A quiet page is normal: the local bound always walks past the cursor and
  // stops at the page that reaches below it (the boundary summary carries the
  // counts).
  if (
    checkpoint?.cursorTimestamp &&
    newestSeenAt &&
    newestSeenAt.getTime() <= checkpoint.cursorTimestamp.getTime() &&
    state.processedTransactions > 0
  ) {
    await input.telemetry.addNote("Local transaction rescan completed without a newer checkpoint row", {
      code: "checkpoint_stalled",
      checkpointTimestamp: checkpoint.cursorTimestamp.toISOString(),
      newestSeenAt: newestSeenAt.toISOString(),
      processed: state.processedTransactions,
      earlyStoppedBeyondBoundary: state.earlyStoppedBeyondBoundary,
    });
  }

  // Whole-ledger completeness. An early-stopped scan reads only the head of
  // the listing, so its fetched rows never match the lifetime total; the
  // ledger must, because every listed row is upserted under fansly:rest and
  // captured rows are never deleted.
  if (state.providerReportedTotal !== null) {
    const ledgerRows = await countTransactionsBySource(app.db, {
      platformAccountId: input.platformAccountId,
      source: "fansly:rest",
    });
    const ledgerDetails = {
      providerReportedTotal: state.providerReportedTotal,
      ledgerRows,
      fetchedRows: state.processedTransactions,
      earlyStoppedBeyondBoundary: state.earlyStoppedBeyondBoundary,
    };
    if (ledgerRows < state.providerReportedTotal) {
      // The hole lies outside this scan's window, so re-reading the window
      // cannot fill it: neither throw nor withhold the checkpoint. It stays
      // an error on every run until a financials re-backfill repairs it.
      await input.telemetry.addAnomaly({
        code: "transactions_ledger_incomplete",
        severity: "error",
        message: "Local Fansly transaction ledger holds fewer rows than the provider-reported total",
        details: ledgerDetails,
      });
    } else if (ledgerRows > state.providerReportedTotal) {
      // Rows the provider stopped listing stay captured, so this never clears.
      await input.telemetry.addNote(
        "Local Fansly transaction ledger holds more rows than the provider-reported total",
        { code: "transactions_ledger_surplus", ...ledgerDetails },
      );
    }
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
  const notedCommissionFallbackIds = new Set<string>();
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

      await rejectFanslyTransactionItemViolation(input.telemetry, page, {
        offset: state.offset,
        snapshotEnd: state.snapshotEnd,
      });

      const pageTotal = page.total;
      if (!isNonNegativeSafeInteger(pageTotal)) {
        await input.telemetry.addAnomaly({
          code: "backfill_total_invalid",
          severity: "error",
          message: "Fansly transaction backfill page omitted a valid non-negative safe-integer total",
          details: {
            currentTotal: pageTotal ?? null,
            offset: state.offset,
            snapshotEnd: state.snapshotEnd,
          },
        });
        throw new Error("Fansly transaction backfill page returned an invalid total");
      }

      providerReportedTotal ??= pageTotal;

      if (
        providerReportedTotal !== null &&
        pageTotal !== providerReportedTotal
      ) {
        await input.telemetry.addAnomaly({
          code: "backfill_total_changed",
          severity: "error",
          message: "Fansly transaction backfill total changed during an offset scan",
          details: {
            initialTotal: providerReportedTotal,
            currentTotal: pageTotal,
            offset: state.offset,
            snapshotEnd: state.snapshotEnd,
          },
        });
        throw new UnstableFanslyBackfillScanError(
          "Fansly transaction backfill total changed during an offset scan",
          "backfill_total_changed",
        );
      }

      if (page.items.length === 0 && !page.done) {
        await input.telemetry.addAnomaly({
          code: "backfill_empty_page_before_done",
          severity: "error",
          message: "Fansly transaction backfill returned an empty page before completion",
          details: {
            total: pageTotal,
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
        pageTotal > 0
      ) {
        await input.telemetry.addAnomaly({
          code: "backfill_empty_head_page",
          severity: "error",
          message: "Fansly head-scan backfill returned an empty first page despite a non-zero total",
          details: {
            total: pageTotal,
            snapshotEnd: state.snapshotEnd,
          },
        });
        throw new Error("Fansly transaction backfill returned an empty first page despite a non-zero total");
      }

      const overlappingIds = findTransactionPageOverlap(state.lastPageTransactionIds, page.items);
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
        throw new UnstableFanslyBackfillScanError(
          "Fansly transaction backfill saw overlapping rows between offset pages",
          "backfill_offset_overlap",
        );
      }

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
        providerReportedTotal: state.providerReportedTotal ?? pageTotal,
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
        notedCommissionFallbackIds,
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

    // After the flush: flushAndClear rewrites the backfill state, so the
    // invalidation must be the last checkpoint write.
    if (error instanceof UnstableFanslyBackfillScanError) {
      await safelyInvalidateFanslyBackfillProgress(app, input, error.reason, error);
    }

    throw error;
  }

  await flushFanslyDirtyRange(
    app,
    input.platformAccountId,
    state.dirtyFrom ? new Date(state.dirtyFrom) : null,
  );

  if (providerReportedTotal !== null && state.processedTransactions !== providerReportedTotal) {
    await input.telemetry.addAnomaly({
      code: "backfill_total_mismatch",
      severity: "error",
      message: "Provider-reported transaction total differed from the fetched transaction rows",
      details: {
        providerReportedTotal,
        fetchedRows: state.processedTransactions,
        pageCount: state.transactionPages,
      },
    });
    throw new Error("Fansly transaction backfill total differed from fetched rows");
  }

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
  // Stage 13 single-writer gate: refuse the whole chunk before any fetch if
  // this page's registered transactions writer is not the Fansly stream.
  await assertPageTransactionsWriter(app, {
    platformAccountId: input.platformAccountId,
    attemptedWriter: "fansly",
  });

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
