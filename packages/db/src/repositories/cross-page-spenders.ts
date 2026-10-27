import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { witnessFor, witnessesFor, type PlaneReadWitness } from "./agent-read-witness.ts";

/**
 * Cross-page spenders: the fans in one page's audience (the TARGET) who paid
 * other pages of the same platform (the SOURCES).
 *
 * The agency runs several pages per model; a fan who spends on lora-2 often
 * follows lora-1 for free, and a lora-1 mass message to every follower then
 * lands in his chat with lora-1 out of place. This is the set such a message
 * should leave out: `hub cross-spenders` reads it, and a hub-managed Fansly
 * list of the target page will hold it.
 *
 * A fan is `fans.id`, one identity across the pages of ONE platform: the
 * statement joins the sources' rows to the target's audience on it, and every
 * source page must be on the target's platform (the caller checks it; the
 * statement repeats it, so a mixed list reads nothing from the foreign page).
 * Money is `fan_spend_lifetime.gross_amount_mills` (what the fan paid, mills).
 *
 * Pure reads, no writes. Each function returns the agent plane's witnesses of
 * the statements it ran (`agent-read-witness.ts`).
 */

export type CrossPageAudience = "followers" | "subscribers" | "any";

export interface CrossPageSpendersQuery {
  targetPageId: number;
  /** Pages of the target's platform, never the target itself. Empty: no fan. */
  sourcePageIds: readonly number[];
  audience: CrossPageAudience;
  /** The fan qualifies when his gross over the sources is at least this. */
  minSourceSpendMills: bigint;
  /** ...and his gross on the target at most this; null: any. */
  maxTargetSpendMills: bigint | null;
}

export interface CrossPageSpenderSourceRow {
  pageId: number;
  grossMills: bigint;
  lastTransactionAt: Date | null;
}

export interface CrossPageSpenderRow {
  fanId: number;
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  isFollower: boolean;
  followerSince: Date | null;
  isSubscriber: boolean;
  subscriptionExpiresAt: Date | null;
  /** The target page's last account answer did not return the fan (deleted
   *  the account or blocked the page); null otherwise. */
  accountLookupMissAt: Date | null;
  targetSpendMills: bigint;
  sourceSpendMills: bigint;
  lastSourceTransactionAt: Date | null;
  /** The sources the fan paid (a non-zero gross), largest first. */
  sources: CrossPageSpenderSourceRow[];
}

