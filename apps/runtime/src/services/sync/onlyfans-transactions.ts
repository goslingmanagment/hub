import {
  getCheckpoint,
  getOldestPendingTransactionAt,
  insertRawPayload,
  recalculateFanPageSpend,
  rebuildRevenueRollups,
  upsertCheckpoint,
  upsertFanPage,
  upsertFans,
  upsertTransaction,
} from "@fansly-connect/db";
import {
  ONLYMONSTER_MAPPER_VERSION,
  mapOnlyMonsterTransactionState,
  mapOnlyMonsterTransactionType,
  type OnlyMonsterChargeback,
  type OnlyMonsterTransaction,
} from "@fansly-connect/onlyfans";
import { dollarsToMills } from "@fansly-connect/shared";

import type { AppContext } from "../../bootstrap.ts";
import { DAY_MS, retentionDate } from "./shared.ts";

async function upsertOnlyFansForBatch(
  app: AppContext,
  platformAccountId: number,
  fanPlatformIds: string[],
) {
  if (fanPlatformIds.length === 0) {
    return new Map<string, number>();
  }

  const fans = await upsertFans(app.db, Array.from(new Set(fanPlatformIds)).map((platformUserId) => ({
    platform: "onlyfans" as const,
    platformUserId,
    metadata: {},
  })));

  for (const fan of fans) {
    await upsertFanPage(app.db, {
      fanId: fan.id,
      platformAccountId,
    });
  }

  return new Map(fans.map((fan) => [fan.platformUserId, fan.id]));
}

export async function syncOnlyFansTransactions(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    platformAccountIdValue: string;
    requestContext: {
      auth: {
        token: string;
      };
      proxy?: {
        url: string;
        username?: string | null;
        password?: string | null;
      } | null;
    };
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
  const start = earliestRescanStart && earliestRescanStart < rescanCapStart
    ? rescanCapStart
    : (earliestRescanStart ?? rescanCapStart);
  const end = new Date();

  let newestSeenAt: Date | null = checkpoint?.cursorTimestamp ?? null;
  let processedTransactions = 0;
  let processedChargebacks = 0;

  let transactionCursor: string | null = null;
  do {
    const page = await app.onlyFansAdapter.getTransactionsPage(
      input.requestContext,
      input.platformAccountIdValue,
      {
        start,
        end,
        cursor: transactionCursor,
        limit: 100,
      },
    );

    await insertRawPayload(app.db, {
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
    });

    const fanMap = await upsertOnlyFansForBatch(
      app,
      input.platformAccountId,
      page.parsed.items.map((item) => item.fan.id),
    );

    for (const item of page.parsed.items) {
      const amountMills = dollarsToMills(item.amount);
      const fanId = fanMap.get(item.fan.id) ?? null;
      const occurredAt = new Date(item.timestamp);

      await upsertTransaction(app.db, {
        platformAccountId: input.platformAccountId,
        fanId,
        transactionId: item.id,
        correlationAccountId: item.fan.id,
        rawType: item.type,
        canonicalType: mapOnlyMonsterTransactionType(item.type),
        transactionState: mapOnlyMonsterTransactionState(item.status),
        rawStatus: item.status,
        amountMills,
        destinationAmountMills: amountMills,
        netAmountMills: amountMills,
        occurredAt,
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

    processedTransactions += page.parsed.items.length;
    transactionCursor = page.parsed.cursor ?? null;
  } while (transactionCursor);

  let chargebackCursor: string | null = null;
  do {
    const page = await app.onlyFansAdapter.getChargebacksPage(
      input.requestContext,
      input.platformAccountIdValue,
      {
        start,
        end,
        cursor: chargebackCursor,
        limit: 100,
      },
    );

    await insertRawPayload(app.db, {
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
    });

    const fanMap = await upsertOnlyFansForBatch(
      app,
      input.platformAccountId,
      page.parsed.items.map((item) => item.fan.id),
    );

    for (const item of page.parsed.items) {
      const amountMills = -dollarsToMills(item.amount);
      const fanId = fanMap.get(item.fan.id) ?? null;
      const occurredAt = new Date(item.chargeback_timestamp);

      await upsertTransaction(app.db, {
        platformAccountId: input.platformAccountId,
        fanId,
        transactionId: item.id,
        correlationAccountId: item.fan.id,
        rawType: item.type,
        canonicalType: "chargeback",
        transactionState: mapOnlyMonsterTransactionState(item.status),
        rawStatus: item.status,
        amountMills,
        destinationAmountMills: amountMills,
        netAmountMills: amountMills,
        occurredAt,
        sourceUpdatedAt: new Date(item.transaction_timestamp),
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

    processedChargebacks += page.parsed.items.length;
    chargebackCursor = page.parsed.cursor ?? null;
  } while (chargebackCursor);

  await recalculateFanPageSpend(app.db, input.platformAccountId);
  await rebuildRevenueRollups(app.db, input.platformAccountId);

  if (newestSeenAt) {
    await upsertCheckpoint(app.db, {
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

  return {
    processed: processedTransactions + processedChargebacks,
    processedTransactions,
    processedChargebacks,
    newestSeenAt,
  };
}
