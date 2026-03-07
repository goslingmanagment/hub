import { sql } from "drizzle-orm";

import {
  mapFanslySubscriptionStatus,
  mapFanslyTransactionState,
  mapFanslyTransactionType,
  FANSLY_MAPPER_VERSION,
} from "@fansly-connect/fansly";
import {
  findPageByLabel,
  getCheckpoint,
  getCurrentSubscribers,
  getRevenueBreakdown,
  insertRawPayload,
  listFanslyPages,
  deleteExpiredRawPayloads,
  recalculateFanPageSpend,
  rebuildFollowerRollups,
  rebuildRevenueRollups,
  rebuildSubscriberRollups,
  setPageSubscriptionsCurrentFlag,
  startSyncRun,
  finishSyncRun,
  upsertCheckpoint,
  upsertFanPage,
  upsertFans,
  upsertPageFollow,
  upsertPageSubscription,
  upsertTransaction,
  updatePageMetadata,
  getFanSpendByIdentifier,
} from "@fansly-connect/db";
import {
  fanslyFollowIdToDate,
  resolvePeriodBounds,
  toMills,
} from "@fansly-connect/shared";

import type { AppContext } from "../bootstrap.ts";
import { resolvePageContext } from "./page-context.ts";

function retentionDate(now = new Date()) {
  return new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
}

async function hydrateFans(
  app: AppContext,
  input: {
    session: Parameters<typeof app.adapter.getAccountsByIds>[0]["session"];
    proxy: Parameters<typeof app.adapter.getAccountsByIds>[0]["proxy"];
    platformUserIds: string[];
  },
) {
  if (input.platformUserIds.length === 0) {
    return new Map<string, number>();
  }

  const uniqueIds = Array.from(new Set(input.platformUserIds.filter(Boolean)));
  const accounts = await app.adapter.getAccountsByIds(
    { session: input.session, proxy: input.proxy },
    uniqueIds,
  );

  const fallbackIds = uniqueIds.filter(
    (id) => !accounts.some((account) => account.id === id),
  );

  const fans = await upsertFans(app.db, [
    ...accounts.map((account) => ({
      platform: "fansly" as const,
      platformUserId: account.id,
      username: account.username,
      displayName: account.displayName,
      createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
      metadata: {},
    })),
    ...fallbackIds.map((id) => ({
      platform: "fansly" as const,
      platformUserId: id,
      metadata: {},
    })),
  ]);

  return new Map(fans.map((fan) => [fan.platformUserId, fan.id]));
}

