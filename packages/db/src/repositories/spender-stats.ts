// Spenders statistics and the awaiting-reply queue for one page
// (chat-extension H-8a). The definitions — what each number means — live in
// packages/shared/src/spender-stats.ts; this file is only how they are read.
//
// - Window money is aggregated from raw `transactions` over
//   transactions_account_active_occurred_idx and bucketed by the local date in
//   the caller's zone. The rollups (revenue_daily, fan_spend_daily) are dated
//   in UTC and cannot be re-bucketed into another zone. The SQL never reads
//   the zone's name: it buckets by the instants each local date starts at,
//   which Intl computes (resolveSpenderStatsWindows), and stops at `asOf`.
// - Lifetime membership (tiers, payers, silence, the queue) reads the spender
//   projection (fan_spend_lifetime), as the Spenders shelves do, so both count
//   the same fans; its watermark is served as `projectionAsOf`.
// - One stats answer is one REPEATABLE READ snapshot: the tier table, the
//   window totals and the queue summary cannot disagree with each other.
//
// Reads only the hub's database; nothing here can reach a platform.

import { sql, type SQL } from "drizzle-orm";

import {
  SPENDER_AUTO_LIST_BUCKETS,
  SPENDER_STATS_INCLUDED_STATES,
  SPENDER_STATS_METRIC_VERSION,
  SPENDER_STATS_PAYER_MIN_LIFETIME_GROSS_MILLS,
  SPENDER_STATS_PURCHASE_TYPES,
  SPENDER_STATS_TRANSACTION_TYPES,
  SPENDER_STATS_UNATTRIBUTED_KEY,
  SPENDER_STATS_UNTIERED_KEY,
  assembleSpenderStatsDays,
  assembleSpenderStatsTiers,
  classifySpenderSilence,
  deriveAwaitingReplyReadState,
  deriveSpenderStatsCoverage,
  resolveSpenderStatsWindows,
  spenderStatsAverageCheckMills,
  spenderStatsDeltaPct,
  sumSpenderStatsWindow,
  type SpenderAwaitingReplyReadState,
  type SpenderSilenceBucket,
  type SpenderStatsCoverage,
  type SpenderStatsDayStateRow,
  type SpenderStatsDayTotals,
  type SpenderStatsMoneyWindow,
  type SpenderStatsTier,
  type SpenderStatsTierCounts,
  type SpenderStatsWindows,
  type TransactionState,
  type TransactionType,
} from "@agency_hub_core/shared";
import type { Database } from "../client.ts";

const READ_SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

function transactionTypeList(types: readonly TransactionType[]): SQL {
  return sql.join(types.map((type) => sql`${type}::transaction_type`), sql`, `);
}

const UNIVERSE_TYPES_SQL = transactionTypeList(SPENDER_STATS_TRANSACTION_TYPES);
const PURCHASE_TYPES_SQL = transactionTypeList(SPENDER_STATS_PURCHASE_TYPES);
const TIER_BANDS_SQL = sql.join(
  SPENDER_AUTO_LIST_BUCKETS.map((bucket) =>
    sql`(${bucket.key}::text, ${bucket.minAmountMills}::bigint, ${bucket.maxAmountMillsExclusive}::bigint)`),
  sql`, `,
);

