import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The «Отчёт» board's check after a hand-in and «нет в Hub» (products plan 2026-11-13, package R §5): what the sync
// machinery and ChatSpace's feed already record, read — never a request of their own — and the sightings' matching,
// the 48-hour line, the pot's offers and the «после сдачи» mark. Raw SQL: the tables are the migrations' alone.

type Row = Record<string, unknown>;

const num = (value: unknown) => Number(value);
const date = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;

/**
 * The wallet's window read of a Fansly page the engine runs (`transactions.rescan`: from the checkpoint minus 7 days, a
 * certified round proves it read every row of its window — `proof.walkStartedAt`). The head walk stops at the first
 * known row: it proves no coverage. A page the engine does not run has none.
 */
export interface WalletRescanRow {
  pageId: number;
  state: string;
  dueAt: Date;
  /** When the last certified round's walk began; null — none certified. */
  walkStartedAt: Date | null;
}

export async function listWalletRescans(db: Database, pageIds: readonly number[]): Promise<Map<number, WalletRescanRow>> {
  if (pageIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select page_id, state, due_at, proof ->> 'walkStartedAt' as walk_started_at from sync_work
    where page_id = any(${ids(pageIds)}) and resource = 'transactions.rescan' and not shadow and state in ('open', 'running')`);
  return new Map(result.rows.map((row) => {
    const walk = row.walk_started_at === null || row.walk_started_at === undefined ? null : new Date(String(row.walk_started_at));
    return [num(row.page_id), {
      pageId: num(row.page_id), state: String(row.state), dueAt: date(row.due_at),
      walkStartedAt: walk === null || Number.isNaN(walk.getTime()) ? null : walk,
    }];
  }));
}

/** What Hub holds now of each transaction: its net, its state, and whether ChatSpace's statement confirmed it (OnlyFans). */
export async function listTransactionChecks(db: Database, transactionIds: readonly number[]): Promise<Map<number, { netMills: number; state: string; statementSeen: boolean }>> {
  if (transactionIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select t.id, t.creator_net_amount_mills, t.transaction_state::text as state,
      (t.source <> 'chatspace:ws' or exists (select 1 from onlyfans_feed_money_claims c where c.transaction_row_id = t.id and c.sighting = 'ledger')) as statement_seen
    from transactions t where t.id = any(${ids(transactionIds)})`);
  return new Map(result.rows.map((row) => [num(row.id), { netMills: num(row.creator_net_amount_mills), state: String(row.state), statementSeen: Boolean(row.statement_seen) }]));
}

/** Reports whose shift row was cancelled (dropped) or merged into another, still waiting or counted with lines. */
export async function listHandinsOfGoneShifts(db: Database): Promise<Array<{ handinId: number; shiftId: number; userId: number; state: string; mergedInto: number | null; phase: string }>> {
  const result = await db.execute<Row>(sql`
    select h.id, h.shift_id, h.user_id, s.state, s.merged_into, h.phase
    from shift_handins h join shifts s on s.id = h.shift_id
    where s.state in ('dropped', 'merged')
      and (h.phase in ('checking', 'confirm', 'fixing')
        or exists (select 1 from shift_handin_versions v where v.handin_id = h.id and v.version = h.current_version and jsonb_array_length(v.lines) > 0))
    order by h.id`);
  return result.rows.map((row) => ({
    handinId: num(row.id), shiftId: num(row.shift_id), userId: num(row.user_id), state: String(row.state),
    mergedInto: row.merged_into === null || row.merged_into === undefined ? null : num(row.merged_into), phase: String(row.phase),
  }));
}

/** A merge: the report moves to the shift that remains, when that shift has none of its own. False — it has one. */
export async function moveHandinToShift(db: Database, input: { handinId: number; shiftId: number }): Promise<boolean> {
  const result = await db.execute(sql`
    update shift_handins set shift_id = ${input.shiftId}, updated_at = clock_timestamp()
    where id = ${input.handinId} and not exists (select 1 from shift_handins other where other.shift_id = ${input.shiftId})`);
  return (result.rowCount ?? 0) > 0;
}

/** Every open candidate of a report is superseded (its shift is gone). */
export async function supersedeOpenCandidates(db: Database, input: { handinId: number; at: Date }): Promise<number> {
  const result = await db.execute(sql`
    update shift_handin_candidates set superseded_at = ${input.at.toISOString()}::timestamptz
    where handin_id = ${input.handinId} and superseded_at is null and confirmed_at is null`);
  return result.rowCount ?? 0;
}

