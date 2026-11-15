import { sql } from "drizzle-orm";

import type { Database } from "@agency_hub_core/db";

/**
 * `sandbox:remove` — takes the test team away. THE OWNER'S WORD ONLY (products plan 2026-11-13 §10 p.15): nobody runs
 * it in a task, and the seed's task did not. Guarded three ways:
 *
 * - a dry run unless `--execute` is given: it counts what it would take, and writes nothing;
 * - `--execute` also needs `--confirm <the test model's id>`, read from the dry run: a wrong or stale id stops it;
 * - it selects ONLY by the test marks (0412): rows of test pages (through a test model), of test logins (through a test
 *   person), the test people and the test model. A row of a live page or a live login is never in its reach; mixed rows
 *   cannot exist (the realm triggers of 0412).
 *
 * What it takes, in one transaction: every row of a table with a foreign key to a test page, a test login, a test person
 * or a test fan (found from the catalog, so a table added later is covered), the rows of the seed's tables that name a
 * test page without a foreign key (`UNKEYED`), then the fans only the test pages knew, the people, the logins (users rows
 * are released by the account-deletion tombstone, never hard-deleted while audit rows name them) and the model with its
 * pages. Tables are retried in passes until none is left (foreign keys between them decide the order).
 */

export interface SandboxRemovalPlan {
  modelId: number | null;
  rows: Record<string, number>;
}

/** Tables the seed and the test team's work write that name a page without a foreign key (or beside one). */
const UNKEYED: ReadonlyArray<{ table: string; column: string }> = [
  { table: "client_send_attributions", column: "page_id" },
  { table: "chatter_activity_minutes", column: "page_id" },
  { table: "message_archive", column: "account_id" },
  { table: "message_media_offers", column: "page_id" },
  { table: "creator_post_tips", column: "account_id" },
];

type Row = Record<string, unknown>;

async function testModelId(db: Database): Promise<number | null> {
  const result = await db.execute<Row>(sql`select id from models where is_test order by id`);
  if (result.rows.length > 1) throw new Error("More than one test model: remove them one by one is not supported");
  return result.rows[0] ? Number(result.rows[0].id) : null;
}

interface ForeignKey { table: string; column: string; target: string; targetColumn: string }

/** Every single-column foreign key of the public schema. */
async function foreignKeys(db: Database): Promise<ForeignKey[]> {
  const result = await db.execute<Row>(sql`
    select cl.relname as table_name, att.attname as column_name, tg.relname as target, tatt.attname as target_column
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_class tg on tg.oid = c.confrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join pg_attribute att on att.attrelid = c.conrelid and att.attnum = c.conkey[1]
      join pg_attribute tatt on tatt.attrelid = c.confrelid and tatt.attnum = c.confkey[1]
     where c.contype = 'f' and ns.nspname = 'public' and array_length(c.conkey, 1) = 1
     order by 1, 2`);
  return result.rows.map((row) => ({
    table: String(row.table_name), column: String(row.column_name), target: String(row.target), targetColumn: String(row.target_column),
  }));
}

const TEST_IDS: Record<string, string> = {
  pages: "select p.id from pages p join models m on m.id = p.model_id where m.is_test",
  users: "select pl.user_id from person_logins pl join people pe on pe.id = pl.person_id where pe.is_test",
  people: "select id from people where is_test",
  // A fan only test pages know: no live page's fan row and no live page's sale names them.
  fans: `select pf.fan_id from page_fans pf join pages p on p.id = pf.platform_account_id join models m on m.id = p.model_id
          where m.is_test and not exists (
            select 1 from page_fans lf join pages lp on lp.id = lf.platform_account_id join models lm on lm.id = lp.model_id
             where lf.fan_id = pf.fan_id and not lm.is_test)
          and not exists (
            select 1 from transactions lt join pages lp on lp.id = lt.platform_account_id join models lm on lm.id = lp.model_id
             where lt.fan_id = pf.fan_id and not lm.is_test)`,
};

