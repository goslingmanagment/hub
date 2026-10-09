import { sql } from "drizzle-orm";
import {
  LINK_ATTRIBUTION_RULE,
  spenderAnalyticsTransactionTypes,
  type TrafficLinkKind,
} from "@agency_hub_core/shared";

import type { Database } from "../client.ts";

// Hub's own money per OnlyFans link (traffic sources plan §2.4, PR 13), under
// `ofapi_subscription_period_equal_split.v1` (LINK_ATTRIBUTION_RULE): a
// transaction of a fan counts for every link whose period for that fan holds
// its time (page_link_fan_periods, PR 8), split equally between them. Nothing
// is stored: it is computed when read, from `transactions` and the periods,
// so a period corrected later (a close confirmed two walks on, a rebuild)
// changes the figure with no recomputation step.
//
// Which transactions count (П9.3): active, posted, with a fan, of the types
// the fan spend rollup counts (spenderAnalyticsTransactionTypes — the same
// selection as `fan_spend_daily`). Pending ones are carried separately and
// never enter the figure. The money is `creator_net_amount_mills`: net after
// the OnlyFans fee, like the vendor's revenue.total.
//
// A chargeback or refund (`<id>:chargeback` / `<id>:reversal`) whose original
// purchase is in the ledger takes the shares of that ORIGINAL purchase — the
// links whose periods held the purchase — and is reported at its own time
// (П2); without the original it is attributed at its own time like any
// transaction.
//
// Recipients are decided per page BEFORE any filter by link, channel or
// contractor, so asking for one link never turns a split transaction into a
// whole one. Shares are integer mills: the remainder of the division goes one
// mill at a time to the recipients in link order (kind, then link number), so
// for every transaction the shares plus the unallocated part equal its amount.

export const HUB_LINK_MONEY_RULE = LINK_ATTRIBUTION_RULE;

const TRANSACTION_TYPES_SQL = sql.join(
  spenderAnalyticsTransactionTypes.map((type) => sql`${type}::transaction_type`),
  sql`, `,
);

const pageIdsParam = (pageIds: readonly number[]) => `{${pageIds.map((id) => Math.trunc(id)).join(",")}}`;

export const hubLinkKey = (pageId: number, linkKind: string, linkRef: string) => `${pageId}:${linkKind}:${linkRef}`;

export interface HubLinkPeriod {
  pageId: number;
  linkKind: TrafficLinkKind;
  linkRef: string;
  fanId: number;
  /** null = before the link's floor: it starts at the floor. */
  startAt: Date | null;
  /** Exclusive; null = open. */
  endAt: Date | null;
}

export interface HubLinkTransaction {
  id: number;
  pageId: number;
  fanId: number;
  state: "posted" | "pending";
  netMills: bigint;
  /** When it happened: the time it is reported at. */
  occurredAt: Date;
  /** The time its recipients are decided at: the original purchase's for a
   *  chargeback or refund whose original is in the ledger, else its own. */
  attributionAt: Date;
  /** The original purchase a chargeback or refund negates, when known. */
  negatesTransactionId: number | null;
}

export interface HubLinkAllocation {
  transactionId: number;
  pageId: number;
  linkKind: TrafficLinkKind;
  linkRef: string;
  fanId: number;
  state: "posted" | "pending";
  occurredAt: Date;
  mills: bigint;
}

export interface HubLinkAttribution {
  /** Per link (hubLinkKey): the start of its first finished walk that may
   *  count absence — where Hub's figure for the link begins. */
  floors: Map<string, Date>;
  /** Per page: the instant up to which the split of its money is final —
   *  the earliest, over every link of the page the sweep is walking (a
   *  subscriber walk started within LINK_WALK_ACTIVE_MS of the read), of the
   *  start of its last finished walk; null when one of them has none. A fan
   *  any of those links lists by then has been seen by all of them, so no
   *  share of a transaction before it can still move to a link not yet read. */
  splitFinalUntil: Map<number, Date | null>;
  allocations: HubLinkAllocation[];
  /** Transactions no period holds: the part of the page's money no link
   *  brought (or none Hub can name). */
  unallocated: Array<{ transactionId: number; pageId: number; state: "posted" | "pending"; occurredAt: Date; mills: bigint }>;
}