async function syncTransactions(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    session: Parameters<typeof app.adapter.getTransactionsPage>[0]["session"];
    proxy: Parameters<typeof app.adapter.getTransactionsPage>[0]["proxy"];
    syncRunId: number;
  },
) {
  const checkpoint = await getCheckpoint(app.db, input.platformAccountId, "transactions");
  const after = checkpoint?.cursorTimestamp
    ? new Date(
      checkpoint.cursorTimestamp.getTime() -
        app.config.transactionLookbackDays * 24 * 60 * 60 * 1000,
    )
    : null;

  let offset = 0;
  let processed = 0;
  let newestSeenAt: Date | null = checkpoint?.cursorTimestamp ?? null;

  while (true) {
    const page = await app.adapter.getTransactionsPage(
      { session: input.session, proxy: input.proxy },
      { after, limit: 100, offset },
    );

    await insertRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: "earnings_transactions",
      requestParams: { after: after?.toISOString() ?? null, offset, limit: 100 },
      responsePayload: { total: page.total, data: page.items },
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    });

    const fanMap = await hydrateFans(app, {
      session: input.session,
      proxy: input.proxy,
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

async function syncSubscribers(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    session: Parameters<typeof app.adapter.getSubscribersPage>[0]["session"];
    proxy: Parameters<typeof app.adapter.getSubscribersPage>[0]["proxy"];
    syncRunId: number;
  },
) {
  let offset = 0;
  const items: Awaited<ReturnType<typeof app.adapter.getSubscribersPage>>["items"] = [];
  let stats: { totalActive: number; totalExpired: number; total: number } | null = null;

  while (true) {
    const page = await app.adapter.getSubscribersPage(
      { session: input.session, proxy: input.proxy },
      { limit: 100, offset, status: "3,4" },
    );

    items.push(...page.items);
    stats = stats ?? {
      totalActive: page.total ?? 0,
      totalExpired: 0,
      total: page.total ?? 0,
    };

    await insertRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: "subscribers",
      requestParams: { offset, limit: 100, status: "3,4" },
      responsePayload: { stats, subscriptions: page.items },
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    });

    if (page.done) {
      break;
    }
    offset += 100;
  }

  const fanMap = await hydrateFans(app, {
    session: input.session,
    proxy: input.proxy,
    platformUserIds: items.map((item) => item.subscriberId),
  });

  const activeIds: string[] = [];
  for (const item of items) {
    const fanId = fanMap.get(item.subscriberId);
    if (!fanId) {
      continue;
    }

    const sourceCreatedAt = item.createdAt ? new Date(item.createdAt) : null;
    const endsAt = item.endsAt ? new Date(item.endsAt) : null;
    const canonicalStatus = mapFanslySubscriptionStatus(item.status);
    const autoRenew = item.autoRenew === null ? null : item.autoRenew === 1;

    await upsertPageSubscription(app.db, {
      platformSubscriptionId: item.id,
      platformAccountId: input.platformAccountId,
      fanId,
      platformHistoryId: item.historyId,
      subscriptionTierId: item.subscriptionTierId,
      subscriptionTierName: item.subscriptionTierName,
      subscriptionTierColor: item.subscriptionTierColor,
      planId: item.planId,
      rawStatus: item.status,
      canonicalStatus,
      priceMills: toMills(item.price),
      renewPriceMills: toMills(item.renewPrice),
      autoRenew,
      billingCycleDays: item.billingCycle,
      durationDays: item.duration,
      renewDate: item.renewDate ? new Date(item.renewDate) : null,
      sourceCreatedAt,
      sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
      endsAt,
    });

    await upsertFanPage(app.db, {
      fanId,
      platformAccountId: input.platformAccountId,
      isSubscriber: canonicalStatus === "active",
      subscriberSince: sourceCreatedAt,
      subscriptionExpiresAt: endsAt,
      autoRenew,
    });
    activeIds.push(item.id);
  }

  await setPageSubscriptionsCurrentFlag(app.db, input.platformAccountId, activeIds);
  await app.db.execute(sql`
    update fan_pages
    set is_subscriber = false,
        subscription_expires_at = null,
        auto_renew = null,
        last_seen_at = now()
    where platform_account_id = ${input.platformAccountId}
      and fan_id not in (
        select fan_id
        from page_subscriptions
        where platform_account_id = ${input.platformAccountId}
          and is_current = true
      )
  `);
  await rebuildSubscriberRollups(app.db, input.platformAccountId);
  await upsertCheckpoint(app.db, {
    platformAccountId: input.platformAccountId,
    stream: "subscribers",
    state: { count: activeIds.length, pageLabel: input.pageLabel },
    lastSuccessfulRunId: input.syncRunId,
  });

  return {
    processed: items.length,
    totalActive: activeIds.length,
  };
}

