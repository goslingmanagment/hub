import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { isOwnerLogin } from "./chatter-activity.ts";

// Whose each sale is by the one rule (0380 `sale_homes`, apps/runtime
// services/sale-rule.ts and sale-homes.ts), the screens' switch to it
// (0381 `sale_rule_switch`) and the refresh-due queue (0441 `sale_home_refresh_due`).

/** First Moscow day covered by the sale rule (matches SALE_RULE.since = 2026-11-02T00:00:00+03:00). */
export const SALE_RULE_SINCE_DAY = "2026-11-02";
const SALE_RULE_SINCE_ISO = "2026-11-02T00:00:00+03:00";

const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;

export type SaleHomeShareDaySource = "report" | "shift" | "visit" | "holding_shift" | "sale_day" | "unresolved";

export interface SaleHomeShareRow {
  /** The person's code in the people registry; null — unlinked login. Optional when reading rows written before 0441. */
  personCode?: string | null;
  userId: number;
  /** The work credited (`<userId>:<startedAt>`); null — none held the sale (an owner's claim). */
  workRef: string | null;
  /** That work's row in `shifts`; null — a look-in, unresolved, or not written yet. */
  shiftId: number | null;
  /** The share's Moscow report date (YYYY-MM-DD); null when daySource is `unresolved`. Optional on legacy rows. */
  reportDate?: string | null;
  /** How `reportDate` was resolved. Optional on legacy rows written before 0441. */
  daySource?: SaleHomeShareDaySource;
  percent: number;
  mills: number;
}

export interface SaleHomeRow {
  transactionId: number;
  pageId: number;
  occurredAt: Date;
  netMills: number;
  home: string;
  reason: string;
  pot: string | null;
  waitsUntil: Date | null;
  shares: SaleHomeShareRow[];
  ruleVersion: string;
}

const UPSERT_BATCH = 500;

/**
 * Writes the homes, each row only when what it says changed (home, reason, shares, the sale's facts or the rule's
 * version): an unchanged home keeps its computed_at. Returns how many rows were written.
 */
export async function upsertSaleHomes(db: Database, rows: readonly SaleHomeRow[], computedAt: Date): Promise<number> {
  let written = 0;
  for (let at = 0; at < rows.length; at += UPSERT_BATCH) {
    const batch = rows.slice(at, at + UPSERT_BATCH).map((row) => ({
      transaction_id: row.transactionId,
      page_id: row.pageId,
      occurred_at: row.occurredAt.toISOString(),
      net_mills: row.netMills,
      home: row.home,
      reason: row.reason,
      pot: row.pot,
      waits_until: row.waitsUntil?.toISOString() ?? null,
      shares: row.shares,
      rule_version: row.ruleVersion,
    }));
    const result = await db.execute(sql`
      insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, pot, waits_until, shares, rule_version, computed_at)
      select r.transaction_id, r.page_id, r.occurred_at, r.net_mills, r.home, r.reason, r.pot, r.waits_until, r.shares, r.rule_version,
        ${computedAt.toISOString()}::timestamptz
      from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as r(
        transaction_id bigint, page_id bigint, occurred_at timestamptz, net_mills bigint, home text, reason text, pot text,
        waits_until timestamptz, shares jsonb, rule_version text)
      on conflict (transaction_id) do update set
        page_id = excluded.page_id, occurred_at = excluded.occurred_at, net_mills = excluded.net_mills, home = excluded.home,
        reason = excluded.reason, pot = excluded.pot, waits_until = excluded.waits_until, shares = excluded.shares,
        rule_version = excluded.rule_version, computed_at = excluded.computed_at
      where (sale_homes.page_id, sale_homes.occurred_at, sale_homes.net_mills, sale_homes.home, sale_homes.reason, sale_homes.pot,
             sale_homes.waits_until, sale_homes.shares, sale_homes.rule_version)
        is distinct from (excluded.page_id, excluded.occurred_at, excluded.net_mills, excluded.home, excluded.reason, excluded.pot,
             excluded.waits_until, excluded.shares, excluded.rule_version)`);
    written += result.rowCount ?? 0;
  }
  return written;
}

