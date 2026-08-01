// Fansly replay projection (agent read plane, slice D).
//
// Appending domain events moves no read plane on its own. These are the
// writers that turn the four replayed Fansly kinds into the identity/audience
// planes the agent actually reads: `fans`, `page_fans` membership,
// `page_follows`, `daily_followers`.
//
// THE ONE RULE THAT SHAPES EVERY STATEMENT HERE: a historical snapshot proves
// what WAS, never what IS. So this module is strictly additive —
//
//   * it fills NULLs and moves "since"/"first seen" timestamps EARLIER
//     (`coalesce` / `least`), never later and never over a known value;
//   * it never flips a current-state boolean: `page_fans.is_follower` /
//     `is_subscriber` keep their live values, and follows this module inserts
//     land `is_active = false` (the live reconcile flips them true when the
//     follow is genuinely current — self-healing in the honest direction);
//   * it never deletes and never lowers a count.
//
// A replay that inflated "active followers" from a year-old page would be
// exactly the class of lie the agent read plane exists to prevent.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export const FANSLY_REPLAY_PROJECTION = "fansly_replay_identity";

/**
 * Parents whose detached partitions would make a replay lie.
 *
 * `domain_events` is here for a failure mode `observations` alone cannot see:
 * Stage 28 tiers the two ledgers INDEPENDENTLY, so a detached
 * `domain_events_YYYY_MM` while `observations` stays attached sails through an
 * observations-only census — and then every append aiming at that
 * `occurred_at` fails with 23514 while the projection watermark marches past
 * them. Events disappear silently and the run still reports success.
 *
 * `sync_raw_payloads` is unpartitioned today and contributes nothing; it stays
 * because the plan names it and a future partitioning must not escape the gate
 * by omission.
 */
export const FANSLY_REPLAY_JOURNAL_TABLES = [
  "observations",
  "domain_events",
  "sync_raw_payloads",
] as const;

export interface DetachedJournalPartition {
  schema: string;
  name: string;
  table: string;
  /** Inclusive lower / exclusive upper bound derived from the name; null =
   *  unbounded on that side, and an unparseable name is treated as covering
   *  everything (fail closed). */
  from: string | null;
  to: string | null;
  rowCount: number;
}

const PARTITION_NAME =
  /^(observations|domain_events|sync_raw_payloads)_(pre_(\d{4})|(\d{4})(?:_(\d{2}))?)$/;

/** Same alternation, for the SQL-side name filter — derived from the table
 *  list so the two can never drift apart. */
const PARTITION_NAME_SQL_PATTERN =
  `^(${FANSLY_REPLAY_JOURNAL_TABLES.join("|")})_(pre_[0-9]{4}|[0-9]{4}(_[0-9]{2})?)$`;

function quotedRelation(schema: string, name: string) {
  return sql.raw(`"${schema.replaceAll("\"", "\"\"")}"."${name.replaceAll("\"", "\"\"")}"`);
}

/** Name → covered range. `_YYYY_MM` = that month, `_YYYY` = that year,
 *  `_pre_YYYY` = everything before it. Anything else: unbounded both ways. */
function partitionRange(name: string): { table: string | null; from: Date | null; to: Date | null } {
  const match = PARTITION_NAME.exec(name);
  if (!match) {
    return { table: null, from: null, to: null };
  }
  const table = match[1] ?? null;
  if (match[3] !== undefined) {
    return { table, from: null, to: new Date(`${match[3]}-01-01T00:00:00Z`) };
  }
  const year = match[4];
  if (year === undefined) {
    return { table, from: null, to: null };
  }
  if (match[5] === undefined) {
    return {
      table,
      from: new Date(`${year}-01-01T00:00:00Z`),
      to: new Date(`${Number(year) + 1}-01-01T00:00:00Z`),
    };
  }
  const month = Number(match[5]);
  const from = new Date(Date.UTC(Number(year), month - 1, 1));
  const to = new Date(Date.UTC(Number(year), month, 1));
  return { table, from, to };
}

