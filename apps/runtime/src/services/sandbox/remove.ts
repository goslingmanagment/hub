import { sql } from "drizzle-orm";

import type { Database } from "@agency_hub_core/db";

/**
 * `sandbox:remove` — takes the test team away. THE OWNER'S WORD ONLY (products plan 2026-11-13 §10 p.15): nobody runs
 * it in a task, and the seed's task did not. Guarded three ways:
 *
 * - a dry run unless `--execute` is given: it counts what it would take, and writes nothing;
 * - `--execute` also needs `--confirm <the test model's id>`, read from the dry run: a wrong or stale id stops it;
 * - it selects ONLY by the test marks (0414): rows of test pages (through a test model), of test logins (through a test
 *   person), the test people and the test model. A row of a live page or a live login is never in its reach; mixed rows
 *   cannot exist (the realm triggers of 0414).
 *
 * What it takes, in one transaction: every row of a table with a foreign key to a test page, a test login, a test person,
 * a test fan or the test team's agent key (found from the catalog, so a table added later is covered), the rows of the
 * tables that name a test page or login without a foreign key (`UNKEYED`), the history of the test objects
 * (`object_events`), then the fans only the test pages knew, the people, the logins (users rows are released by the
 * account-deletion tombstone, never hard-deleted while audit rows name them) and the model with its pages. Tables are
 * retried in passes until none is left (foreign keys between them decide the order).
 *
 * The test realm's ids are read once, before anything is taken (a condition read again after `person_logins` went would
 * match nothing). A handed-in report is never deleted (0400, 0412): the removal sets `agency_hub.sandbox_remove` for its
 * own transaction, and the report tables' triggers honour it for a test person's rows only (0425).
 */

export interface SandboxRemovalPlan {
  modelId: number | null;
  rows: Record<string, number>;
}

/**
 * Tables that name a test page or login without a foreign key (or beside one), each taken where it exists. Compared as
 * text: some of them keep the id as text.
 */
const UNKEYED: ReadonlyArray<{ table: string; column: string; of: "pages" | "users" }> = [
  { table: "client_send_attributions", column: "page_id", of: "pages" },
  { table: "chatter_activity_minutes", column: "page_id", of: "pages" },
  { table: "message_archive", column: "account_id", of: "pages" },
  { table: "message_media_offers", column: "page_id", of: "pages" },
  { table: "creator_post_tips", column: "account_id", of: "pages" },
  { table: "spender_projection_watermarks", column: "platform_account_id", of: "pages" },
  { table: "projection_seq_watermarks", column: "account_id", of: "pages" },
  { table: "projection_debt", column: "platform_account_id", of: "pages" },
  { table: "publication_revisions", column: "page_id", of: "pages" },
  { table: "ai_generation_content", column: "page_id", of: "pages" },
  { table: "page_browser_commands", column: "page_id", of: "pages" },
  { table: "page_browser_transitions", column: "page_id", of: "pages" },
  { table: "page_fan_identities", column: "account_id", of: "pages" },
  { table: "page_dm_message_sync_health", column: "platform_account_id", of: "pages" },
  { table: "voice_notes", column: "user_id", of: "users" },
];

/** The kinds of `object_events` (0382, no foreign key) and the table of their object: a test object's history goes with it. */
const OBJECT_EVENT_TABLES: Readonly<Record<string, string>> = { matter: "matters", custom_order: "custom_orders", shift_report: "shift_handins" };

/** Taken at the end, by hand: `person_logins` is what marks a login as test while the passes run. */
const LAST = new Set(["person_logins"]);

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