/**
 * The one login a sale's home is wholly: a person's work (`shift`, `visit`) with exactly one share, of 100%. Null — the
 * sale has no home yet, or it is several people's, the pot's, the owner's to decide, nobody's. A custom order's taker
 * («принял») is named by it when the order names none (services/custom-orders).
 */
export async function findSaleSingleHomeUser(db: Database, transactionId: number): Promise<number | null> {
  const result = await db.execute<{ user_id: string | number | null }>(sql`
    select (h.shares -> 0 ->> 'userId')::bigint as user_id from sale_homes h
    where h.transaction_id = ${transactionId} and h.home in ('shift', 'visit') and jsonb_array_length(h.shares) = 1
      and (h.shares -> 0 ->> 'percent')::numeric = 100 and h.shares -> 0 ->> 'userId' ~ '^[0-9]{1,18}$'`);
  const id = result.rows[0]?.user_id;
  return id === null || id === undefined ? null : Number(id);
}

/** The homes of the sales in [from, to), oldest first. */
export async function listSaleHomes(db: Database, input: { from: Date; to: Date }): Promise<Array<SaleHomeRow & { computedAt: Date }>> {
  const result = await db.execute<{
    transaction_id: string | number; page_id: string | number; occurred_at: Date | string; net_mills: string | number; home: string;
    reason: string; pot: string | null; waits_until: Date | string | null; shares: SaleHomeShareRow[]; rule_version: string; computed_at: Date | string;
  }>(sql`
    select transaction_id, page_id, occurred_at, net_mills, home, reason, pot, waits_until, shares, rule_version, computed_at
    from sale_homes
    where occurred_at >= ${input.from.toISOString()}::timestamptz and occurred_at < ${input.to.toISOString()}::timestamptz
    order by occurred_at, transaction_id`);
  return result.rows.map((row) => ({
    transactionId: Number(row.transaction_id),
    pageId: Number(row.page_id),
    occurredAt: new Date(row.occurred_at),
    netMills: Number(row.net_mills),
    home: row.home,
    reason: row.reason,
    pot: row.pot,
    waitsUntil: row.waits_until === null ? null : new Date(row.waits_until),
    shares: row.shares,
    ruleVersion: row.rule_version,
    computedAt: new Date(row.computed_at),
  }));
}

/**
 * What the homes of the sales in [from, to) give each of these shift rows (`shares[].shiftId`) by these logins: the
 * sales and the shares' mills. A shift with none is absent.
 */
export async function sumSaleHomesOfShifts(
  db: Database,
  input: { shiftIds: readonly number[]; userIds: readonly number[]; from: Date; to: Date },
): Promise<Map<number, { count: number; mills: number }>> {
  if (input.shiftIds.length === 0 || input.userIds.length === 0) return new Map();
  const result = await db.execute<{ shift_id: string | number; count: string | number; mills: string | number }>(sql`
    select (s.share->>'shiftId')::bigint as shift_id, count(distinct h.transaction_id) as count, sum((s.share->>'mills')::bigint) as mills
    from sale_homes h cross join lateral jsonb_array_elements(h.shares) as s(share)
    where h.occurred_at >= ${input.from.toISOString()}::timestamptz and h.occurred_at < ${input.to.toISOString()}::timestamptz
      and (s.share->>'shiftId')::bigint = any(${sql.param(input.shiftIds.map(String))}::bigint[])
      and (s.share->>'userId')::bigint = any(${sql.param(input.userIds.map(String))}::bigint[])
    group by 1`);
  return new Map(result.rows.map((row) => [Number(row.shift_id), { count: Number(row.count), mills: Number(row.mills) }]));
}

export interface SaleRuleSwitch {
  /** The first Moscow day (YYYY-MM-DD) the screens count by the rule; null — off. */
  screensFrom: string | null;
  setBy: string | null;
  setAt: Date | null;
}

