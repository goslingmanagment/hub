import { and, eq, notInArray, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { fanPages, fans, pageFollows, pageSubscriptions, transactions } from "../schema.ts";

export interface UpsertFanInput {
  platform: "fansly" | "onlyfans";
  platformUserId: string;
  username?: string | null;
  displayName?: string | null;
  createdAtExternal?: Date | null;
  metadata?: Record<string, unknown>;
}

export async function upsertFans(db: Database, items: UpsertFanInput[]) {
  const results: Array<typeof fans.$inferSelect> = [];

  for (const item of items) {
    const updateSet: Record<string, unknown> = {
      lastSeenAt: new Date(),
    };

    if (item.username !== undefined) {
      updateSet.username = item.username;
    }
    if (item.displayName !== undefined) {
      updateSet.displayName = item.displayName;
    }
    if (item.createdAtExternal !== undefined) {
      updateSet.createdAtExternal = item.createdAtExternal;
    }
    if (item.metadata !== undefined) {
      updateSet.metadata = item.metadata;
    }

    const [fan] = await db
      .insert(fans)
      .values({
        platform: item.platform,
        platformUserId: item.platformUserId,
        username: item.username ?? null,
        displayName: item.displayName ?? null,
        createdAtExternal: item.createdAtExternal ?? null,
        metadata: item.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [fans.platform, fans.platformUserId],
        set: updateSet,
      })
      .returning();
    results.push(fan);
  }

  return results;
}

export async function upsertFanPage(
  db: Database,
  input: {
    fanId: number;
    platformAccountId: number;
    isFollower?: boolean;
    followerSince?: Date | null;
    isSubscriber?: boolean;
    subscriberSince?: Date | null;
    subscriptionExpiresAt?: Date | null;
    autoRenew?: boolean | null;
    totalSpentMills?: bigint;
    lastTransactionAt?: Date | null;
  },
) {
  const patch = {
    totalSpentMills: input.totalSpentMills ?? 0n,
    isFollower: input.isFollower ?? false,
    followerSince: input.followerSince ?? null,
    isSubscriber: input.isSubscriber ?? false,
    subscriberSince: input.subscriberSince ?? null,
    subscriptionExpiresAt: input.subscriptionExpiresAt ?? null,
    autoRenew: input.autoRenew ?? null,
    lastTransactionAt: input.lastTransactionAt ?? null,
    lastSeenAt: new Date(),
  };

  const updateSet: Record<string, unknown> = {
    lastSeenAt: patch.lastSeenAt,
  };

  if (input.totalSpentMills !== undefined) {
    updateSet.totalSpentMills = input.totalSpentMills;
  }
  if (input.isFollower !== undefined) {
    updateSet.isFollower = input.isFollower;
  }
  if (input.followerSince !== undefined) {
    updateSet.followerSince = input.followerSince;
  }
  if (input.isSubscriber !== undefined) {
    updateSet.isSubscriber = input.isSubscriber;
  }
  if (input.subscriberSince !== undefined) {
    updateSet.subscriberSince = input.subscriberSince;
  }
  if (input.subscriptionExpiresAt !== undefined) {
    updateSet.subscriptionExpiresAt = input.subscriptionExpiresAt;
  }
  if (input.autoRenew !== undefined) {
    updateSet.autoRenew = input.autoRenew;
  }
  if (input.lastTransactionAt !== undefined) {
    updateSet.lastTransactionAt = input.lastTransactionAt;
  }

  const [fanPage] = await db
    .insert(fanPages)
    .values({
      fanId: input.fanId,
      platformAccountId: input.platformAccountId,
      ...patch,
    })
    .onConflictDoUpdate({
      target: [fanPages.fanId, fanPages.platformAccountId],
      set: updateSet,
    })
    .returning();
  return fanPage;
}

export async function upsertPageFollow(
  db: Database,
  input: {
    platformAccountId: number;
    fanId: number;
    platformFollowId: string;
    followedAt: Date;
  },
) {
  const [pageFollow] = await db
    .insert(pageFollows)
    .values({
      platformAccountId: input.platformAccountId,
      fanId: input.fanId,
      platformFollowId: input.platformFollowId,
      followedAt: input.followedAt,
    })
    .onConflictDoUpdate({
      target: [pageFollows.platformAccountId, pageFollows.platformFollowId],
      set: {
        lastSeenAt: new Date(),
        isActive: true,
      },
    })
    .returning();
  return pageFollow;
}

export async function setPageSubscriptionsCurrentFlag(
  db: Database,
  platformAccountId: number,
  activeIds: string[],
) {
  if (activeIds.length === 0) {
    await db
      .update(pageSubscriptions)
      .set({
        isCurrent: false,
        lastSeenAt: new Date(),
      })
      .where(eq(pageSubscriptions.platformAccountId, platformAccountId));
    return;
  }

  await db
    .update(pageSubscriptions)
    .set({
      isCurrent: false,
      lastSeenAt: new Date(),
    })
    .where(
      and(
        eq(pageSubscriptions.platformAccountId, platformAccountId),
        notInArray(pageSubscriptions.platformSubscriptionId, activeIds),
      ),
    );
}

export async function upsertPageSubscription(
  db: Database,
  input: {
    platformSubscriptionId: string;
    platformAccountId: number;
    fanId: number;
    platformHistoryId?: string | null;
    subscriptionTierId?: string | null;
    subscriptionTierName?: string | null;
    subscriptionTierColor?: string | null;
    planId?: string | null;
    rawStatus: number;
    canonicalStatus: string;
    priceMills: bigint;
    renewPriceMills: bigint;
    autoRenew?: boolean | null;
    billingCycleDays?: number | null;
    durationDays?: number | null;
    renewDate?: Date | null;
    sourceCreatedAt?: Date | null;
    sourceUpdatedAt?: Date | null;
    endsAt?: Date | null;
  },
) {
  const patch = {
    platformAccountId: input.platformAccountId,
    fanId: input.fanId,
    platformHistoryId: input.platformHistoryId ?? null,
    subscriptionTierId: input.subscriptionTierId ?? null,
    subscriptionTierName: input.subscriptionTierName ?? null,
    subscriptionTierColor: input.subscriptionTierColor ?? null,
    planId: input.planId ?? null,
    rawStatus: input.rawStatus,
    canonicalStatus: input.canonicalStatus,
    priceMills: input.priceMills,
    renewPriceMills: input.renewPriceMills,
    autoRenew: input.autoRenew ?? null,
    billingCycleDays: input.billingCycleDays ?? null,
    durationDays: input.durationDays ?? null,
    renewDate: input.renewDate ?? null,
    sourceCreatedAt: input.sourceCreatedAt ?? null,
    sourceUpdatedAt: input.sourceUpdatedAt ?? null,
    endsAt: input.endsAt ?? null,
    isCurrent: true,
    lastSeenAt: new Date(),
  };

  const [subscription] = await db
    .insert(pageSubscriptions)
    .values({
      platformSubscriptionId: input.platformSubscriptionId,
      ...patch,
    })
    .onConflictDoUpdate({
      target: pageSubscriptions.platformSubscriptionId,
      set: patch,
    })
    .returning();
  return subscription;
}

export async function recalculateFanPageSpend(db: Database, platformAccountId: number) {
  await db.execute(sql`
    update fan_pages fp
    set total_spent_mills = coalesce(tx.total_spent_mills, 0),
        last_transaction_at = tx.last_transaction_at,
        last_seen_at = now()
    from (
      select fan_id,
             sum(net_amount_mills) as total_spent_mills,
             max(occurred_at) as last_transaction_at
      from transactions
      where platform_account_id = ${platformAccountId}
        and fan_id is not null
      group by fan_id
    ) tx
    where fp.platform_account_id = ${platformAccountId}
      and fp.fan_id = tx.fan_id
  `);
}

export async function getFanSpendByIdentifier(
  db: Database,
  platformAccountId: number,
  identifier: string,
) {
  return db.execute(sql`
    select f.platform_user_id,
           f.username,
           fp.total_spent_mills
    from fan_pages fp
    join fans f on f.id = fp.fan_id
    where fp.platform_account_id = ${platformAccountId}
      and (f.platform_user_id = ${identifier} or f.username = ${identifier})
    limit 1
  `);
}

export async function getCurrentSubscribers(db: Database, platformAccountId: number) {
  return db.execute(sql`
    select ps.platform_subscription_id,
           ps.ends_at,
           ps.auto_renew,
           ps.subscription_tier_name,
           f.platform_user_id,
           f.username,
           f.display_name
    from page_subscriptions ps
    join fans f on f.id = ps.fan_id
    where ps.platform_account_id = ${platformAccountId}
      and ps.is_current = true
    order by ps.ends_at asc nulls last
  `);
}
