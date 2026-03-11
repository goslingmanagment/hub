import {
  deleteTransactionsMissingFromWindow,
  getCheckpoint,
  getOldestPendingTransactionAt,
  rebuildSpenderProjections,
  rebuildRevenueRollups,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertFanPage,
  upsertFans,
  upsertTransaction,
} from "@fansly-connect/db";
import {
  ONLYMONSTER_MAPPER_VERSION,
  mapOnlyMonsterTransactionState,
  mapOnlyMonsterTransactionType,
  OnlyMonsterApiError,
  type OnlyMonsterChargeback,
  type OnlyMonsterTransaction,
} from "@fansly-connect/onlyfans";
import {
  calculateNetMillsFromGross,
  dollarsToMills,
  startOfBusinessDay,
  UTC_TIME_ZONE,
} from "@fansly-connect/shared";

import type { AppContext } from "../../bootstrap.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { DAY_MS, persistRawPayload, retentionDate } from "./shared.ts";
import {
  buildBackfillProgressMessage,
  isoDateOrNull,
  parseTransactionBackfillState,
  type OnlyFansTransactionBackfillState,
} from "./transaction-backfill.ts";

const ONLYFANS_EPOCH_BACKFILL_START = new Date("1970-01-01T00:00:00.000Z");
const ONLYFANS_FALLBACK_BACKFILL_START = new Date("2020-01-01T00:00:00.000Z");

