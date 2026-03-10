import {
  deleteTransactionsMissingFromWindow,
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
  ONLYMONSTER_MAPPER_VERSION,
  mapOnlyMonsterTransactionState,
  mapOnlyMonsterTransactionType,
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
import { DAY_MS, retentionDate } from "./shared.ts";

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

export async function syncOnlyFansTransactions(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    platformAccountIdValue: string;
    commissionRate: number;
    rescanStart?: Date | null;
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

  let newestSeenAt: Date | null = checkpoint?.cursorTimestamp ?? null;
  let processedTransactions = 0;
  let processedChargebacks = 0;
  const sourceTransactionIds = new Set<string>();
  const transactionsToUpsert: Array<OnlyMonsterTransaction> = [];
  const chargebacksToUpsert: Array<OnlyMonsterChargeback> = [];
  const fanPlatformIds = new Set<string>();

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

    for (const item of page.parsed.items) {
      fanPlatformIds.add(item.fan.id);
      transactionsToUpsert.push(item);
      sourceTransactionIds.add(item.id);
      const occurredAt = new Date(item.timestamp);

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

    for (const item of page.parsed.items) {
      fanPlatformIds.add(item.fan.id);
      chargebacksToUpsert.push(item);
      sourceTransactionIds.add(item.id);
      const occurredAt = new Date(item.chargeback_timestamp);

      if (!newestSeenAt || occurredAt > newestSeenAt) {
        newestSeenAt = occurredAt;
      }
    }

    processedChargebacks += page.parsed.items.length;
    chargebackCursor = page.parsed.cursor ?? null;
  } while (chargebackCursor);

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
      await upsertCheckpoint(tx as typeof app.db, {
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

  return {
    processed: processedTransactions + processedChargebacks,
    processedTransactions,
    processedChargebacks,
    newestSeenAt,
  };
}
