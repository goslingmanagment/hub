import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Project Browser (plan §4.11, §4.13; 0281, PR 17): the owner's one-shot
// commands to a page's browser — `sync browser start` (`restartBrowser`),
// `stop` and `snapshot` (`stopPage`: the operator answers once Chrome is
// down, so its answer is the stop's confirmation) and `sync browser
// selftest` (`selfTest`). The CLI asks;
// the engine that owns the page runs each once over its link to the operator
// (a command reaches a browser only from the page's current owner, plan §4.8)
// and writes what the operator answered. `command_id` is the operator's id of
// the command: one run per id. A command nobody took before `expires_at` is
// never run.
//
// Every command ends (Astra round 3): `ok`; `failed` (the operator said no,
// or it was not run: the guard, the owner's stop lifted…); `expired` (not
// sent before its expiry — nobody took it, or its taker went before sending
// it); `unknown` (sent, and no answer came: never sent again — a newer owner
// takes only a command nothing was sent of). The owner that took a command
// marks it sent before anything of it goes to the operator; one superseded
// before that gives it back (released) to the newer owner.

// A profile no page has takes one command (Astra round 4): the owner's
// `clearHalt` of the halt its operator holds (`sync browser-profile
// clear-halt`), run by its onboarding link — `page_id` null.
export const PAGE_BROWSER_COMMAND_KINDS = ["restartBrowser", "stopPage", "selfTest", "clearHalt"] as const;
export type PageBrowserCommandKind = (typeof PAGE_BROWSER_COMMAND_KINDS)[number];

export interface PageBrowserCommandRow {
  id: number;
  commandId: string;
  profileId: string;
  /** Null: a profile no page has (its `clearHalt`). */
  pageId: number | null;
  kind: PageBrowserCommandKind;
  requestedBy: string;
  note: string | null;
  requestedAt: Date;
  expiresAt: Date;
  takenGeneration: bigint | null;
  takenAt: Date | null;
  /** The halt the owner decided on (a start: the operator's held halt as
   *  Hub mirrored it when he asked; its `clearHalt` names it). */
  haltId: string | null;
  /** Something of it went to the operator (never sent again). */
  sentAt: Date | null;
  doneAt: Date | null;
  outcome: PageBrowserCommandOutcome | null;
  ok: boolean | null;
  detail: string | null;
}

export type PageBrowserCommandOutcome = "ok" | "failed" | "unknown" | "expired";

/** A command sent and not answered is called unknown this long after its
 *  expiry (the operator executes none past its expiry; its answer comes
 *  within the owner's wait). */
export const PAGE_BROWSER_COMMAND_ANSWER_GRACE_MS = 60_000;

type SqlRow = Omit<PageBrowserCommandRow, "id" | "pageId" | "requestedAt" | "expiresAt" | "takenGeneration" | "takenAt" | "sentAt" | "doneAt"> & {
  id: string;
  pageId: string | null;
  requestedAt: Date | string;
  expiresAt: Date | string;
  takenGeneration: string | null;
  takenAt: Date | string | null;
  sentAt: Date | string | null;
  doneAt: Date | string | null;
};

const columns = sql`
  c.id::text as id, c.command_id::text as "commandId", c.profile_id::text as "profileId", c.page_id::text as "pageId",
  c.kind, c.requested_by as "requestedBy", c.note, c.requested_at as "requestedAt", c.expires_at as "expiresAt",
  c.taken_generation::text as "takenGeneration", c.taken_at as "takenAt", c.halt_id as "haltId", c.sent_at as "sentAt",
  c.done_at as "doneAt", c.outcome, c.ok, c.detail
`;