function buildOnlyFansFanInputs(
  fanPlatformIds: string[],
) {
  if (fanPlatformIds.length === 0) {
    return [];
  }

  return Array.from(new Set(fanPlatformIds)).map((platformUserId) => ({
    platform: "onlyfans" as const,
    platformUserId,
    metadata: {},
  }));
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

function parseOnlyFansMetadataAccountCreatedAt(metadata: Record<string, unknown>) {
  const value = metadata.accountCreatedAt;
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isOnlyFansBackfillRangeError(error: unknown) {
  if (!(error instanceof OnlyMonsterApiError)) {
    return false;
  }

  if (![400, 422].includes(error.status ?? 0)) {
    return false;
  }

  const details = `${error.message} ${error.responseSnippet ?? ""}`.toLowerCase();
  return ["range", "start", "date", "before", "after", "old", "invalid"].some((term) =>
    details.includes(term)
  );
}

async function flushOnlyFansDirtyRange(
  app: AppContext,
  platformAccountId: number,
  dirtyFrom: Date | null,
) {
  if (!dirtyFrom) {
    return;
  }

  await rebuildSpenderProjections(app.db, platformAccountId, dirtyFrom);
  await rebuildRevenueRollups(app.db, platformAccountId, dirtyFrom);
}

async function syncOnlyFansTransactionsIncremental(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    platformAccountIdValue: string;
    commissionRate: number;
    rescanStart?: Date | null;
    requestContext: Parameters<AppContext["onlyFansAdapter"]["getTransactionsPage"]>[0];
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
  const rescanCapStart = startOfBusinessDay(
    new Date(Date.now() - app.config.transactionRescanCapDays * DAY_MS),
    UTC_TIME_ZONE,
  );
  const start = input.rescanStart ?? (
    earliestRescanStart && earliestRescanStart < rescanCapStart
      ? rescanCapStart
      : (earliestRescanStart ?? rescanCapStart)
  );
  const end = new Date();

  if (start >= end) {
    throw new Error(`OnlyFans transaction rescan start must be before ${end.toISOString()}`);
  }

  if (input.rescanStart) {
    await input.telemetry.addNote("Manual rescan override was applied", {
      start: input.rescanStart.toISOString(),
    });
  }

  let newestSeenAt: Date | null = checkpoint?.cursorTimestamp ?? null;
  let oldestSeenAt: Date | null = null;
  let processedTransactions = 0;
  let processedChargebacks = 0;
  let transactionPages = 0;
  let chargebackPages = 0;
  let olderThanBoundaryItems = 0;
  let olderThanBoundaryPages = 0;
  const sourceTransactionIds = new Set<string>();
  const transactionsToUpsert: Array<OnlyMonsterTransaction> = [];
  const chargebacksToUpsert: Array<OnlyMonsterChargeback> = [];
  const fanPlatformIds = new Set<string>();

  let transactionCursor: string | null = null;
  let transactionPageIndex = 0;
  do {
    const page = await app.onlyFansAdapter.getTransactionsPage(
      input.requestContext,
      input.platformAccountIdValue,
      {
        start,
        end,
        cursor: transactionCursor,
        limit: 100,
        pageIndex: transactionPageIndex,
      },
    );
    transactionPages += 1;

    await persistRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: "onlymonster_transactions",
      requestParams: {
        start: start.toISOString(),
        end: end.toISOString(),
        cursor: transactionCursor,
        limit: 100,
      },
      responsePayload: page.raw,
      mapperVersion: ONLYMONSTER_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting onlymonster_transactions raw payload",
    });

    for (const item of page.parsed.items) {
      fanPlatformIds.add(item.fan.id);
      transactionsToUpsert.push(item);
      sourceTransactionIds.add(item.id);
      const occurredAt = new Date(item.timestamp);

      oldestSeenAt = minDate(oldestSeenAt, occurredAt);
      newestSeenAt = maxDate(newestSeenAt, occurredAt);
    }

    const olderItemsInPage = page.parsed.items.filter(
      (item) => new Date(item.timestamp).getTime() < start.getTime(),
    ).length;
    olderThanBoundaryItems += olderItemsInPage;
    if (olderItemsInPage > 0 && olderItemsInPage === page.parsed.items.length) {
      olderThanBoundaryPages += 1;
    }

    processedTransactions += page.parsed.items.length;
    transactionCursor = page.parsed.cursor ?? null;
    transactionPageIndex += 1;
  } while (transactionCursor);

  let chargebackCursor: string | null = null;
  let chargebackPageIndex = 0;
  do {
    const page = await app.onlyFansAdapter.getChargebacksPage(
      input.requestContext,
      input.platformAccountIdValue,
      {
        start,
        end,
        cursor: chargebackCursor,
        limit: 100,
        pageIndex: chargebackPageIndex,
      },
    );
    chargebackPages += 1;

    await persistRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: "onlymonster_chargebacks",
      requestParams: {
        start: start.toISOString(),
        end: end.toISOString(),
        cursor: chargebackCursor,
        limit: 100,
      },
      responsePayload: page.raw,
      mapperVersion: ONLYMONSTER_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting onlymonster_chargebacks raw payload",
    });

    for (const item of page.parsed.items) {
      fanPlatformIds.add(item.fan.id);
      chargebacksToUpsert.push(item);
      sourceTransactionIds.add(item.id);
      const occurredAt = new Date(item.chargeback_timestamp);

      oldestSeenAt = minDate(oldestSeenAt, occurredAt);
      newestSeenAt = maxDate(newestSeenAt, occurredAt);
    }

    const olderItemsInPage = page.parsed.items.filter(
      (item) => new Date(item.chargeback_timestamp).getTime() < start.getTime(),
    ).length;
    olderThanBoundaryItems += olderItemsInPage;
    if (olderItemsInPage > 0 && olderItemsInPage === page.parsed.items.length) {
      olderThanBoundaryPages += 1;
    }

    processedChargebacks += page.parsed.items.length;
    chargebackCursor = page.parsed.cursor ?? null;
    chargebackPageIndex += 1;
  } while (chargebackCursor);

  let checkpointAfter = null;
  await app.db.transaction(async (tx) => {
    const fans = await upsertFans(
      tx as typeof app.db,
      buildOnlyFansFanInputs(Array.from(fanPlatformIds)),
    );
    const fanMap = new Map(fans.map((fan) => [fan.platformUserId, fan.id]));

    for (const fan of fans) {
      await upsertFanPage(tx as typeof app.db, {
        fanId: fan.id,
        platformAccountId: input.platformAccountId,
      });
    }

    for (const item of transactionsToUpsert) {
      const grossAmountMills = dollarsToMills(item.amount);
      const creatorNetAmountMills = calculateNetMillsFromGross(
        grossAmountMills,
        input.commissionRate,
      );

      await upsertTransaction(tx as typeof app.db, {
        platformAccountId: input.platformAccountId,
        fanId: fanMap.get(item.fan.id) ?? null,
        transactionId: item.id,
        correlationAccountId: item.fan.id,
        rawType: item.type,
        canonicalType: mapOnlyMonsterTransactionType(item.type),
        transactionState: mapOnlyMonsterTransactionState(item.status),
        rawStatus: item.status,
        grossAmountMills,
        sourceDestinationAmountMills: grossAmountMills,
        creatorNetAmountMills,
        occurredAt: new Date(item.timestamp),
      });
    }

    for (const item of chargebacksToUpsert) {
      const grossAmountMills = -dollarsToMills(item.amount);
      const creatorNetAmountMills = calculateNetMillsFromGross(
        grossAmountMills,
        input.commissionRate,
      );

      await upsertTransaction(tx as typeof app.db, {
        platformAccountId: input.platformAccountId,
        fanId: fanMap.get(item.fan.id) ?? null,
        transactionId: item.id,
        correlationAccountId: item.fan.id,
        rawType: item.type,
        canonicalType: "chargeback",
        transactionState: mapOnlyMonsterTransactionState(item.status),
        rawStatus: item.status,
        grossAmountMills,
        sourceDestinationAmountMills: grossAmountMills,
        creatorNetAmountMills,
        occurredAt: new Date(item.chargeback_timestamp),
        sourceUpdatedAt: new Date(item.transaction_timestamp),
      });
    }

    if (processedTransactions > 0) {
      await deleteTransactionsMissingFromWindow(tx as typeof app.db, {
        platformAccountId: input.platformAccountId,
        from: start,
        to: end,
        keepTransactionIds: Array.from(sourceTransactionIds),
      });
    }
    await rebuildSpenderProjections(tx as typeof app.db, input.platformAccountId);
    await rebuildRevenueRollups(tx as typeof app.db, input.platformAccountId);

    if (newestSeenAt) {
      checkpointAfter = await upsertCheckpoint(tx as typeof app.db, {
        platformAccountId: input.platformAccountId,
        stream: "transactions",
        cursorTimestamp: newestSeenAt,
        state: {
          pageLabel: input.pageLabel,
          processedTransactions,
          processedChargebacks,
        },
        lastSuccessfulRunId: input.syncRunId,
      });
    }
  });

  await input.telemetry.recordCheckpointAdvanced("transactions", summarizeCheckpoint(checkpointAfter));
  input.telemetry.setBoundarySummary({
    kind: "start",
    requestedLowerBound: start.toISOString(),
    end: end.toISOString(),
    lookbackStart: lookbackStart?.toISOString() ?? null,
    oldestPendingAt: oldestPendingAt?.toISOString() ?? null,
    rescanCapStart: rescanCapStart.toISOString(),
    olderThanBoundaryItems,
    olderThanBoundaryPages,
  });
  input.telemetry.setScanSummary({
    transactionPages,
    chargebackPages,
    processedTransactions,
    processedChargebacks,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    deleteWindowApplied: processedTransactions > 0,
    mode: "incremental",
  });
  if (processedTransactions > 0) {
    await input.telemetry.addNote("Delete-missing-in-window cleanup was applied to the OnlyFans transaction scan", {
      from: start.toISOString(),
      to: end.toISOString(),
      keptTransactionIds: sourceTransactionIds.size,
    });
  }

  if (oldestPendingAt && oldestPendingAt < rescanCapStart) {
    await input.telemetry.addAnomaly({
      code: "rescan_cap_clamped",
      severity: "warn",
      message: "OnlyFans scan window was clamped by the configured rescan cap",
      details: {
        oldestPendingAt: oldestPendingAt.toISOString(),
        rescanCapStart: rescanCapStart.toISOString(),
      },
    });
  }

  if (lookbackStart && start.getTime() < lookbackStart.getTime() - DAY_MS) {
    await input.telemetry.addAnomaly({
      code: "wide_rescan",
      severity: "warn",
      message: "OnlyFans scan expanded materially beyond the normal incremental lookback window",
      details: {
        start: start.toISOString(),
        lookbackStart: lookbackStart.toISOString(),
      },
    });
  }

  if (
    checkpoint?.cursorTimestamp &&
    newestSeenAt &&
    newestSeenAt.getTime() <= checkpoint.cursorTimestamp.getTime() &&
    (processedTransactions + processedChargebacks) > 0
  ) {
    await input.telemetry.addAnomaly({
      code: "checkpoint_stalled",
      severity: "error",
      message: "OnlyFans transaction checkpoint did not advance despite scanning source data",
      details: {
        checkpointTimestamp: checkpoint.cursorTimestamp.toISOString(),
        newestSeenAt: newestSeenAt.toISOString(),
      },
    });
  }

  if (
    olderThanBoundaryPages > 1 ||
    (
      olderThanBoundaryItems > 100 &&
      checkpoint?.cursorTimestamp &&
      newestSeenAt &&
      newestSeenAt.getTime() <= checkpoint.cursorTimestamp.getTime()
    )
  ) {
    await input.telemetry.addAnomaly({
      code: "after_ineffective",
      severity: "error",
      message: "The OnlyFans lower-bound filter behaved ineffectively and scanned materially old data",
      details: {
        start: start.toISOString(),
        olderThanBoundaryItems,
        olderThanBoundaryPages,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
      },
    });
  }

  return {
    processed: processedTransactions + processedChargebacks,
    processedTransactions,
    processedChargebacks,
    newestSeenAt,
  };
}