function quoted(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected identifier ${name}`);
  return `"${name}"`;
}

interface Target { table: string; where: string; label: string }

/**
 * The rows to take: those pointing at a test page, login, person or fan, and — to the depth the schema has — the rows
 * pointing at those rows (an order's events, a shift's changes). Children come first in the list.
 */
async function targets(db: Database): Promise<Target[]> {
  const keys = await foreignKeys(db);
  const roots = new Set(["pages", "users", "people", "models"]);
  const out: Target[] = [];
  const visit = (target: Target, depth: number) => {
    if (depth < 5) {
      for (const child of keys.filter((key) => key.target === target.table && !roots.has(key.table))) {
        visit({
          table: child.table,
          where: `${quoted(child.column)} in (select ${quoted(child.targetColumn)} from ${quoted(target.table)} where ${target.where})`,
          label: `${child.table}.${child.column} via ${target.label}`,
        }, depth + 1);
      }
    }
    out.push(target);
  };
  for (const key of keys.filter((one) => TEST_IDS[one.target] !== undefined && !roots.has(one.table))) {
    visit({ table: key.table, where: `${quoted(key.column)} in (${TEST_IDS[key.target]})`, label: `${key.table}.${key.column}` }, 0);
  }
  for (const one of UNKEYED) {
    out.push({ table: one.table, where: `${quoted(one.column)} in (${TEST_IDS.pages})`, label: `${one.table}.${one.column}` });
  }
  return out;
}

/** What the removal would take (a dry run): rows per table. Reads only. */
export async function planSandboxRemoval(db: Database): Promise<SandboxRemovalPlan> {
  const modelId = await testModelId(db);
  const rows: Record<string, number> = {};
  if (modelId === null) return { modelId, rows };
  for (const target of await targets(db)) {
    const result = await db.execute<Row>(sql.raw(`select count(*)::int as n from ${quoted(target.table)} where ${target.where}`));
    const n = Number(result.rows[0]?.n ?? 0);
    if (n > 0) rows[target.label] = n;
  }
  for (const [table, query] of [
    ["people", TEST_IDS.people], ["users (released)", TEST_IDS.users], ["pages", TEST_IDS.pages],
  ] as const) {
    const result = await db.execute<Row>(sql.raw(`select count(*)::int as n from (${query}) q`));
    rows[table] = Number(result.rows[0]?.n ?? 0);
  }
  rows.models = 1;
  return { modelId, rows };
}

/** Takes the test team away. Only with the owner's word, the test model's id as the confirmation. */
export async function executeSandboxRemoval(db: Database, input: { confirmModelId: number }): Promise<SandboxRemovalPlan> {
  const plan = await planSandboxRemoval(db);
  if (plan.modelId === null) return plan;
  if (plan.modelId !== input.confirmModelId) {
    throw new Error(`--confirm ${input.confirmModelId} is not the test model (${plan.modelId}): nothing removed`);
  }
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    // The logins first: the passes below take their person_logins rows, which is how a login is known to be test.
    const logins = (await tx.execute<Row>(sql.raw(TEST_IDS.users!))).rows.map((row) => String(row.user_id));
    let left = await targets(tx);
    for (let pass = 0; left.length > 0; pass += 1) {
      if (pass > 20) throw new Error(`Rows still referenced after 20 passes: ${left.map((one) => one.table).join(", ")}`);
      const next: typeof left = [];
      for (const target of left) {
        await tx.execute(sql`savepoint sandbox_remove`);
        try {
          await tx.execute(sql.raw(`delete from ${quoted(target.table)} where ${target.where}`));
          await tx.execute(sql`release savepoint sandbox_remove`);
        } catch {
          await tx.execute(sql`rollback to savepoint sandbox_remove`);
          next.push(target);
        }
      }
      left = next;
    }
    // Logins: the tombstone releases the login name; the row stays for the audit rows that name it.
    await tx.execute(sql`update users set deleted_at = now(), disabled_at = coalesce(disabled_at, now()), password_hash = null
      where id = any(${sql.param(logins)}::bigint[])`);
    await tx.execute(sql.raw(`delete from person_logins where person_id in (${TEST_IDS.people})`));
    await tx.execute(sql.raw(`delete from people where id in (${TEST_IDS.people})`));
    await tx.execute(sql.raw(`delete from fans f where not exists (select 1 from page_fans pf where pf.fan_id = f.id)
      and not exists (select 1 from transactions t where t.fan_id = f.id) and f.username like 'sbx_fan_%'`));
    await tx.execute(sql.raw(`delete from spender_projection_watermarks where platform_account_id in (${TEST_IDS.pages})`));
    await tx.execute(sql`delete from pages where model_id = ${plan.modelId}`);
    await tx.execute(sql`delete from models where id = ${plan.modelId} and is_test`);
  });
  return plan;
}
