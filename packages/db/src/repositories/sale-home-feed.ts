import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { SaleHomeRow, SaleHomeShareRow } from "./sale-homes.ts";

// The sale homes feed (0441): every change of a `sale_homes` row (upsert or retract), in the order the feed placed it.
// Mirrors sale-decision-feed.ts (0409): a change gets its `seq` only once committed, under an advisory lock, so late
// commits land after the cursor. Test-realm rows are filtered in SQL by `is_test` BEFORE `held`, limit, or `next`, so
// test rows never leak into live reads, held lists, or live cursors.

type Row = Record<string, unknown>;
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;
const num = (value: unknown) => Number(value);

export type SaleHomeChangeOp = "upsert" | "retract";

export interface SaleHomeChangeRow {
  id: number;
  seq: number;
  transactionId: number;
  pageId: number;
  isTest: boolean;
  op: SaleHomeChangeOp;
  at: Date;
}

export interface SaleHomeHydratedRow extends SaleHomeRow {
  pageLabel: string | null;
  canonicalType: string | null;
  computedAt: Date;
}

const CHANGE_COLUMNS = sql`c.id, c.seq, c.transaction_id, c.page_id, c.is_test, c.op, c.at`;

function changeOf(row: Row): SaleHomeChangeRow {
  return {
    id: num(row.id),
    seq: num(row.seq),
    transactionId: num(row.transaction_id),
    pageId: num(row.page_id),
    isTest: Boolean(row.is_test),
    op: row.op as SaleHomeChangeOp,
    at: new Date(String(row.at)),
  };
}

/** Places every committed `sale_home_changes` row not placed yet, after every place given before, in id order. */
export async function placeSaleHomeChanges(db: Database): Promise<number> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sale_home_changes', 0))`);
    const placed = await tx.execute(sql`
      update sale_home_changes c set seq = placed.seq
      from (
        select id, (select coalesce(max(seq), 0) from sale_home_changes) + row_number() over (order by id) as seq
        from sale_home_changes where seq is null
      ) placed
      where c.id = placed.id`);
    return Number((placed as { rowCount?: number | null }).rowCount ?? 0);
  });
}

/**
 * Releases held changes whose page is now among `pageIds` (and matches `isTest`): moves them to a NEW place at the end
 * of the feed under the placement advisory lock and removes them from `sale_home_feed_held`.
 */
export async function releaseSaleHomeChangesHeld(
  db: Database,
  input: { agentKeyId: number; pageIds: readonly number[]; isTest: boolean },
): Promise<number> {
  if (input.pageIds.length === 0) return 0;
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sale_home_changes', 0))`);
    const moved = await tx.execute<Row>(sql`
      update sale_home_changes c set seq = ready.seq
      from (
        select old.id, (select coalesce(max(seq), 0) from sale_home_changes) + row_number() over (order by old.seq, old.id) as seq
        from sale_home_feed_held k
        join sale_home_changes old on old.id = k.change_id
        where k.agent_key_id = ${input.agentKeyId}
          and old.is_test = ${input.isTest}
          and old.page_id = any(${ids(input.pageIds)})
      ) ready
      where c.id = ready.id
      returning c.id`);
    const changeIds = moved.rows.map((row) => num(row.id));
    if (changeIds.length > 0) {
      await tx.execute(sql`
        delete from sale_home_feed_held
        where agent_key_id = ${input.agentKeyId} and change_id = any(${ids(changeIds)})`);
    }
    return changeIds.length;
  });
}

/**
 * Placed changes in the caller's realm (`is_test = isTest`) after `afterSeq`, in feed order, up to `limit` places.
 * Filtering `is_test` in SQL keeps test rows out of live `homes`, `held`, `limit`, and `next`.
 */
export async function listSaleHomeChangesAfter(
  db: Database,
  input: { afterSeq: number; limit: number; isTest: boolean },
): Promise<{ changes: SaleHomeChangeRow[]; more: boolean }> {
  const result = await db.execute<Row>(sql`
    select ${CHANGE_COLUMNS}
    from sale_home_changes c
    where c.seq > ${input.afterSeq} and c.is_test = ${input.isTest}
    order by c.seq
    limit ${input.limit + 1}`);
  return {
    changes: result.rows.slice(0, input.limit).map(changeOf),
    more: result.rows.length > input.limit,
  };
}

