import { and, eq, gte, inArray, notInArray, or, sql } from "drizzle-orm";

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
  pages,
  pageSubscriptions,
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

/**
 * Write only when something changed, or when `last_seen_at` is older than this
 * window. Every sync pass used to rewrite every row of a page with
 * `last_seen_at = now()` (page_fans: ~10k updates/min on ~350 rows, autovacuum
 * every minute, 20+ GB WAL/day — docs/diag/2026-09-11-agency-hub-load).
 * `last_seen_at` therefore means "last change, or refreshed within a minute".
 */
const LAST_SEEN_REFRESH_WINDOW = sql`interval '60 seconds'`;

function lastSeenIsStale(column: unknown) {
  return sql`${column} < now() - ${LAST_SEEN_REFRESH_WINDOW}`;
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
    const changed: ReturnType<typeof sql>[] = [lastSeenIsStale(fans.lastSeenAt)];
    if (template.username !== undefined) {
      changed.push(sql`${fans.username} is distinct from excluded.username`);
    }
    if (template.displayName !== undefined) {
      changed.push(sql`${fans.displayName} is distinct from excluded.display_name`);
    }
    if (template.createdAtExternal !== undefined) {
      changed.push(sql`${fans.createdAtExternal} is distinct from excluded.created_at_external`);
    }
    if (template.metadata !== undefined) {
      changed.push(sql`${fans.metadata} is distinct from excluded.metadata`);
    }
    if (template.deletedDetectedAt !== undefined || hasPresentIdentity(template)) {
      const nextDeletedDetectedAt = sql`
        case
          when nullif(btrim(coalesce(excluded.username, '')), '') is not null
            or nullif(btrim(coalesce(excluded.display_name, '')), '') is not null
            then null
          when excluded.deleted_detected_at is not null
            then coalesce(${fans.deletedDetectedAt}, excluded.deleted_detected_at)
          else ${fans.deletedDetectedAt}
        end
      `;
      const nextDeletedLastDetectedAt = sql`
        case
          when nullif(btrim(coalesce(excluded.username, '')), '') is not null
            or nullif(btrim(coalesce(excluded.display_name, '')), '') is not null
            then null
          when excluded.deleted_detected_at is not null
            then excluded.deleted_last_detected_at
          else ${fans.deletedLastDetectedAt}
        end
      `;
      updateSet.deletedDetectedAt = nextDeletedDetectedAt;
      updateSet.deletedLastDetectedAt = nextDeletedLastDetectedAt;
      changed.push(sql`(${nextDeletedDetectedAt}) is distinct from ${fans.deletedDetectedAt}`);
      changed.push(sql`(${nextDeletedLastDetectedAt}) is distinct from ${fans.deletedLastDetectedAt}`);
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
        setWhere: sql.join(changed, sql` or `),
      })
      .returning();
    // Rows the conditional update skipped are not RETURNED; callers still
    // need every fan row, so read the untouched ones back.
    const returnedKeys = new Set(rows.map((row) => `${row.platform}:${row.platformUserId}`));
    const untouched = group.filter((item) => !returnedKeys.has(`${item.platform}:${item.platformUserId}`));
    if (untouched.length > 0) {
      const existing = await db
        .select()
        .from(fans)
        .where(or(...untouched.map((item) => and(
          eq(fans.platform, item.platform),
          eq(fans.platformUserId, item.platformUserId),
        ))));
      rows.push(...existing);
    }

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
      // RETURNING followed by the untouched read-back has no stable order.
      // Concurrent autocommit callers have already released their fan locks;
      // acquire alias conflicts in the same order even when UPDATE is skipped.
      aliasValues.sort((left, right) => left.fanId - right.fanId
        || (left.username < right.username ? -1 : left.username > right.username ? 1 : 0));
      await db.insert(fanUsernameAliases).values(aliasValues).onConflictDoUpdate({
        target: [fanUsernameAliases.fanId, fanUsernameAliases.username],
        set: {
          firstSeenAt: sql`least(${fanUsernameAliases.firstSeenAt}, excluded.first_seen_at)`,
          lastSeenAt: sql`greatest(${fanUsernameAliases.lastSeenAt}, excluded.last_seen_at)`,
        },
        setWhere: sql`excluded.first_seen_at < ${fanUsernameAliases.firstSeenAt}
          or excluded.last_seen_at > ${fanUsernameAliases.lastSeenAt}`,
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
    const changed: ReturnType<typeof sql>[] = [lastSeenIsStale(fanPages.lastSeenAt)];
    const compare = (column: unknown, excludedColumn: string) => {
      changed.push(sql`${column} is distinct from ${sql.raw(`excluded.${excludedColumn}`)}`);
    };
    if (template.isFollower !== undefined) compare(fanPages.isFollower, "is_follower");
    if (template.followerSince !== undefined) compare(fanPages.followerSince, "follower_since");
    if (template.isSubscriber !== undefined) compare(fanPages.isSubscriber, "is_subscriber");
    if (template.subscriberSince !== undefined) compare(fanPages.subscriberSince, "subscriber_since");
    if (template.subscriptionExpiresAt !== undefined) {
      compare(fanPages.subscriptionExpiresAt, "subscription_expires_at");
    }
    if (template.autoRenew !== undefined) compare(fanPages.autoRenew, "auto_renew");
    if (template.autoRenew !== undefined || template.autoRenewOffDetectedAt !== undefined) {
      const nextAutoRenewOffDetectedAt = sql`
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
      updateSet.autoRenewOffDetectedAt = nextAutoRenewOffDetectedAt;
      changed.push(sql`(${nextAutoRenewOffDetectedAt}) is distinct from ${fanPages.autoRenewOffDetectedAt}`);
    }
    if (template.pageAlias !== undefined) {
      updateSet.pageAlias = sql`excluded.page_alias`;
      compare(fanPages.pageAlias, "page_alias");
    }
    if (template.pageAliasSource !== undefined) {
      updateSet.pageAliasSource = sql`excluded.page_alias_source`;
      compare(fanPages.pageAliasSource, "page_alias_source");
    }
    if (template.pageAliasSourceNoteId !== undefined) {
      updateSet.pageAliasSourceNoteId = sql`excluded.page_alias_source_note_id`;
      compare(fanPages.pageAliasSourceNoteId, "page_alias_source_note_id");
    }
    if (template.pageAliasSyncedAt !== undefined) {
      updateSet.pageAliasSyncedAt = sql`excluded.page_alias_synced_at`;
      compare(fanPages.pageAliasSyncedAt, "page_alias_synced_at");
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
        setWhere: sql.join(changed, sql` or `),
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

/**
 * Owner decision 2026-09-30: a fan's Fansly profile is read at most once a day
 * per page. Returns the ids linked to this page whose account lookup through
 * the page returned at or after `since` and was stored (0224). An id with no
 * fan row or no link to the page was never looked up here, so it never comes
 * back and its caller looks it up.
 */
export async function listFanslyFansLookedUpSince(
  db: Database,
  input: { platformAccountId: number; platformUserIds: string[]; since: Date },
) {
  if (input.platformUserIds.length === 0) {
    return [] as string[];
  }

  const rows = await db
    .select({ platformUserId: fans.platformUserId })
    .from(fans)
    .innerJoin(fanPages, and(
      eq(fanPages.fanId, fans.id),
      eq(fanPages.platformAccountId, input.platformAccountId),
    ))
    .where(and(
      eq(fans.platform, "fansly"),
      inArray(fans.platformUserId, input.platformUserIds),
      gte(fanPages.accountLookupAt, input.since),
    ));
  return rows.map((row) => row.platformUserId);
}

/** Stamps the page links of fans whose lookup result the caller's transaction
 * stores, so the stamp commits (or rolls back) with that result. */
export async function markFanPageAccountLookups(
  db: Database,
  input: { platformAccountId: number; fanIds: number[]; lookedUpAt: Date },
) {
  if (input.fanIds.length === 0) {
    return;
  }

  await db
    .update(fanPages)
    .set({ accountLookupAt: input.lookedUpAt })
    .where(and(
      eq(fanPages.platformAccountId, input.platformAccountId),
      inArray(fanPages.fanId, input.fanIds),
    ));
}

export interface FanslyAccountProbeAnswer {
  probedAt: Date;
  resolved: boolean;
}

/** The DM partner probe's last answer through this page, or null when the
 * partner is not linked to the page or was never probed there. */
export async function readFanslyAccountProbe(
  db: Database,
  input: { platformAccountId: number; platformUserId: string },
): Promise<FanslyAccountProbeAnswer | null> {
  const [row] = await db
    .select({ probedAt: fanPages.accountProbeAt, resolved: fanPages.accountProbeResolved })
    .from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .where(and(
      eq(fanPages.platformAccountId, input.platformAccountId),
      eq(fans.platform, "fansly"),
      eq(fans.platformUserId, input.platformUserId),
    ))
    .limit(1);
  return row?.probedAt && row.resolved !== null
    ? { probedAt: row.probedAt, resolved: row.resolved }
    : null;
}

/** Records the probe's answer on the partner's page link. A partner not linked
 * to the page keeps no answer, and the next probe asks again. */
export async function recordFanslyAccountProbe(
  db: Database,
  input: { platformAccountId: number; platformUserId: string; probedAt: Date; resolved: boolean },
) {
  await db
    .update(fanPages)
    .set({ accountProbeAt: input.probedAt, accountProbeResolved: input.resolved })
    .where(and(
      eq(fanPages.platformAccountId, input.platformAccountId),
      inArray(
        fanPages.fanId,
        db.select({ id: fans.id }).from(fans).where(and(
          eq(fans.platform, "fansly"),
          eq(fans.platformUserId, input.platformUserId),
        )),
      ),
    ));
}

export interface UpsertPageFollowInput {
  platformAccountId: number;
  fanId: number;
  platformFollowId: string;
  followedAt: Date;
  lastSeenGeneration?: number | null;
}

/** A live incremental upsert carries no reconcile generation. Preserve the
 * row's sweep witness in that case, and make explicit generations monotonic so
 * an older concurrent writer cannot move a row back into the retire set. */
function monotonicPageFollowGeneration() {
  return sql`
    case
      when excluded.last_seen_generation is null then ${pageFollows.lastSeenGeneration}
      when ${pageFollows.lastSeenGeneration} is null then excluded.last_seen_generation
      else greatest(${pageFollows.lastSeenGeneration}, excluded.last_seen_generation)
    end
  `;
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
        lastSeenGeneration: monotonicPageFollowGeneration(),
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
        lastSeenGeneration: monotonicPageFollowGeneration(),
      },
    })
    .returning();
  return pageFollow;
}

export async function countActivePageFollows(db: Database, platformAccountId: number) {
  const result = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    from page_follows
    where platform_account_id = ${platformAccountId}
      and is_active = true
  `);

  return result.rows[0]?.count ?? 0;
}

function parseGenerationHighWater(value: unknown, relation: string) {
  const generation = Number(value ?? 0);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error(`Expected ${relation} generation high-water to be a non-negative safe integer`);
  }
  return generation;
}

