import { and, eq, notInArray, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  fanPages,
  fans,
  fanUsernameAliases,
  pageFollows,
  pageSubscriptions,
  spenderLifetimePage,
} from "../schema.ts";
import { rebuildSpenderProjections } from "./spenders.ts";

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

    if (fan.username && fan.username.trim().length > 0) {
      await db.insert(fanUsernameAliases).values({
        fanId: fan.id,
        username: fan.username,
        firstSeenAt: fan.firstSeenAt,
        lastSeenAt: fan.lastSeenAt,
      }).onConflictDoUpdate({
        target: [fanUsernameAliases.fanId, fanUsernameAliases.username],
        set: {
          firstSeenAt: sql`least(${fanUsernameAliases.firstSeenAt}, ${fan.firstSeenAt})`,
          lastSeenAt: fan.lastSeenAt,
        },
      });
    }

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
  },
) {
  const patch = {
    isFollower: input.isFollower ?? false,
    followerSince: input.followerSince ?? null,
    isSubscriber: input.isSubscriber ?? false,
    subscriberSince: input.subscriberSince ?? null,
    subscriptionExpiresAt: input.subscriptionExpiresAt ?? null,
    autoRenew: input.autoRenew ?? null,
    lastSeenAt: new Date(),
  };

  const updateSet: Record<string, unknown> = {
    lastSeenAt: patch.lastSeenAt,
  };

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
    lastSeenGeneration?: number | null;
  },
) {
  const lastSeenAt = new Date();
  const [pageFollow] = await db
    .insert(pageFollows)
    .values({
      platformAccountId: input.platformAccountId,
      fanId: input.fanId,
      platformFollowId: input.platformFollowId,
      followedAt: input.followedAt,
      lastSeenGeneration: input.lastSeenGeneration ?? null,
      lastSeenAt,
    })
    .onConflictDoUpdate({
      target: [pageFollows.platformAccountId, pageFollows.platformFollowId],
      set: {
        lastSeenAt,
        isActive: true,
        lastSeenGeneration: input.lastSeenGeneration ?? null,
      },
    })
    .returning();
  return pageFollow;
}

export async function countActivePageFollows(db: Database, platformAccountId: number) {
  const result = await db.execute(sql`
    select count(*)::int as count
    from page_follows
    where platform_account_id = ${platformAccountId}
      and is_active = true
  `);

  return result.rows[0]?.count ?? 0;
}

export async function deactivatePageFollowsMissingFromSnapshot(
  db: Database,
  platformAccountId: number,
  activeFollowIds: string[],
) {
  if (activeFollowIds.length === 0) {
    await db
      .update(pageFollows)
      .set({
        isActive: false,
        lastSeenAt: new Date(),
      })
      .where(eq(pageFollows.platformAccountId, platformAccountId));
    return;
  }

  await db
    .update(pageFollows)
    .set({
      isActive: false,
      lastSeenAt: new Date(),
    })
    .where(and(
      eq(pageFollows.platformAccountId, platformAccountId),
      notInArray(pageFollows.platformFollowId, activeFollowIds),
    ));
}

export async function refreshFanPageFollowerState(db: Database, platformAccountId: number) {
  await db.execute(sql`
    update fan_pages fp
    set is_follower = active.active_followed_at is not null,
        follower_since = active.active_followed_at,
        last_seen_at = now()
    from (
      select fan_id,
             min(followed_at) as active_followed_at
      from page_follows
      where platform_account_id = ${platformAccountId}
        and is_active = true
      group by fan_id
    ) active
    where fp.platform_account_id = ${platformAccountId}
      and fp.fan_id = active.fan_id
  `);
  await db.execute(sql`
    update fan_pages
    set is_follower = false,
        follower_since = null,
        last_seen_at = now()
    where platform_account_id = ${platformAccountId}
      and fan_id not in (
        select fan_id
        from page_follows
        where platform_account_id = ${platformAccountId}
          and is_active = true
      )
  `);
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
    lastSeenGeneration?: number | null;
  },
) {
  const lastSeenAt = new Date();
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
    lastSeenGeneration: input.lastSeenGeneration ?? null,
    lastSeenAt,
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

export async function deactivatePageFollowsByGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
  },
) {
  await db.execute(sql`
    update page_follows
    set is_active = false,
        last_seen_at = now()
    where platform_account_id = ${input.platformAccountId}
      and is_active = true
      and (last_seen_generation is null or last_seen_generation < ${input.generation})
  `);
}

export async function deactivatePageSubscriptionsByGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
  },
) {
  await db.execute(sql`
    update page_subscriptions
    set is_current = false,
        last_seen_at = now()
    where platform_account_id = ${input.platformAccountId}
      and is_current = true
      and (last_seen_generation is null or last_seen_generation < ${input.generation})
  `);
}

export async function refreshFanPageSubscriberState(db: Database, platformAccountId: number) {
  await db.execute(sql`
    update fan_pages fp
    set is_subscriber = active.active_subscriber_since is not null,
        subscriber_since = active.active_subscriber_since,
        subscription_expires_at = active.active_subscription_expires_at,
        auto_renew = active.active_auto_renew,
        last_seen_at = now()
    from (
      select fan_id,
             min(source_created_at) as active_subscriber_since,
             max(ends_at) as active_subscription_expires_at,
             bool_or(coalesce(auto_renew, false)) as active_auto_renew
      from page_subscriptions
      where platform_account_id = ${platformAccountId}
        and is_current = true
      group by fan_id
    ) active
    where fp.platform_account_id = ${platformAccountId}
      and fp.fan_id = active.fan_id
  `);
  await db.execute(sql`
    update fan_pages
    set is_subscriber = false,
        subscriber_since = null,
        subscription_expires_at = null,
        auto_renew = null,
        last_seen_at = now()
    where platform_account_id = ${platformAccountId}
      and fan_id not in (
        select fan_id
        from page_subscriptions
        where platform_account_id = ${platformAccountId}
          and is_current = true
      )
  `);
}

export async function recalculateFanPageSpend(db: Database, platformAccountId: number) {
  await rebuildSpenderProjections(db, platformAccountId);
}

export async function getFanSpendByIdentifier(
  db: Database,
  platformAccountId: number,
  identifier: string,
) {
  return db.execute(sql`
    select f.platform_user_id,
           f.username,
           coalesce(slp.creator_net_amount_mills, 0)::bigint as total_creator_net_mills
    from fan_pages fp
    join fans f on f.id = fp.fan_id
    left join spender_lifetime_page slp
      on slp.platform_account_id = fp.platform_account_id
     and slp.fan_id = fp.fan_id
    where fp.platform_account_id = ${platformAccountId}
      and (
        f.platform_user_id = ${identifier}
        or f.username = ${identifier}
        or exists (
          select 1
          from fan_username_aliases fua
          where fua.fan_id = f.id
            and fua.username = ${identifier}
        )
      )
    order by
      case
        when f.platform_user_id = ${identifier} then 0
        when f.username = ${identifier} then 1
        else 2
      end,
      f.id asc
    limit 1
  `);
}

export async function listTopFansForPage(
  db: Database,
  platformAccountId: number,
  limit = 20,
) {
  return db.execute(sql`
    select f.platform_user_id,
           f.username,
           f.display_name,
           coalesce(slp.creator_net_amount_mills, 0)::bigint as total_creator_net_mills,
           fp.is_subscriber,
           fp.is_follower,
           slp.last_transaction_at
    from fan_pages fp
    join fans f on f.id = fp.fan_id
    left join spender_lifetime_page slp
      on slp.platform_account_id = fp.platform_account_id
     and slp.fan_id = fp.fan_id
    where fp.platform_account_id = ${platformAccountId}
    order by coalesce(slp.creator_net_amount_mills, 0) desc,
             slp.last_transaction_at desc nulls last,
             f.id asc
    limit ${limit}
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

export async function getFollowersForPage(db: Database, platformAccountId: number) {
  return db.execute(sql`
    select f.username,
           f.platform_user_id,
           pf.followed_at
    from page_follows pf
    join fans f on f.id = pf.fan_id
    where pf.platform_account_id = ${platformAccountId}
      and pf.is_active = true
    order by pf.followed_at desc, pf.id desc
  `);
}