async function fetchOnlyFansBackfillTransactionsPage(
  app: AppContext,
  input: {
    platformAccountIdValue: string;
    requestContext: Parameters<AppContext["onlyFansAdapter"]["getTransactionsPage"]>[0];
    pageMetadata: Record<string, unknown>;
    telemetry: SyncRunTelemetry;
  },
  state: OnlyFansTransactionBackfillState,
  pageIndex: number,
  end: Date,
) {
  try {
    return {
      page: await app.onlyFansAdapter.getTransactionsPage(
        input.requestContext,
        input.platformAccountIdValue,
        {
          start: new Date(state.start),
          end,
          cursor: state.cursor,
          limit: 100,
          pageIndex,
        },
      ),
      state,
    };
  } catch (error) {
    if (
      state.transactionPages === 0 &&
      state.chargebackPages === 0 &&
      state.start === ONLYFANS_EPOCH_BACKFILL_START.toISOString() &&
      isOnlyFansBackfillRangeError(error)
    ) {
      const fallbackStart = parseOnlyFansMetadataAccountCreatedAt(input.pageMetadata) ??
        ONLYFANS_FALLBACK_BACKFILL_START;
      const nextState: OnlyFansTransactionBackfillState = {
        ...state,
        start: fallbackStart.toISOString(),
        fallbackStartUsed: true,
      };
      await input.telemetry.addNote("OnlyFans full-history backfill start was clamped after provider rejection", {
        rejectedStart: state.start,
        fallbackStart: nextState.start,
      });
      return {
        page: await app.onlyFansAdapter.getTransactionsPage(
          input.requestContext,
          input.platformAccountIdValue,
          {
            start: fallbackStart,
            end,
            cursor: null,
            limit: 100,
            pageIndex,
          },
        ),
        state: nextState,
      };
    }

    throw error;
  }
}