export async function maxPageFollowGeneration(db: Database, platformAccountId: number) {
  const result = await db.execute(sql`
    select coalesce(max(last_seen_generation), 0)::int as generation
    from page_follows
    where platform_account_id = ${platformAccountId}
  `);

  return parseGenerationHighWater(result.rows[0]?.generation, "page_follows");
}

export async function countPageFollowsByGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
  },
) {
  const result = await db.execute(sql`
    select count(*)::int as count
    from page_follows
    where platform_account_id = ${input.platformAccountId}
      and last_seen_generation = ${input.generation}
  `);

  return result.rows[0]?.count ?? 0;
}

export interface PageFollowReconcileActivity {
  /** Active rows first inserted after the sweep started but not stamped by it. */
  firstSeenDuringSweepOutsideGeneration: number;
  activeFollowerCount: number;
  /** Rows the guarded destructive statement could currently retire. */
  deactivationCandidateCount: number;
  activeInGenerationCount: number;
  /** Active rows not observed in this generation, partitioned below. */
  activeOutsideGenerationCount: number;
  generationGraceOnlyCount: number;
  touchedSinceStartOnlyCount: number;
  generationGraceAndTouchCount: number;
  futureGenerationCount: number;
}

export interface PageFollowDeactivationCandidate {
  id: number;
  lastSeenGeneration: number | null;
}