function toBigInt(value: unknown): bigint {
  return value === null || value === undefined ? 0n : BigInt(String(value));
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The d30 window of one request, as instants. */
interface WindowScope {
  pageId: number;
  /** The window's local dates and the instant each starts at, ascending. */
  dates: readonly string[];
  dateStarts: readonly Date[];
  /** The instant the date after the window starts. */
  end: Date;
  /** Rows after it are not counted yet: today ends at `asOf`. */
  asOf: Date;
}

function windowScope(pageId: number, windows: SpenderStatsWindows): WindowScope {
  return {
    pageId,
    dates: windows.dates,
    dateStarts: windows.dateStarts,
    end: windows.end,
    asOf: windows.asOf,
  };
}

function timestampSql(instant: Date): SQL {
  return sql`${instant.toISOString()}::timestamptz`;
}

/** The instant the window's first local date starts. */
function windowStartSql(scope: WindowScope): SQL {
  return timestampSql(scope.dateStarts[0]!);
}

/**
 * Every transaction of the universe in the window, with its local date:
 * `width_bucket` finds the last date that starts at or before the row.
 */
function windowRowsSql(scope: WindowScope): SQL {
  const starts = `{${scope.dateStarts.map((start) => start.toISOString()).join(",")}}`;
  const dates = `{${scope.dates.join(",")}}`;
  return sql`
    select t.fan_id,
           (${dates}::date[])[width_bucket(t.occurred_at, ${starts}::timestamptz[])] as local_date,
           t.transaction_state::text as state,
           t.gross_amount_mills as gross,
           t.creator_net_amount_mills as net,
           (t.canonical_type in (${PURCHASE_TYPES_SQL}) and t.gross_amount_mills > 0) as is_purchase
    from transactions t
    where t.platform_account_id = ${scope.pageId}
      and t.is_active = true
      and t.canonical_type in (${UNIVERSE_TYPES_SQL})
      and t.occurred_at >= ${windowStartSql(scope)}
      and t.occurred_at < ${timestampSql(scope.end)}
      and t.occurred_at <= ${timestampSql(scope.asOf)}
  `;
}

/** The page's payers: lifetime gross at or above the lowest tier floor, as the shelves count them. */
function payersSql(pageId: number): SQL {
  return sql`
    select l.fan_id, l.gross_amount_mills as lifetime_gross
    from fan_spend_lifetime l
    join page_fans fp on fp.platform_account_id = l.platform_account_id and fp.fan_id = l.fan_id
    join fans f on f.id = l.fan_id and f.deleted_detected_at is null
    where l.platform_account_id = ${pageId}
      and l.gross_amount_mills >= ${SPENDER_STATS_PAYER_MIN_LIFETIME_GROSS_MILLS}::bigint
  `;
}

function buildWindowDaysQuery(scope: WindowScope): SQL {
  return sql`
    with win as (${windowRowsSql(scope)})
    select to_char(w.local_date, 'YYYY-MM-DD') as date,
           w.state,
           coalesce(sum(w.gross), 0)::bigint as gross,
           coalesce(sum(w.gross) filter (where w.is_purchase), 0)::bigint as purchases_gross,
           coalesce(sum(w.net), 0)::bigint as net,
           (count(*) filter (where w.is_purchase))::int as purchase_count
    from win w
    group by w.local_date, w.state
  `;
}

/**
 * The last TEXT message of each payer's fan, over every chat of that fan on
 * the page, in whole days before `asOf`; null when the archive holds none.
 * One LATERAL probe per chat walks message_archive_account_conv_idx backwards
 * and stops at the first match.
 */
function buildSilenceQuery(input: { pageId: number; asOf: Date }): SQL {
  return sql`
    with payers as (${payersSql(input.pageId)})
    select case
             when lt.last_at is null then null
             else floor(extract(epoch from (${input.asOf.toISOString()}::timestamptz - lt.last_at)) / 86400)::int
           end as whole_days,
           count(*)::int as fans,
           coalesce(sum(p.lifetime_gross), 0)::bigint as lifetime_gross
    from payers p
    left join lateral (
      select max(m.occurred_at) as last_at
      from page_dm_threads th
      cross join lateral (
        select ma.occurred_at
        from message_archive ma
        where ma.account_id = ${input.pageId}
          and ma.conversation_ref = th.platform_conversation_id
          and ma.occurred_at is not null
          and ma.is_sent_by_me = false
          and ma.deleted_at is null
          and ma.content_pending = false
          and ma.text_plain ~ '[^[:space:]]'
        order by ma.occurred_at desc
        limit 1
      ) m
      where th.platform_account_id = ${input.pageId}
        and th.fan_id = p.fan_id
    ) lt on true
    group by 1
  `;
}

/**
 * Payers whose fan wrote after our last message, judged on the fan's primary
 * chat — the visible one with the newest message, the rule the Spenders
 * board uses. `last_fan_us` is the exact keyset value (microseconds).
 */
function awaitingSql(pageId: number): SQL {
  return sql`
    payers as (${payersSql(pageId)}),
    primary_threads as (
      select distinct on (th.fan_id)
             th.fan_id,
             th.unread_count,
             th.last_message_sender_role::text as last_message_sender_role,
             th.last_fan_message_at,
             th.last_model_message_at,
             th.partner_username,
             th.partner_display_name
      from page_dm_threads th
      join payers p on p.fan_id = th.fan_id
      where th.platform_account_id = ${pageId}
        and th.is_visible = true
      order by th.fan_id, th.last_message_at desc nulls last, th.platform_conversation_id desc
    ),
    awaiting as (
      select pt.*,
             p.lifetime_gross,
             (extract(epoch from pt.last_fan_message_at) * 1000000)::bigint as last_fan_us
      from primary_threads pt
      join payers p on p.fan_id = pt.fan_id
      where pt.last_fan_message_at is not null
        and (pt.last_model_message_at is null or pt.last_fan_message_at > pt.last_model_message_at)
    )
  `;
}

export interface SpenderAwaitingReplySummary {
  /** Payers waiting for our reply. */
  total: number;
  /** Of those, the ones whose read state is unknown. */
  unknown: number;
}

async function readAwaitingReplySummary(db: Database, pageId: number): Promise<SpenderAwaitingReplySummary> {
  const result = await db.execute<{ has_unread: boolean; last_message_sender_role: string; fans: number }>(sql`
    with ${awaitingSql(pageId)}
    select a.unread_count > 0 as has_unread, a.last_message_sender_role, count(*)::int as fans
    from awaiting a
    group by 1, 2
  `);
  let total = 0;
  let unknown = 0;
  for (const row of result.rows) {
    const fans = Number(row.fans);
    total += fans;
    const { readState } = deriveAwaitingReplyReadState({
      unreadCount: row.has_unread ? 1 : 0,
      lastMessageSenderRole: row.last_message_sender_role,
    });
    if (readState === "unknown") unknown += fans;
  }
  return { total, unknown };
}

export interface PageSpenderStats {
  pageId: number;
  metricVersion: number;
  timeZone: string;
  asOf: Date;
  /** First and last local date of the window. */
  from: string;
  to: string;
  /** When the spender projection behind tiers, silence and the queue was rebuilt. */
  projectionAsOf: Date | null;
  includedStates: TransactionState[];
  coverage: SpenderStatsCoverage;
  days: SpenderStatsDayTotals[];
  totals: {
    today: SpenderStatsMoneyWindow;
    d7: SpenderStatsMoneyWindow;
    prev7: SpenderStatsMoneyWindow;
    d30: SpenderStatsMoneyWindow;
    d7DeltaPct: number | null;
  };
  avgCheckMills: bigint | null;
  tiers: SpenderStatsTier[];
  silence: Record<SpenderSilenceBucket, { fans: number; lifetimeGrossMills: bigint }>;
  newPayers: { count: number; firstPurchaseKnown: boolean };
  queueSummary: SpenderAwaitingReplySummary;
}

async function readDayStateRows(db: Database, scope: WindowScope): Promise<SpenderStatsDayStateRow[]> {
  const result = await db.execute<{
    date: string;
    state: TransactionState;
    gross: string;
    purchases_gross: string;
    net: string;
    purchase_count: number;
  }>(buildWindowDaysQuery(scope));
  return result.rows.map((row) => ({
    date: row.date,
    state: row.state,
    grossMills: toBigInt(row.gross),
    purchasesGrossMills: toBigInt(row.purchases_gross),
    creatorNetMills: toBigInt(row.net),
    purchaseCount: Number(row.purchase_count),
  }));
}

async function readTierCounts(db: Database, scope: WindowScope) {
  const result = await db.execute<{ part: "members" | "window"; key: string; fans: number; payers: number; gross: string }>(sql`
    with bands(key, min_mills, max_mills) as (values ${TIER_BANDS_SQL}),
    payers as (${payersSql(scope.pageId)}),
    members as (
      select p.fan_id, b.key
      from payers p
      join bands b
        on p.lifetime_gross >= b.min_mills
       and (b.max_mills is null or p.lifetime_gross < b.max_mills)
    ),
    win as (${windowRowsSql(scope)}),
    fan_window as (
      select w.fan_id, sum(w.gross) as gross, bool_or(w.is_purchase) as paid
      from win w
      group by w.fan_id
    )
    select 'members' as part, m.key, count(*)::int as fans, 0 as payers, 0::bigint as gross
    from members m
    group by m.key
    union all
    select 'window' as part,
           case
             when fw.fan_id is null then ${SPENDER_STATS_UNATTRIBUTED_KEY}::text
             else coalesce(m.key, ${SPENDER_STATS_UNTIERED_KEY}::text)
           end as key,
           count(fw.fan_id)::int as fans,
           (count(*) filter (where fw.paid and fw.fan_id is not null))::int as payers,
           coalesce(sum(fw.gross), 0)::bigint as gross
    from fan_window fw
    left join members m on m.fan_id = fw.fan_id
    group by 2
  `);

  const byTierKey = new Map<string, SpenderStatsTierCounts>();
  const tierCounts = (key: string) => {
    let counts = byTierKey.get(key);
    if (!counts) {
      counts = { members: 0, windowPayers: 0, windowGrossMills: 0n };
      byTierKey.set(key, counts);
    }
    return counts;
  };
  const untiered: SpenderStatsTierCounts = { members: 0, windowPayers: 0, windowGrossMills: 0n };
  let unattributedGrossMills = 0n;
  let payerCount = 0;

  for (const row of result.rows) {
    if (row.part === "members") {
      tierCounts(row.key).members = Number(row.fans);
      payerCount += Number(row.fans);
    } else if (row.key === SPENDER_STATS_UNATTRIBUTED_KEY) {
      unattributedGrossMills = toBigInt(row.gross);
    } else if (row.key === SPENDER_STATS_UNTIERED_KEY) {
      untiered.members = Number(row.fans);
      untiered.windowPayers = Number(row.payers);
      untiered.windowGrossMills = toBigInt(row.gross);
    } else {
      const counts = tierCounts(row.key);
      counts.windowPayers = Number(row.payers);
      counts.windowGrossMills = toBigInt(row.gross);
    }
  }

  return {
    tiers: assembleSpenderStatsTiers({ byTierKey, untiered, unattributedGrossMills }),
    payerCount,
  };
}

/** Window payers, new payers and what coverage needs, in one statement. */
async function readPageFacts(db: Database, scope: WindowScope, windows: SpenderStatsWindows) {
  const result = await db.execute<{
    payers_today: number;
    payers_d7: number;
    payers_prev7: number;
    payers_d30: number;
    new_payers: number;
    history_before_window: boolean;
    newest_transaction_at: Date | string | null;
    projection_as_of: Date | string | null;
    has_archived_messages: boolean;
  }>(sql`
    with win as (${windowRowsSql(scope)}),
    window_payers as (
      select w.fan_id,
             bool_or(w.local_date >= ${windows.today.from}::date) as today,
             bool_or(w.local_date >= ${windows.d7.from}::date) as d7,
             bool_or(w.local_date between ${windows.prev7.from}::date and ${windows.prev7.to}::date) as prev7
      from win w
      where w.is_purchase and w.fan_id is not null
      group by w.fan_id
    )
    select
      (select count(*) filter (where wp.today)::int from window_payers wp) as payers_today,
      (select count(*) filter (where wp.d7)::int from window_payers wp) as payers_d7,
      (select count(*) filter (where wp.prev7)::int from window_payers wp) as payers_prev7,
      (select count(*)::int from window_payers wp) as payers_d30,
      (select count(*)::int
       from window_payers wp
       where not exists (
         select 1
         from transactions t
         where t.fan_id = wp.fan_id
           and t.platform_account_id = ${scope.pageId}
           and t.is_active = true
           and t.canonical_type in (${PURCHASE_TYPES_SQL})
           and t.gross_amount_mills > 0
           and t.occurred_at < ${windowStartSql(scope)}
       )) as new_payers,
      exists (
        select 1
        from transactions t
        where t.platform_account_id = ${scope.pageId}
          and t.is_active = true
          and t.canonical_type in (${UNIVERSE_TYPES_SQL})
          and t.occurred_at < ${windowStartSql(scope)}
      ) as history_before_window,
      (select max(t.occurred_at)
       from transactions t
       where t.platform_account_id = ${scope.pageId}
         and t.is_active = true
         and t.canonical_type in (${UNIVERSE_TYPES_SQL})) as newest_transaction_at,
      (select w.last_rebuilt_at
       from projection_watermarks w
       where w.platform_account_id = ${scope.pageId}) as projection_as_of,
      exists (select 1 from message_archive ma where ma.account_id = ${scope.pageId}) as has_archived_messages
  `);
  const row = result.rows[0];
  const projectionAsOf = toDate(row?.projection_as_of);
  return {
    payerCounts: {
      today: Number(row?.payers_today ?? 0),
      d7: Number(row?.payers_d7 ?? 0),
      prev7: Number(row?.payers_prev7 ?? 0),
      d30: Number(row?.payers_d30 ?? 0),
    },
    newPayers: Number(row?.new_payers ?? 0),
    historyBeforeWindow: row?.history_before_window === true,
    newestTransactionAt: toDate(row?.newest_transaction_at),
    // The watermark's epoch placeholder means "never rebuilt" (getSpenderProjectionAsOf).
    projectionAsOf: projectionAsOf && projectionAsOf.getTime() > 0 ? projectionAsOf : null,
    hasArchivedMessages: row?.has_archived_messages === true,
  };
}

async function readSilence(db: Database, input: { pageId: number; asOf: Date }) {
  const result = await db.execute<{ whole_days: number | null; fans: number; lifetime_gross: string }>(
    buildSilenceQuery(input),
  );
  const silence: PageSpenderStats["silence"] = {
    d8to21: { fans: 0, lifetimeGrossMills: 0n },
    over21: { fans: 0, lifetimeGrossMills: 0n },
    unknown: { fans: 0, lifetimeGrossMills: 0n },
  };
  for (const row of result.rows) {
    const bucket = classifySpenderSilence(row.whole_days === null ? null : Number(row.whole_days));
    if (bucket === "recent") continue;
    silence[bucket].fans += Number(row.fans);
    silence[bucket].lifetimeGrossMills += toBigInt(row.lifetime_gross);
  }
  return silence;
}

/**
 * The stats of one page for a 30-day window in the caller's zone, as of
 * `asOf` (the request time; nothing after it is counted). A zone that is not
 * an IANA name Intl knows throws RangeError before any read
 * (`normalizeSpenderStatsTimeZone`); the caller checks page access first.
 */
export async function getPageSpenderStats(
  db: Database,
  input: { pageId: number; timeZone: string; asOf: Date; windowDays?: number },
): Promise<PageSpenderStats> {
  const windows = resolveSpenderStatsWindows({
    asOf: input.asOf,
    timeZone: input.timeZone,
    ...(input.windowDays === undefined ? {} : { windowDays: input.windowDays }),
  });
  const scope = windowScope(input.pageId, windows);

  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const dayRows = await readDayStateRows(database, scope);
    const { tiers, payerCount } = await readTierCounts(database, scope);
    const facts = await readPageFacts(database, scope, windows);
    const { payerCounts } = facts;
    const silence = await readSilence(database, { pageId: input.pageId, asOf: input.asOf });
    const queueSummary = await readAwaitingReplySummary(database, input.pageId);

    const days = assembleSpenderStatsDays(windows.dates, dayRows);
    const d7 = sumSpenderStatsWindow(days, windows.d7, payerCounts.d7);
    const prev7 = sumSpenderStatsWindow(days, windows.prev7, payerCounts.prev7);
    const d30 = sumSpenderStatsWindow(days, windows.d30, payerCounts.d30);

    return {
      pageId: input.pageId,
      metricVersion: SPENDER_STATS_METRIC_VERSION,
      timeZone: windows.timeZone,
      asOf: input.asOf,
      from: windows.d30.from,
      to: windows.d30.to,
      projectionAsOf: facts.projectionAsOf,
      includedStates: [...SPENDER_STATS_INCLUDED_STATES],
      coverage: deriveSpenderStatsCoverage({
        newestTransactionAt: facts.newestTransactionAt,
        historyBeforeWindow: facts.historyBeforeWindow,
        projectionAsOf: facts.projectionAsOf,
        payerCount,
        hasArchivedMessages: facts.hasArchivedMessages,
      }),
      days,
      totals: {
        today: sumSpenderStatsWindow(days, windows.today, payerCounts.today),
        d7,
        prev7,
        d30,
        d7DeltaPct: spenderStatsDeltaPct(d7.grossMills, prev7.grossMills),
      },
      avgCheckMills: spenderStatsAverageCheckMills(d30.purchasesGrossMills, d30.purchaseCount),
      tiers,
      silence,
      newPayers: { count: facts.newPayers, firstPurchaseKnown: facts.historyBeforeWindow },
      queueSummary,
    };
  }, READ_SNAPSHOT);
}