/** Link order for the division remainder: kind, then link number. */
function compareLinks(left: { linkKind: string; linkRef: string }, right: { linkKind: string; linkRef: string }) {
  if (left.linkKind !== right.linkKind) return left.linkKind < right.linkKind ? -1 : 1;
  if (left.linkRef.length !== right.linkRef.length) return left.linkRef.length - right.linkRef.length;
  return left.linkRef < right.linkRef ? -1 : left.linkRef > right.linkRef ? 1 : 0;
}

/**
 * The rule itself, pure. Every transaction is either split over the links
 * whose periods hold its attribution time or left unallocated; the shares of
 * one transaction sum to its amount exactly.
 */
export function attributeHubLinkMoney(input: {
  floors: ReadonlyMap<string, Date>;
  periods: readonly HubLinkPeriod[];
  transactions: readonly HubLinkTransaction[];
}): Omit<HubLinkAttribution, "floors" | "splitFinalUntil"> {
  const periodsByFan = new Map<string, Array<HubLinkPeriod & { from: number; to: number }>>();
  for (const period of input.periods) {
    const floor = input.floors.get(hubLinkKey(period.pageId, period.linkKind, period.linkRef));
    // A link without a floor has no figure; a period before the floor starts there.
    if (floor === undefined) continue;
    const from = Math.max((period.startAt ?? floor).getTime(), floor.getTime());
    const to = period.endAt === null ? Number.POSITIVE_INFINITY : period.endAt.getTime();
    if (to <= from) continue;
    const key = `${period.pageId}:${period.fanId}`;
    const list = periodsByFan.get(key) ?? [];
    list.push({ ...period, from, to });
    periodsByFan.set(key, list);
  }

  const allocations: HubLinkAllocation[] = [];
  const unallocated: HubLinkAttribution["unallocated"] = [];
  for (const transaction of input.transactions) {
    const at = transaction.attributionAt.getTime();
    const holding = (periodsByFan.get(`${transaction.pageId}:${transaction.fanId}`) ?? [])
      .filter((period) => period.from <= at && at < period.to);
    const byLink = new Map<string, HubLinkPeriod>();
    for (const period of holding) byLink.set(hubLinkKey(period.pageId, period.linkKind, period.linkRef), period);
    const recipients = [...byLink.values()].sort(compareLinks);
    if (recipients.length === 0) {
      unallocated.push({
        transactionId: transaction.id,
        pageId: transaction.pageId,
        state: transaction.state,
        occurredAt: transaction.occurredAt,
        mills: transaction.netMills,
      });
      continue;
    }
    const count = BigInt(recipients.length);
    const share = transaction.netMills / count; // truncates toward zero
    const remainder = transaction.netMills - share * count; // same sign, |r| < count
    const step = remainder < 0n ? -1n : 1n;
    const extra = remainder < 0n ? -remainder : remainder;
    recipients.forEach((recipient, index) => {
      allocations.push({
        transactionId: transaction.id,
        pageId: transaction.pageId,
        linkKind: recipient.linkKind,
        linkRef: recipient.linkRef,
        fanId: transaction.fanId,
        state: transaction.state,
        occurredAt: transaction.occurredAt,
        mills: share + (BigInt(index) < extra ? step : 0n),
      });
    });
  }
  return { allocations, unallocated };
}

/** A link whose last subscriber walk started longer ago than this is no
 *  longer walked (the vendor dropped it): it does not hold a page's split
 *  open. Four sweeps a day walk every listed link. */
export const LINK_WALK_ACTIVE_MS = 48 * 3_600_000;

/** Each link's floor — the start of its first finished subscriber walk that
 *  may count absence (П9.10) — and, per page, the instant up to which the
 *  split is final (see HubLinkAttribution.splitFinalUntil), as of `now`. */