export interface PageFollowDeactivationGenerationBucket {
  lastSeenGeneration: number | null;
  count: number;
}

type PageFollowDeactivationCandidateInput = {
  platformAccountId: number;
  generation: number;
  fullSweepStartedAt: Date;
};

/** The one destructive predicate shared by count, preview and apply. Keeping
 *  it as one SQL fragment is load-bearing: an owner approval must hash exactly
 *  the rows the existing finalizer can update, not a look-alike population. */
function pageFollowDeactivationCandidatePredicate(
  input: PageFollowDeactivationCandidateInput,
) {
  return sql`
    platform_account_id = ${input.platformAccountId}
    and is_active = true
    and last_seen_at < ${input.fullSweepStartedAt}
    and (
      last_seen_generation is null
      or last_seen_generation < ${input.generation - 1}
    )
  `;
}

function pageFollowIdFromText(value: string) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error("page_follows.id is outside the safe integer range");
  }
  return normalized;
}

/** Transactional witnesses for the terminal follower-reconcile decision. */
export async function readPageFollowReconcileActivity(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
    fullSweepStartedAt: Date;
  },
): Promise<PageFollowReconcileActivity> {
  const result = await db.execute(sql`
    select
      count(*) filter (
        where is_active = true
          and first_seen_at >= ${input.fullSweepStartedAt}
          and last_seen_generation is distinct from ${input.generation}
      )::int as first_seen_during_sweep_outside_generation,
      count(*) filter (where is_active = true)::int as active_follower_count,
      count(*) filter (
        where ${pageFollowDeactivationCandidatePredicate(input)}
      )::int as deactivation_candidate_count,
      count(*) filter (
        where is_active = true and last_seen_generation = ${input.generation}
      )::int as active_in_generation_count,
      count(*) filter (
        where is_active = true
          and last_seen_generation is distinct from ${input.generation}
      )::int as active_outside_generation_count,
      count(*) filter (
        where is_active = true
          and last_seen_generation = ${input.generation - 1}
          and last_seen_at < ${input.fullSweepStartedAt}
      )::int as generation_grace_only_count,
      count(*) filter (
        where is_active = true
          and (last_seen_generation is null or last_seen_generation < ${input.generation - 1})
          and last_seen_at >= ${input.fullSweepStartedAt}
      )::int as touched_since_start_only_count,
      count(*) filter (
        where is_active = true
          and last_seen_generation = ${input.generation - 1}
          and last_seen_at >= ${input.fullSweepStartedAt}
      )::int as generation_grace_and_touch_count,
      count(*) filter (
        where is_active = true and last_seen_generation > ${input.generation}
      )::int as future_generation_count
    from page_follows
    where platform_account_id = ${input.platformAccountId}
  `);
  const row = result.rows[0];
  return {
    firstSeenDuringSweepOutsideGeneration: Number(
      row?.first_seen_during_sweep_outside_generation ?? 0,
    ),
    activeFollowerCount: Number(row?.active_follower_count ?? 0),
    deactivationCandidateCount: Number(row?.deactivation_candidate_count ?? 0),
    activeInGenerationCount: Number(row?.active_in_generation_count ?? 0),
    activeOutsideGenerationCount: Number(row?.active_outside_generation_count ?? 0),
    generationGraceOnlyCount: Number(row?.generation_grace_only_count ?? 0),
    touchedSinceStartOnlyCount: Number(row?.touched_since_start_only_count ?? 0),
    generationGraceAndTouchCount: Number(row?.generation_grace_and_touch_count ?? 0),
    futureGenerationCount: Number(row?.future_generation_count ?? 0),
  };
}