/** The screens' switch to the rule; off when the row is missing too. */
export async function readSaleRuleSwitch(db: Database): Promise<SaleRuleSwitch> {
  const result = await db.execute<{ screens_from: string | null; set_by: string | null; set_at: Date | string | null }>(sql`
    select to_char(screens_from, 'YYYY-MM-DD') as screens_from, set_by, set_at from sale_rule_switch where id`);
  const row = result.rows[0];
  return {
    screensFrom: row?.screens_from ?? null,
    setBy: row?.set_by ?? null,
    setAt: row?.set_at === null || row?.set_at === undefined ? null : new Date(row.set_at),
  };
}

/** Sets the switch: a Moscow day, or null to turn it off. */
export async function setSaleRuleSwitch(db: Database, input: { screensFrom: string | null; setBy: string; at: Date }): Promise<void> {
  await db.execute(sql`
    insert into sale_rule_switch (id, screens_from, set_by, set_at)
    values (true, ${input.screensFrom}::date, ${input.setBy}, ${input.at.toISOString()}::timestamptz)
    on conflict (id) do update set screens_from = excluded.screens_from, set_by = excluded.set_by, set_at = excluded.set_at`);
}

/** What says a user left the team, for the PPV of a sender no longer in it: their login's end, their person's state. */
export interface UserLeaveFacts {
  userId: number;
  disabledAt: Date | null;
  deletedAt: Date | null;
  /**
   * The login's person in the people registry (0384) is `left`: the day they left (`left_on`, YYYY-MM-DD; null —
   * unknown) and when the registry came to say so (the audit of the edit or import that made them `left` since they
   * last were anything else; without one, the record's last change). Null — no person, or one not `left`.
   */
  personLeft: { leftOn: string | null; recordedAt: Date } | null;
}

const PERSON_STATE_EVENTS = sql`('person.created', 'person.updated')`;

/** The leave facts of every given user who has one (absent — still in the team). */
export async function listUserLeaveFacts(db: Database, userIds: readonly number[]): Promise<UserLeaveFacts[]> {
  if (userIds.length === 0) return [];
  const result = await db.execute<{
    id: string | number; disabled_at: Date | string | null; deleted_at: Date | string | null; person_left: boolean | null;
    left_on: string | null; left_recorded_at: Date | string | null;
  }>(sql`
    select u.id, u.disabled_at, u.deleted_at, (p.state = 'left') as person_left, to_char(p.left_on, 'YYYY-MM-DD') as left_on,
      case when p.state = 'left' then coalesce((
        select min(a.created_at) from audit_events a
        where a.event_type in ${PERSON_STATE_EVENTS} and a.metadata ->> 'code' = p.code and a.metadata ->> 'state' = 'left'
          and a.created_at > coalesce((
            select max(b.created_at) from audit_events b
            where b.event_type in ${PERSON_STATE_EVENTS} and b.metadata ->> 'code' = p.code and b.metadata ->> 'state' <> 'left'
          ), '-infinity'::timestamptz)
      ), p.updated_at) end as left_recorded_at
    from users u
    left join person_logins l on l.user_id = u.id
    left join people p on p.id = l.person_id
    where u.id = any(${sql.param(userIds.map(String))}::bigint[])
      and (u.disabled_at is not null or u.deleted_at is not null or p.state = 'left')
    order by u.id`);
  const at = (value: Date | string | null) => (value === null ? null : new Date(value));
  return result.rows.map((row) => ({
    userId: Number(row.id),
    disabledAt: at(row.disabled_at),
    deletedAt: at(row.deleted_at),
    personLeft: row.person_left === true ? { leftOn: row.left_on, recordedAt: new Date(row.left_recorded_at!) } : null,
  }));
}

/**
 * Of these sales, the ones whose fan one of the owner's logins (`isOwnerLogin`) wrote to on the page within `hours`
 * before the sale: the sales whose last writer the owner's messages no longer are (2026-11-12). For the comparison only.
 */