const TEST_ID_QUERIES = {
  pages: "select p.id as id from pages p join models m on m.id = p.model_id where m.is_test",
  users: "select pl.user_id as id from person_logins pl join people pe on pe.id = pl.person_id where pe.is_test",
  people: "select id from people where is_test",
  // A fan only test pages know: no live page's fan row and no live page's sale names them.
  fans: `select pf.fan_id as id from page_fans pf join pages p on p.id = pf.platform_account_id join models m on m.id = p.model_id
          where m.is_test and not exists (
            select 1 from page_fans lf join pages lp on lp.id = lf.platform_account_id join models lm on lm.id = lp.model_id
             where lf.fan_id = pf.fan_id and not lm.is_test)
          and not exists (
            select 1 from transactions lt join pages lp on lp.id = lt.platform_account_id join models lm on lm.id = lp.model_id
             where lt.fan_id = pf.fan_id and not lm.is_test)`,
  // The test team's agent keys: every page a key holds is a test page (a key of both realms cannot exist, 0414).
  agent_keys: `select k.id as id from agent_keys k where cardinality(k.page_ids) > 0 and not exists (
          select 1 from unnest(k.page_ids) as kp(page_id) join pages p on p.id = kp.page_id join models m on m.id = p.model_id
           where not m.is_test)`,
} as const;
type TestIdKind = keyof typeof TEST_ID_QUERIES;
/** The tables whose rows ARE the test realm's ids, each by its id kind. */
const ID_TABLES: Readonly<Record<string, TestIdKind>> = { pages: "pages", users: "users", people: "people", fans: "fans", agent_keys: "agent_keys" };

/** The test realm's ids, each kind as an SQL list (`null` when none: matches nothing). */
type TestIds = Record<TestIdKind, string>;

async function readTestIds(db: Database): Promise<TestIds> {
  const out = {} as TestIds;
  for (const kind of Object.keys(TEST_ID_QUERIES) as TestIdKind[]) {
    const result = await db.execute<Row>(sql.raw(`select distinct q.id::text as id from (${TEST_ID_QUERIES[kind]}) q`));
    const ids = result.rows.map((row) => String(row.id));
    for (const id of ids) if (!/^[0-9]+$/.test(id)) throw new Error(`Unexpected id ${id}`);
    out[kind] = ids.length === 0 ? "null" : ids.join(", ");
  }
  return out;
}