export async function readHubLinkWalkBounds(
  db: Database,
  pageIds: readonly number[],
  now: Date,
): Promise<{ floors: Map<string, Date>; splitFinalUntil: Map<number, Date | null> }> {
  if (pageIds.length === 0) return { floors: new Map(), splitFinalUntil: new Map() };
  const result = await db.execute<{
    page_id: string; link_kind: string; link_ref: string;
    floor_at: Date | string | null; last_finished_at: Date | string | null; last_started_at: Date | string;
  }>(sql`
    select platform_account_id::text as page_id, link_kind, platform_link_id as link_ref,
           min(started_at) filter (where finished_at is not null and evidential) as floor_at,
           max(started_at) filter (where finished_at is not null and evidential) as last_finished_at,
           max(started_at) as last_started_at
      from page_link_fan_walks
     where platform_account_id = any(${pageIdsParam(pageIds)}::bigint[])
       and list_kind = 'subscribers'
     group by 1, 2, 3
  `);
  const floors = new Map<string, Date>();
  const splitFinalUntil = new Map<number, Date | null>();
  for (const row of result.rows) {
    const pageId = Number(row.page_id);
    if (row.floor_at !== null) floors.set(hubLinkKey(pageId, row.link_kind, row.link_ref), new Date(row.floor_at));
    if (now.getTime() - new Date(row.last_started_at).getTime() > LINK_WALK_ACTIVE_MS) continue;
    const lastFinished = row.last_finished_at === null ? null : new Date(row.last_finished_at);
    const current = splitFinalUntil.has(pageId) ? splitFinalUntil.get(pageId)! : undefined;
    splitFinalUntil.set(pageId, current === undefined
      ? lastFinished
      : current === null || lastFinished === null
        ? null
        : (lastFinished.getTime() < current.getTime() ? lastFinished : current));
  }
  return { floors, splitFinalUntil };
}

/**
 * Hub's attribution for the pages over transactions that happened in
 * [`from`, `to`) — `from` defaults to the pages' earliest floor (nothing before
 * any floor can count). The rule's inputs are read in one statement each;
 * the division is `attributeHubLinkMoney`.
 */
export async function readHubLinkAttribution(
  db: Database,
  input: { pageIds: readonly number[]; to: Date; from?: Date; now?: Date },
): Promise<HubLinkAttribution> {
  const { floors, splitFinalUntil } = await readHubLinkWalkBounds(db, input.pageIds, input.now ?? input.to);
  if (floors.size === 0) return { floors, splitFinalUntil, allocations: [], unallocated: [] };
  const earliestFloor = new Date(Math.min(...[...floors.values()].map((floor) => floor.getTime())));
  const from = input.from !== undefined && input.from.getTime() > earliestFloor.getTime() ? input.from : earliestFloor;
  if (from.getTime() >= input.to.getTime()) return { floors, splitFinalUntil, allocations: [], unallocated: [] };

  const periods = await db.execute<{
    page_id: string; link_kind: TrafficLinkKind; link_ref: string; fan_id: string;
    start_at: Date | string | null; end_at: Date | string | null;
  }>(sql`
    select platform_account_id::text as page_id, link_kind, platform_link_id as link_ref, fan_id::text,
           period_start_at as start_at, closed_at as end_at
      from page_link_fan_periods
     where platform_account_id = any(${pageIdsParam(input.pageIds)}::bigint[])
  `);
  const transactions = await db.execute<{
    id: string; page_id: string; fan_id: string; state: "posted" | "pending"; net_mills: string;
    occurred_at: Date | string; attribution_at: Date | string; original_id: string | null;
  }>(sql`
    select t.id::text, t.platform_account_id::text as page_id, t.fan_id::text,
           t.transaction_state::text as state, t.creator_net_amount_mills::text as net_mills,
           t.occurred_at, coalesce(o.occurred_at, t.occurred_at) as attribution_at, o.id::text as original_id
      from transactions t
      left join transactions o
        on t.transaction_id ~ ':(reversal|chargeback)$'
       and o.platform_account_id = t.platform_account_id
       and o.transaction_id = regexp_replace(t.transaction_id, ':(reversal|chargeback)$', '')
     where t.platform_account_id = any(${pageIdsParam(input.pageIds)}::bigint[])
       and t.is_active
       and t.fan_id is not null
       and t.transaction_state in ('posted', 'pending')
       and t.canonical_type in (${TRANSACTION_TYPES_SQL})
       and t.occurred_at >= ${from}
       and t.occurred_at < ${input.to}
     order by t.occurred_at, t.id
  `);

  const result = attributeHubLinkMoney({
    floors,
    periods: periods.rows.map((row) => ({
      pageId: Number(row.page_id),
      linkKind: row.link_kind,
      linkRef: row.link_ref,
      fanId: Number(row.fan_id),
      startAt: row.start_at === null ? null : new Date(row.start_at),
      endAt: row.end_at === null ? null : new Date(row.end_at),
    })),
    transactions: transactions.rows.map((row) => ({
      id: Number(row.id),
      pageId: Number(row.page_id),
      fanId: Number(row.fan_id),
      state: row.state,
      netMills: BigInt(row.net_mills),
      occurredAt: new Date(row.occurred_at),
      attributionAt: new Date(row.attribution_at),
      negatesTransactionId: row.original_id === null ? null : Number(row.original_id),
    })),
  });
  return { floors, splitFinalUntil, ...result };
}

