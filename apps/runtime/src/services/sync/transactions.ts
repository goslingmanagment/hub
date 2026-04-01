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
import { hydrateFans } from "./fan-hydration.ts";
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

async function syncTransactionsIncremental(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    commissionRate: number;
    requestContext: Parameters<AppContext["adapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
  },
  checkpoint: Awaited<ReturnType<typeof getCheckpoint>>,
) {
  const oldestPendingAt = await getOldestPendingTransactionAt(app.db, input.platformAccountId);
  const lookbackStart = checkpoint?.cursorTimestamp
    ? new Date(
      checkpoint.cursorTimestamp.getTime() -
        app.config.transactionLookbackDays * DAY_MS,
    )
    : null;
  const earliestRescanStart = lookbackStart && oldestPendingAt
    ? (oldestPendingAt < lookbackStart ? oldestPendingAt : lookbackStart)
    : (lookbackStart ?? oldestPendingAt);
  const rescanCapStart = new Date(Date.now() - app.config.transactionRescanCapDays * DAY_MS);
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

  let offset = 0;
  let processed = 0;
  let newestSeenAt: Date | null = checkpoint?.cursorTimestamp ?? null;
  let oldestSeenAt: Date | null = null;
  let pageCount = 0;
  let olderThanBoundaryItems = 0;
  let olderThanBoundaryPages = 0;
  let consecutiveAllOlderPages = 0;
  let firstPageOlderThanBoundaryItems = 0;
  let earlyStoppedBeyondBoundary = false;
  const collectedItems: Awaited<ReturnType<AppContext["adapter"]["getTransactionsPage"]>>["items"] = [];
  const seenUnknownRawTypes = new Set<number>();
  let providerReportedTotal: number | null = null;

  while (true) {
    await assertOwnedPageSyncLease(app.db);
    const page = await app.adapter.getTransactionsPage(
      input.requestContext,
      { after, limit: 100, offset },
    );
    pageCount += 1;
    providerReportedTotal ??= page.total ?? null;

    await persistRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: "earnings_transactions",
      requestParams: { after: after?.toISOString() ?? null, offset, limit: 100 },
      responsePayload: page.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting earnings_transactions raw payload",
    });

    for (const item of page.items) {
      const occurredAt = new Date(item.createdAt);
      collectedItems.push(item);

      if (!oldestSeenAt || occurredAt < oldestSeenAt) {
        oldestSeenAt = occurredAt;
      }
      if (!newestSeenAt || occurredAt > newestSeenAt) {
        newestSeenAt = occurredAt;
      }
    }

    if (after) {
      const olderItemsInPage = page.items.filter((item) => item.createdAt < after.getTime()).length;
      olderThanBoundaryItems += olderItemsInPage;
      if (pageCount === 1) {
        firstPageOlderThanBoundaryItems = olderItemsInPage;
      }
      if (olderItemsInPage > 0 && olderItemsInPage === page.items.length) {
        olderThanBoundaryPages += 1;
        consecutiveAllOlderPages += 1;
      } else {
        consecutiveAllOlderPages = 0;
      }
    }

    processed += page.items.length;
    if (page.done) {
      break;
    }

    // The upstream API returns transactions newest-first. If we see two
    // consecutive full pages where every item is older than the requested
    // lower bound, the API is not honoring the `after` filter and all
    // subsequent pages will only contain even older data. Stop early to
    // avoid exhaustively scanning the full transaction history.
    if (after && consecutiveAllOlderPages >= 2) {
      earlyStoppedBeyondBoundary = true;
      app.logger.warn(
        {
          pageLabel: input.pageLabel,
          platformAccountId: input.platformAccountId,
          after: after.toISOString(),
          pageCount,
          olderThanBoundaryItems,
          olderThanBoundaryPages,
        },
        "Early-stopping transaction scan: upstream API is not honoring the after filter",
      );
      break;
    }

    offset += 100;
  }

  let checkpointAfter = null;
  for (const item of collectedItems) {
    await recordUnknownFanslyTransactionType(app, input, item.type, seenUnknownRawTypes);
  }
  await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
    const fanMap = await hydrateFans(app, {
      db: dbTx,
      platformAccountId: input.platformAccountId,
      requestContext: input.requestContext,
      platformUserIds: collectedItems
        .map((item) => item.correlationAccountId)
        .filter((value): value is string => Boolean(value)),
      telemetry: input.telemetry,
    });

    for (const item of collectedItems) {
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
        newBalanceMills: item.newBalance64 ? toMills(item.newBalance64) : null,
        senderId: item.senderId,
        receiverId: item.receiverId,
        occurredAt: new Date(item.createdAt),
        sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
      });
    }

    if (oldestSeenAt) {
      await rebuildSpenderProjections(dbTx, input.platformAccountId, oldestSeenAt);
      await rebuildRevenueRollups(dbTx, input.platformAccountId, oldestSeenAt);
    }

    if (newestSeenAt) {
      checkpointAfter = await upsertCheckpoint(dbTx, {
        platformAccountId: input.platformAccountId,
        stream: "transactions",
        cursorTimestamp: newestSeenAt,
        state: { pageLabel: input.pageLabel },
        lastSuccessfulRunId: input.syncRunId,
      });
    }
  });

  await input.telemetry.recordCheckpointAdvanced("transactions", summarizeCheckpoint(checkpointAfter));
  input.telemetry.setBoundarySummary({
    kind: "after",
    requestedLowerBound: after?.toISOString() ?? null,
    lookbackStart: lookbackStart?.toISOString() ?? null,
    oldestPendingAt: oldestPendingAt?.toISOString() ?? null,
    rescanCapStart: rescanCapStart.toISOString(),
    lowerBoundClamped: Boolean(after && earliestRescanStart && after.getTime() !== earliestRescanStart.getTime()),
    olderThanBoundaryItems,
    olderThanBoundaryPages,
    earlyStoppedBeyondBoundary,
  });
  input.telemetry.setScanSummary({
    transactionPages: pageCount,
    processedTransactions: processed,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    mode: "incremental",
    earlyStoppedBeyondBoundary,
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
    processed > 0
  ) {
    // When the scan was early-stopped because the upstream API ignored the
    // `after` filter, a stalled checkpoint is the expected outcome — all the
    // scanned items were older than the checkpoint so there is nothing to
    // advance. Downgrade to warn so it doesn't page.
    const severity = earlyStoppedBeyondBoundary ? "warn" : "error";
    await input.telemetry.addAnomaly({
      code: "checkpoint_stalled",
      severity,
      message: "Transaction checkpoint did not advance despite processing transaction pages",
      details: {
        checkpointTimestamp: checkpoint.cursorTimestamp.toISOString(),
        newestSeenAt: newestSeenAt.toISOString(),
        processed,
        earlyStoppedBeyondBoundary,
      },
    });
  }

  if (
    after &&
    (
      (firstPageOlderThanBoundaryItems > 0 && olderThanBoundaryItems > 100) ||
      olderThanBoundaryPages > 1 ||
      (
        oldestSeenAt &&
        oldestSeenAt.getTime() < after.getTime() &&
        checkpoint?.cursorTimestamp &&
        newestSeenAt &&
        newestSeenAt.getTime() <= checkpoint.cursorTimestamp.getTime()
      )
    )
  ) {
    const severity = earlyStoppedBeyondBoundary ? "warn" : "error";
    await input.telemetry.addAnomaly({
      code: "after_ineffective",
      severity,
      message: "The lower-bound transaction filter behaved ineffectively and scanned materially old data",
      details: {
        after: after.toISOString(),
        firstPageOlderThanBoundaryItems,
        olderThanBoundaryItems,
        olderThanBoundaryPages,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        earlyStoppedBeyondBoundary,
      },
    });
  }

  if (providerReportedTotal !== null && providerReportedTotal !== processed) {
    await input.telemetry.addAnomaly({
      code: "transactions_total_mismatch",
      severity: "warn",
      message: "Provider-reported transaction total differed from the fetched transaction rows",
      details: {
        providerReportedTotal,
        fetchedRows: processed,
        pageCount,
      },
    });
  }

  return { processed, newestSeenAt };
}

