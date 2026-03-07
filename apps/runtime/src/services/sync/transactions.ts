import {
  getCheckpoint,
  getOldestPendingTransactionAt,
  insertRawPayload,
  recalculateFanPageSpend,
  rebuildRevenueRollups,
  upsertCheckpoint,
  upsertFanPage,
  upsertTransaction,
} from "@fansly-connect/db";
import {
  FANSLY_MAPPER_VERSION,
  mapFanslyTransactionState,
  mapFanslyTransactionType,
} from "@fansly-connect/fansly";
import { toMills } from "@fansly-connect/shared";

import type { AppContext } from "../../bootstrap.ts";
import { hydrateFans } from "./fan-hydration.ts";
import { DAY_MS, retentionDate } from "./shared.ts";

export async function syncTransactions(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    requestContext: Parameters<AppContext["adapter"]["getTransactionsPage"]>[0];
    syncRunId: number;
  },
) {
  const checkpoint = await getCheckpoint(app.db, input.platformAccountId, "transactions");
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
  }

  let offset = 0;
  let processed = 0;
  let newestSeenAt: Date | null = checkpoint?.cursorTimestamp ?? null;

  while (true) {
    const page = await app.adapter.getTransactionsPage(
      input.requestContext,
      { after, limit: 100, offset },
    );

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

    const fanMap = await hydrateFans(app, {
      requestContext: input.requestContext,
      platformUserIds: page.items
        .map((item) => item.correlationAccountId)
        .filter((value): value is string => Boolean(value)),
    });

    for (const item of page.items) {
      const fanId = item.correlationAccountId
        ? (fanMap.get(item.correlationAccountId) ?? null)
        : null;
      const occurredAt = new Date(item.createdAt);
      const sourceUpdatedAt = item.updatedAt ? new Date(item.updatedAt) : null;

      await upsertTransaction(app.db, {
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
        amountMills: toMills(item.amount),
        destinationAmountMills: toMills(item.destinationAmount),
        netAmountMills: toMills(item.destinationAmount),
        rawDestinationTax: item.destinationTax,
        newBalanceMills: item.newBalance64 ? toMills(item.newBalance64) : null,
        senderId: item.senderId,
        receiverId: item.receiverId,
        occurredAt,
        sourceUpdatedAt,
      });

      if (fanId) {
        await upsertFanPage(app.db, {
          fanId,
          platformAccountId: input.platformAccountId,
          lastTransactionAt: occurredAt,
        });
      }

      if (!newestSeenAt || occurredAt > newestSeenAt) {
        newestSeenAt = occurredAt;
      }
    }

    processed += page.items.length;
    if (page.done) {
      break;
    }
    offset += 100;
  }

  await recalculateFanPageSpend(app.db, input.platformAccountId);
  await rebuildRevenueRollups(app.db, input.platformAccountId);

  if (newestSeenAt) {
    await upsertCheckpoint(app.db, {
      platformAccountId: input.platformAccountId,
      stream: "transactions",
      cursorTimestamp: newestSeenAt,
      state: { pageLabel: input.pageLabel },
      lastSuccessfulRunId: input.syncRunId,
    });
  }

  return { processed, newestSeenAt };
}
