import { and, eq, notInArray, sql } from "drizzle-orm";

import {
  FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN,
  type ExternalPresenceSource,
} from "@agency_hub_core/shared";

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
  deletedDetectedAt?: Date | null;
}

function dedupeByKey<T>(items: T[], keyFor: (item: T) => string, merge: (current: T, next: T) => T) {
  const deduped = new Map<string, T>();

  for (const item of items) {
    const key = keyFor(item);
    const current = deduped.get(key);
    deduped.set(key, current ? merge(current, item) : item);
  }

  return Array.from(deduped.values());
}

function groupByKey<T>(items: T[], keyFor: (item: T) => string) {
  const grouped = new Map<string, T[]>();

  for (const item of items) {
    const key = keyFor(item);
    const current = grouped.get(key) ?? [];
    current.push(item);
    grouped.set(key, current);
  }

  return grouped;
}

function mergeUpsertFanInput(current: UpsertFanInput, next: UpsertFanInput): UpsertFanInput {
  return {
    platform: next.platform,
    platformUserId: next.platformUserId,
    username: next.username !== undefined ? next.username : current.username,
    displayName: next.displayName !== undefined ? next.displayName : current.displayName,
    createdAtExternal: next.createdAtExternal !== undefined
      ? next.createdAtExternal
      : current.createdAtExternal,
    metadata: next.metadata !== undefined ? next.metadata : current.metadata,
    deletedDetectedAt: next.deletedDetectedAt !== undefined
      ? next.deletedDetectedAt
      : current.deletedDetectedAt,
  };
}

function fanUpsertPresenceKey(item: UpsertFanInput) {
  return [
    item.username !== undefined ? "username" : "",
    item.displayName !== undefined ? "displayName" : "",
    item.createdAtExternal !== undefined ? "createdAtExternal" : "",
    item.metadata !== undefined ? "metadata" : "",
    item.deletedDetectedAt !== undefined ? "deletedDetectedAt" : "",
  ].join("|");
}

function hasPresentIdentity(input: UpsertFanInput) {
  return (input.username?.trim().length ?? 0) > 0 ||
    (input.displayName?.trim().length ?? 0) > 0;
}

export async function upsertFans(db: Database, items: UpsertFanInput[]) {
  if (items.length === 0) {
    return [] as Array<typeof fans.$inferSelect>;
  }

  const deduped = dedupeByKey(
    items,
    (item) => `${item.platform}:${item.platformUserId}`,
    mergeUpsertFanInput,
  );
  const groups = groupByKey(deduped, fanUpsertPresenceKey);
  const fanByKey = new Map<string, typeof fans.$inferSelect>();

  for (const group of groups.values()) {
    const template = group[0]!;
    const lastSeenAt = new Date();
    const updateSet: Record<string, unknown> = {
      lastSeenAt,
    };

    if (template.username !== undefined) {
      updateSet.username = sql`excluded.username`;
    }
    if (template.displayName !== undefined) {
      updateSet.displayName = sql`excluded.display_name`;
    }
    if (template.createdAtExternal !== undefined) {
      updateSet.createdAtExternal = sql`excluded.created_at_external`;
    }
    if (template.metadata !== undefined) {
      updateSet.metadata = sql`excluded.metadata`;
    }
    if (template.deletedDetectedAt !== undefined || hasPresentIdentity(template)) {
      updateSet.deletedDetectedAt = sql`
        case
          when nullif(btrim(coalesce(excluded.username, '')), '') is not null
            or nullif(btrim(coalesce(excluded.display_name, '')), '') is not null
            then null
          when excluded.deleted_detected_at is not null
            then coalesce(${fans.deletedDetectedAt}, excluded.deleted_detected_at)
          else ${fans.deletedDetectedAt}
        end
      `;
      updateSet.deletedLastDetectedAt = sql`
        case
          when nullif(btrim(coalesce(excluded.username, '')), '') is not null
            or nullif(btrim(coalesce(excluded.display_name, '')), '') is not null
            then null
          when excluded.deleted_detected_at is not null
            then excluded.deleted_last_detected_at
          else ${fans.deletedLastDetectedAt}
        end
      `;
    }

    const rows = await db
      .insert(fans)
      .values(group.map((item) => ({
        platform: item.platform,
        platformUserId: item.platformUserId,
        username: item.username ?? null,
        displayName: item.displayName ?? null,
        createdAtExternal: item.createdAtExternal ?? null,
        metadata: item.metadata ?? {},
        deletedDetectedAt: hasPresentIdentity(item) ? null : item.deletedDetectedAt ?? null,
        deletedLastDetectedAt: hasPresentIdentity(item) ? null : item.deletedDetectedAt ?? null,
      })))
      .onConflictDoUpdate({
        target: [fans.platform, fans.platformUserId],
        set: updateSet,
      })
      .returning();

    const aliasValues = rows.flatMap((fan) => (
      fan.username && fan.username.trim().length > 0
        ? [{
          fanId: fan.id,
          username: fan.username,
          firstSeenAt: fan.firstSeenAt,
          lastSeenAt: fan.lastSeenAt,
        }]
        : []
    ));
    if (aliasValues.length > 0) {
      await db.insert(fanUsernameAliases).values(aliasValues).onConflictDoUpdate({
        target: [fanUsernameAliases.fanId, fanUsernameAliases.username],
        set: {
          firstSeenAt: sql`least(${fanUsernameAliases.firstSeenAt}, excluded.first_seen_at)`,
          lastSeenAt: sql`greatest(${fanUsernameAliases.lastSeenAt}, excluded.last_seen_at)`,
        },
      });
    }

    for (const row of rows) {
      fanByKey.set(`${row.platform}:${row.platformUserId}`, row);
    }
  }

  return deduped.map((item) => fanByKey.get(`${item.platform}:${item.platformUserId}`)!);
}