export interface HubLinkMoneySum {
  /** Posted only. */
  netMills: bigint;
  /** Pending, never part of netMills. */
  pendingMills: bigint;
  /** Posted transactions with a share. */
  transactionCount: number;
  /** Fans of those transactions. */
  fanCount: number;
}

/** One link's shares of transactions that happened in [fromAt, toAt). */
export function sumHubLinkMoney(
  allocations: readonly HubLinkAllocation[],
  filter: { pageId: number; linkKind: string; linkRef: string; fromAt: Date; toAt: Date },
): HubLinkMoneySum {
  const from = filter.fromAt.getTime();
  const to = filter.toAt.getTime();
  let netMills = 0n;
  let pendingMills = 0n;
  const transactions = new Set<number>();
  const fans = new Set<number>();
  for (const allocation of allocations) {
    const at = allocation.occurredAt.getTime();
    if (
      allocation.pageId !== filter.pageId || allocation.linkKind !== filter.linkKind
      || allocation.linkRef !== filter.linkRef || at < from || at >= to
    ) continue;
    if (allocation.state === "pending") {
      pendingMills += allocation.mills;
      continue;
    }
    netMills += allocation.mills;
    transactions.add(allocation.transactionId);
    fans.add(allocation.fanId);
  }
  return { netMills, pendingMills, transactionCount: transactions.size, fanCount: fans.size };
}

/** Whether the chargebacks reconcile is failing now (its incident open):
 *  Hub's ledger then may lack chargebacks the vendor's figure already took
 *  out — the comparison's `ledger_gap`. */
export async function readHubLedgerGap(db: Database): Promise<boolean> {
  const result = await db.execute<{ open: boolean }>(sql`
    select exists (
      select 1 from notification_incidents
       where kind = 'ofapi_chargebacks_reconcile_failed' and resolved_at is null
    ) as open
  `);
  return result.rows[0]?.open === true;
}

/** The vendor's revenue calculation time and loading flag of snapshots,
 *  by (run, link): what the comparison aligns Hub's window to. */
export async function readLinkSnapshotCalculations(
  db: Database,
  keys: ReadonlyArray<{ runId: number; linkRef: string }>,
): Promise<Map<string, { calculatedAt: Date | null; isLoading: boolean | null }>> {
  if (keys.length === 0) return new Map();
  const result = await db.execute<{
    run_id: string; link_ref: string; calculated_at: Date | string | null; is_loading: boolean | null;
  }>(sql`
    select s.run_id::text, s.platform_link_id as link_ref, s.revenue_calculated_at as calculated_at,
           s.revenue_is_loading as is_loading
      from page_link_stat_snapshots s
      join unnest(${sql.param(keys.map((key) => key.runId))}::bigint[], ${sql.param(keys.map((key) => key.linkRef))}::text[])
        as k(run_id, link_ref) on k.run_id = s.run_id and k.link_ref = s.platform_link_id
  `);
  return new Map(result.rows.map((row) => [`${row.run_id}:${row.link_ref}`, {
    calculatedAt: row.calculated_at === null ? null : new Date(row.calculated_at),
    isLoading: row.is_loading,
  }]));
}