async function syncOnlyFansTransactionsBackfill(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    platformAccountIdValue: string;
    pageMetadata: Record<string, unknown>;
    commissionRate: number;
    rescanStart?: Date | null;
    requestContext: Parameters<AppContext["onlyFansAdapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
  },
  existingState: OnlyFansTransactionBackfillState | null,
) {
  if (existingState && input.rescanStart) {
    throw new Error("Manual OnlyFans transaction rescans are not allowed while an incomplete backfill exists");
  }

  let state: OnlyFansTransactionBackfillState = existingState ?? {
    mode: "backfill",
    completed: false,
    provider: "onlyfans",
    phase: "transactions",
    snapshotEnd: new Date().toISOString(),
    newestSeenAt: null,
    dirtyFrom: null,
    processedTransactions: 0,
    processedChargebacks: 0,
    transactionPages: 0,
    chargebackPages: 0,
    start: ONLYFANS_EPOCH_BACKFILL_START.toISOString(),
    fallbackStartUsed: false,
    cursor: null,
  };

  const end = new Date(state.snapshotEnd);
  let oldestSeenAt: Date | null = null;
  let newestSeenAt = state.newestSeenAt ? new Date(state.newestSeenAt) : null;
  let currentRunProcessedTransactions = 0;
  let currentRunProcessedChargebacks = 0;

  await input.telemetry.addNote(
    existingState
      ? "Resuming incomplete OnlyFans transaction backfill"
      : "Starting OnlyFans full-history transaction backfill",
    {
      snapshotEnd: state.snapshotEnd,
      start: state.start,
      phase: state.phase,
      processedTransactions: state.processedTransactions,
      processedChargebacks: state.processedChargebacks,
    },
  );

  input.telemetry.setBoundarySummary({
    kind: "backfill",
    requestedLowerBound: state.start,
    end: state.snapshotEnd,
    phase: state.phase,
    fallbackStartUsed: state.fallbackStartUsed,
  });
  input.telemetry.setScanSummary({
    mode: "backfill",
    phase: state.phase,
    transactionPages: state.transactionPages,
    chargebackPages: state.chargebackPages,
    processedTransactions: state.processedTransactions,
    processedChargebacks: state.processedChargebacks,
    processedTransactionsThisRun: currentRunProcessedTransactions,
    processedChargebacksThisRun: currentRunProcessedChargebacks,
    oldestSeenAt: null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    fallbackStartUsed: state.fallbackStartUsed,
  });

  try {
    while (true) {
      if (state.phase === "transactions") {
        const pageResult = await fetchOnlyFansBackfillTransactionsPage(
          app,
          {
            platformAccountIdValue: input.platformAccountIdValue,
            requestContext: input.requestContext,
            pageMetadata: input.pageMetadata,
            telemetry: input.telemetry,
          },
          state,
          state.transactionPages,
          end,
        );
        state = pageResult.state;
        const page = pageResult.page;

        await persistRawPayload(app.db, {
          platformAccountId: input.platformAccountId,
          syncRunId: input.syncRunId,
          endpoint: "onlymonster_transactions",
          requestParams: {
            start: state.start,
            end: end.toISOString(),
            cursor: state.cursor,
            limit: 100,
          },
          responsePayload: page.raw,
          mapperVersion: ONLYMONSTER_MAPPER_VERSION,
          payloadKind: "mapping_critical",
          retainUntil: retentionDate(),
        }, {
          action: "inserting onlymonster_transactions raw payload",
        });

        const pageOldestSeenAt = page.parsed.items.reduce<Date | null>(
          (oldest, item) => minDate(oldest, new Date(item.timestamp)),
          null,
        );
        const pageNewestSeenAt = page.parsed.items.reduce<Date | null>(
          (latest, item) => maxDate(latest, new Date(item.timestamp)),
          null,
        );
        oldestSeenAt = minDate(oldestSeenAt, pageOldestSeenAt);
        newestSeenAt = maxDate(newestSeenAt, pageNewestSeenAt);

        const fanPlatformIds = Array.from(new Set(page.parsed.items.map((item) => item.fan.id)));
        const nextCursor = page.parsed.cursor ?? null;
        const nextState: OnlyFansTransactionBackfillState = {
          ...state,
          phase: nextCursor ? "transactions" : "chargebacks",
          cursor: nextCursor,
          transactionPages: state.transactionPages + 1,
          processedTransactions: state.processedTransactions + page.parsed.items.length,
          newestSeenAt: isoDateOrNull(newestSeenAt),
          dirtyFrom: isoDateOrNull(minDate(
            state.dirtyFrom ? new Date(state.dirtyFrom) : null,
            pageOldestSeenAt,
          )),
        };

        await app.db.transaction(async (tx) => {
          const dbTx = tx as typeof app.db;
          const fans = await upsertFans(dbTx, buildOnlyFansFanInputs(fanPlatformIds));
          const fanMap = new Map(fans.map((fan) => [fan.platformUserId, fan.id]));

          for (const fan of fans) {
            await upsertFanPage(dbTx, {
              fanId: fan.id,
              platformAccountId: input.platformAccountId,
            });
          }

          for (const item of page.parsed.items) {
            const grossAmountMills = dollarsToMills(item.amount);
            const creatorNetAmountMills = calculateNetMillsFromGross(
              grossAmountMills,
              input.commissionRate,
            );

            await upsertTransaction(dbTx, {
              platformAccountId: input.platformAccountId,
              fanId: fanMap.get(item.fan.id) ?? null,
              transactionId: item.id,
              correlationAccountId: item.fan.id,
              rawType: item.type,
              canonicalType: mapOnlyMonsterTransactionType(item.type),
              transactionState: mapOnlyMonsterTransactionState(item.status),
              rawStatus: item.status,
              grossAmountMills,
              sourceDestinationAmountMills: grossAmountMills,
              creatorNetAmountMills,
              occurredAt: new Date(item.timestamp),
            });
          }

          await upsertCheckpointProgress(dbTx, {
            platformAccountId: input.platformAccountId,
            stream: "transactions",
            state: nextState,
          });
        });

        state = nextState;
        currentRunProcessedTransactions += page.parsed.items.length;

        const progressMessage = buildBackfillProgressMessage({
          provider: "onlyfans",
          phase: "transactions",
          page: state.transactionPages,
          processedTransactions: state.processedTransactions,
          processedChargebacks: state.processedChargebacks,
          oldestSeenAt,
          newestSeenAt,
        });
        await input.telemetry.addNote(progressMessage, {
          phase: "transactions",
          page: state.transactionPages,
          processedTransactions: state.processedTransactions,
          processedChargebacks: state.processedChargebacks,
          oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
          newestSeenAt: newestSeenAt?.toISOString() ?? null,
        });
        app.logger.info({
          pageLabel: input.pageLabel,
          platformAccountId: input.platformAccountId,
          provider: "onlyfans",
          stream: "transactions",
          phase: "transactions",
          page: state.transactionPages,
          processedTransactions: state.processedTransactions,
          processedChargebacks: state.processedChargebacks,
          oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
          newestSeenAt: newestSeenAt?.toISOString() ?? null,
          fallbackStartUsed: state.fallbackStartUsed,
        }, progressMessage);
        input.telemetry.setScanSummary({
          mode: "backfill",
          phase: state.phase,
          transactionPages: state.transactionPages,
          chargebackPages: state.chargebackPages,
          processedTransactions: state.processedTransactions,
          processedChargebacks: state.processedChargebacks,
          processedTransactionsThisRun: currentRunProcessedTransactions,
          processedChargebacksThisRun: currentRunProcessedChargebacks,
          oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
          newestSeenAt: newestSeenAt?.toISOString() ?? null,
          fallbackStartUsed: state.fallbackStartUsed,
        });

        continue;
      }

      const page = await app.onlyFansAdapter.getChargebacksPage(
        input.requestContext,
        input.platformAccountIdValue,
        {
          start: new Date(state.start),
          end,
          cursor: state.cursor,
          limit: 100,
          pageIndex: state.chargebackPages,
        },
      );

      await persistRawPayload(app.db, {
        platformAccountId: input.platformAccountId,
        syncRunId: input.syncRunId,
        endpoint: "onlymonster_chargebacks",
        requestParams: {
          start: state.start,
          end: end.toISOString(),
          cursor: state.cursor,
          limit: 100,
        },
        responsePayload: page.raw,
        mapperVersion: ONLYMONSTER_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting onlymonster_chargebacks raw payload",
      });

      const pageOldestSeenAt = page.parsed.items.reduce<Date | null>(
        (oldest, item) => minDate(oldest, new Date(item.chargeback_timestamp)),
        null,
      );
      const pageNewestSeenAt = page.parsed.items.reduce<Date | null>(
        (latest, item) => maxDate(latest, new Date(item.chargeback_timestamp)),
        null,
      );
      oldestSeenAt = minDate(oldestSeenAt, pageOldestSeenAt);
      newestSeenAt = maxDate(newestSeenAt, pageNewestSeenAt);

      const fanPlatformIds = Array.from(new Set(page.parsed.items.map((item) => item.fan.id)));
      const nextCursor = page.parsed.cursor ?? null;
      const nextState: OnlyFansTransactionBackfillState = {
        ...state,
        cursor: nextCursor,
        chargebackPages: state.chargebackPages + 1,
        processedChargebacks: state.processedChargebacks + page.parsed.items.length,
        newestSeenAt: isoDateOrNull(newestSeenAt),
        dirtyFrom: isoDateOrNull(minDate(
          state.dirtyFrom ? new Date(state.dirtyFrom) : null,
          pageOldestSeenAt,
        )),
      };

      await app.db.transaction(async (tx) => {
        const dbTx = tx as typeof app.db;
        const fans = await upsertFans(dbTx, buildOnlyFansFanInputs(fanPlatformIds));
        const fanMap = new Map(fans.map((fan) => [fan.platformUserId, fan.id]));

        for (const fan of fans) {
          await upsertFanPage(dbTx, {
            fanId: fan.id,
            platformAccountId: input.platformAccountId,
          });
        }

        for (const item of page.parsed.items) {
          const grossAmountMills = -dollarsToMills(item.amount);
          const creatorNetAmountMills = calculateNetMillsFromGross(
            grossAmountMills,
            input.commissionRate,
          );

          await upsertTransaction(dbTx, {
            platformAccountId: input.platformAccountId,
            fanId: fanMap.get(item.fan.id) ?? null,
            transactionId: item.id,
            correlationAccountId: item.fan.id,
            rawType: item.type,
            canonicalType: "chargeback",
            transactionState: mapOnlyMonsterTransactionState(item.status),
            rawStatus: item.status,
            grossAmountMills,
            sourceDestinationAmountMills: grossAmountMills,
            creatorNetAmountMills,
            occurredAt: new Date(item.chargeback_timestamp),
            sourceUpdatedAt: new Date(item.transaction_timestamp),
          });
        }

        await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.platformAccountId,
          stream: "transactions",
          state: nextState,
        });
      });

      state = nextState;
      currentRunProcessedChargebacks += page.parsed.items.length;

      const progressMessage = buildBackfillProgressMessage({
        provider: "onlyfans",
        phase: "chargebacks",
        page: state.chargebackPages,
        processedTransactions: state.processedTransactions,
        processedChargebacks: state.processedChargebacks,
        oldestSeenAt,
        newestSeenAt,
      });
      await input.telemetry.addNote(progressMessage, {
        phase: "chargebacks",
        page: state.chargebackPages,
        processedTransactions: state.processedTransactions,
        processedChargebacks: state.processedChargebacks,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        newestSeenAt: newestSeenAt?.toISOString() ?? null,
      });
      app.logger.info({
        pageLabel: input.pageLabel,
        platformAccountId: input.platformAccountId,
        provider: "onlyfans",
        stream: "transactions",
        phase: "chargebacks",
        page: state.chargebackPages,
        processedTransactions: state.processedTransactions,
        processedChargebacks: state.processedChargebacks,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        newestSeenAt: newestSeenAt?.toISOString() ?? null,
        fallbackStartUsed: state.fallbackStartUsed,
      }, progressMessage);
      input.telemetry.setScanSummary({
        mode: "backfill",
        phase: "chargebacks",
        transactionPages: state.transactionPages,
        chargebackPages: state.chargebackPages,
        processedTransactions: state.processedTransactions,
        processedChargebacks: state.processedChargebacks,
        processedTransactionsThisRun: currentRunProcessedTransactions,
        processedChargebacksThisRun: currentRunProcessedChargebacks,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
        newestSeenAt: newestSeenAt?.toISOString() ?? null,
        fallbackStartUsed: state.fallbackStartUsed,
      });

      if (!page.parsed.cursor) {
        break;
      }
    }
  } catch (error) {
    const dirtyFrom = state.dirtyFrom ? new Date(state.dirtyFrom) : null;
    await flushOnlyFansDirtyRange(app, input.platformAccountId, dirtyFrom);
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

    throw error;
  }

  await flushOnlyFansDirtyRange(
    app,
    input.platformAccountId,
    state.dirtyFrom ? new Date(state.dirtyFrom) : null,
  );

  const checkpointAfter = await upsertCheckpoint(app.db, {
    platformAccountId: input.platformAccountId,
    stream: "transactions",
    cursorTimestamp: newestSeenAt ?? end,
    state: {
      pageLabel: input.pageLabel,
      processedTransactions: state.processedTransactions,
      processedChargebacks: state.processedChargebacks,
    },
    lastSuccessfulRunId: input.syncRunId,
  });

  await input.telemetry.recordCheckpointAdvanced("transactions", summarizeCheckpoint(checkpointAfter));
  input.telemetry.setBoundarySummary({
    kind: "backfill",
    requestedLowerBound: state.start,
    end: state.snapshotEnd,
    phase: "complete",
    fallbackStartUsed: state.fallbackStartUsed,
  });
  input.telemetry.setScanSummary({
    mode: "backfill",
    phase: "complete",
    transactionPages: state.transactionPages,
    chargebackPages: state.chargebackPages,
    processedTransactions: state.processedTransactions,
    processedChargebacks: state.processedChargebacks,
    processedTransactionsThisRun: currentRunProcessedTransactions,
    processedChargebacksThisRun: currentRunProcessedChargebacks,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
    fallbackStartUsed: state.fallbackStartUsed,
  });

  return {
    processed: currentRunProcessedTransactions + currentRunProcessedChargebacks,
    processedTransactions: currentRunProcessedTransactions,
    processedChargebacks: currentRunProcessedChargebacks,
    newestSeenAt: newestSeenAt ?? end,
  };
}

export async function syncOnlyFansTransactions(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    platformAccountIdValue: string;
    pageMetadata: Record<string, unknown>;
    commissionRate: number;
    rescanStart?: Date | null;
    requestContext: Parameters<AppContext["onlyFansAdapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
  },
) {
  const checkpoint = await getCheckpoint(app.db, input.platformAccountId, "transactions");
  await input.telemetry.recordCheckpointLoaded("transactions", summarizeCheckpoint(checkpoint));

  const backfillState = parseTransactionBackfillState(checkpoint?.state);
  if (backfillState?.provider === "onlyfans") {
    return syncOnlyFansTransactionsBackfill(app, input, backfillState);
  }

  if (checkpoint?.cursorTimestamp) {
    return syncOnlyFansTransactionsIncremental(app, input, checkpoint);
  }

  return syncOnlyFansTransactionsBackfill(app, input, null);
}
