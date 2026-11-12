import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Цепочка продажи (package T): the two reads the chain needs beyond the shift report's and the claims' — a sale by its
// page and the platform's transaction id, and whether one of a person's shifts held the sale's page at its moment.
// Read only.

type Row = Record<string, unknown>;
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;

/** Hub's id of a sale named by its page and the platform's transaction id; null — none. */
export async function findSaleIdByPlatformRef(db: Database, input: { pageLabel: string; transactionRef: string }): Promise<number | null> {
  const result = await db.execute<Row>(sql`
    select t.id from transactions t join pages p on p.id = t.platform_account_id
    where p.label = ${input.pageLabel} and t.transaction_id = ${input.transactionRef}
    order by t.id limit 1`);
  const row = result.rows[0];
  return row === undefined ? null : Number(row.id);
}

/**
 * Whether a living shift row of the logins held the page at that instant (the reach of the person's shift screen:
 * «Ваши продажи» and «Рядом» are the sales of their shifts on the pages they held).
 */
export async function shiftOfUsersHoldsSale(db: Database, input: { userIds: readonly number[]; pageLabel: string; at: Date }): Promise<boolean> {
  if (input.userIds.length === 0) return false;
  const result = await db.execute<Row>(sql`
    select 1 from shifts s
    where s.user_id = any(${ids(input.userIds)}) and s.state in ('going', 'closed')
      and s.started_at <= ${input.at.toISOString()}::timestamptz and s.ended_at >= ${input.at.toISOString()}::timestamptz
      and exists (select 1 from jsonb_array_elements(s.pages) as page where page ->> 'pageLabel' = ${input.pageLabel})
    limit 1`);
  return result.rows.length > 0;
}