/** Candidates whose check is not final: open, made since `since`. */
export async function listCandidatesUnderCheck(db: Database, since: Date): Promise<Array<{ candidateId: number; handinId: number; shiftId: number }>> {
  const result = await db.execute<Row>(sql`
    select c.id, c.handin_id, h.shift_id from shift_handin_candidates c join shift_handins h on h.id = c.handin_id
    where c.superseded_at is null and c.hub_checked_at is null and c.made_at >= ${since.toISOString()}::timestamptz
    order by c.id`);
  return result.rows.map((row) => ({ candidateId: num(row.id), handinId: num(row.handin_id), shiftId: num(row.shift_id) }));
}

/** «Исправить» remembers where it came from; «Отмена» clears it. */
export async function setHandinFixingFrom(db: Database, input: { handinId: number; from: "counted" | "confirm" | null }): Promise<void> {
  await db.execute(sql`update shift_handins set fixing_from = ${input.from}, updated_at = clock_timestamp() where id = ${input.handinId}`);
}

/** «Скопировать пост»: when, and which version. */
export async function setHandinPostCopied(db: Database, input: { handinId: number; version: number; at: Date }): Promise<void> {
  await db.execute(sql`
    update shift_handins set post_copied_at = ${input.at.toISOString()}::timestamptz, post_copied_version = ${input.version}, updated_at = clock_timestamp()
    where id = ${input.handinId}`);
}

/** Reports whose post was copied from a version older than the newest. */
export async function listHandinsPostCopiedBehind(db: Database): Promise<Array<{ handinId: number; shiftId: number; userId: number; copied: number; current: number }>> {
  const result = await db.execute<Row>(sql`
    select id, shift_id, user_id, post_copied_version, current_version from shift_handins
    where post_copied_version is not null and current_version is not null and post_copied_version < current_version`);
  return result.rows.map((row) => ({ handinId: num(row.id), shiftId: num(row.shift_id), userId: num(row.user_id), copied: num(row.post_copied_version), current: num(row.current_version) }));
}

/** The comment of the latest shift before this one on any of its pages (a draft's too): who, what, when. */
export async function findPreviousShiftComment(db: Database, input: { shiftId: number; pageLabels: readonly string[]; before: Date }): Promise<{ userId: number; comment: string; at: Date } | null> {
  if (input.pageLabels.length === 0) return null;
  const result = await db.execute<Row>(sql`
    select h.user_id, h.comment, coalesce(h.draft_updated_at, h.submitted_at, h.updated_at) as at
    from shift_handins h join shifts s on s.id = h.shift_id
    where s.id <> ${input.shiftId} and s.started_at < ${input.before.toISOString()}::timestamptz and btrim(h.comment) <> ''
      and exists (select 1 from jsonb_array_elements(s.pages) as page where page ->> 'pageLabel' = any(${sql.param([...input.pageLabels])}::text[]))
    order by s.started_at desc limit 1`);
  const row = result.rows[0];
  return row === undefined ? null : { userId: num(row.user_id), comment: String(row.comment), at: date(row.at) };
}

/** The notes people wrote on sales in their reports (the newest of each sale): the folded «До 18:00» rows carry them. */
export async function listNotesOfSales(db: Database, transactionIds: readonly number[]): Promise<Map<number, { note: string; userId: number }>> {
  if (transactionIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select distinct on (m.transaction_id) m.transaction_id, m.note, h.user_id
    from shift_handin_marks m join shift_handins h on h.id = m.handin_id
    where m.transaction_id = any(${ids(transactionIds)}) and m.note is not null
    order by m.transaction_id, m.updated_at desc`);
  return new Map(result.rows.map((row) => [num(row.transaction_id), { note: String(row.note), userId: num(row.user_id) }]));
}

/** When ChatSpace's statement of each OnlyFans page was last read back to the newest row Hub holds (0344). */
export async function listStatementPasses(db: Database, pageIds: readonly number[]): Promise<Map<number, Date>> {
  if (pageIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select platform_account_id, ledger_passed_at from onlyfans_feed_poll_leases
    where platform_account_id = any(${ids(pageIds)}) and ledger_passed_at is not null`);
  return new Map(result.rows.map((row) => [num(row.platform_account_id), date(row.ledger_passed_at)]));
}

/** Open sightings whose sale Hub now holds (the same page and platform reference). */
export async function listSightingsHubNowHolds(db: Database, limit: number): Promise<Array<{ sightingId: number; transactionId: number }>> {
  const result = await db.execute<Row>(sql`
    select s.id as sighting_id, t.id as transaction_id
    from sale_sightings s join transactions t on t.platform_account_id = s.page_id and t.transaction_id = s.platform_ref
    where s.matched_transaction_id is null
    order by s.id limit ${limit}`);
  return result.rows.map((row) => ({ sightingId: num(row.sighting_id), transactionId: num(row.transaction_id) }));
}