async function recordTransactionsRuntimeProgress(
  db: AppContext["db"],
  input: {
    platformAccountId: number;
    activeLease?: ActiveSyncLease;
  },
  state: FanslyTransactionBackfillState,
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
    workClass: "history",
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
    activeLease?: ActiveSyncLease;
  },
  checkpoint: Awaited<ReturnType<typeof getCheckpoint>>,
  existingState: FanslyTransactionBackfillState | null,
) {
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
  let providerReportedTotal: number | null = null;

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

      await persistRawPayload(app.db, {
        platformAccountId: input.platformAccountId,
        syncRunId: input.syncRunId,
        endpoint: "earnings_transactions",
        requestParams: {
          after: null,
          before: null,
          offset: state.offset,
          limit: 100,
        },
        responsePayload: page.raw,
        mapperVersion: FANSLY_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting earnings_transactions raw payload",
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
        dirtyFrom: isoDateOrNull(minDate(
          state.dirtyFrom ? new Date(state.dirtyFrom) : null,
          pageOldestSeenAt,
        )),
      };

      for (const item of page.items) {
        await recordUnknownFanslyTransactionType(app, input, item.type, seenUnknownRawTypes);
      }

      await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
        const fanMap = await hydrateFans(app, {
          db: dbTx,
          platformAccountId: input.platformAccountId,
          requestContext: input.requestContext,
          platformUserIds: page.items
            .map((item) => item.correlationAccountId)
            .filter((value): value is string => Boolean(value)),
          telemetry: input.telemetry,
        });

        for (const item of page.items) {
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
            newBalanceMills: item.newBalance64 ? toMills(item.newBalance64) : null,
            senderId: item.senderId,
            receiverId: item.receiverId,
            occurredAt: new Date(item.createdAt),
            sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
          });
        }

        await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.platformAccountId,
          stream: "transactions",
          state: nextState,
        });

        await recordTransactionsRuntimeProgress(dbTx, {
          platformAccountId: input.platformAccountId,
          activeLease: input.activeLease,
        }, nextState, currentRunProcessed + page.items.length);
      });

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
    }
  } catch (error) {
    if (error instanceof PageSyncLeaseLostError) {
      throw error;
    }

    const dirtyFrom = state.dirtyFrom ? new Date(state.dirtyFrom) : null;
    try {
      await flushFanslyDirtyRange(app, input.platformAccountId, dirtyFrom);
      if (dirtyFrom) {
        state = {
          ...state,
          dirtyFrom: null,
        };
        await upsertCheckpointProgress(app.db, {
          platformAccountId: input.platformAccountId,
          stream: "transactions",
          state,
        });
      }
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
    processed: currentRunProcessed,
    newestSeenAt: newestSeenAt ?? snapshotEnd,
  };
}

export async function syncTransactions(
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
) {
  const checkpoint = await getCheckpoint(app.db, input.platformAccountId, "transactions");
  await input.telemetry.recordCheckpointLoaded("transactions", summarizeCheckpoint(checkpoint));

  const backfillState = parseTransactionBackfillState(checkpoint?.state);
  if (backfillState?.provider === "fansly") {
    return syncTransactionsBackfill(app, input, checkpoint, backfillState);
  }

  if (checkpoint?.cursorTimestamp) {
    return syncTransactionsIncremental(app, input, checkpoint);
  }

  return syncTransactionsBackfill(app, input, checkpoint, null);
}
