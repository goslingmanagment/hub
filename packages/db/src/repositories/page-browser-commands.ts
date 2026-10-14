import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Project Browser (plan §4.11, §4.13; 0280, PR 17): the owner's one-shot
// commands to a page's browser — `sync browser start` (`restartBrowser`),
// `stop` and `snapshot` (`stopPage`: the operator answers once Chrome is
// down, so its answer is the stop's confirmation) and `sync browser
// selftest` (`selfTest`). The CLI asks;
// the engine that owns the page runs each once over its link to the operator
// (a command reaches a browser only from the page's current owner, plan §4.8)
// and writes what the operator answered. `command_id` is the operator's id of
// the command: one run per id, also when a new owner takes it again after a
// crash. A command nobody took before `expires_at` is never run.

export const PAGE_BROWSER_COMMAND_KINDS = ["restartBrowser", "stopPage", "selfTest"] as const;
export type PageBrowserCommandKind = (typeof PAGE_BROWSER_COMMAND_KINDS)[number];

export interface PageBrowserCommandRow {
  id: number;
  commandId: string;
  profileId: string;
  pageId: number;
  kind: PageBrowserCommandKind;
  requestedBy: string;
  note: string | null;
  requestedAt: Date;
  expiresAt: Date;
  takenGeneration: bigint | null;
  takenAt: Date | null;
  doneAt: Date | null;
  ok: boolean | null;
  detail: string | null;
}

type SqlRow = Omit<PageBrowserCommandRow, "id" | "pageId" | "requestedAt" | "expiresAt" | "takenGeneration" | "takenAt" | "doneAt"> & {
  id: string;
  pageId: string;
  requestedAt: Date | string;
  expiresAt: Date | string;
  takenGeneration: string | null;
  takenAt: Date | string | null;
  doneAt: Date | string | null;
};

const columns = sql`
  c.id::text as id, c.command_id::text as "commandId", c.profile_id::text as "profileId", c.page_id::text as "pageId",
  c.kind, c.requested_by as "requestedBy", c.note, c.requested_at as "requestedAt", c.expires_at as "expiresAt",
  c.taken_generation::text as "takenGeneration", c.taken_at as "takenAt", c.done_at as "doneAt", c.ok, c.detail
`;

function dateOf(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function rowOf(row: SqlRow): PageBrowserCommandRow {
  return {
    ...row,
    id: Number(row.id),
    pageId: Number(row.pageId),
    requestedAt: dateOf(row.requestedAt)!,
    expiresAt: dateOf(row.expiresAt)!,
    takenGeneration: row.takenGeneration === null ? null : BigInt(row.takenGeneration),
    takenAt: dateOf(row.takenAt),
    doneAt: dateOf(row.doneAt),
  };
}

/** The owner's command to the browser of a page (its bound profile), to be
 *  taken within `ttlMs` of the database's clock. Null: no profile is bound to
 *  the page. */
export async function insertPageBrowserCommand(
  db: Database,
  input: { pageId: number; kind: PageBrowserCommandKind; requestedBy: string; note?: string | null; ttlMs: number },
): Promise<PageBrowserCommandRow | null> {
  const result = await db.execute<SqlRow>(sql`
    with inserted as (
      insert into page_browser_commands as c (profile_id, page_id, kind, requested_by, note, expires_at)
      select b.profile_id, b.page_id, ${input.kind}, ${input.requestedBy}, ${input.note ?? null},
             clock_timestamp() + ${Math.max(1, Math.round(input.ttlMs))}::double precision * interval '1 millisecond'
        from page_browsers b
       where b.page_id = ${input.pageId}::bigint
      returning c.*
    )
    select ${columns} from inserted c
  `);
  const row = result.rows[0];
  return row === undefined ? null : rowOf(row);
}

export async function getPageBrowserCommand(db: Database, id: number): Promise<PageBrowserCommandRow | null> {
  const result = await db.execute<SqlRow>(sql`select ${columns} from page_browser_commands c where c.id = ${id}::bigint`);
  const row = result.rows[0];
  return row === undefined ? null : rowOf(row);
}

/**
 * The oldest command of the page's browser that waits (not done, not past its
 * expiry, not taken by this generation or a newer one), taken by the owner of
 * `generation`: it is this owner's to run now. A command an earlier owner
 * took and never finished (its process went) is taken again — the operator
 * runs a command id once. Null: nothing waits.
 */
export async function takePageBrowserCommand(
  db: Database,
  input: { pageId: number; profileId: string; generation: bigint },
): Promise<PageBrowserCommandRow | null> {
  const result = await db.execute<SqlRow>(sql`
    with next as (
      select id from page_browser_commands
       where page_id = ${input.pageId}::bigint and profile_id = ${input.profileId}::uuid
         and done_at is null and expires_at > clock_timestamp()
         and (taken_generation is null or taken_generation < ${input.generation.toString()}::bigint)
       order by id
       limit 1
       for update skip locked
    ), taken as (
      update page_browser_commands c
         set taken_generation = ${input.generation.toString()}::bigint, taken_at = clock_timestamp()
        from next
       where c.id = next.id
      returning c.*
    )
    select ${columns} from taken c
  `);
  const row = result.rows[0];
  return row === undefined ? null : rowOf(row);
}

/** What the operator answered (or why the command did not run), once: a
 *  command already done keeps its first answer. */
export async function finishPageBrowserCommand(
  db: Database,
  input: { id: number; generation: bigint; ok: boolean; detail: string | null },
): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browser_commands
       set done_at = clock_timestamp(), ok = ${input.ok}, detail = ${input.detail === null ? null : input.detail.slice(0, 500)}
     where id = ${input.id}::bigint and done_at is null and taken_generation = ${input.generation.toString()}::bigint
    returning id
  `);
  return result.rows.length === 1;
}

/** A command nobody took before its expiry: closed as not run (the CLI that
 *  asked closes it when it stops waiting). True: closed now. */
export async function expirePageBrowserCommand(db: Database, input: { id: number }): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browser_commands
       set done_at = clock_timestamp(), ok = false, detail = 'not run: no owner of the page''s browser took it before its expiry'
     where id = ${input.id}::bigint and done_at is null and taken_at is null and expires_at <= clock_timestamp()
    returning id
  `);
  return result.rows.length === 1;
}
