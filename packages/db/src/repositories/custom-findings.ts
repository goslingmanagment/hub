import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { testPageSql } from "./realm.ts";

// Заказ кастома, a custom with no order (customs facts spec §8; table custom_findings, 0436): one trace of a custom no
// order has — a sale (a tip whose note says custom, a purchase or renewal of a tier that includes one), a line of a
// shift report marked «кастом», a card the reader found in a Telegram place. `(source, ref)` names it once: a dismissed
// one never comes back, a tier's next renewal is a new sale and a new finding. Hub's checks pass writes these (behind
// the switch `customsFacts`); people and the agent resolve them. A sale's finding is known by Hub's id of the sale.

type Row = Record<string, unknown>;
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const date = (value: unknown) => (value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value)));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;
const texts = (values: readonly string[]) => sql`${sql.param([...values])}::text[]`;
const times = (values: ReadonlyArray<Date | null>) => sql`${sql.param(values.map((value) => value?.toISOString() ?? null))}::timestamptz[]`;

/** The words of a custom in a note: Latin either case, Cyrillic either case whatever the database's locale. */
const CUSTOM_WORD = String.raw`(custom|[кК][аА][сС][тТ][оО][мМ])`;
/** «Кастом», the quick word of a shift report's sale line (shift-report-board.ts). */
const QUICK_WORD = "[кК][аА][сС][тТ][оО][мМ]";

/** A tier that includes a custom, as the owner corrects the wording match (`customTierOverrides`, custom-tier-overrides.ts). */
export interface CustomTierOverrideInput {
  pageLabel: string;
  tierRef: string;
  includesCustom: boolean;
}

/**
 * The CTEs `tier_overrides` and `custom_tiers` (page_id, tier_ref, name): the tiers that include a custom — a benefit or
 * the name with «free» and «custom» (today's wording match), unless the owner's setting says no; and every tier it says
 * yes for, whatever its words.
 */
function customTiersCtes(overrides: readonly CustomTierOverrideInput[]): SQL {
  return sql`
    tier_overrides as (
      select * from unnest(${texts(overrides.map((one) => one.pageLabel))}, ${texts(overrides.map((one) => one.tierRef))},
        ${sql.param(overrides.map((one) => one.includesCustom))}::boolean[]) as x(page_label, tier_ref, includes)
    ),
    custom_tiers as (
      select t.page_id, t.tier_ref, t.name from page_subscription_tiers t join pages tp on tp.id = t.page_id
      where (exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(t.subscription_benefits) = 'array' then t.subscription_benefits else '[]'::jsonb end) b
               where b ~* '\\mfree\\M' and b ~* 'custom')
          or (coalesce(t.name, '') ~* '\\mfree\\M' and coalesce(t.name, '') ~* 'custom'))
        and not exists (select 1 from tier_overrides ov where ov.page_label = tp.label and ov.tier_ref = t.tier_ref and not ov.includes)
      union
      select op.id, ov.tier_ref, (select t.name from page_subscription_tiers t where t.page_id = op.id and t.tier_ref = ov.tier_ref)
      from tier_overrides ov join pages op on op.label = ov.page_label
      where ov.includes
    )`;
}

/**
 * The fan's note with a tip (the transaction `t`, its page `p`, its fan `f`): Fansly's (and any) tip context by the
 * tip's id; else, on OnlyFans, the tip message of the fan within five minutes whose amount is the sale's — its own
 * amount, or the «$15.00» its text says (OnlyFans' tip messages carry no amount of their own).
 */
const TIP_NOTE = sql`coalesce(
  (select nullif(btrim(tc.tip_message_text), '') from transaction_tip_contexts tc
    where tc.account_id = t.platform_account_id and tc.platform_tip_id = t.correlation_id limit 1),
  case when p.platform = 'onlyfans' then (
    select nullif(btrim(ma.tip_text_plain), '') from message_archive ma
    where ma.account_id = t.platform_account_id and ma.is_tip and ma.fan_native_id = f.platform_user_id
      and coalesce(ma.tip_text_plain, '') <> ''
      and ma.occurred_at between t.occurred_at - interval '5 minutes' and t.occurred_at + interval '5 minutes'
      and (ma.tip_amount_mills = t.gross_amount_mills
        or (ma.tip_amount_mills = 0
          and replace(substring(ma.text_plain from '\\$([0-9][0-9,]{0,9}(?:\\.[0-9]{1,2})?)'), ',', '')::numeric * 1000 = t.gross_amount_mills))
    order by abs(extract(epoch from ma.occurred_at - t.occurred_at)), ma.id limit 1) end)`;