export async function listSalesOwnerWroteTo(
  db: Database,
  input: { hours: number; sales: ReadonlyArray<{ transactionId: number; pageId: number; fanRef: string; at: Date }> },
): Promise<Set<number>> {
  if (input.sales.length === 0) return new Set();
  const rows = input.sales.map((sale) => ({ id: sale.transactionId, page_id: sale.pageId, fan_ref: sale.fanRef, at: sale.at.toISOString() }));
  const result = await db.execute<{ id: string | number }>(sql`
    select s.id from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as s(id bigint, page_id bigint, fan_ref text, at timestamptz)
    where exists (
      select 1 from client_send_attributions a
      where a.page_id = s.page_id and a.fan_ref = s.fan_ref
        and a.observed_at <= s.at and a.observed_at > s.at - make_interval(hours => ${input.hours})
        and ${isOwnerLogin(sql`a.user_id`)}
    )`);
  return new Set(result.rows.map((row) => Number(row.id)));
}

/** The platform's own reference of each sale (`transactions.transaction_id`), by Hub's id: how the ledger's layouts name a sale. */
export async function listSalePlatformRefs(db: Database, transactionIds: readonly number[]): Promise<Map<number, string>> {
  if (transactionIds.length === 0) return new Map();
  const result = await db.execute<{ id: string | number; transaction_id: string }>(sql`
    select id, transaction_id from transactions where id = any(${ids(transactionIds)})`);
  return new Map(result.rows.map((row) => [Number(row.id), row.transaction_id]));
}

/**
 * Removes `sale_homes` rows in [from, to) whose sale is no longer active on the read pages OR whose source transaction
 * no longer exists (including erased or vanished transactions on inactive pages), so the `sale_homes` DELETE trigger
 * emits `retract` on the feed while historical homes of soft-deleted pages whose transactions still exist survive.
 * Derived projection hygiene, never deletes captured facts.
 */
export async function deleteVanishedSaleHomesInWindow(
  db: Database,
  input: { from: Date; to: Date; pageIds: readonly number[]; keepTransactionIds: readonly number[] },
): Promise<number> {
  const uniquePages = [...new Set(input.pageIds.filter(Number.isSafeInteger))];
  const keep = input.keepTransactionIds.length === 0
    ? sql`true`
    : sql`not (sale_homes.transaction_id = any(${ids(input.keepTransactionIds)}))`;
  const activeVanished = uniquePages.length === 0
    ? sql`false`
    : sql`(sale_homes.page_id = any(${ids(uniquePages)}) and ${keep})`;
  const result = await db.execute(sql`
    delete from sale_homes
    where sale_homes.occurred_at >= ${input.from.toISOString()}::timestamptz
      and sale_homes.occurred_at < ${input.to.toISOString()}::timestamptz
      and (
        ${activeVanished}
        or not exists (select 1 from transactions t where t.id = sale_homes.transaction_id)
      )`);
  return result.rowCount ?? 0;
}

// ── Refresh-due queue (0441 `sale_home_refresh_due`) ─────────────────────────

export interface SaleHomeRefreshDueRow {
  day: string;
  generation: number;
  queuedAt: Date;
}

/** Enqueues Moscow days (YYYY-MM-DD) >= SALE_RULE_SINCE_DAY, bumping `generation` on conflict. Run in the writer's tx. */
export async function enqueueSaleHomeRefreshDays(db: Database, days: readonly string[]): Promise<void> {
  const unique = [...new Set(days.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= SALE_RULE_SINCE_DAY))];
  if (unique.length === 0) return;
  await db.execute(sql`
    insert into sale_home_refresh_due (day, generation, queued_at)
    select d, 1, clock_timestamp()
    from unnest(${sql.param(unique)}::date[]) as d
    on conflict (day) do update set
      generation = sale_home_refresh_due.generation + 1,
      queued_at = clock_timestamp()`);
}

/** Enqueues the Moscow day(s) of the named sales (from `transactions` and `sale_homes`). Run in the writer's tx. */
export async function enqueueSaleHomeRefreshForSales(db: Database, transactionIds: readonly number[]): Promise<void> {
  const unique = [...new Set(transactionIds.filter(Number.isSafeInteger))];
  if (unique.length === 0) return;
  await db.execute(sql`
    insert into sale_home_refresh_due (day, generation, queued_at)
    select distinct day, 1, clock_timestamp()
    from (
      select (occurred_at at time zone 'Europe/Moscow')::date as day
      from transactions
      where id = any(${ids(unique)})
      union
      select (occurred_at at time zone 'Europe/Moscow')::date as day
      from sale_homes
      where transaction_id = any(${ids(unique)})
    ) d
    where day >= ${SALE_RULE_SINCE_DAY}::date
    on conflict (day) do update set
      generation = sale_home_refresh_due.generation + 1,
      queued_at = clock_timestamp()`);
}