function dateOf(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function rowOf(row: SqlRow): PageBrowserCommandRow {
  return {
    ...row,
    id: Number(row.id),
    pageId: row.pageId === null ? null : Number(row.pageId),
    requestedAt: dateOf(row.requestedAt)!,
    expiresAt: dateOf(row.expiresAt)!,
    takenGeneration: row.takenGeneration === null ? null : BigInt(row.takenGeneration),
    takenAt: dateOf(row.takenAt),
    sentAt: dateOf(row.sentAt),
    doneAt: dateOf(row.doneAt),
  };
}

/** The owner's command to the browser of a page (its bound profile), to be
 *  taken within `ttlMs` of the database's clock. Null: no profile is bound to
 *  the page. */
export async function insertPageBrowserCommand(
  db: Database,
  input: { pageId: number; kind: PageBrowserCommandKind; requestedBy: string; note?: string | null; ttlMs: number; haltId?: string | null },
): Promise<PageBrowserCommandRow | null> {
  const result = await db.execute<SqlRow>(sql`
    with inserted as (
      insert into page_browser_commands as c (profile_id, page_id, kind, requested_by, note, halt_id, expires_at)
      select b.profile_id, b.page_id, ${input.kind}, ${input.requestedBy}, ${input.note ?? null}, ${input.haltId ?? null}::text,
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

/** The owner's `clearHalt` of a profile no page has (its onboarding link runs
 *  it), naming the halt its operator holds. Null: no such profile, or one a
 *  page has (its page's start clears it). */
export async function insertProfileClearHaltCommand(
  db: Database,
  input: { profileId: string; haltId: string; requestedBy: string; note?: string | null; ttlMs: number },
): Promise<PageBrowserCommandRow | null> {
  const result = await db.execute<SqlRow>(sql`
    with inserted as (
      insert into page_browser_commands as c (profile_id, page_id, kind, requested_by, note, halt_id, expires_at)
      select b.profile_id, null, 'clearHalt', ${input.requestedBy}, ${input.note ?? null}, ${input.haltId}::text,
             clock_timestamp() + ${Math.max(1, Math.round(input.ttlMs))}::double precision * interval '1 millisecond'
        from page_browsers b
       where b.profile_id = ${input.profileId}::uuid and b.page_id is null
      returning c.*
    )
    select ${columns} from inserted c
  `);
  const row = result.rows[0];
  return row === undefined ? null : rowOf(row);
}

/** The oldest command of a profile no page has that waits (as
 *  `takePageBrowserCommand`), taken by its onboarding link of `generation`
 *  (the profile's link generation). */
export async function takeProfileCommand(
  db: Database,
  input: { profileId: string; generation: bigint },
): Promise<PageBrowserCommandRow | null> {
  await expirePageBrowserCommands(db, { profileId: input.profileId });
  const result = await db.execute<SqlRow>(sql`
    with next as (
      select id from page_browser_commands
       where page_id is null and profile_id = ${input.profileId}::uuid
         and done_at is null and expires_at > clock_timestamp() and sent_at is null
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

export async function getPageBrowserCommand(db: Database, id: number): Promise<PageBrowserCommandRow | null> {
  const result = await db.execute<SqlRow>(sql`select ${columns} from page_browser_commands c where c.id = ${id}::bigint`);
  const row = result.rows[0];
  return row === undefined ? null : rowOf(row);
}

/**
 * The oldest command of the page's browser that waits (not done, not past its
 * expiry, nothing of it sent, not taken by this generation or a newer one),
 * taken by the owner of `generation`: it is this owner's to run now. A
 * command an earlier owner took and never sent (its process went) is taken
 * again; one it sent is not (its outcome is unknown, never sent twice). The
 * page's commands past their expiry are closed first. Null: nothing waits.
 */
export async function takePageBrowserCommand(
  db: Database,
  input: { pageId: number; profileId: string; generation: bigint },
): Promise<PageBrowserCommandRow | null> {
  await expirePageBrowserCommands(db, { pageId: input.pageId });
  const result = await db.execute<SqlRow>(sql`
    with next as (
      select id from page_browser_commands
       where page_id = ${input.pageId}::bigint and profile_id = ${input.profileId}::uuid
         and done_at is null and expires_at > clock_timestamp() and sent_at is null
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

/** Something of the command goes to the operator now: marked before it
 *  goes, by the owner that took it. False: it is not this owner's any more
 *  (a newer one took it, or it ended) — nothing may be sent. */
export async function markPageBrowserCommandSent(db: Database, input: { id: number; generation: bigint }): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browser_commands
       set sent_at = coalesce(sent_at, clock_timestamp())
     where id = ${input.id}::bigint and done_at is null and taken_generation = ${input.generation.toString()}::bigint
    returning id
  `);
  return result.rows.length === 1;
}

/** A command taken and not sent, given back by an owner that was superseded
 *  meanwhile: the newer owner takes it (or it expires). True: released. */
export async function releasePageBrowserCommand(db: Database, input: { id: number; generation: bigint }): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browser_commands
       set taken_generation = null, taken_at = null
     where id = ${input.id}::bigint and done_at is null and sent_at is null and taken_generation = ${input.generation.toString()}::bigint
    returning id
  `);
  return result.rows.length === 1;
}

/** The command's end, once: `ok`, `failed` (the operator said no, or it was
 *  not run) or `unknown` (sent, no answer). A command already done keeps its
 *  first end. */
export async function finishPageBrowserCommand(
  db: Database,
  input: { id: number; generation: bigint; outcome: "ok" | "failed" | "unknown"; detail: string | null },
): Promise<boolean> {
  const ok = input.outcome === "unknown" ? null : input.outcome === "ok";
  const result = await db.execute(sql`
    update page_browser_commands
       set done_at = clock_timestamp(), outcome = ${input.outcome}, ok = ${ok}::boolean,
           detail = ${input.detail === null ? null : input.detail.slice(0, 500)}
     where id = ${input.id}::bigint and done_at is null and taken_generation = ${input.generation.toString()}::bigint
    returning id
  `);
  return result.rows.length === 1;
}

/**
 * The commands past their expiry, closed (of `id`, or of the page): one
 * nothing was sent of — nobody took it, or its taker went before sending it
 * — `expired`, never run; one sent and not answered `unknown`, once the
 * operator's answer can no longer come (`PAGE_BROWSER_COMMAND_ANSWER_GRACE_MS`
 * after its expiry). Returns how many it closed.
 */
export async function expirePageBrowserCommands(db: Database, input: { id: number } | { pageId: number } | { profileId: string }): Promise<number> {
  const which = "id" in input ? sql`id = ${input.id}::bigint`
    : "pageId" in input ? sql`page_id = ${input.pageId}::bigint`
    : sql`page_id is null and profile_id = ${input.profileId}::uuid`;
  const result = await db.execute(sql`
    update page_browser_commands
       set done_at = clock_timestamp(),
           outcome = case when sent_at is null then 'expired' else 'unknown' end,
           ok = case when sent_at is null then false else null end,
           detail = case
             when sent_at is not null then 'unknown: sent to the operator, and no answer came; never sent again'
             when taken_at is not null then 'not run: taken by an owner of the page that went before sending it, and not taken again before its expiry'
             else 'not run: no owner of the page''s browser took it before its expiry' end
     where ${which} and done_at is null
       and ((sent_at is null and expires_at <= clock_timestamp())
         or (sent_at is not null and expires_at + ${PAGE_BROWSER_COMMAND_ANSWER_GRACE_MS}::double precision * interval '1 millisecond' <= clock_timestamp()))
    returning id
  `);
  return result.rows.length;
}