function overlapsWindow(
  range: { from: Date | null; to: Date | null },
  window: { from: Date | null; to: Date | null },
): boolean {
  if (range.from !== null && window.to !== null && range.from >= window.to) {
    return false;
  }
  if (range.to !== null && window.from !== null && range.to <= window.from) {
    return false;
  }
  return true;
}

/**
 * MANDATORY PREFLIGHT. Every relation named like a partition of a journal
 * parent that is NOT attached right now (`pg_inherits`) — parked in
 * `tiered_pending_drop` by Stage 28 tiering, or left detached in `public`.
 *
 * Nonempty means months of ledger are invisible to the replay while their rows
 * still exist. Canonicalizing across that hole and then publishing a capture
 * floor mints a floor that lies about which months were ever captured. The
 * runner refuses; the owner re-attaches first.
 *
 * Window scoping differs by parent ON PURPOSE:
 *   * `observations` / `sync_raw_payloads` are read through the replay window
 *     (`received_at`), so only partitions overlapping it can hide input;
 *   * `domain_events` is read by the PROJECTION, which walks each account from
 *     its watermark with no window at all. A detached month holding events
 *     there is fatal regardless of the requested window: `listEventsSince`
 *     cannot see those rows, the watermark marches straight past their seqs,
 *     and they are never projected. The window never excuses it.
 *
 * ONLY PARTITIONS THAT HOLD ROWS COUNT. An empty detached partition hides
 * nothing, and the healthy production schema HAS several: migration 0077
 * deliberately leaves the 2024/2025 `domain_events` monthlies detached in
 * `public` after re-covering their range with yearly partitions. Refusing on
 * those would mean refusing forever.
 */