/** Exact, stable-order candidate set for the owner blast-radius override.
 *  `lock` is required by apply: it prevents an existing candidate from being
 *  touched between the approval re-check and the guarded UPDATE. */
export async function listPageFollowDeactivationCandidates(
  db: Database,
  input: PageFollowDeactivationCandidateInput,
  options?: { lock?: boolean },
): Promise<PageFollowDeactivationCandidate[]> {
  const result = await db.execute<{ id: string; lastSeenGeneration: string | null }>(sql`
    select id::text as id,
           last_seen_generation::text as "lastSeenGeneration"
    from page_follows
    where ${pageFollowDeactivationCandidatePredicate(input)}
    order by id asc
    ${options?.lock ? sql`for update` : sql``}
  `);

  return result.rows.map((row) => ({
    id: pageFollowIdFromText(row.id),
    lastSeenGeneration: row.lastSeenGeneration === null
      ? null
      : Number(row.lastSeenGeneration),
  }));
}

/** Aggregate-only blocker telemetry. A corrupt/self-consistent provider list
 *  could make the candidate set enormous; the automatic guard must not load
 *  every surrogate id merely to explain why it refused the UPDATE. */
export async function readPageFollowDeactivationGenerationBuckets(
  db: Database,
  input: PageFollowDeactivationCandidateInput,
): Promise<PageFollowDeactivationGenerationBucket[]> {
  const result = await db.execute<{
    lastSeenGeneration: string | null;
    count: number | string;
  }>(sql`
    select last_seen_generation::text as "lastSeenGeneration",
           count(*)::int as count
    from page_follows
    where ${pageFollowDeactivationCandidatePredicate(input)}
    group by last_seen_generation
    order by last_seen_generation asc nulls first
  `);

  return result.rows.map((row) => ({
    lastSeenGeneration: row.lastSeenGeneration === null
      ? null
      : Number(row.lastSeenGeneration),
    count: Number(row.count),
  }));
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
      and (
        fp.is_follower is distinct from (resolved.active_followed_at is not null)
        or fp.follower_since is distinct from resolved.active_followed_at
        or ${lastSeenIsStale(sql`fp.last_seen_at`)}
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
    isCurrent: input.isCurrent ?? true,
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
      ...(input.lifecycleEvidenceAt ? { setWhere: sql`(${pageSubscriptions.sourceUpdatedAt} is null
        or ${pageSubscriptions.sourceUpdatedAt} <= ${input.lifecycleEvidenceAt})` } : {}),
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
  isCurrent?: boolean;
  /** Webhook-only monotonic guard; callers must update page_fans only when this write wins. */
  lifecycleEvidenceAt?: Date;
}

export async function maxPageSubscriptionGeneration(db: Database, platformAccountId: number) {
  const result = await db.execute(sql`
    select coalesce(max(last_seen_generation), 0)::int as generation
    from page_subscriptions
    where platform_account_id = ${platformAccountId}
  `);

  return parseGenerationHighWater(result.rows[0]?.generation, "page_subscriptions");
}

async function writePageSubscriptions(
  db: Database,
  inputs: UpsertPageSubscriptionInput[],
  isCurrent: boolean,
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
  const rows = deduped.map((input) => ({
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
    isCurrent,
    lastSeenGeneration: input.lastSeenGeneration ?? null,
    lastSeenAt,
  }));
  const updateSet = {
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
    isCurrent: sql`excluded.is_current`,
    lastSeenGeneration: sql`excluded.last_seen_generation`,
    lastSeenAt,
  };

  if (isCurrent) {
    await db
      .insert(pageSubscriptions)
      .values(rows)
      .onConflictDoUpdate({
        target: [pageSubscriptions.platformAccountId, pageSubscriptions.platformSubscriptionId],
        set: updateSet,
      });
  } else {
    await db
      .insert(pageSubscriptions)
      .values(rows)
      .onConflictDoUpdate({
        target: [pageSubscriptions.platformAccountId, pageSubscriptions.platformSubscriptionId],
        set: {
          ...updateSet,
          // last_seen_at is the historical retirement stamp once a row is
          // inactive. A later archive refresh may improve metadata, but must
          // not move that factual boundary to the backfill date.
          lastSeenAt: pageSubscriptions.lastSeenAt,
        },
        // History backfill is archive-only: a stale status=5 row must never
        // turn a concurrently active subscription off.
        setWhere: eq(pageSubscriptions.isCurrent, false),
      });
  }
}

export async function upsertPageSubscriptions(
  db: Database,
  inputs: UpsertPageSubscriptionInput[],
) {
  return writePageSubscriptions(db, inputs, true);
}

export async function upsertArchivedPageSubscriptions(
  db: Database,
  inputs: UpsertPageSubscriptionInput[],
) {
  return writePageSubscriptions(db, inputs, false);
}

export async function deactivatePageFollowsByGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
    // A live follower inserted or touched while the sweep was in flight was
    // not necessarily reachable by its already-passed offset. It must survive
    // this generation and prove absent on a later one before retirement. A
    // row seen by the immediately preceding generation receives the same
    // two-generation grace even when it was not touched live.
    lastSeenBefore: Date;
  },
) {
  const result = await db.execute<{ id: string }>(sql`
    update page_follows
    set is_active = false,
        last_seen_at = now()
    where ${pageFollowDeactivationCandidatePredicate({
      platformAccountId: input.platformAccountId,
      generation: input.generation,
      fullSweepStartedAt: input.lastSeenBefore,
    })}
    returning id::text as id
  `);
  return result.rows.map((row) => pageFollowIdFromText(row.id));
}

