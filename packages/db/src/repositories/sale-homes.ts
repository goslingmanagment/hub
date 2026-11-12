import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Whose each sale is by the one rule (0380 `sale_homes`, apps/runtime
// services/sale-rule.ts and sale-homes.ts) and the screens' switch to it
// (0381 `sale_rule_switch`, off). In shadow: no screen reads either yet.

export interface SaleHomeShareRow {
  userId: number;
  /** The work credited (`<userId>:<startedAt>`); null — none held the sale (an owner's claim). */
  workRef: string | null;
  /** That work's row in `shifts`; null — a look-in, or not written yet. */
  shiftId: number | null;
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

/** When each user left the team (disabled or deleted), for the PPV of a sender no longer in it; absent — still in it. */
export async function listUsersLeftAt(db: Database, userIds: readonly number[]): Promise<Map<number, Date>> {
  if (userIds.length === 0) return new Map();
  const result = await db.execute<{ id: string | number; left_at: Date | string }>(sql`
    select id, least(disabled_at, deleted_at) as left_at from users
    where id = any(${sql.param(userIds.map(String))}::bigint[]) and (disabled_at is not null or deleted_at is not null)`);
  return new Map(result.rows.map((row) => [Number(row.id), new Date(row.left_at)]));
}

/** The platform's own reference of each sale (`transactions.transaction_id`), by Hub's id: how the ledger's layouts name a sale. */
export async function listSalePlatformRefs(db: Database, transactionIds: readonly number[]): Promise<Map<number, string>> {
  if (transactionIds.length === 0) return new Map();
  const result = await db.execute<{ id: string | number; transaction_id: string }>(sql`
    select id, transaction_id from transactions where id = any(${sql.param(transactionIds.map(String))}::bigint[])`);
  return new Map(result.rows.map((row) => [Number(row.id), row.transaction_id]));
}