function idList(ids: readonly number[]): SQL {
  return sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

function date(value: unknown): Date | null {
  if (value == null) return null;
  const parsed = new Date(value as string | Date);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function audiencePredicate(audience: CrossPageAudience): SQL {
  switch (audience) {
    case "followers":
      return sql`pf.is_follower`;
    case "subscribers":
      return sql`pf.is_subscriber`;
    case "any":
      return sql`(pf.is_follower or pf.is_subscriber)`;
  }
}

/**
 * The whole qualifying set, largest source spend first, then the fan's
 * platform id (byte order, so a resumed page compares the way it sorted).
 * Bounded by the target's audience: one statement over `page_fans` of one page
 * and the primary keys of `fan_spend_lifetime`.
 */
export async function listCrossPageSpenders(
  db: Database,
  query: CrossPageSpendersQuery,
): Promise<{ rows: CrossPageSpenderRow[]; witnesses: PlaneReadWitness[] }> {
  if (query.sourcePageIds.length === 0) {
    return { rows: [], witnesses: [] };
  }
  const max = query.maxTargetSpendMills === null ? null : query.maxTargetSpendMills.toString();
  const result = await db.execute<Record<string, unknown>>(sql`
    with audience as (
      select pf.fan_id, pf.is_follower, pf.follower_since, pf.is_subscriber, pf.subscription_expires_at,
             case when pf.account_probe_resolved is false then pf.account_probe_at end as account_lookup_miss_at
        from page_fans pf
       where pf.platform_account_id = ${query.targetPageId}
         and ${audiencePredicate(query.audience)}
    ),
    source_spend as (
      select s.fan_id, s.platform_account_id as page_id, s.gross_amount_mills, s.last_transaction_at
        from fan_spend_lifetime s
        join audience a on a.fan_id = s.fan_id
        join pages sp on sp.id = s.platform_account_id
        join pages tp on tp.id = ${query.targetPageId}
       where s.platform_account_id in ${idList(query.sourcePageIds)}
         and s.platform_account_id <> ${query.targetPageId}
         and sp.platform = tp.platform
         and s.gross_amount_mills <> 0
    ),
    spend as (
      select fan_id,
             sum(gross_amount_mills) as source_mills,
             max(last_transaction_at) as last_source_at,
             jsonb_agg(jsonb_build_object(
               'pageId', page_id,
               'grossMills', gross_amount_mills::text,
               'lastTransactionAt', last_transaction_at
             ) order by gross_amount_mills desc, page_id) as sources
        from source_spend
       group by fan_id
    )
    select f.id::text as fan_id, f.platform_user_id, f.username, f.display_name,
           a.is_follower, a.follower_since, a.is_subscriber, a.subscription_expires_at, a.account_lookup_miss_at,
           coalesce(t.gross_amount_mills, 0)::text as target_mills,
           spend.source_mills::text as source_mills,
           spend.last_source_at,
           spend.sources
      from spend
      join audience a on a.fan_id = spend.fan_id
      join fans f on f.id = spend.fan_id
      left join fan_spend_lifetime t on t.platform_account_id = ${query.targetPageId} and t.fan_id = spend.fan_id
     where spend.source_mills >= ${query.minSourceSpendMills.toString()}::numeric
       and (${max}::bigint is null or coalesce(t.gross_amount_mills, 0) <= ${max}::bigint)
     order by spend.source_mills desc, f.platform_user_id collate "C" asc
  `);
  const rows = result.rows.map((row): CrossPageSpenderRow => {
    const sources = (Array.isArray(row.sources) ? row.sources : []) as Array<Record<string, unknown>>;
    return {
      fanId: Number(row.fan_id),
      platformUserId: String(row.platform_user_id),
      username: row.username == null ? null : String(row.username),
      displayName: row.display_name == null ? null : String(row.display_name),
      isFollower: row.is_follower === true,
      followerSince: date(row.follower_since),
      isSubscriber: row.is_subscriber === true,
      subscriptionExpiresAt: date(row.subscription_expires_at),
      accountLookupMissAt: date(row.account_lookup_miss_at),
      targetSpendMills: BigInt(String(row.target_mills)),
      sourceSpendMills: BigInt(String(row.source_mills)),
      lastSourceTransactionAt: date(row.last_source_at),
      sources: sources.map((source) => ({
        pageId: Number(source.pageId),
        grossMills: BigInt(String(source.grossMills)),
        lastTransactionAt: date(source.lastTransactionAt),
      })),
    };
  });
  return { rows, witnesses: witnessesFor(["page_fans", "fans", "fan_spend_lifetime"]) };
}

/** When the target's audience was last read, by the walk that proves it. */
export interface CrossPageAudienceFreshness {
  /** The newest follows were last read (the hourly `followers.head` walk):
   *  a fan who followed after it is not in the audience yet. */
  newFollowersReadAt: Date | null;
  /** The last certified full followers walk (`followers.reconcile`): an
   *  unfollow leaves the audience only at such a walk. */
  followersWalkedAt: Date | null;
  /** The last walk of the current subscribers, when it was certified (the
   *  engine's `subscribers.poll` receipt, or the OnlyFans audience sweep);
   *  null when the latest one was not or none is recorded. */
  subscribersWalkedAt: Date | null;
}

function latest(...values: Array<Date | null>): Date | null {
  let best: Date | null = null;
  for (const value of values) {
    if (value !== null && (best === null || value.getTime() > best.getTime())) best = value;
  }
  return best;
}

/**
 * What makes the answer fresh: the target's audience walks, and each source
 * page's transactions capture floor — the oldest transaction Hub stores for
 * the page (`oldest_stored_row`, the same floor the transactions dataset
 * reports). `fan_spend_lifetime` is a rollup, so it can hold money older than
 * that floor; the floor says where the ledger behind it begins.
 */
export async function readCrossPageSpendersFreshness(
  db: Database,
  input: { targetPageId: number; sourcePageIds: readonly number[] },
): Promise<{
  audience: CrossPageAudienceFreshness;
  transactionFloors: Map<number, Date | null>;
  witnesses: PlaneReadWitness[];
}> {
  const audience = await db.execute<Record<string, unknown>>(sql`
    select p.last_follower_sync_at as new_followers_read_at,
           (select max(w.closed_at)
              from sync_work w
             where w.page_id = p.id
               and w.resource = 'followers.reconcile'
               and not w.shadow
               and w.close_reason = 'reconcile_certified') as followers_walked_at,
           (select w.proof ->> 'completedAt'
              from sync_work w
             where w.page_id = p.id
               and w.resource = 'subscribers.poll'
               and w.subject = ''
               and not w.shadow
               and w.proof ->> 'mode' = 'active'
               and w.proof -> 'destructiveFinalization' = 'true'::jsonb
             order by w.id desc
             limit 1) as engine_subscribers_walked_at,
           (select c.state ->> 'lastSweepCompletedAt'
              from page_sync_cursors c
             where c.page_id = p.id
               and c.stream = 'subscribers'
               and c.state ->> 'lastSweepUnverifiedAt' is null) as sweep_subscribers_walked_at
      from pages p
     where p.id = ${input.targetPageId}
  `);
  const row = audience.rows[0];
  const freshness: CrossPageAudienceFreshness = {
    newFollowersReadAt: date(row?.new_followers_read_at),
    followersWalkedAt: date(row?.followers_walked_at),
    subscribersWalkedAt: latest(date(row?.engine_subscribers_walked_at), date(row?.sweep_subscribers_walked_at)),
  };
  const transactionFloors = new Map<number, Date | null>(input.sourcePageIds.map((id) => [id, null]));
  if (input.sourcePageIds.length === 0) {
    return { audience: freshness, transactionFloors, witnesses: [] };
  }
  const floors = await db.execute<Record<string, unknown>>(sql`
    select t.platform_account_id::text as page_id, min(t.occurred_at) as floor_at
      from transactions t
     where t.platform_account_id in ${idList(input.sourcePageIds)}
     group by t.platform_account_id
  `);
  for (const floor of floors.rows) {
    transactionFloors.set(Number(floor.page_id), date(floor.floor_at));
  }
  // The scope is only as observable as its least observable source: the
  // latest floor, or unknown when a source stores no transaction at all.
  const values = [...transactionFloors.values()];
  const scopeFloor = values.some((value) => value === null) ? null : latest(...values);
  return { audience: freshness, transactionFloors, witnesses: [witnessFor("transactions", scopeFloor)] };
}

/** A page a set may take as its target or a source: every live page with its
 *  label, platform and model (Hub's own work draws from all of them). */
export interface CrossPageCandidatePage {
  id: number;
  pageLabel: string;
  platform: string;
  modelSlug: string;
}

/** Every page not deleted, by label: the candidates of Hub's own sets (the
 *  hub-kept Fansly list of `fan-set-lists.sync`), never an agent's grant. */
export async function listCrossPageCandidatePages(db: Database): Promise<CrossPageCandidatePage[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select p.id::text as id, p.label, p.platform::text as platform, m.slug
      from pages p
      join models m on m.id = p.model_id
     where p.deleted_at is null
       and p.status = 'active'
     order by p.label collate "C"
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    pageLabel: String(row.label),
    platform: String(row.platform),
    modelSlug: String(row.slug),
  }));
}