/**
 * The tier a subscription sale `t` paid for: by the sale's own reference to its subscription (Fansly: the sale's
 * correlation id is the subscription's history id — a renewal too), the ±2 h window around the subscription's start only
 * when no subscription names it.
 */
const SALE_TIER = sql`coalesce(
  (select ps.subscription_tier_id from page_subscriptions ps
    where ps.platform_account_id = t.platform_account_id and ps.fan_id = t.fan_id and ps.platform_history_id = t.correlation_id
    order by ps.id desc limit 1),
  (select ps.subscription_tier_id from page_subscriptions ps
    where ps.platform_account_id = t.platform_account_id and ps.fan_id = t.fan_id
      and ps.source_created_at between t.occurred_at - interval '2 hours' and t.occurred_at + interval '2 hours'
    order by ps.source_created_at desc limit 1))`;

const quoteOf = (value: SQL) => sql`nullif(left(btrim(${value}), 300), '')`;
const amountOf = sql`case when t.gross_amount_mills > 0 then t.gross_amount_mills end`;

/**
 * The sales of [from, to) that look like a custom, written as open findings (`sale`): a tip whose note speaks of a
 * custom, a purchase or renewal of a tier that includes one. Skipped only a sale that pays an order, or one that has
 * a finding already (its dismissal stays: `(source, ref)` is written once) — no more the week around an existing order
 * of the fan (the old rule hid a second custom). Answers how many were written.
 */
export async function insertCustomSaleFindings(
  db: Database,
  input: { from: Date; to: Date; overrides: readonly CustomTierOverrideInput[]; now: Date },
): Promise<number> {
  const window = sql`t.is_active and t.gross_amount_mills > 0
    and t.occurred_at >= ${input.from.toISOString()}::timestamptz and t.occurred_at < ${input.to.toISOString()}::timestamptz
    and not exists (select 1 from custom_order_payments cp where cp.transaction_id = t.id)
    and not exists (select 1 from custom_findings cf where cf.source in ('sale', 'shift_report') and cf.ref = t.id::text)`;
  const result = await db.execute(sql`
    with ${customTiersCtes(input.overrides)},
    tips as (
      select t.id, ${TIP_NOTE} as quote
      from transactions t join pages p on p.id = t.platform_account_id left join fans f on f.id = t.fan_id
      where t.canonical_type = 'tip' and ${window}
    ),
    tier_sales as (
      select t.id, coalesce(ct.name, (select ps.subscription_tier_name from page_subscriptions ps
          where ps.platform_account_id = t.platform_account_id and ps.subscription_tier_id = ct.tier_ref limit 1)) as quote
      from transactions t
      cross join lateral (select ${SALE_TIER} as tier_ref) st
      join custom_tiers ct on ct.page_id = t.platform_account_id and ct.tier_ref = st.tier_ref
      where t.canonical_type = 'subscription' and ${window}
    ),
    found as (
      select id, quote from tips where quote ~* ${CUSTOM_WORD}
      union all
      select id, quote from tier_sales
    )
    insert into custom_findings (source, ref, page_id, fan_id, amount_mills, quote, happened_at, created_at)
    select 'sale', t.id::text, t.platform_account_id, t.fan_id, ${amountOf}, ${quoteOf(sql`x.quote`)}, t.occurred_at, ${input.now.toISOString()}::timestamptz
    from (select distinct on (id) id, quote from found order by id) x join transactions t on t.id = x.id
    on conflict (source, ref) do nothing`);
  return result.rowCount ?? 0;
}

/**
 * The lines of the shift reports handed in since `since` (their newest versions) whose note carries the quick word
 * «кастом» and whose sale pays no order and is no finding yet, written as open findings (`shift_report`, the sale's id;
 * the line's note is the quote). Answers how many were written.
 */