/** Keeps changes held back for an agent key until its grant covers their pages. */
export async function holdSaleHomeChanges(db: Database, input: { agentKeyId: number; changeIds: readonly number[] }): Promise<void> {
  if (input.changeIds.length === 0) return;
  await db.execute(sql`
    insert into sale_home_feed_held (agent_key_id, change_id)
    select ${input.agentKeyId}, unnest(${ids(input.changeIds)})
    on conflict do nothing`);
}

/** The changes currently held back for an agent key in its realm, in feed order. */
export async function listSaleHomeChangesHeld(
  db: Database,
  input: { agentKeyId: number; isTest: boolean },
): Promise<SaleHomeChangeRow[]> {
  const result = await db.execute<Row>(sql`
    select ${CHANGE_COLUMNS}
    from sale_home_feed_held h
    join sale_home_changes c on c.id = h.change_id
    where h.agent_key_id = ${input.agentKeyId} and c.is_test = ${input.isTest}
    order by c.seq`);
  return result.rows.map(changeOf);
}

/** Hydrates current `sale_homes` rows by transaction id, joined with page label and transaction canonical type. */
export async function listSaleHomesByTransactionIds(
  db: Database,
  transactionIds: readonly number[],
): Promise<Map<number, SaleHomeHydratedRow>> {
  const unique = [...new Set(transactionIds.filter(Number.isSafeInteger))];
  if (unique.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select h.transaction_id, h.page_id, p.label as page_label, t.canonical_type::text as canonical_type,
      h.occurred_at, h.net_mills, h.home, h.reason, h.pot, h.waits_until, h.shares, h.rule_version, h.computed_at
    from sale_homes h
    left join pages p on p.id = h.page_id
    left join transactions t on t.id = h.transaction_id
    where h.transaction_id = any(${ids(unique)})`);
  const out = new Map<number, SaleHomeHydratedRow>();
  for (const row of result.rows) {
    const shares = typeof row.shares === "string" ? (JSON.parse(row.shares) as SaleHomeShareRow[]) : (row.shares as SaleHomeShareRow[]);
    const transactionId = num(row.transaction_id);
    out.set(transactionId, {
      transactionId,
      pageId: num(row.page_id),
      pageLabel: row.page_label === null || row.page_label === undefined ? null : String(row.page_label),
      canonicalType: row.canonical_type === null || row.canonical_type === undefined ? null : String(row.canonical_type),
      occurredAt: new Date(String(row.occurred_at)),
      netMills: num(row.net_mills),
      home: String(row.home),
      reason: String(row.reason),
      pot: row.pot === null || row.pot === undefined ? null : String(row.pot),
      waitsUntil: row.waits_until === null || row.waits_until === undefined ? null : new Date(String(row.waits_until)),
      shares: Array.isArray(shares) ? shares : [],
      ruleVersion: String(row.rule_version),
      computedAt: new Date(String(row.computed_at)),
    });
  }
  return out;
}

/** Looks up current report date (handed-in version's if submitted, else `shifts.report_date`) by shift id for legacy share fallback. */
export async function listShiftReportDatesByIds(
  db: Database,
  shiftIds: readonly number[],
): Promise<Map<number, { reportDate: string; handedIn: boolean }>> {
  const unique = [...new Set(shiftIds.filter(Number.isSafeInteger))];
  if (unique.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select s.id,
      to_char(coalesce(v.report_date, h.report_date, s.report_date), 'YYYY-MM-DD') as report_date,
      (h.state = 'submitted') as handed_in
    from shifts s
    left join shift_handins h on h.shift_id = s.id and h.state = 'submitted'
    left join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
    where s.id = any(${ids(unique)})`);
  const out = new Map<number, { reportDate: string; handedIn: boolean }>();
  for (const row of result.rows) {
    if (row.report_date === null || row.report_date === undefined) continue;
    out.set(num(row.id), { reportDate: String(row.report_date), handedIn: row.handed_in === true });
  }
  return out;
}