export interface UpsertFanPageInput {
  fanId: number;
  platformAccountId: number;
  isFollower?: boolean;
  followerSince?: Date | null;
  isSubscriber?: boolean;
  subscriberSince?: Date | null;
  subscriptionExpiresAt?: Date | null;
  autoRenew?: boolean | null;
  autoRenewOffDetectedAt?: Date | null;
  pageAlias?: string | null;
  pageAliasSource?: string | null;
  pageAliasSourceNoteId?: string | null;
  pageAliasSyncedAt?: Date | null;
}

export interface UpsertFanPageExternalPresenceInput {
  fanId: number;
  platformAccountId: number;
  externalPresenceAt: Date;
  externalPresenceObservedAt: Date;
  externalPresenceSource?: ExternalPresenceSource;
}

function mergeUpsertFanPageInput(
  current: UpsertFanPageInput,
  next: UpsertFanPageInput,
): UpsertFanPageInput {
  return {
    fanId: next.fanId,
    platformAccountId: next.platformAccountId,
    isFollower: next.isFollower !== undefined ? next.isFollower : current.isFollower,
    followerSince: next.followerSince !== undefined ? next.followerSince : current.followerSince,
    isSubscriber: next.isSubscriber !== undefined ? next.isSubscriber : current.isSubscriber,
    subscriberSince: next.subscriberSince !== undefined ? next.subscriberSince : current.subscriberSince,
    subscriptionExpiresAt: next.subscriptionExpiresAt !== undefined
      ? next.subscriptionExpiresAt
      : current.subscriptionExpiresAt,
    autoRenew: next.autoRenew !== undefined ? next.autoRenew : current.autoRenew,
    autoRenewOffDetectedAt: next.autoRenewOffDetectedAt !== undefined
      ? next.autoRenewOffDetectedAt
      : current.autoRenewOffDetectedAt,
    pageAlias: next.pageAlias !== undefined ? next.pageAlias : current.pageAlias,
    pageAliasSource: next.pageAliasSource !== undefined
      ? next.pageAliasSource
      : current.pageAliasSource,
    pageAliasSourceNoteId: next.pageAliasSourceNoteId !== undefined
      ? next.pageAliasSourceNoteId
      : current.pageAliasSourceNoteId,
    pageAliasSyncedAt: next.pageAliasSyncedAt !== undefined
      ? next.pageAliasSyncedAt
      : current.pageAliasSyncedAt,
  };
}

