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
import { toMills } from "@fansly-connect/shared";

import type { AppContext } from "../../bootstrap.ts";
import { prepareHydratedFans } from "./fan-hydration.ts";
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
  const collectedItems: Awaited<ReturnType<AppContext["adapter"]["getTransactionsPage"]>>["items"] = [];

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

    for (const item of page.items) {
      const occurredAt = new Date(item.createdAt);
      collectedItems.push(item);

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

  const hydratedFans = await prepareHydratedFans(app, {
    requestContext: input.requestContext,
    platformUserIds: collectedItems
      .map((item) => item.correlationAccountId)
      .filter((value): value is string => Boolean(value)),
  });

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
        grossAmountMills: toMills(item.amount),
        sourceDestinationAmountMills: toMills(item.destinationAmount),
        creatorNetAmountMills: toMills(item.destinationAmount),
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
      await upsertCheckpoint(tx as typeof app.db, {
        platformAccountId: input.platformAccountId,
        stream: "transactions",
        cursorTimestamp: newestSeenAt,
        state: { pageLabel: input.pageLabel },
        lastSuccessfulRunId: input.syncRunId,
      });
    }
  });

  return { processed, newestSeenAt };
}