/**
 * Enqueues the Moscow days affected by a new hand-in version: the days of every sale in its new lines, any sale removed
 * since the previous version, any existing `sale_homes` referencing the shift, and the report date itself. Run in the
 * hand-in writer's transaction.
 */
export async function enqueueSaleHomeRefreshForHandin(
  db: Database,
  input: { shiftId: number; reportDate: string; transactionIds: readonly number[]; handinId?: number; previousVersion?: number | null },
): Promise<void> {
  const unique = [...new Set(input.transactionIds.filter(Number.isSafeInteger))];
  const txPart = unique.length === 0
    ? sql``
    : sql`
      union
      select (occurred_at at time zone 'Europe/Moscow')::date as day
      from transactions
      where id = any(${ids(unique)})`;
  const prevPart = input.handinId !== undefined && input.previousVersion !== undefined && input.previousVersion !== null && input.previousVersion > 0
    ? sql`
      union
      select (t.occurred_at at time zone 'Europe/Moscow')::date as day
      from shift_handin_versions v
      cross join lateral jsonb_array_elements(v.lines) as l(line)
      join transactions t on (l.line ->> 'transactionId') ~ '^[0-9]{1,18}$' and t.id = (l.line ->> 'transactionId')::bigint
      where v.handin_id = ${input.handinId} and v.version = ${input.previousVersion}`
    : sql``;
  await db.execute(sql`
    insert into sale_home_refresh_due (day, generation, queued_at)
    select distinct day, 1, clock_timestamp()
    from (
      select ${input.reportDate}::date as day
      union
      select (h.occurred_at at time zone 'Europe/Moscow')::date as day
      from sale_homes h
      where exists (
        select 1 from jsonb_array_elements(h.shares) as s
        where (s ->> 'shiftId') ~ '^[0-9]{1,18}$' and (s ->> 'shiftId')::bigint = ${input.shiftId}
      )
      ${txPart}
      ${prevPart}
    ) d
    where day >= ${SALE_RULE_SINCE_DAY}::date
    on conflict (day) do update set
      generation = sale_home_refresh_due.generation + 1,
      queued_at = clock_timestamp()`);
}

/**
 * Enqueues Moscow days since SALE_RULE_SINCE_DAY where any of `userIds` has a share in `sale_homes`, a shift, activity
 * or a send attribution (login link/unlink, leave-state edit). Run in the writer's transaction.
 */
export async function enqueueSaleHomeRefreshForUsers(db: Database, userIds: readonly number[]): Promise<void> {
  const unique = [...new Set(userIds.filter(Number.isSafeInteger))];
  if (unique.length === 0) return;
  await db.execute(sql`
    insert into sale_home_refresh_due (day, generation, queued_at)
    select distinct day, 1, clock_timestamp()
    from (
      select (h.occurred_at at time zone 'Europe/Moscow')::date as day
      from sale_homes h
      where h.occurred_at >= ${SALE_RULE_SINCE_ISO}::timestamptz
        and exists (
          select 1 from jsonb_array_elements(h.shares) as s
          where (s ->> 'userId') ~ '^[0-9]{1,18}$' and (s ->> 'userId')::bigint = any(${ids(unique)})
        )
      union
      select (s.started_at at time zone 'Europe/Moscow')::date as day
      from shifts s
      where s.user_id = any(${ids(unique)}) and s.ended_at >= ${SALE_RULE_SINCE_ISO}::timestamptz
      union
      select (s.ended_at at time zone 'Europe/Moscow')::date as day
      from shifts s
      where s.user_id = any(${ids(unique)}) and s.ended_at >= ${SALE_RULE_SINCE_ISO}::timestamptz
      union
      select (a.minute at time zone 'Europe/Moscow')::date as day
      from chatter_activity_minutes a
      where a.user_id = any(${ids(unique)}) and a.minute >= ${SALE_RULE_SINCE_ISO}::timestamptz
      union
      select (c.observed_at at time zone 'Europe/Moscow')::date as day
      from client_send_attributions c
      where c.user_id = any(${ids(unique)}) and c.observed_at >= ${SALE_RULE_SINCE_ISO}::timestamptz
    ) d
    where day >= ${SALE_RULE_SINCE_DAY}::date and day <= (clock_timestamp() at time zone 'Europe/Moscow')::date
    on conflict (day) do update set
      generation = sale_home_refresh_due.generation + 1,
      queued_at = clock_timestamp()`);
}

