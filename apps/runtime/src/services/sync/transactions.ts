import {
  getCheckpoint,
  getOldestPendingTransactionAt,
  insertRawPayload,
  rebuildSpenderProjections,
  rebuildRevenueRollups,
  upsertCheckpoint,
  upsertFanPage,
  upsertFans,
  upsertTransaction,
} from "@fansly-connect/db";
import {
  FANSLY_MAPPER_VERSION,
  mapFanslyTransactionState,
  mapFanslyTransactionType,
} from "@fansly-connect/fansly";
import { calculateGrossMillsFromNet, toMills } from "@fansly-connect/shared";

import type { AppContext } from "../../bootstrap.ts";
import { prepareHydratedFans } from "./fan-hydration.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { DAY_MS, retentionDate } from "./shared.ts";

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

export async function syncTransactions(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    commissionRate: number;
    requestContext: Parameters<AppContext["adapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
  },
) {
  const checkpoint = await getCheckpoint(app.db, input.platformAccountId, "transactions");
  await input.telemetry.recordCheckpointLoaded("transactions", summarizeCheckpoint(checkpoint));
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
  let firstPageOlderThanBoundaryItems = 0;
  const collectedItems: Awaited<ReturnType<AppContext["adapter"]["getTransactionsPage"]>>["items"] = [];

  while (true) {
    const page = await app.adapter.getTransactionsPage(
      input.requestContext,
      { after, limit: 100, offset },
    );
    pageCount += 1;

    await insertRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: "earnings_transactions",
      requestParams: { after: after?.toISOString() ?? null, offset, limit: 100 },
      responsePayload: page.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
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
      }
    }

    processed += page.items.length;
    if (page.done) {
      break;
    }
    offset += 100;
  }

  const hydratedFans = await prepareHydratedFans(app, {
    requestContext: input.requestContext,
    platformUserIds: collectedItems
      .map((item) => item.correlationAccountId)
      .filter((value): value is string => Boolean(value)),
    telemetry: input.telemetry,
  });

  let checkpointAfter = null;
  await app.db.transaction(async (tx) => {
    const fans = await upsertFans(tx as typeof app.db, hydratedFans);
    const fanMap = new Map(fans.map((fan) => [fan.platformUserId, fan.id]));

    for (const fan of fans) {
      await upsertFanPage(tx as typeof app.db, {
        fanId: fan.id,
        platformAccountId: input.platformAccountId,
      });
    }

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
      // Live Fansly earnings rows currently repeat creator-net in both amount fields.
      const grossAmountMills = sourceAmountMills === destinationAmountMills
        ? calculateGrossMillsFromNet(creatorNetAmountMills, commissionRate)
        : sourceAmountMills;

      await upsertTransaction(tx as typeof app.db, {
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

    await rebuildSpenderProjections(tx as typeof app.db, input.platformAccountId);
    await rebuildRevenueRollups(tx as typeof app.db, input.platformAccountId);

    if (newestSeenAt) {
      checkpointAfter = await upsertCheckpoint(tx as typeof app.db, {
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
  });
  input.telemetry.setScanSummary({
    transactionPages: pageCount,
    processedTransactions: processed,
    oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
    newestSeenAt: newestSeenAt?.toISOString() ?? null,
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
    await input.telemetry.addAnomaly({
      code: "checkpoint_stalled",
      severity: "error",
      message: "Transaction checkpoint did not advance despite processing transaction pages",
      details: {
        checkpointTimestamp: checkpoint.cursorTimestamp.toISOString(),
        newestSeenAt: newestSeenAt.toISOString(),
        processed,
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
    await input.telemetry.addAnomaly({
      code: "after_ineffective",
      severity: "error",
      message: "The lower-bound transaction filter behaved ineffectively and scanned materially old data",
      details: {
        after: after.toISOString(),
        firstPageOlderThanBoundaryItems,
        olderThanBoundaryItems,
        olderThanBoundaryPages,
        oldestSeenAt: oldestSeenAt?.toISOString() ?? null,
      },
    });
  }

  return { processed, newestSeenAt };
}