function fanPagePresenceKey(input: UpsertFanPageInput) {
  return [
    input.isFollower !== undefined ? "isFollower" : "",
    input.followerSince !== undefined ? "followerSince" : "",
    input.isSubscriber !== undefined ? "isSubscriber" : "",
    input.subscriberSince !== undefined ? "subscriberSince" : "",
    input.subscriptionExpiresAt !== undefined ? "subscriptionExpiresAt" : "",
    input.autoRenew !== undefined ? "autoRenew" : "",
    input.autoRenewOffDetectedAt !== undefined ? "autoRenewOffDetectedAt" : "",
    input.pageAlias !== undefined ? "pageAlias" : "",
    input.pageAliasSource !== undefined ? "pageAliasSource" : "",
    input.pageAliasSourceNoteId !== undefined ? "pageAliasSourceNoteId" : "",
    input.pageAliasSyncedAt !== undefined ? "pageAliasSyncedAt" : "",
  ].join("|");
}

export async function upsertFanPages(db: Database, inputs: UpsertFanPageInput[]) {
  if (inputs.length === 0) {
    return;
  }

  const deduped = dedupeByKey(
    inputs,
    (input) => `${input.platformAccountId}:${input.fanId}`,
    mergeUpsertFanPageInput,
  );
  const groups = groupByKey(deduped, fanPagePresenceKey);

  for (const group of groups.values()) {
    const template = group[0]!;
    const lastSeenAt = new Date();
    const updateSet: Record<string, unknown> = {
      lastSeenAt,
    };

    if (template.isFollower !== undefined) {
      updateSet.isFollower = sql`excluded.is_follower`;
    }
    if (template.followerSince !== undefined) {
      updateSet.followerSince = sql`excluded.follower_since`;
    }
    if (template.isSubscriber !== undefined) {
      updateSet.isSubscriber = sql`excluded.is_subscriber`;
    }
    if (template.subscriberSince !== undefined) {
      updateSet.subscriberSince = sql`excluded.subscriber_since`;
    }
    if (template.subscriptionExpiresAt !== undefined) {
      updateSet.subscriptionExpiresAt = sql`excluded.subscription_expires_at`;
    }
    if (template.autoRenew !== undefined) {
      updateSet.autoRenew = sql`excluded.auto_renew`;
    }
    if (template.autoRenew !== undefined || template.autoRenewOffDetectedAt !== undefined) {
      updateSet.autoRenewOffDetectedAt = sql`
        case
          when excluded.auto_renew is false then
            case
              when ${fanPages.autoRenew} is distinct from false then excluded.auto_renew_off_detected_at
              else coalesce(${fanPages.autoRenewOffDetectedAt}, excluded.auto_renew_off_detected_at)
            end
          when excluded.auto_renew is true then null
          when excluded.auto_renew_off_detected_at is not null then excluded.auto_renew_off_detected_at
          else ${fanPages.autoRenewOffDetectedAt}
        end
      `;
    }
    if (template.pageAlias !== undefined) {
      updateSet.pageAlias = sql`excluded.page_alias`;
    }
    if (template.pageAliasSource !== undefined) {
      updateSet.pageAliasSource = sql`excluded.page_alias_source`;
    }
    if (template.pageAliasSourceNoteId !== undefined) {
      updateSet.pageAliasSourceNoteId = sql`excluded.page_alias_source_note_id`;
    }
    if (template.pageAliasSyncedAt !== undefined) {
      updateSet.pageAliasSyncedAt = sql`excluded.page_alias_synced_at`;
    }

    await db
      .insert(fanPages)
      .values(group.map((input) => ({
        fanId: input.fanId,
        platformAccountId: input.platformAccountId,
        isFollower: input.isFollower ?? false,
        followerSince: input.followerSince ?? null,
        isSubscriber: input.isSubscriber ?? false,
        subscriberSince: input.subscriberSince ?? null,
        subscriptionExpiresAt: input.subscriptionExpiresAt ?? null,
        autoRenew: input.autoRenew ?? null,
        autoRenewOffDetectedAt: input.autoRenewOffDetectedAt ?? (
          input.autoRenew === false ? lastSeenAt : null
        ),
        pageAlias: input.pageAlias ?? null,
        pageAliasSource: input.pageAliasSource ?? null,
        pageAliasSourceNoteId: input.pageAliasSourceNoteId ?? null,
        pageAliasSyncedAt: input.pageAliasSyncedAt ?? null,
        lastSeenAt,
      })))
      .onConflictDoUpdate({
        target: [fanPages.fanId, fanPages.platformAccountId],
        set: updateSet,
      });
  }
}