export async function runLightSync(
  app: AppContext,
  label: string,
  trigger = "cli",
) {
  const pageContext = await resolvePageContext(app, label);
  const run = await startSyncRun(app.db, {
    platformAccountId: pageContext.page.id,
    stream: "light",
    trigger,
  });

  const errors: string[] = [];
  const stats: Record<string, unknown> = {};

  try {
    const accountMe = await app.adapter.getAccountMe({
      session: pageContext.session,
      proxy: pageContext.proxy,
    });

    await insertRawPayload(app.db, {
      platformAccountId: pageContext.page.id,
      syncRunId: run.id,
      endpoint: "account_me",
      requestParams: {},
      responsePayload: accountMe,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    });

    await updatePageMetadata(app.db, pageContext.page.id, {
      platformAccountIdValue: accountMe.account.id,
      username: accountMe.account.username,
      displayName: accountMe.account.displayName,
      followerCount: accountMe.account.followCount,
      subscriberCount: accountMe.account.subscriberCount,
      earningsBalanceMills: toMills(accountMe.account.earningsWallet?.balance ?? 0),
      metadata: {
        walls: accountMe.account.walls ?? [],
        subscriptionTiers: accountMe.account.subscriptionTiers ?? [],
      },
      syncType: "light",
    });

    try {
      stats.transactions = await syncTransactions(app, {
        pageLabel: label,
        platformAccountId: pageContext.page.id,
        session: pageContext.session,
        proxy: pageContext.proxy,
        syncRunId: run.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`transactions: ${message}`);
    }

    try {
      stats.subscribers = await syncSubscribers(app, {
        pageLabel: label,
        platformAccountId: pageContext.page.id,
        session: pageContext.session,
        proxy: pageContext.proxy,
        syncRunId: run.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`subscribers: ${message}`);
    }

    await finishSyncRun(app.db, run.id, {
      status: errors.length ? "partial" : "success",
      stats,
      errorSummary: errors.length ? errors.join("; ") : null,
    });

    return {
      runId: run.id,
      status: errors.length ? "partial" : "success",
      stats,
      errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await insertRawPayload(app.db, {
      platformAccountId: pageContext.page.id,
      syncRunId: run.id,
      endpoint: "light_sync",
      requestParams: {},
      responsePayload: { message },
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "failed",
      errorMessage: message,
      retainUntil: retentionDate(),
    });
    await finishSyncRun(app.db, run.id, {
      status: "failed",
      stats,
      errorSummary: message,
    });
    throw error;
  }
}

export async function runFollowerSync(
  app: AppContext,
  label: string,
  trigger = "cli",
) {
  const pageContext = await resolvePageContext(app, label);
  const run = await startSyncRun(app.db, {
    platformAccountId: pageContext.page.id,
    stream: "followers",
    trigger,
  });

  try {
    const accountMe = await app.adapter.getAccountMe({
      session: pageContext.session,
      proxy: pageContext.proxy,
    });

    await updatePageMetadata(app.db, pageContext.page.id, {
      platformAccountIdValue: accountMe.account.id,
      username: accountMe.account.username,
      displayName: accountMe.account.displayName,
      followerCount: accountMe.account.followCount,
      subscriberCount: accountMe.account.subscriberCount,
      earningsBalanceMills: toMills(accountMe.account.earningsWallet?.balance ?? 0),
      metadata: {
        walls: accountMe.account.walls ?? [],
        subscriptionTiers: accountMe.account.subscriptionTiers ?? [],
      },
      syncType: "followers",
    });

    const checkpoint = await getCheckpoint(app.db, pageContext.page.id, "followers");
    const knownFollowId = checkpoint?.cursorText ?? null;

    let offset = 0;
    let processed = 0;
    let delta = 0;
    let newestFollowId: string | null = knownFollowId;
    let done = false;

    while (!done) {
      const page = await app.adapter.getFollowersPage(
        { session: pageContext.session, proxy: pageContext.proxy },
        accountMe.account.id,
        {
          offset,
          limit: 100,
          minDelayMs: app.config.followerPageDelayMs,
        },
      );

      await insertRawPayload(app.db, {
        platformAccountId: pageContext.page.id,
        syncRunId: run.id,
        endpoint: "followers",
        requestParams: { offset, limit: 100 },
        responsePayload: {
          followers: page.items,
          accounts: page.accounts,
        },
        mapperVersion: FANSLY_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      });

      if (page.items[0]?.id) {
        newestFollowId = newestFollowId ?? page.items[0].id;
      }

      const fanRows = await upsertFans(app.db, page.accounts.map((account) => ({
        platform: "fansly" as const,
        platformUserId: account.id,
        username: account.username,
        displayName: account.displayName,
        createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
        metadata: {},
      })));
      const fanMap = new Map(fanRows.map((fan) => [fan.platformUserId, fan.id]));

      for (const follower of page.items) {
        processed += 1;
        if (knownFollowId && follower.id === knownFollowId) {
          done = true;
          break;
        }

        const fanId = fanMap.get(follower.followerId);
        if (!fanId) {
          continue;
        }

        const followedAt = fanslyFollowIdToDate(follower.id);
        await upsertPageFollow(app.db, {
          platformAccountId: pageContext.page.id,
          fanId,
          platformFollowId: follower.id,
          followedAt,
        });
        await upsertFanPage(app.db, {
          fanId,
          platformAccountId: pageContext.page.id,
          isFollower: true,
          followerSince: followedAt,
        });
        delta += 1;
      }

      if (page.done) {
        done = true;
      } else {
        offset += 100;
      }
    }

    await rebuildFollowerRollups(app.db, pageContext.page.id, accountMe.account.followCount);
    if (newestFollowId) {
      await upsertCheckpoint(app.db, {
        platformAccountId: pageContext.page.id,
        stream: "followers",
        cursorText: newestFollowId,
        state: { pageLabel: label, followerCount: accountMe.account.followCount },
        lastSuccessfulRunId: run.id,
      });
    }

    await finishSyncRun(app.db, run.id, {
      status: "success",
      stats: {
        processed,
        delta,
        followerCount: accountMe.account.followCount,
      },
    });

    return {
      runId: run.id,
      status: "success" as const,
      processed,
      delta,
      followerCount: accountMe.account.followCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await insertRawPayload(app.db, {
      platformAccountId: pageContext.page.id,
      syncRunId: run.id,
      endpoint: "followers",
      requestParams: {},
      responsePayload: { message },
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "failed",
      errorMessage: message,
      retainUntil: retentionDate(),
    });
    await finishSyncRun(app.db, run.id, {
      status: "failed",
      errorSummary: message,
    });
    throw error;
  }
}

export async function runAllSync(app: AppContext, label: string, trigger = "cli") {
  const light = await runLightSync(app, label, trigger);
  const followers = await runFollowerSync(app, label, trigger);

  return {
    light,
    followers,
  };
}

export async function listSubscribers(app: AppContext, label: string) {
  const page = await findPageByLabel(app.db, label);
  if (!page) {
    throw new Error(`Page not found for label "${label}"`);
  }
  const result = await getCurrentSubscribers(app.db, page.page.id);
  return result.rows;
}

export async function revenueBreakdownForPage(
  app: AppContext,
  label: string,
  period: "today" | "7d" | "30d" | "all" | "custom",
  custom?: { from: string; to: string },
) {
  const page = await findPageByLabel(app.db, label);
  if (!page) {
    throw new Error(`Page not found for label "${label}"`);
  }

  const bounds = resolvePeriodBounds(period, new Date(), custom);
  const rows = await getRevenueBreakdown(app.db, page.page.id, bounds.from, bounds.to);

  return {
    page: page.page,
    bounds,
    rows,
  };
}

export async function fanSpendForPage(app: AppContext, label: string, identifier: string) {
  const page = await findPageByLabel(app.db, label);
  if (!page) {
    throw new Error(`Page not found for label "${label}"`);
  }

  const result = await getFanSpendByIdentifier(app.db, page.page.id, identifier);
  return result.rows[0] ?? null;
}

export async function scheduleExistingPages(app: AppContext, boss: {
  schedule: (...args: any[]) => Promise<unknown>;
  work: (...args: any[]) => Promise<unknown>;
}) {
  const pages = await listFanslyPages(app.db);
  for (const page of pages) {
    const lightQueue = `fansly.sync.light.${page.label}`;
    const followerQueue = `fansly.sync.followers.${page.label}`;

    await boss.schedule(lightQueue, "0 * * * *", { label: page.label });
    await boss.schedule(followerQueue, "0 */12 * * *", { label: page.label });
    await boss.work(lightQueue, async (job: { data?: { label: string } }) => {
      const label = (job.data as { label: string }).label;
      await runLightSync(app, label, "worker");
    });
    await boss.work(followerQueue, async (job: { data?: { label: string } }) => {
      const label = (job.data as { label: string }).label;
      await runFollowerSync(app, label, "worker");
    });
  }

  await boss.schedule("fansly.raw-payload-cleanup", "0 2 * * *");
  await boss.work("fansly.raw-payload-cleanup", async () => {
    await deleteExpiredRawPayloads(app.db, new Date());
  });
}