/** Distinct current subscriptions a subscriber walk has stamped with its
 * generation: the membership a multi-page walk must prove before it retires
 * unseen rows. */
export async function countCurrentPageSubscriptionsByGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
  },
) {
  const result = await db.execute<{ count: string | number }>(sql`
    select count(*)::int as count
    from page_subscriptions
    where platform_account_id = ${input.platformAccountId}
      and last_seen_generation = ${input.generation}
      and is_current = true
  `);

  return Number(result.rows[0]?.count ?? 0);
}

export async function deactivatePageSubscriptionsByGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
    // Audit P-25: a sweep can only retire what it had a chance to observe.
    // The live webhook projection inserts subscriptions with a null
    // generation; one created mid-sweep may sit at an offset the walk already
    // passed and would be retired at finalization despite being fresh and
    // real. Passing the sweep's start time spares every row touched since.
    lastSeenBefore?: Date;
  },
) {
  const touchedSinceSweepStartGuard = input.lastSeenBefore
    ? sql` and last_seen_at < ${input.lastSeenBefore}`
    : sql``;
  await db.execute(sql`
    update page_subscriptions
    set is_current = false,
        last_seen_at = now()
    where platform_account_id = ${input.platformAccountId}
      and is_current = true
      and (last_seen_generation is null or last_seen_generation < ${input.generation})${touchedSinceSweepStartGuard}
  `);
}