export async function insertShiftReportCustomFindings(db: Database, input: { since: Date; now: Date }): Promise<number> {
  const result = await db.execute(sql`
    with lines as materialized (
      select distinct on ((line->>'transactionId')) (line->>'transactionId') as sale, line->>'note' as note
      from shift_handins h
      join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
      cross join lateral jsonb_array_elements(v.lines) as line
      where h.state = 'submitted' and h.submitted_at >= ${input.since.toISOString()}::timestamptz
        and jsonb_typeof(line->'transactionId') = 'number' and coalesce(line->>'note', '') ~ ${QUICK_WORD}
      order by (line->>'transactionId'), h.submitted_at desc
    )
    insert into custom_findings (source, ref, page_id, fan_id, amount_mills, quote, happened_at, created_at)
    select 'shift_report', t.id::text, t.platform_account_id, t.fan_id, ${amountOf}, ${quoteOf(sql`l.note`)}, t.occurred_at, ${input.now.toISOString()}::timestamptz
    from lines l join transactions t on t.id = l.sale::bigint
    where not exists (select 1 from custom_order_payments cp where cp.transaction_id = t.id)
      and not exists (select 1 from custom_findings cf where cf.source in ('sale', 'shift_report') and cf.ref = t.id::text)
    on conflict (source, ref) do nothing`);
  return result.rowCount ?? 0;
}

/**
 * Sales a matter «похоже на кастом без заказа» waited about, written as open findings (`sale`) from the time each matter
 * was opened, so their escalation does not start again. A sale no longer in the hub keeps the matter's page and day.
 */
export async function insertCustomFindingsOfSales(
  db: Database,
  rows: ReadonlyArray<{ transactionId: number; pageId: number | null; at: Date | null; createdAt: Date }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await db.execute(sql`
    insert into custom_findings (source, ref, page_id, fan_id, amount_mills, quote, happened_at, created_at)
    select 'sale', x.id::text, coalesce(t.platform_account_id, x.page_id), t.fan_id, ${amountOf},
      ${quoteOf(sql`case when t.canonical_type = 'tip' then ${TIP_NOTE}
        when t.canonical_type = 'subscription' then (select ps.subscription_tier_name from page_subscriptions ps
          where ps.platform_account_id = t.platform_account_id and ps.subscription_tier_id = ${SALE_TIER} limit 1) end`)},
      coalesce(t.occurred_at, x.at, x.created_at), x.created_at
    from unnest(${ids(rows.map((row) => row.transactionId))}, ${sql.param(rows.map((row) => (row.pageId === null ? null : String(row.pageId))))}::bigint[],
      ${times(rows.map((row) => row.at))}, ${times(rows.map((row) => row.createdAt))}) as x(id, page_id, at, created_at)
    left join transactions t on t.id = x.id
    left join pages p on p.id = t.platform_account_id
    left join fans f on f.id = t.fan_id
    where x.page_id is null or exists (select 1 from pages xp where xp.id = x.page_id)
    on conflict (source, ref) do nothing`);
  return result.rowCount ?? 0;
}

/** Cards of a Telegram place no order has, written as open findings of that place (`model_group` | `work_chat`). */
export async function insertCustomCardFindings(
  db: Database,
  rows: ReadonlyArray<{ source: "model_group" | "work_chat"; telegramRef: string; postedAt: Date | null; createdAt: Date }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await db.execute(sql`
    insert into custom_findings (source, ref, happened_at, created_at)
    select x.source, x.ref, coalesce(x.posted_at, x.created_at), x.created_at
    from unnest(${texts(rows.map((row) => row.source))}, ${texts(rows.map((row) => row.telegramRef))},
      ${times(rows.map((row) => row.postedAt))}, ${times(rows.map((row) => row.createdAt))}) as x(source, ref, posted_at, created_at)
    on conflict (source, ref) do nothing`);
  return result.rowCount ?? 0;
}

/** Which of these `(source, ref)` have a finding (any status), as `source:ref`. */
export async function listCustomFindingKeys(db: Database, keys: ReadonlyArray<{ source: string; ref: string }>): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const result = await db.execute<Row>(sql`
    select f.source, f.ref from custom_findings f
    join unnest(${texts(keys.map((key) => key.source))}, ${texts(keys.map((key) => key.ref))}) as x(source, ref) on x.source = f.source and x.ref = f.ref`);
  return new Set(result.rows.map((row) => `${String(row.source)}:${String(row.ref)}`));
}

