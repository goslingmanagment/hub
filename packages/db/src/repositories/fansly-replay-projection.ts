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

export interface FanslyReplayPreflightScope {
  /** The journal read window (`observations.received_at`). */
  from?: Date | null;
  to?: Date | null;
  /** Pages this run replays. Empty = nothing is in scope. */
  accountIds: readonly number[];
  /** Observation kinds this run reads. */
  journalKinds: readonly string[];
  /** Event types this run appends and projects. */
  eventTypes: readonly string[];
  /** `occurred_at` range this run will WRITE events into (derived from the
   *  eligible observations); null when the run will write nothing. */
  writeFrom?: Date | null;
  writeTo?: Date | null;
}

/**
 * MANDATORY PREFLIGHT. Relations named like a partition of a journal parent
 * that are NOT attached right now (`pg_inherits`) — parked in
 * `tiered_pending_drop` by Stage 28 tiering, or left detached in `public` —
 * AND that actually intersect what THIS run touches.
 *
 * The hazard is real: rows in a parked partition still exist but are invisible,
 * so canonicalizing across the hole and then publishing a capture floor mints a
 * floor that lies about which months were captured. But an unscoped census is
 * just as wrong in the other direction — it refuses forever on a healthy
 * database. Production carries exactly that state today: four parked
 * `domain_events` monthlies from 2024/2025 holding 30 `transaction.posted`
 * rows, kept detached on purpose because migration 0077 re-covered their range
 * with overlapping YEARLY partitions and re-attaching is therefore impossible.
 * None of it can collide with a replay whose sources start in 2026.
 *
 * So a detached partition is an offender only when it is NON-EMPTY (R-014) and
 * intersects this run, per parent:
 *
 *   * `observations` — holds rows for a replayed page and a replayed kind, and
 *     overlaps the replay window (`received_at`). That is exactly the input
 *     this run reads, so hidden rows there would corrupt the floors.
 *   * `sync_raw_payloads` — unpartitioned today, so nothing matches; kept for
 *     the day it is partitioned.
 *   * `domain_events` — either it holds events of a REPLAYED TYPE for a
 *     replayed page (the projection walks each account from its watermark with
 *     no window; hidden rows are skipped silently and forever), or its range
 *     overlaps the `occurred_at` range this run will write into (appends there
 *     would fail 23514). Foreign types and foreign accounts cannot do either.
 */