/** Keyset position in the queue order (lifetime gross desc, last fan message asc, fan id asc). */
export interface SpenderAwaitingReplyPosition {
  lifetimeGrossMills: bigint;
  /** `last_fan_message_at` in exact microseconds: a JS Date would drop them and repeat rows. */
  lastFanMessageAtMicros: bigint;
  fanId: number;
}

export interface SpenderAwaitingReplyItem {
  fanId: number;
  /** The platform's fan id (on OnlyFans, the chat id). */
  fanRef: string;
  username: string | null;
  displayName: string | null;
  lifetimeGrossMills: bigint;
  lastFanMessageAt: Date;
  lastModelMessageAt: Date | null;
  /** Null when the read state is unknown. */
  unreadCount: number | null;
  readState: SpenderAwaitingReplyReadState;
  position: SpenderAwaitingReplyPosition;
}

export const SPENDER_AWAITING_REPLY_MAX_LIMIT = 200;

/**
 * One page of the awaiting-reply queue after `after` (exclusive), with the
 * queue's totals from the same snapshot. The order is total and stable: a
 * fan whose sort values do not change is returned exactly once by a walk.
 */
export async function listPageSpenderAwaitingReply(
  db: Database,
  input: { pageId: number; limit: number; after?: SpenderAwaitingReplyPosition | null },
): Promise<SpenderAwaitingReplySummary & { items: SpenderAwaitingReplyItem[] }> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > SPENDER_AWAITING_REPLY_MAX_LIMIT) {
    throw new RangeError(`limit must be 1..${SPENDER_AWAITING_REPLY_MAX_LIMIT}`);
  }
  const after = input.after ?? null;
  const keyset = after === null
    ? sql`true`
    : sql`(
        a.lifetime_gross < ${after.lifetimeGrossMills}::bigint
        or (a.lifetime_gross = ${after.lifetimeGrossMills}::bigint and (
          a.last_fan_us > ${after.lastFanMessageAtMicros}::bigint
          or (a.last_fan_us = ${after.lastFanMessageAtMicros}::bigint and a.fan_id > ${after.fanId}::bigint)
        ))
      )`;

  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const summary = await readAwaitingReplySummary(database, input.pageId);
    const result = await database.execute<{
      fan_id: string | number;
      fan_ref: string;
      username: string | null;
      display_name: string | null;
      lifetime_gross: string;
      last_fan_message_at: Date | string;
      last_model_message_at: Date | string | null;
      last_fan_us: string;
      unread_count: number;
      last_message_sender_role: string;
    }>(sql`
      with ${awaitingSql(input.pageId)}
      select a.fan_id,
             f.platform_user_id as fan_ref,
             coalesce(f.username, a.partner_username) as username,
             coalesce(f.display_name, a.partner_display_name) as display_name,
             a.lifetime_gross,
             a.last_fan_message_at,
             a.last_model_message_at,
             a.last_fan_us,
             a.unread_count,
             a.last_message_sender_role
      from awaiting a
      join fans f on f.id = a.fan_id
      where ${keyset}
      order by a.lifetime_gross desc, a.last_fan_us asc, a.fan_id asc
      limit ${input.limit}
    `);

    return {
      ...summary,
      items: result.rows.map((row) => {
        const fanId = Number(row.fan_id);
        const lifetimeGrossMills = toBigInt(row.lifetime_gross);
        const lastFanMessageAtMicros = toBigInt(row.last_fan_us);
        const read = deriveAwaitingReplyReadState({
          unreadCount: Number(row.unread_count),
          lastMessageSenderRole: row.last_message_sender_role,
        });
        return {
          fanId,
          fanRef: row.fan_ref,
          username: row.username,
          displayName: row.display_name,
          lifetimeGrossMills,
          lastFanMessageAt: toDate(row.last_fan_message_at)!,
          lastModelMessageAt: toDate(row.last_model_message_at),
          unreadCount: read.unreadCount,
          readState: read.readState,
          position: { lifetimeGrossMills, lastFanMessageAtMicros, fanId },
        };
      }),
    };
  }, READ_SNAPSHOT);
}

async function explain(db: Database, query: SQL, options: { analyze?: boolean } = {}): Promise<string> {
  const head = options.analyze ? sql`explain (analyze, buffers, format text)` : sql`explain (format text)`;
  const result = await db.execute<{ "QUERY PLAN": string }>(sql`${head} ${query}`);
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/**
 * EXPLAIN of the exact silence statement (the H-8 perf gate). `analyze` runs
 * it and adds the buffers: the measurement that decides whether the archive
 * needs a partial index for fan messages; on production, run it inside a
 * read-only transaction.
 */
export function explainPageSpenderSilenceQuery(
  db: Database,
  input: { pageId: number; asOf: Date },
  options: { analyze?: boolean } = {},
) {
  return explain(db, buildSilenceQuery(input), options);
}

/** EXPLAIN of the exact window statement for the window ending at `asOf`. */
export function explainPageSpenderWindowQuery(
  db: Database,
  input: { pageId: number; timeZone: string; asOf: Date },
) {
  const windows = resolveSpenderStatsWindows({ asOf: input.asOf, timeZone: input.timeZone });
  return explain(db, buildWindowDaysQuery(windowScope(input.pageId, windows)));
}