/**
 * «Не кастом» marks of the board before findings (custom_sale_dismissals, kept and no longer written by the new
 * screen) as dismissed findings of their sale; an open finding of such a sale is dismissed by it. Answers how many.
 */
export async function copyCustomSaleDismissals(db: Database): Promise<number> {
  const result = await db.execute(sql`
    insert into custom_findings (source, ref, page_id, fan_id, amount_mills, happened_at, status, dismiss_reason, resolved_by_user_id, resolved_at, created_at)
    select 'sale', d.transaction_id::text, t.platform_account_id, t.fan_id, ${amountOf}, coalesce(t.occurred_at, d.dismissed_at),
      'dismissed', 'not_custom', d.user_id, d.dismissed_at, d.dismissed_at
    from custom_sale_dismissals d left join transactions t on t.id = d.transaction_id
    on conflict (source, ref) do update set status = 'dismissed', dismiss_reason = 'not_custom',
      resolved_by_user_id = excluded.resolved_by_user_id, resolved_by_agent_key_id = null, resolved_at = excluded.resolved_at
    where custom_findings.status = 'open'`);
  return result.rowCount ?? 0;
}

/**
 * Open findings an order took by now: a sale (or a shift report's sale) that pays an order, a card attached to one — each
 * linked to that order by the system. Answers how many.
 */
export async function linkCustomFindingsToOrders(db: Database, now: Date): Promise<number> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const sales = await db.execute(sql`
    update custom_findings f set status = 'linked', order_id = cp.order_id, resolved_at = ${at}
    from custom_order_payments cp
    where f.status = 'open' and f.source in ('sale', 'shift_report') and cp.transaction_id::text = f.ref`);
  const cards = await db.execute(sql`
    update custom_findings f set status = 'linked', order_id = c.order_id, resolved_at = ${at}
    from custom_order_cards c
    where f.status = 'open' and f.source in ('model_group', 'work_chat') and c.telegram_ref = f.ref`);
  return (sales.rowCount ?? 0) + (cards.rowCount ?? 0);
}

export interface OpenCustomFindingRow {
  id: number;
  source: string;
  ref: string;
  pageId: number | null;
  pageLabel: string | null;
  /** Of the test realm (its page's model is test, 0414); a finding of no known page is the live agency's. */
  test: boolean;
  amountMills: number | null;
  happenedAt: Date;
  createdAt: Date;
}

/** The open findings written before `before`, the oldest first. */
export async function listOpenCustomFindings(db: Database, input: { before: Date }): Promise<OpenCustomFindingRow[]> {
  const result = await db.execute<Row>(sql`
    select f.id, f.source, f.ref, f.page_id, p.label as page_label, (f.page_id is not null and ${testPageSql(sql`f.page_id`)}) as test,
      f.amount_mills, f.happened_at, f.created_at
    from custom_findings f left join pages p on p.id = f.page_id
    where f.status = 'open' and f.created_at <= ${input.before.toISOString()}::timestamptz
    order by f.created_at, f.id`);
  return result.rows.map((row) => ({
    id: Number(row.id), source: String(row.source), ref: String(row.ref), pageId: num(row.page_id), pageLabel: (row.page_label as string | null) ?? null,
    test: row.test === true, amountMills: num(row.amount_mills), happenedAt: date(row.happened_at)!, createdAt: date(row.created_at)!,
  }));
}

// ── The agent's candidates ───────────────────────────────────────────────────

interface CandidateFan {
  platform: string;
  fanRef: string;
  username: string | null;
  displayName: string | null;
}

const fanOf = (row: Row): CandidateFan | null => (row.fan_ref === null || row.fan_ref === undefined
  ? null
  : { platform: String(row.platform), fanRef: String(row.fan_ref), username: (row.fan_username as string | null) ?? null, displayName: (row.fan_display_name as string | null) ?? null });

export interface CustomCandidateTipRow {
  transactionId: number;
  pageLabel: string;
  fan: CandidateFan | null;
  grossMills: number;
  at: Date;
  note: string | null;
}