export async function listDetachedJournalPartitions(
  db: Database,
  window: { from?: Date | null; to?: Date | null } = {},
): Promise<DetachedJournalPartition[]> {
  const detached = await db.execute<{ schema: string; name: string }>(sql`
    select n.nspname as schema, c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and c.relname ~ ${PARTITION_NAME_SQL_PATTERN}
      and (
        n.nspname = 'tiered_pending_drop'
        or (
          n.nspname = 'public'
          and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
        )
      )
    order by n.nspname, c.relname
  `);

  const bounds = { from: window.from ?? null, to: window.to ?? null };
  const offenders: DetachedJournalPartition[] = [];
  for (const relation of detached.rows) {
    const range = partitionRange(relation.name);
    const windowScoped = range.table !== "domain_events";
    if (windowScoped && !overlapsWindow(range, bounds)) {
      continue;
    }
    const count = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from ${quotedRelation(relation.schema, relation.name)}
    `);
    const rowCount = Number(count.rows[0]?.n ?? 0);
    if (rowCount === 0) {
      continue;
    }
    offenders.push({
      schema: relation.schema,
      name: relation.name,
      table: range.table ?? "unknown",
      from: range.from === null ? null : range.from.toISOString(),
      to: range.to === null ? null : range.to.toISOString(),
      rowCount,
    });
  }
  return offenders;
}

// ── projection appliers ────────────────────────────────────────────────────

export interface FanslyReplayIdentityInput {
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  createdAtExternal: Date | null;
  observedAt: Date;
}

export interface FanslyReplayMembershipInput {
  platformUserId: string;
  followerSince: Date | null;
  subscriberSince: Date | null;
  observedAt: Date;
}

export interface FanslyReplayFollowInput {
  platformUserId: string;
  platformFollowId: string;
  followedAt: Date;
  observedAt: Date;
}

export interface FanslyReplayApplyResult {
  fansTouched: number;
  membershipsTouched: number;
  followsInserted: number;
}

function jsonParam(rows: readonly unknown[]) {
  return sql`${JSON.stringify(rows)}::jsonb`;
}

/**
 * Applies one batch of replayed facts for ONE Fansly page, in a single
 * transaction. Caller-deduped by key (a jsonb batch with two rows for the same
 * conflict target cannot be applied twice in one statement).
 */
export async function applyFanslyReplayEvents(
  db: Database,
  input: {
    platformAccountId: number;
    identities: readonly FanslyReplayIdentityInput[];
    memberships: readonly FanslyReplayMembershipInput[];
    follows: readonly FanslyReplayFollowInput[];
  },
): Promise<FanslyReplayApplyResult> {
  const result: FanslyReplayApplyResult = {
    fansTouched: 0,
    membershipsTouched: 0,
    followsInserted: 0,
  };
  if (
    input.identities.length === 0
    && input.memberships.length === 0
    && input.follows.length === 0
  ) {
    return result;
  }

  await db.transaction(async (tx) => {
    if (input.identities.length > 0) {
      // Gap-filling only: a stale snapshot must never overwrite the username
      // the page carries today. `first_seen_at` moving earlier IS the identity
      // capture floor moving back — the whole point of the slice.
      const rows = input.identities.map((identity) => ({
        platform_user_id: identity.platformUserId,
        username: identity.username,
        display_name: identity.displayName,
        created_at_external: identity.createdAtExternal === null
          ? null
          : identity.createdAtExternal.toISOString(),
        observed_at: identity.observedAt.toISOString(),
      }));
      const applied = await tx.execute(sql`
        insert into fans (
          platform, platform_user_id, username, display_name, created_at_external,
          first_seen_at, last_seen_at
        )
        select 'fansly', x.platform_user_id, x.username, x.display_name,
               x.created_at_external, x.observed_at, x.observed_at
        from jsonb_to_recordset(${jsonParam(rows)}) as x(
          platform_user_id text, username text, display_name text,
          created_at_external timestamptz, observed_at timestamptz
        )
        on conflict (platform, platform_user_id) do update set
          username = coalesce(fans.username, excluded.username),
          display_name = coalesce(fans.display_name, excluded.display_name),
          created_at_external = coalesce(fans.created_at_external, excluded.created_at_external),
          first_seen_at = least(fans.first_seen_at, excluded.first_seen_at)
        returning fans.id
      `);
      result.fansTouched = applied.rows.length;
    }

    if (input.memberships.length > 0) {
      // UPDATE ONLY — a replay never CREATES a page_fans row.
      //
      // `page_fans` is the workboard's candidate set: the board selects from
      // it filtered by page and `fans.deleted_detected_at is null` and nothing
      // else (repositories/workboard-v2.ts). Minting a row per historical
      // follower would drop thousands of year-old fans onto the owner's live
      // board — an effect nowhere in this slice's scope. The audience floors
      // do not need it either: they read `page_follows`, which this module
      // does insert into.
      //
      // So the replay only backfills the two HISTORICAL dates on rows the page
      // already has, folded monotonically earlier. Current state
      // (is_follower / is_subscriber) is never written.
      const rows = input.memberships.map((membership) => ({
        platform_user_id: membership.platformUserId,
        follower_since: membership.followerSince === null
          ? null
          : membership.followerSince.toISOString(),
        subscriber_since: membership.subscriberSince === null
          ? null
          : membership.subscriberSince.toISOString(),
      }));
      const applied = await tx.execute(sql`
        update page_fans pf set
          follower_since = least(pf.follower_since, x.follower_since),
          subscriber_since = least(pf.subscriber_since, x.subscriber_since)
        from jsonb_to_recordset(${jsonParam(rows)}) as x(
          platform_user_id text, follower_since timestamptz, subscriber_since timestamptz
        )
        join fans f on f.platform = 'fansly' and f.platform_user_id = x.platform_user_id
        where pf.platform_account_id = ${input.platformAccountId}
          and pf.fan_id = f.id
          and (x.follower_since is not null or x.subscriber_since is not null)
        returning pf.id
      `);
      result.membershipsTouched = applied.rows.length;
    }

    if (input.follows.length > 0) {
      // Insert-only. A follow proven by an old page may have ended since, so
      // it lands inactive; DO NOTHING keeps the live sync's rows untouched.
      const rows = input.follows.map((follow) => ({
        platform_user_id: follow.platformUserId,
        platform_follow_id: follow.platformFollowId,
        followed_at: follow.followedAt.toISOString(),
        observed_at: follow.observedAt.toISOString(),
      }));
      const applied = await tx.execute(sql`
        insert into page_follows (
          platform_account_id, fan_id, platform_follow_id, followed_at,
          first_seen_at, last_seen_at, is_active
        )
        select ${input.platformAccountId}, f.id, x.platform_follow_id, x.followed_at,
               x.observed_at, x.observed_at, false
        from jsonb_to_recordset(${jsonParam(rows)}) as x(
          platform_user_id text, platform_follow_id text,
          followed_at timestamptz, observed_at timestamptz
        )
        join fans f on f.platform = 'fansly' and f.platform_user_id = x.platform_user_id
        on conflict (platform_account_id, platform_follow_id) do nothing
        returning page_follows.id
      `);
      result.followsInserted = applied.rows.length;
    }
  });

  return result;
}

export interface FanslyReplayRollupResult {
  followerDaysTouched: number;
  knownTotalDaysTouched: number;
}

/**
 * Audience rollups, derived not destroyed — and RE-DERIVED on every run.
 *
 * Both statements read durable sources (`page_follows` and the event ledger),
 * never this run's batch, so they are pure functions of committed state. That
 * is what makes the historical values SURVIVE: the live hourly
 * `rebuildFollowerRollups` DELETEs the page's `daily_followers` rows and
 * rebuilds them with `known_total_followers` set only for today, wiping every
 * historical value. The runner therefore calls this for every selected
 * account on every run, not only when new events showed up — a refresh gated
 * on "did this run see work" would run exactly once, and the floors it
 * advertises would quietly evaporate at the next live rebuild (or after a
 * crash between the watermark advance and the refresh).
 *
 * Statement 1 UPSERTS `new_followers` from `page_follows` with `greatest`, so
 * a replay can never lower a live count; `page_follows` only ever grows.
 *
 * Statement 2 fills `known_total_followers`, which today is NULL for every
 * past day. It is deliberately an UPDATE, never an insert: a day with an
 * `account_me` snapshot but no follows would otherwise get a row claiming
 * `new_followers = 0`, and "0 new followers" is a very different statement
 * from "we do not know" — the column is NOT NULL and `reporting.ts` SUMS it.
 * Absence of a row already means unknown, which is the honest answer. It also
 * takes the LATEST snapshot of each day (by occurred_at, then account_seq),
 * not the peak: that matches how the live rebuild fills today's value.
 */
export async function refreshFanslyReplayAudienceRollups(
  db: Database,
  platformAccountId: number,
): Promise<FanslyReplayRollupResult> {
  const followerDays = await db.execute(sql`
    insert into daily_followers (
      platform_account_id, business_date, new_followers, updated_at
    )
    select pf.platform_account_id,
           ((pf.followed_at at time zone 'UTC')::date),
           count(*)::int,
           now()
    from page_follows pf
    where pf.platform_account_id = ${platformAccountId}
    group by 1, 2
    on conflict (platform_account_id, business_date) do update set
      new_followers = greatest(daily_followers.new_followers, excluded.new_followers),
      updated_at = now()
    returning daily_followers.id
  `);

  const knownTotals = await db.execute(sql`
    with witness as (
      select distinct on (((de.occurred_at at time zone 'UTC')::date))
             ((de.occurred_at at time zone 'UTC')::date) as business_date,
             (de.data ->> 'followCount')::int as follow_count
      from domain_events de
      where de.account_id = ${platformAccountId}
        and de.type = 'page.identity_observed'
        and de.data ->> 'followCount' ~ '^[0-9]+$'
      order by ((de.occurred_at at time zone 'UTC')::date),
               de.occurred_at desc, de.account_seq desc
    )
    update daily_followers df set
      known_total_followers = coalesce(df.known_total_followers, witness.follow_count),
      updated_at = now()
    from witness
    where df.platform_account_id = ${platformAccountId}
      and df.business_date = witness.business_date
      and df.known_total_followers is null
    returning df.id
  `);

  return {
    followerDaysTouched: followerDays.rows.length,
    knownTotalDaysTouched: knownTotals.rows.length,
  };
}

export interface FanslyReplayFloors {
  platformAccountId: number;
  /** Earliest journaled observation of the replayed kinds — the TARGET the
   *  read-plane floors below should be moving toward. */
  journalEarliestReceivedAt: string | null;
  pageFollowsEarliestFollowedAt: string | null;
  dailyFollowersEarliestDate: string | null;
  fansEarliestFirstSeenAt: string | null;
  pageFansEarliestFollowerSince: string | null;
  pageFansEarliestSubscriberSince: string | null;
}

/** Timestamps cross `db.execute` as raw PG text ('2026-03-10 09:00:00+00');
 *  the report is machine-read, so it publishes ISO or nothing. */
function asIsoOrNull(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** `business_date` is a DATE, selected as text and published verbatim. */
function asTextOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

/** One floor snapshot per page — the runner reports before/after so the
 *  owner can see the planes move rather than take the runner's word. */
export async function getFanslyReplayFloors(
  db: Database,
  platformAccountId: number,
  journalKinds: readonly string[],
): Promise<FanslyReplayFloors> {
  const kinds = journalKinds.length > 0 ? journalKinds : [""];
  const result = await db.execute<Record<string, unknown>>(sql`
    select
      (select min(o.received_at) from observations o
        where o.account_id = ${platformAccountId}
          and o.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})
      ) as journal_earliest,
      (select min(pf.followed_at) from page_follows pf
        where pf.platform_account_id = ${platformAccountId}) as follows_earliest,
      (select min(df.business_date)::text from daily_followers df
        where df.platform_account_id = ${platformAccountId}) as daily_earliest,
      -- Scoped by page_fans UNION page_follows: the replay backfills
      -- page_follows but deliberately never creates a page_fans row (that
      -- table is the workboard's candidate set), so a page_fans-only scope
      -- would hide exactly the fans this slice recovers.
      (select min(f.first_seen_at) from fans f
        where exists (
          select 1 from page_fans pfa
          where pfa.fan_id = f.id and pfa.platform_account_id = ${platformAccountId}
        ) or exists (
          select 1 from page_follows pfo
          where pfo.fan_id = f.id and pfo.platform_account_id = ${platformAccountId}
        )) as fans_earliest,
      (select min(pfa.follower_since) from page_fans pfa
        where pfa.platform_account_id = ${platformAccountId}) as follower_since_earliest,
      (select min(pfa.subscriber_since) from page_fans pfa
        where pfa.platform_account_id = ${platformAccountId}) as subscriber_since_earliest
  `);
  const row = result.rows[0] ?? {};
  return {
    platformAccountId,
    journalEarliestReceivedAt: asIsoOrNull(row.journal_earliest),
    pageFollowsEarliestFollowedAt: asIsoOrNull(row.follows_earliest),
    dailyFollowersEarliestDate: asTextOrNull(row.daily_earliest),
    fansEarliestFirstSeenAt: asIsoOrNull(row.fans_earliest),
    pageFansEarliestFollowerSince: asIsoOrNull(row.follower_since_earliest),
    pageFansEarliestSubscriberSince: asIsoOrNull(row.subscriber_since_earliest),
  };
}