/** Fansly's own account subscriber counter (`/account/me` subscriberCount),
 * as last written to the page with the instant it was read. */
export type PageSubscriberCounter = {
  subscriberCount: number | null;
  lastVerifiedAt: Date | null;
};

export type EmptySnapshotSubscriptionRetirement =
  | {
    certified: true;
    retiredCount: number;
    currentCount: number;
    /** Present when the account counter, not the lapsed rule, confirmed the zero. */
    counter?: PageSubscriberCounter;
  }
  | {
    certified: false;
    reason: "observed_by_walk" | "too_many_current" | "not_known_lapsed";
    currentCount: number;
    /** The counter that was consulted and did not confirm the zero. */
    counter?: PageSubscriberCounter;
  };

/**
 * Retires the membership a stated-empty active subscriber snapshot (an
 * explicit provider total of zero, no rows) vouches for, inside the caller's
 * owned transaction. The zero is trusted only as far as it is independently
 * plausible: at most `maxRetirements` current subscriptions, each known to have
 * lapsed before the walk began (`ends_at` earlier than `walkStartedAt`) with
 * auto-renew off. Failing that, and given `counterVerifiedSince`, the zero is
 * trusted when the page's account subscriber counter also reads 0 and was
 * verified at or after that instant; every candidate is then retired, whatever
 * its count, end or auto-renew. The candidates are locked, assessed and retired
 * as one set, so a row renewed or inserted after the assessment is never swept
 * up with it; rows touched since the walk began are not candidates at all
 * (Audit P-25). A current row stamped with the walk's own generation is a
 * positive observation from the same walk and refuses the zero. A refusal
 * writes nothing.
 */