export async function upsertFanPage(
  db: Database,
  input: UpsertFanPageInput,
) {
  const lastSeenAt = new Date();
  const patch = {
    isFollower: input.isFollower ?? false,
    followerSince: input.followerSince ?? null,
    isSubscriber: input.isSubscriber ?? false,
    subscriberSince: input.subscriberSince ?? null,
    subscriptionExpiresAt: input.subscriptionExpiresAt ?? null,
    autoRenew: input.autoRenew ?? null,
    autoRenewOffDetectedAt: input.autoRenewOffDetectedAt ?? (
      input.autoRenew === false ? lastSeenAt : null
    ),
    pageAlias: input.pageAlias ?? null,
    pageAliasSource: input.pageAliasSource ?? null,
    pageAliasSourceNoteId: input.pageAliasSourceNoteId ?? null,
    pageAliasSyncedAt: input.pageAliasSyncedAt ?? null,
    lastSeenAt,
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
    updateSet.autoRenewOffDetectedAt = sql`
      case
        when excluded.auto_renew is false then
          case
            when ${fanPages.autoRenew} is distinct from false then excluded.auto_renew_off_detected_at
            else coalesce(${fanPages.autoRenewOffDetectedAt}, excluded.auto_renew_off_detected_at)
          end
        when excluded.auto_renew is true then null
        else ${fanPages.autoRenewOffDetectedAt}
      end
    `;
  } else if (input.autoRenewOffDetectedAt !== undefined) {
    updateSet.autoRenewOffDetectedAt = input.autoRenewOffDetectedAt;
  }
  if (input.pageAlias !== undefined) {
    updateSet.pageAlias = input.pageAlias;
  }
  if (input.pageAliasSource !== undefined) {
    updateSet.pageAliasSource = input.pageAliasSource;
  }
  if (input.pageAliasSourceNoteId !== undefined) {
    updateSet.pageAliasSourceNoteId = input.pageAliasSourceNoteId;
  }
  if (input.pageAliasSyncedAt !== undefined) {
    updateSet.pageAliasSyncedAt = input.pageAliasSyncedAt;
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

export async function upsertFanPageExternalPresences(
  db: Database,
  inputs: UpsertFanPageExternalPresenceInput[],
) {
  if (inputs.length === 0) {
    return;
  }

  const deduped = dedupeByKey(
    inputs,
    (input) => `${input.platformAccountId}:${input.fanId}`,
    (current, next) => ({
      fanId: next.fanId,
      platformAccountId: next.platformAccountId,
      externalPresenceAt: next.externalPresenceAt > current.externalPresenceAt
        ? next.externalPresenceAt
        : current.externalPresenceAt,
      externalPresenceObservedAt: next.externalPresenceObservedAt > current.externalPresenceObservedAt
        ? next.externalPresenceObservedAt
        : current.externalPresenceObservedAt,
      externalPresenceSource: next.externalPresenceSource ?? current.externalPresenceSource,
    }),
  );
  const lastSeenAt = new Date();

  await db
    .insert(fanPages)
    .values(deduped.map((input) => ({
      fanId: input.fanId,
      platformAccountId: input.platformAccountId,
      externalPresenceAt: input.externalPresenceAt,
      externalPresenceObservedAt: input.externalPresenceObservedAt,
      externalPresenceSource: input.externalPresenceSource ?? FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN,
      lastSeenAt,
    })))
    .onConflictDoUpdate({
      target: [fanPages.fanId, fanPages.platformAccountId],
      set: {
        externalPresenceAt: sql`
          greatest(
            coalesce(${fanPages.externalPresenceAt}, '-infinity'::timestamptz),
            coalesce(excluded.external_presence_at, '-infinity'::timestamptz)
          )
        `,
        externalPresenceObservedAt: sql`
          greatest(
            coalesce(${fanPages.externalPresenceObservedAt}, '-infinity'::timestamptz),
            coalesce(excluded.external_presence_observed_at, '-infinity'::timestamptz)
          )
        `,
        externalPresenceSource: sql`
          coalesce(
            excluded.external_presence_source,
            ${fanPages.externalPresenceSource}
          )
        `,
        lastSeenAt,
      },
    });
}

export interface UpsertPageFollowInput {
  platformAccountId: number;
  fanId: number;
  platformFollowId: string;
  followedAt: Date;
  lastSeenGeneration?: number | null;
}

export async function upsertPageFollows(db: Database, inputs: UpsertPageFollowInput[]) {
  if (inputs.length === 0) {
    return;
  }

  const deduped = dedupeByKey(
    inputs,
    (input) => `${input.platformAccountId}:${input.platformFollowId}`,
    (_current, next) => next,
  );
  const lastSeenAt = new Date();

  await db
    .insert(pageFollows)
    .values(deduped.map((input) => ({
      platformAccountId: input.platformAccountId,
      fanId: input.fanId,
      platformFollowId: input.platformFollowId,
      followedAt: input.followedAt,
      lastSeenGeneration: input.lastSeenGeneration ?? null,
      lastSeenAt,
    })))
    .onConflictDoUpdate({
      target: [pageFollows.platformAccountId, pageFollows.platformFollowId],
      set: {
        lastSeenAt,
        isActive: true,
        lastSeenGeneration: sql`excluded.last_seen_generation`,
      },
    });
}

export async function upsertPageFollow(
  db: Database,
  input: UpsertPageFollowInput,
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
    with active as (
      select fan_id,
             min(followed_at) as active_followed_at
      from page_follows
      where platform_account_id = ${platformAccountId}
        and is_active = true
      group by fan_id
    ),
    resolved as (
      select fp.id,
             active.active_followed_at
      from page_fans fp
      left join active on active.fan_id = fp.fan_id
      where fp.platform_account_id = ${platformAccountId}
    )
    update page_fans fp
    set is_follower = resolved.active_followed_at is not null,
        follower_since = resolved.active_followed_at,
        last_seen_at = now()
    from resolved
    where fp.id = resolved.id
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
  input: UpsertPageSubscriptionInput,
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
    autoRenewOffDetectedAt: input.autoRenewOffDetectedAt ?? (
      input.autoRenew === false ? lastSeenAt : null
    ),
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
      target: [pageSubscriptions.platformAccountId, pageSubscriptions.platformSubscriptionId],
      set: {
        ...patch,
        autoRenewOffDetectedAt: sql`
          case
            when excluded.auto_renew is false then
              case
                when ${pageSubscriptions.autoRenew} is distinct from false then excluded.auto_renew_off_detected_at
                else coalesce(${pageSubscriptions.autoRenewOffDetectedAt}, excluded.auto_renew_off_detected_at)
              end
            when excluded.auto_renew is true then null
            else ${pageSubscriptions.autoRenewOffDetectedAt}
          end
        `,
      },
    })
    .returning();
  return subscription;
}