/**
 * Enqueues Moscow days with sales on `pageIds` (null — all pages) on or after `fromDay` (null — SALE_RULE_SINCE_DAY),
 * up to today Moscow (schedule slot or working-pages edit). Run in the writer's transaction.
 */
export async function enqueueSaleHomeRefreshForPages(
  db: Database,
  input: { pageIds: readonly number[] | null; fromDay: string | null },
): Promise<void> {
  if (input.pageIds !== null && input.pageIds.length === 0) return;
  const fromDay = input.fromDay !== null && input.fromDay > SALE_RULE_SINCE_DAY ? input.fromDay : SALE_RULE_SINCE_DAY;
  const fromIso = `${fromDay}T00:00:00+03:00`;
  const txPage = input.pageIds === null ? sql`` : sql`and platform_account_id = any(${ids(input.pageIds)})`;
  const homePage = input.pageIds === null ? sql`` : sql`and page_id = any(${ids(input.pageIds)})`;
  await db.execute(sql`
    insert into sale_home_refresh_due (day, generation, queued_at)
    select distinct day, 1, clock_timestamp()
    from (
      select (occurred_at at time zone 'Europe/Moscow')::date as day
      from transactions
      where occurred_at >= ${fromIso}::timestamptz and occurred_at <= clock_timestamp() ${txPage}
      union
      select (occurred_at at time zone 'Europe/Moscow')::date as day
      from sale_homes
      where occurred_at >= ${fromIso}::timestamptz and occurred_at <= clock_timestamp() ${homePage}
    ) d
    where day >= ${fromDay}::date and day <= (clock_timestamp() at time zone 'Europe/Moscow')::date
    on conflict (day) do update set
      generation = sale_home_refresh_due.generation + 1,
      queued_at = clock_timestamp()`);
}

/** All days currently queued for refresh, oldest first. */
export async function listSaleHomeRefreshDue(db: Database): Promise<SaleHomeRefreshDueRow[]> {
  const result = await db.execute<{ day: string; generation: string | number; queued_at: Date | string }>(sql`
    select to_char(day, 'YYYY-MM-DD') as day, generation, queued_at
    from sale_home_refresh_due
    order by day`);
  return result.rows.map((row) => ({ day: row.day, generation: Number(row.generation), queuedAt: new Date(row.queued_at) }));
}

/** Current queued generation for a Moscow day; null — not queued. */
export async function readSaleHomeRefreshGeneration(db: Database, day: string): Promise<number | null> {
  const result = await db.execute<{ generation: string | number }>(sql`
    select generation from sale_home_refresh_due where day = ${day}::date`);
  const row = result.rows[0];
  return row === undefined ? null : Number(row.generation);
}

/** Acquires the per-day transaction advisory lock before reading inputs for a Moscow day's `sale_homes` refresh. */
export async function lockSaleHomeRefreshDay(db: Database, day: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sale_home_refresh_day:${day}`}, 0))`);
}

/**
 * Deletes a queued day ONLY if its `generation` still equals what this pass computed (and without blocking on another
 * transaction currently bumping that day's row). Queue hygiene, never deletes captured facts.
 */
export async function completeSaleHomeRefreshDue(db: Database, input: { day: string; generation: number }): Promise<boolean> {
  const result = await db.execute(sql`
    delete from sale_home_refresh_due
    where ctid in (
      select ctid from sale_home_refresh_due
      where day = ${input.day}::date and generation = ${input.generation}
      for update skip locked
    )`);
  return (result.rowCount ?? 0) > 0;
}