export async function listDetachedJournalPartitions(
  db: Database,
  scope: FanslyReplayPreflightScope,
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
  if (detached.rows.length === 0 || scope.accountIds.length === 0) {
    return [];
  }

  const readWindow = { from: scope.from ?? null, to: scope.to ?? null };
  const writeWindow = { from: scope.writeFrom ?? null, to: scope.writeTo ?? null };
  const hasWriteRange = scope.writeFrom != null || scope.writeTo != null;
  const accounts = sql.join(scope.accountIds.map((id) => sql`${id}`), sql`, `);
  const offenders: DetachedJournalPartition[] = [];

  for (const relation of detached.rows) {
    const range = partitionRange(relation.name);
    const target = quotedRelation(relation.schema, relation.name);
    let rowCount = 0;

    if (range.table === "domain_events") {
      // Arm 1: does it hide events the PROJECTION would have applied?
      const types = scope.eventTypes.length === 0
        ? null
        : sql.join(scope.eventTypes.map((type) => sql`${type}`), sql`, `);
      if (types !== null) {
        const held = await db.execute<{ n: string }>(sql`
          select count(*)::text as n from ${target}
          where account_id in (${accounts}) and type in (${types})
        `);
        rowCount = Number(held.rows[0]?.n ?? 0);
      }
      // Arm 2: would this run try to WRITE into that month? Still gated on
      // non-emptiness (R-014) — an empty partition in the write range fails
      // loudly per row (23514) and surfaces through `errored`, which the CLI
      // turns into a non-zero exit.
      if (rowCount === 0 && hasWriteRange && overlapsWindow(range, writeWindow)) {
        const any = await db.execute<{ n: string }>(sql`
          select count(*)::text as n from ${target}
        `);
        rowCount = Number(any.rows[0]?.n ?? 0);
      }
    } else if (range.table === "observations") {
      if (!overlapsWindow(range, readWindow) || scope.journalKinds.length === 0) {
        continue;
      }
      const kinds = sql.join(scope.journalKinds.map((kind) => sql`${kind}`), sql`, `);
      const held = await db.execute<{ n: string }>(sql`
        select count(*)::text as n from ${target}
        where account_id in (${accounts}) and kind in (${kinds})
      `);
      rowCount = Number(held.rows[0]?.n ?? 0);
    } else {
      if (!overlapsWindow(range, readWindow)) {
        continue;
      }
      const held = await db.execute<{ n: string }>(sql`
        select count(*)::text as n from ${target}
      `);
      rowCount = Number(held.rows[0]?.n ?? 0);
    }

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

export interface FanslyReplayEligibleSpan {
  /** Rows still awaiting this canonicalizer version under the run's filters. */
  total: number;
  /** Earliest / latest `occurred_at` the run would stamp on new events —
   *  events take the observation time (`observed_at`, else `received_at`). */
  writeFrom: Date | null;
  writeTo: Date | null;
}

/**
 * The run's own footprint, measured before it starts: how many observations it
 * is eligible to consume, and the exact `occurred_at` band its appends would
 * land in. The preflight needs the band to decide whether a detached
 * `domain_events` month could possibly collide, and the report needs the count
 * to say honestly how much of the corpus a bounded (especially dry) run left
 * unexamined.
 */
export async function getFanslyReplayEligibleSpan(
  db: Database,
  input: {
    belowParseVersion: number;
    source: string;
    kinds: readonly string[];
    accountIds: readonly number[];
    from?: Date | null;
    to?: Date | null;
    afterId?: number | null;
  },
): Promise<FanslyReplayEligibleSpan> {
  if (input.accountIds.length === 0 || input.kinds.length === 0) {
    return { total: 0, writeFrom: null, writeTo: null };
  }
  const conditions = [
    sql`o.parse_version < ${input.belowParseVersion}`,
    sql`o.source = ${input.source}`,
    sql`o.kind in (${sql.join(input.kinds.map((kind) => sql`${kind}`), sql`, `)})`,
    sql`o.account_id in (${sql.join(input.accountIds.map((id) => sql`${id}`), sql`, `)})`,
  ];
  if (input.from) {
    conditions.push(sql`o.received_at >= ${input.from}`);
  }
  if (input.to) {
    conditions.push(sql`o.received_at < ${input.to}`);
  }
  if (input.afterId != null) {
    conditions.push(sql`o.id > ${input.afterId}`);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select count(*)::text as total,
           min(coalesce(o.observed_at, o.received_at)) as write_from,
           max(coalesce(o.observed_at, o.received_at)) as write_to
    from observations o
    where ${sql.join(conditions, sql` and `)}
  `);
  const row = result.rows[0] ?? {};
  const toDate = (value: unknown): Date | null => {
    if (value == null) {
      return null;
    }
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  return {
    total: Number(row.total ?? 0),
    writeFrom: toDate(row.write_from),
    writeTo: toDate(row.write_to),
  };
}

// ── projection appliers ────────────────────────────────────────────────────

export interface FanslyReplayIdentityInput {
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  createdAtExternal: Date | null;
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
  followsInserted: number;
}

function jsonParam(rows: readonly unknown[]) {
  return sql`${JSON.stringify(rows)}::jsonb`;
}

/**
 * Applies one batch of replayed facts for ONE Fansly page, in a single
 * transaction. Caller-deduped by key (a jsonb batch with two rows for the same
 * conflict target cannot be applied twice in one statement).
 *
 * `page_fans` IS NOT WRITTEN AT ALL — not created, not updated.
 * `follower_since` / `subscriber_since` describe the fan's CURRENT
 * relationship, and a replay only ever knows about past ones. A fan whose old
 * relationship ENDED and who later started a NEW one would have the current
 * membership backdated to the old start (`least()` cannot tell the two apart),
 * and the ordinary reconciles then rewrite or clear those fields from ACTIVE
 * rows only (`repositories/fans.ts` followers / subscribers) — so the damage
 * would neither be caught nor be repairable by a rerun, whose watermark has
 * already passed the events. Historical intervals live where they belong:
 * follows in `page_follows` (inactive rows, dated by the relation id) and
 * subscriptions in the event ledger, which is also why `subscription.observed`
 * has no projection in run-1.
 */
export async function applyFanslyReplayEvents(
  db: Database,
  input: {
    platformAccountId: number;
    identities: readonly FanslyReplayIdentityInput[];
    follows: readonly FanslyReplayFollowInput[];
  },
): Promise<FanslyReplayApplyResult> {
  const result: FanslyReplayApplyResult = {
    fansTouched: 0,
    followsInserted: 0,
  };
  if (input.identities.length === 0 && input.follows.length === 0) {
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
 * never this run's batch, so they are pure functions of committed state, and
 * the runner calls them for every selected account on every run — a refresh
 * gated on "did this run see new events" would fire exactly once and never
 * again once the watermark reached the head.
 *
 * Survival across an ORDINARY sync is the live rebuild's job, not this one's:
 * `rebuildFollowerRollups` now preserves any `known_total_followers` it did
 * not produce instead of clearing it. This function is the writer; that one
 * agreed to stop destroying.
 *
 * Statement 1 UPSERTS `new_followers` from `page_follows` with `greatest`, so
 * a replay can never lower a live count; `page_follows` only ever grows.
 *
 * Statement 2 fills `known_total_followers`, which is otherwise NULL for every
 * past day. It is deliberately an UPDATE, never an insert: a day with an
 * `account_me` snapshot but no follows would otherwise get a row claiming
 * `new_followers = 0`, and "0 new followers" is a very different statement
 * from "we do not know" — the column is NOT NULL and `reporting.ts` SUMS it.
 * Absence of a row already means unknown, which is the honest answer. It takes
 * the LATEST snapshot of each day (by occurred_at, then account_seq), not the
 * peak, matching how the live rebuild fills today's value.
 *
 * Its guard is BY DAY, not by nullness. `where known_total_followers is null`
 * froze a historical day at whichever witness a bounded run happened to reach
 * first: a later same-day snapshot canonicalized in the NEXT run could never
 * replace it, defeating the latest-witness ordering above. Past days are owned
 * by the ledger and always take the latest witness; only TODAY defers to the
 * live value, which is fresher than anything canonicalized so far.
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
      known_total_followers = case
        when df.business_date < (now() at time zone 'UTC')::date then witness.follow_count
        else coalesce(df.known_total_followers, witness.follow_count)
      end,
      updated_at = now()
    from witness
    where df.platform_account_id = ${platformAccountId}
      and df.business_date = witness.business_date
      and df.known_total_followers is distinct from (case
        when df.business_date < (now() at time zone 'UTC')::date then witness.follow_count
        else coalesce(df.known_total_followers, witness.follow_count)
      end)
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