/** Sightings still not in Hub, seen first before `before` (the 48-hour line), with their page. */
export async function listSightingsUnmatchedSince(db: Database, before: Date): Promise<Array<{ id: number; pageId: number; pageLabel: string; kind: string; netMills: number; occurredAt: Date }>> {
  const result = await db.execute<Row>(sql`
    select s.id, s.page_id, p.label, s.kind, s.net_mills, s.occurred_at
    from sale_sightings s join pages p on p.id = s.page_id
    where s.matched_transaction_id is null and s.first_seen_at < ${before.toISOString()}::timestamptz
    order by s.id`);
  return result.rows.map((row) => ({
    id: num(row.id), pageId: num(row.page_id), pageLabel: String(row.label), kind: String(row.kind), netMills: num(row.net_mills), occurredAt: date(row.occurred_at),
  }));
}

/** «В общак» said of one's own sale (a mark `pot`) that no active decision of the owner settled yet. */
export async function listOpenPotOffers(db: Database): Promise<Array<{ handinId: number; shiftId: number; userId: number; transactionId: number; pageId: number; kind: string; netMills: number; occurredAt: Date }>> {
  const result = await db.execute<Row>(sql`
    select m.handin_id, h.shift_id, h.user_id, m.transaction_id, t.platform_account_id, t.canonical_type::text as kind,
      t.creator_net_amount_mills, t.occurred_at
    from shift_handin_marks m
    join shift_handins h on h.id = m.handin_id
    join transactions t on t.id = m.transaction_id
    where m.statement = 'pot'
      and not exists (select 1 from sale_owner_decisions d where d.transaction_id = m.transaction_id and d.state = 'active')
    order by m.transaction_id`);
  return result.rows.map((row) => ({
    handinId: num(row.handin_id), shiftId: num(row.shift_id), userId: num(row.user_id), transactionId: num(row.transaction_id),
    pageId: num(row.platform_account_id), kind: String(row.kind), netMills: num(row.creator_net_amount_mills), occurredAt: date(row.occurred_at),
  }));
}

/**
 * «После сдачи», cheaply: for each counted report, how many sales the rule gives the person on that shift (`sale_homes`
 * shares naming the shift) that its newest version does not hold (no line, or a $0 line with nothing on it).
 */
export async function countLateSales(db: Database, input: { since: Date }): Promise<Array<{ handinId: number; lateSales: number; current: number }>> {
  const result = await db.execute<Row>(sql`
    select h.id as handin_id, h.late_sales as current, count(s.transaction_id)::int as n
    from shift_handins h
    join shifts sh on sh.id = h.shift_id
    join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
    left join sale_homes s on s.occurred_at >= sh.started_at - interval '1 day'
      and s.occurred_at < sh.ended_at + interval '7 days'
      and exists (select 1 from jsonb_array_elements(s.shares) as share
        where (share ->> 'shiftId') = h.shift_id::text and coalesce((share ->> 'mills')::bigint, 0) > 0)
      -- A line holds its sale when it counts it or says something of it (runtime shift-report-phases.ts, holdsSale).
      and not exists (select 1 from jsonb_array_elements(v.lines) as line where (line ->> 'transactionId') = s.transaction_id::text
        and (coalesce((line ->> 'amountMills')::bigint, 0) > 0 or (line ->> 'statement') is not null
          or coalesce((line ->> 'disputed')::boolean, false) or (line ->> 'settled') is not null))
    where h.state = 'submitted' and sh.started_at >= ${input.since.toISOString()}::timestamptz
    group by h.id, h.late_sales`);
  return result.rows.map((row) => ({ handinId: num(row.handin_id), lateSales: num(row.n), current: num(row.current) }));
}

export async function setHandinLateSales(db: Database, input: { handinId: number; lateSales: number }): Promise<void> {
  await db.execute(sql`update shift_handins set late_sales = ${input.lateSales}, updated_at = clock_timestamp() where id = ${input.handinId}`);
}

/** The report's «после сдачи» mark (0413). */
export async function findHandinLateSales(db: Database, handinId: number): Promise<number> {
  const result = await db.execute<Row>(sql`select late_sales from shift_handins where id = ${handinId}`);
  return result.rows[0] === undefined ? 0 : num(result.rows[0].late_sales);
}

/** The newest version of every report holding each sale, with what it says of the line (who took a given sale back). */
export async function listCurrentWordsOfSales(db: Database, transactionIds: readonly number[]): Promise<Array<{ userId: number; transactionId: number; statement: string | null }>> {
  if (transactionIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select h.user_id, (line ->> 'transactionId')::bigint as transaction_id, line ->> 'statement' as statement
    from shift_handins h
    join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
    cross join lateral jsonb_array_elements(v.lines) as line
    where (line ->> 'transactionId') ~ '^[0-9]+$' and (line ->> 'transactionId')::bigint = any(${ids(transactionIds)})`);
  return result.rows.map((row) => ({ userId: num(row.user_id), transactionId: num(row.transaction_id), statement: row.statement === null ? null : String(row.statement) }));
}