function quoted(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected identifier ${name}`);
  return `"${name}"`;
}

const textList = (ids: string) => (ids === "null" ? "null" : ids.split(", ").map((id) => `'${id}'`).join(", "));

interface Target { table: string; where: string; label: string }

/**
 * The rows to take: those pointing at a test page, login, person, fan or agent key, and — to the depth the schema has —
 * the rows pointing at those rows (an order's events, a shift's changes). Children come first in the list.
 */
async function targets(db: Database, ids: TestIds): Promise<Target[]> {
  const keys = await foreignKeys(db);
  const roots = new Set(["pages", "users", "people", "models"]);
  const out: Target[] = [];
  const visit = (target: Target, depth: number) => {
    if (depth < 5) {
      for (const child of keys.filter((key) => key.target === target.table && !roots.has(key.table) && !LAST.has(key.table))) {
        visit({
          table: child.table,
          where: `${quoted(child.column)} in (select ${quoted(child.targetColumn)} from ${quoted(target.table)} where ${target.where})`,
          label: `${child.table}.${child.column} via ${target.label}`,
        }, depth + 1);
      }
    }
    out.push(target);
  };
  for (const key of keys.filter((one) => ID_TABLES[one.target] !== undefined && !roots.has(one.table) && !LAST.has(one.table))) {
    if (key.table === "agent_keys") continue; // the keys themselves are one target below, with their own children
    visit({ table: key.table, where: `${quoted(key.column)} in (${ids[ID_TABLES[key.target]!]})`, label: `${key.table}.${key.column}` }, 0);
  }
  visit({ table: "agent_keys", where: `id in (${ids.agent_keys})`, label: "agent_keys" }, 0);
  // A matter of test pages waits for a test login (0414), so its owner's key finds it; its pages say it as well.
  visit({ table: "matters", where: `page_ids && array[${ids.pages === "null" ? "" : ids.pages}]::bigint[]`, label: "matters.page_ids" }, 0);
  const existing = new Set((await db.execute<Row>(sql`select table_name || '.' || column_name as name from information_schema.columns
    where table_schema = 'public'`)).rows.map((row) => String(row.name)));
  for (const one of UNKEYED.filter((entry) => existing.has(`${entry.table}.${entry.column}`))) {
    out.push({
      table: one.table, where: `${quoted(one.column)}::text in (${textList(ids[one.of])})`, label: `${one.table}.${one.column}`,
    });
  }
  return out;
}

/** The history of the test objects (`object_events`, no foreign key to its object): read while the objects are there. */
function objectEventsTarget(all: readonly Target[]): Target | null {
  const of = Object.entries(OBJECT_EVENT_TABLES).flatMap(([type, table]) => all.filter((one) => one.table === table)
    .map((one) => `(object_type = '${type}' and object_id in (select id::text from ${quoted(table)} where ${one.where}))`));
  return of.length === 0 ? null : { table: "object_events", where: of.join(" or "), label: "object_events of test objects" };
}

/** What the removal would take (a dry run): rows per table. Reads only. */
export async function planSandboxRemoval(db: Database): Promise<SandboxRemovalPlan> {
  const modelId = await testModelId(db);
  const rows: Record<string, number> = {};
  if (modelId === null) return { modelId, rows };
  const ids = await readTestIds(db);
  const all = await targets(db, ids);
  const history = objectEventsTarget(all);
  for (const target of history === null ? all : [history, ...all]) {
    const result = await db.execute<Row>(sql.raw(`select count(*)::int as n from ${quoted(target.table)} where ${target.where}`));
    const n = Number(result.rows[0]?.n ?? 0);
    if (n > 0) rows[target.label] = n;
  }
  for (const [table, query] of [
    ["people", TEST_ID_QUERIES.people], ["users (released)", TEST_ID_QUERIES.users], ["pages", TEST_ID_QUERIES.pages],
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
    // The report tables let a test person's rows go while this is set, for this transaction only (0425).
    await tx.execute(sql`select set_config('agency_hub.sandbox_remove', 'test_realm', true)`);
    const ids = await readTestIds(tx);
    const all = await targets(tx, ids);
    const history = objectEventsTarget(all);
    if (history !== null) await tx.execute(sql.raw(`delete from ${quoted(history.table)} where ${history.where}`));
    let left = all;
    const errors = new Map<string, string>();
    for (let pass = 0; left.length > 0; pass += 1) {
      if (pass > 20) {
        throw new Error(`Rows still referenced after 20 passes: ${left.map((one) => `${one.label} (${errors.get(one.label) ?? "?"})`).join("; ")}`);
      }
      const next: typeof left = [];
      for (const target of left) {
        await tx.execute(sql`savepoint sandbox_remove`);
        try {
          await tx.execute(sql.raw(`delete from ${quoted(target.table)} where ${target.where}`));
          await tx.execute(sql`release savepoint sandbox_remove`);
        } catch (error) {
          await tx.execute(sql`rollback to savepoint sandbox_remove`);
          errors.set(target.label, error instanceof Error ? error.message : String(error));
          next.push(target);
        }
      }
      left = next;
    }
    // Logins: the tombstone releases the login name; the row stays for the audit rows that name it.
    await tx.execute(sql.raw(`update users set deleted_at = now(), disabled_at = coalesce(disabled_at, now()), password_hash = null
      where id in (${ids.users})`));
    await tx.execute(sql.raw(`delete from person_logins where person_id in (${ids.people})`));
    await tx.execute(sql.raw(`delete from people where id in (${ids.people})`));
    await tx.execute(sql.raw(`delete from fans f where f.id in (${ids.fans}) and not exists (select 1 from page_fans pf where pf.fan_id = f.id)
      and not exists (select 1 from transactions t where t.fan_id = f.id)`));
    await tx.execute(sql`delete from pages where model_id = ${plan.modelId}`);
    await tx.execute(sql`delete from models where id = ${plan.modelId} and is_test`);
  });
  return plan;
}