export async function retireLapsedPageSubscriptionsForEmptySnapshot(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
    walkStartedAt: Date;
    maxRetirements: number;
    counterVerifiedSince?: Date;
  },
): Promise<EmptySnapshotSubscriptionRetirement> {
  const current = await db.execute<{ current_count: number; observed_by_walk: number }>(sql`
    select count(*)::int as current_count,
           count(*) filter (where last_seen_generation >= ${input.generation})::int as observed_by_walk
    from page_subscriptions
    where platform_account_id = ${input.platformAccountId}
      and is_current = true
  `);
  const currentCount = Number(current.rows[0]?.current_count ?? 0);
  if (Number(current.rows[0]?.observed_by_walk ?? 0) > 0) {
    return { certified: false, reason: "observed_by_walk", currentCount };
  }

  const candidatePredicate = sql`
    platform_account_id = ${input.platformAccountId}
      and is_current = true
      and (last_seen_generation is null or last_seen_generation < ${input.generation})
      and last_seen_at < ${input.walkStartedAt}`;
  const candidates = await db.execute<{ id: string; lapsed: boolean }>(sql`
    select id::text as id,
           (ends_at is not null and ends_at < ${input.walkStartedAt} and auto_renew is false) as lapsed
    from page_subscriptions
    where ${candidatePredicate}
    order by id
    limit ${input.maxRetirements + 1}
    for update
  `);
  const refusal = candidates.rows.length > input.maxRetirements
    ? "too_many_current" as const
    : candidates.rows.every((row) => row.lapsed === true) ? null : "not_known_lapsed" as const;
  if (refusal !== null) {
    if (input.counterVerifiedSince === undefined) {
      return { certified: false, reason: refusal, currentCount };
    }
    const [counter] = await db
      .select({ subscriberCount: pages.subscriberCount, lastVerifiedAt: pages.lastVerifiedAt })
      .from(pages)
      .where(eq(pages.id, input.platformAccountId));
    const pageCounter: PageSubscriberCounter = {
      subscriberCount: counter?.subscriberCount ?? null,
      lastVerifiedAt: counter?.lastVerifiedAt ?? null,
    };
    const confirmed = pageCounter.subscriberCount === 0 &&
      pageCounter.lastVerifiedAt !== null &&
      pageCounter.lastVerifiedAt.getTime() >= input.counterVerifiedSince.getTime();
    if (!confirmed) {
      return { certified: false, reason: refusal, currentCount, counter: pageCounter };
    }
    // The whole candidate set, locked before it is retired; it contains the
    // rows the lapsed rule already locked.
    const confirmedCandidates = await db.execute<{ id: string }>(sql`
      select id::text as id
      from page_subscriptions
      where ${candidatePredicate}
      order by id
      for update
    `);
    const retiredCount = await retireCurrentPageSubscriptions(
      db,
      input.platformAccountId,
      confirmedCandidates.rows.map((row) => row.id),
    );
    return { certified: true, retiredCount, currentCount, counter: pageCounter };
  }
  const retiredCount = await retireCurrentPageSubscriptions(
    db,
    input.platformAccountId,
    candidates.rows.map((row) => row.id),
  );
  return { certified: true, retiredCount, currentCount };
}