export interface UpsertPageSubscriptionInput {
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
  autoRenewOffDetectedAt?: Date | null;
  billingCycleDays?: number | null;
  durationDays?: number | null;
  renewDate?: Date | null;
  sourceCreatedAt?: Date | null;
  sourceUpdatedAt?: Date | null;
  endsAt?: Date | null;
  lastSeenGeneration?: number | null;
}

export async function upsertPageSubscriptions(
  db: Database,
  inputs: UpsertPageSubscriptionInput[],
) {
  if (inputs.length === 0) {
    return;
  }

  const deduped = dedupeByKey(
    inputs,
    (input) => `${input.platformAccountId}:${input.platformSubscriptionId}`,
    (_current, next) => next,
  );
  const lastSeenAt = new Date();

  await db
    .insert(pageSubscriptions)
    .values(deduped.map((input) => ({
      platformSubscriptionId: input.platformSubscriptionId,
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
      autoRenewOffDetectedAt: input.autoRenewOffDetectedAt ?? (
        input.autoRenew === false ? lastSeenAt : null
      ),
      billingCycleDays: input.billingCycleDays ?? null,
      durationDays: input.durationDays ?? null,
      renewDate: input.renewDate ?? null,
      sourceCreatedAt: input.sourceCreatedAt ?? null,
      sourceUpdatedAt: input.sourceUpdatedAt ?? null,
      endsAt: input.endsAt ?? null,
      isCurrent: true,
      lastSeenGeneration: input.lastSeenGeneration ?? null,
      lastSeenAt,
    })))
    .onConflictDoUpdate({
      target: [pageSubscriptions.platformAccountId, pageSubscriptions.platformSubscriptionId],
      set: {
        platformAccountId: sql`excluded.platform_account_id`,
        fanId: sql`excluded.fan_id`,
        platformHistoryId: sql`excluded.platform_history_id`,
        subscriptionTierId: sql`excluded.subscription_tier_id`,
        subscriptionTierName: sql`excluded.subscription_tier_name`,
        subscriptionTierColor: sql`excluded.subscription_tier_color`,
        planId: sql`excluded.plan_id`,
        rawStatus: sql`excluded.raw_status`,
        canonicalStatus: sql`excluded.canonical_status`,
        priceMills: sql`excluded.price_mills`,
        renewPriceMills: sql`excluded.renew_price_mills`,
        autoRenew: sql`excluded.auto_renew`,
        autoRenewOffDetectedAt: sql`
          case
            when excluded.auto_renew is false then
              case
                when ${pageSubscriptions.autoRenew} is distinct from false then excluded.auto_renew_off_detected_at
                else coalesce(${pageSubscriptions.autoRenewOffDetectedAt}, excluded.auto_renew_off_detected_at)
              end
            when excluded.auto_renew is true then null
            else ${pageSubscriptions.autoRenewOffDetectedAt}
          end
        `,
        billingCycleDays: sql`excluded.billing_cycle_days`,
        durationDays: sql`excluded.duration_days`,
        renewDate: sql`excluded.renew_date`,
        sourceCreatedAt: sql`excluded.source_created_at`,
        sourceUpdatedAt: sql`excluded.source_updated_at`,
        endsAt: sql`excluded.ends_at`,
        isCurrent: true,
        lastSeenGeneration: sql`excluded.last_seen_generation`,
        lastSeenAt,
      },
    });
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
    update page_fans fp
    set is_subscriber = active.active_subscriber_since is not null,
        subscriber_since = active.active_subscriber_since,
        subscription_expires_at = active.active_subscription_expires_at,
        auto_renew = active.active_auto_renew,
        auto_renew_off_detected_at = active.active_auto_renew_off_detected_at,
        last_seen_at = now()
    from (
      select fan_id,
             min(source_created_at) as active_subscriber_since,
             max(ends_at) as active_subscription_expires_at,
             case
               when bool_or(auto_renew = true) then true
               when bool_or(auto_renew = false) then false
               else null
             end as active_auto_renew,
             case
               when bool_or(auto_renew = true) then null
               else min(auto_renew_off_detected_at) filter (where auto_renew = false)
             end as active_auto_renew_off_detected_at
      from page_subscriptions
      where platform_account_id = ${platformAccountId}
        and is_current = true
      group by fan_id
    ) active
    where fp.platform_account_id = ${platformAccountId}
      and fp.fan_id = active.fan_id
  `);
  await db.execute(sql`
    update page_fans
    set is_subscriber = false,
        subscriber_since = null,
        subscription_expires_at = null,
        auto_renew = null,
        auto_renew_off_detected_at = null,
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
    from page_fans fp
    join fans f on f.id = fp.fan_id
    left join fan_spend_lifetime slp
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
    from page_fans fp
    join fans f on f.id = fp.fan_id
    left join fan_spend_lifetime slp
      on slp.platform_account_id = fp.platform_account_id
     and slp.fan_id = fp.fan_id
    where fp.platform_account_id = ${platformAccountId}
    order by coalesce(slp.creator_net_amount_mills, 0) desc,
             slp.last_transaction_at desc nulls last,
             f.id asc
    limit ${limit}
  `);
}

/** One subscription row by its platform identity (OFAPI live projection lookups). */
export async function findPageSubscription(
  db: Database,
  input: { platformAccountId: number; platformSubscriptionId: string },
) {
  const [row] = await db
    .select()
    .from(pageSubscriptions)
    .where(and(
      eq(pageSubscriptions.platformAccountId, input.platformAccountId),
      eq(pageSubscriptions.platformSubscriptionId, input.platformSubscriptionId),
    ))
    .limit(1);

  return row ?? null;
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
