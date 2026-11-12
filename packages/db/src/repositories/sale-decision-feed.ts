import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The decisions feed (0409, review R2b-B): every change of a decision about whose a sale is, in the order the feed
// placed it. A change gets its place only when a read finds it committed, after every place given before, one read at
// a time — a change committed late is placed later, so a cursor of places never passes it.

type Row = Record<string, unknown>;
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;
const num = (value: unknown) => Number(value);

export type SaleDecisionChange = "made" | "superseded" | "cancelled" | "linked" | "applied" | "changed";

export interface SaleDecisionChangeRow {
  id: number;
  seq: number;
  decisionId: number;
  change: SaleDecisionChange;
  at: Date;
  /** The decision's page (null — a decision carried over that names no page). */
  pageId: number | null;
}

/** Places every committed change not placed yet, after every place given before, in id order; returns how many. */
export async function placeSaleDecisionChanges(db: Database): Promise<number> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sale_decision_changes', 0))`);
    const placed = await tx.execute(sql`
      update sale_decision_changes c set seq = placed.seq
      from (
        select id, (select coalesce(max(seq), 0) from sale_decision_changes) + row_number() over (order by id) as seq
        from sale_decision_changes where seq is null
      ) placed
      where c.id = placed.id`);
    return Number((placed as { rowCount?: number | null }).rowCount ?? 0);
  });
}

const CHANGE_COLUMNS = sql`c.id, c.seq, c.decision_id, c.change, c.at, d.page_id`;

function changeOf(row: Row): SaleDecisionChangeRow {
  return {
    id: num(row.id), seq: num(row.seq), decisionId: num(row.decision_id), change: row.change as SaleDecisionChange,
    at: new Date(String(row.at)), pageId: row.page_id === null || row.page_id === undefined ? null : num(row.page_id),
  };
}

/** The changes placed after a place, in the feed's order, up to `limit`. */
export async function listSaleDecisionChangesAfter(db: Database, input: { afterSeq: number; limit: number }): Promise<SaleDecisionChangeRow[]> {
  const result = await db.execute<Row>(sql`
    select ${CHANGE_COLUMNS} from sale_decision_changes c join sale_owner_decisions d on d.id = c.decision_id
    where c.seq > ${input.afterSeq} order by c.seq limit ${input.limit}`);
  return result.rows.map(changeOf);
}

/** The changes held back for an agent key, in the feed's order. */
export async function listSaleDecisionChangesHeld(db: Database, agentKeyId: number): Promise<SaleDecisionChangeRow[]> {
  const result = await db.execute<Row>(sql`
    select ${CHANGE_COLUMNS} from sale_decision_feed_held h
    join sale_decision_changes c on c.id = h.change_id join sale_owner_decisions d on d.id = c.decision_id
    where h.agent_key_id = ${agentKeyId} order by c.seq`);
  return result.rows.map(changeOf);
}

/** Keeps the changes held back for an agent key; `release` — the ones it may read now. */
export async function holdSaleDecisionChanges(db: Database, input: { agentKeyId: number; hold: readonly number[]; release: readonly number[] }): Promise<void> {
  if (input.hold.length > 0) {
    await db.execute(sql`
      insert into sale_decision_feed_held (agent_key_id, change_id) select ${input.agentKeyId}, unnest(${ids(input.hold)}) on conflict do nothing`);
  }
  if (input.release.length > 0) {
    await db.execute(sql`delete from sale_decision_feed_held where agent_key_id = ${input.agentKeyId} and change_id = any(${ids(input.release)})`);
  }
}