async function retireCurrentPageSubscriptions(db: Database, platformAccountId: number, ids: string[]) {
  if (ids.length > 0) {
    await db.execute(sql`
      update page_subscriptions
      set is_current = false,
          last_seen_at = now()
      where platform_account_id = ${platformAccountId}
        and id = any(${sql.param(ids)}::bigint[])
        and is_current = true
    `);
  }
  return ids.length;
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
      and (
        fp.is_subscriber is distinct from (active.active_subscriber_since is not null)
        or fp.subscriber_since is distinct from active.active_subscriber_since
        or fp.subscription_expires_at is distinct from active.active_subscription_expires_at
        or fp.auto_renew is distinct from active.active_auto_renew
        or fp.auto_renew_off_detected_at is distinct from active.active_auto_renew_off_detected_at
        or ${lastSeenIsStale(sql`fp.last_seen_at`)}
      )
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
      and (
        is_subscriber
        or subscriber_since is not null
        or subscription_expires_at is not null
        or auto_renew is not null
        or auto_renew_off_detected_at is not null
        or ${lastSeenIsStale(sql`last_seen_at`)}
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

/**
 * One subscription row by its platform identity (OFAPI live projection
 * lookups). Audit P-26: the projection carries the row it read forward into a
 * full-row upsert, so its read must be locked (forUpdate inside the writing
 * transaction) — otherwise a concurrent audience sweep's fresher
 * renew/expiry dates and generation stamp get clobbered back to the stale
 * snapshot (the same lost-update shape as B11).
 */
export async function findPageSubscription(
  db: Database,
  input: {
    platformAccountId: number;
    platformSubscriptionId: string;
    forUpdate?: boolean;
  },
) {
  const query = db
    .select()
    .from(pageSubscriptions)
    .where(and(
      eq(pageSubscriptions.platformAccountId, input.platformAccountId),
      eq(pageSubscriptions.platformSubscriptionId, input.platformSubscriptionId),
    ))
    .limit(1);
  const [row] = input.forUpdate === true ? await query.for("update") : await query;

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

/**
 * Stage 16: the purchase_history walk iterates a page's fans by native id —
 * the order-history endpoint is per-fan (accountIds), cursorless. Keyset by
 * fans.id for a stable checkpointed walk.
 */
export async function listPageFanNativeIds(
  db: Database,
  input: {
    platformAccountId: number;
    afterFanId?: number | null;
    limit?: number;
    /** Only fans with recorded spend (page_fans net > 0) — the Stage 32
     * fan-earnings walk is spender-scoped: 92–994 spenders per page vs
     * 3.6k–20k fans, and zero-spend fans have no earnings rows to fetch. */
    spendersOnly?: boolean;
  },
): Promise<Array<{ fanId: number; platformUserId: string }>> {
  const spenderClause = input.spendersOnly
    ? sql`and pf.total_creator_net_mills > 0`
    : sql``;
  const result = await db.execute<{ fan_id: string; platform_user_id: string }>(sql`
    select f.id::text as fan_id, f.platform_user_id
    from page_fans pf
    join fans f on f.id = pf.fan_id
    where pf.platform_account_id = ${input.platformAccountId}
      and f.id > ${input.afterFanId ?? 0}
      ${spenderClause}
    order by f.id asc
    limit ${input.limit ?? 25}
  `);
  return result.rows.map((row) => ({
    fanId: Number(row.fan_id),
    platformUserId: row.platform_user_id,
  }));
}