/** Tips of these pages of `minMills` and more since `since` that pay no order and have no finding, the newest first. */
export async function listCustomCandidateTips(
  db: Database,
  input: { pageIds: readonly number[]; since: Date; minMills: number; limit: number },
): Promise<CustomCandidateTipRow[]> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select t.id, p.label, p.platform, f.platform_user_id as fan_ref, f.username as fan_username, f.display_name as fan_display_name,
      t.gross_amount_mills, t.occurred_at, ${TIP_NOTE} as note
    from transactions t join pages p on p.id = t.platform_account_id left join fans f on f.id = t.fan_id
    where t.platform_account_id = any(${ids(input.pageIds)}) and t.canonical_type = 'tip' and t.is_active
      and t.gross_amount_mills >= ${input.minMills} and t.occurred_at >= ${input.since.toISOString()}::timestamptz
      and not exists (select 1 from custom_order_payments cp where cp.transaction_id = t.id)
      and not exists (select 1 from custom_findings cf where cf.source in ('sale', 'shift_report') and cf.ref = t.id::text)
    order by t.occurred_at desc, t.id desc
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    transactionId: Number(row.id), pageLabel: String(row.label), fan: fanOf(row), grossMills: Number(row.gross_amount_mills),
    at: date(row.occurred_at)!, note: (row.note as string | null) ?? null,
  }));
}

export interface CustomCandidateTierRow {
  pageLabel: string;
  fan: CandidateFan | null;
  tierRef: string;
  tierName: string | null;
  endsAt: Date | null;
  transactionId: number | null;
  grossMills: number | null;
  at: Date | null;
}

/**
 * The fans of these pages holding now a tier that includes a custom whose current period has no resolved finding: the
 * period's sale (the newest subscription sale of the fan there in 40 days, the one that names the subscription first)
 * pays no order and its finding, if any, is still open.
 */
export async function listCustomCandidateTiers(
  db: Database,
  input: { pageIds: readonly number[]; overrides: readonly CustomTierOverrideInput[]; now: Date; limit: number },
): Promise<CustomCandidateTierRow[]> {
  if (input.pageIds.length === 0) return [];
  const now = sql`${input.now.toISOString()}::timestamptz`;
  const result = await db.execute<Row>(sql`
    with ${customTiersCtes(input.overrides)},
    holders as (
      select distinct on (ps.platform_account_id, ps.fan_id) ps.platform_account_id as page_id, ps.fan_id, ps.subscription_tier_id as tier_ref,
        coalesce(ct.name, ps.subscription_tier_name) as tier_name, ps.ends_at, ps.platform_history_id
      from page_subscriptions ps join custom_tiers ct on ct.page_id = ps.platform_account_id and ct.tier_ref = ps.subscription_tier_id
      where ps.platform_account_id = any(${ids(input.pageIds)}) and ps.fan_id is not null and ps.is_current
        and (ps.ends_at is null or ps.ends_at > ${now})
      order by ps.platform_account_id, ps.fan_id, ps.ends_at desc nulls first, ps.id desc
    )
    select p.label, p.platform, f.platform_user_id as fan_ref, f.username as fan_username, f.display_name as fan_display_name,
      h.tier_ref, h.tier_name, h.ends_at, sale.id as sale_id, sale.gross_amount_mills, sale.occurred_at
    from holders h
    join pages p on p.id = h.page_id
    left join fans f on f.id = h.fan_id
    left join lateral (
      select t.id, t.gross_amount_mills, t.occurred_at from transactions t
      where t.platform_account_id = h.page_id and t.fan_id = h.fan_id and t.canonical_type = 'subscription' and t.is_active
        and t.gross_amount_mills > 0 and t.occurred_at > ${now} - interval '40 days'
      order by (t.correlation_id is not distinct from h.platform_history_id) desc, t.occurred_at desc, t.id desc
      limit 1) sale on true
    where not exists (select 1 from custom_order_payments cp where cp.transaction_id = sale.id)
      and not exists (select 1 from custom_findings cf where cf.source = 'sale' and cf.ref = sale.id::text and cf.status <> 'open')
    order by sale.occurred_at desc nulls last, p.label, f.id
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    pageLabel: String(row.label), fan: fanOf(row), tierRef: String(row.tier_ref), tierName: (row.tier_name as string | null) ?? null,
    endsAt: date(row.ends_at), transactionId: num(row.sale_id), grossMills: num(row.gross_amount_mills), at: date(row.occurred_at),
  }));
}
