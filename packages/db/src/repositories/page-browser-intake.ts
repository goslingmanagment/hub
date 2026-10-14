import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Project Browser (plan §3.2 «Приём буфера и восстановление», §4.4; 0276;
// stage 3 PR 13): where the engine's intake of a page's operator buffer
// stands, on the row of the page's browser profile. The intake commits a
// batch of the operator's events and its new position in ONE transaction,
// and acknowledges the batch to the operator only after that commit: the
// position is the `afterSeq` of every new subscription, which the operator
// takes as the acknowledgement of everything up to it — so a crash before
// the commit loses nothing (the batch comes again), and a crash after it, or
// an acknowledgement lost on the way, duplicates nothing.

export interface PageBrowserIntake {
  profileId: string;
  /** The buffer the engine takes events of; null before its first batch. */
  bufferId: string | null;
  /** The last number of `bufferId` whose event is committed. */
  ackedSeq: number;
  /** The loss boundary (`events_last_wall`): the latest instant of a socket
   *  open or frame committed (`ws.open`, `ws.in`), of any buffer — where a
   *  loss whose start nothing names reads back from. A site's answer, a gap
   *  and a close are stamped at the operator's take and never move it
   *  (`browser-intake.ts`). */
  lastWall: Date | null;
  /** A gap marked and not yet taken by a connection of the site's socket. */
  gapSince: Date | null;
  /** A buffer nothing is taken of (its history contradicts the engine's),
   *  and why; null: none. */
  halted: { bufferId: string; reason: string; at: Date } | null;
}

type IntakeSqlRow = {
  profileId: string;
  bufferId: string | null;
  ackedSeq: string;
  lastWall: Date | string | null;
  gapSince: Date | string | null;
  haltedBufferId: string | null;
  haltedReason: string | null;
  haltedAt: Date | string | null;
};

function dateOf(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function intakeOf(row: IntakeSqlRow): PageBrowserIntake {
  return {
    profileId: row.profileId,
    bufferId: row.bufferId,
    ackedSeq: Number(row.ackedSeq),
    lastWall: dateOf(row.lastWall),
    gapSince: dateOf(row.gapSince),
    halted: row.haltedBufferId === null || row.haltedReason === null
      ? null
      : { bufferId: row.haltedBufferId, reason: row.haltedReason, at: dateOf(row.haltedAt) ?? new Date(0) },
  };
}

const columns = sql`
  b.profile_id::text as "profileId",
  b.events_buffer_id::text as "bufferId",
  b.events_acked_seq::text as "ackedSeq",
  b.events_last_wall as "lastWall",
  b.events_gap_since as "gapSince",
  b.events_halted_buffer_id::text as "haltedBufferId",
  b.events_halted_reason as "haltedReason",
  b.events_halted_at as "haltedAt"
`;

/** The intake's position of the page's browser; null: the page has no
 *  browser profile. */
export async function readPageBrowserIntake(db: Database, pageId: number): Promise<PageBrowserIntake | null> {
  const result = await db.execute<IntakeSqlRow>(sql`select ${columns} from page_browsers b where b.page_id = ${pageId}::bigint`);
  const row = result.rows[0];
  return row === undefined ? null : intakeOf(row);
}

/** The same, locked until the caller's transaction ends (the intake's batch:
 *  one writer of a page's position at a time). */
export async function lockPageBrowserIntake(tx: Database, pageId: number): Promise<PageBrowserIntake | null> {
  const result = await tx.execute<IntakeSqlRow>(sql`
    select ${columns} from page_browsers b where b.page_id = ${pageId}::bigint for no key update of b
  `);
  const row = result.rows[0];
  return row === undefined ? null : intakeOf(row);
}

/**
 * Nothing more of `bufferId` is taken (its history contradicts the
 * engine's: `ahead`). Persisted, so no restart and no automatic retry takes
 * it again; only another buffer of the operator (a volume made anew) is
 * taken — its first commit clears this. True when this call halted it.
 */
export async function haltPageBrowserIntake(
  db: Database,
  input: { pageId: number; bufferId: string; reason: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browsers
       set events_halted_buffer_id = ${input.bufferId}::uuid,
           events_halted_reason = ${input.reason},
           events_halted_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}::bigint
       and events_halted_buffer_id is distinct from ${input.bufferId}::uuid
    returning profile_id
  `);
  return result.rows.length === 1;
}

/** The intake's new position, in the transaction of the batch it took. A
 *  batch of another buffer than a halted one clears the halt. */
export async function writePageBrowserIntake(
  tx: Database,
  input: { profileId: string; bufferId: string; ackedSeq: number; lastWall: Date | null; gapSince: Date | null },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update page_browsers
       set events_buffer_id = ${input.bufferId}::uuid,
           events_acked_seq = ${input.ackedSeq}::bigint,
           events_last_wall = ${input.lastWall === null ? null : input.lastWall.toISOString()}::timestamptz,
           events_gap_since = ${input.gapSince === null ? null : input.gapSince.toISOString()}::timestamptz,
           events_updated_at = clock_timestamp(),
           events_halted_buffer_id = case when events_halted_buffer_id = ${input.bufferId}::uuid then events_halted_buffer_id end,
           events_halted_reason = case when events_halted_buffer_id = ${input.bufferId}::uuid then events_halted_reason end,
           events_halted_at = case when events_halted_buffer_id = ${input.bufferId}::uuid then events_halted_at end,
           updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid
    returning profile_id
  `);
  return result.rows.length === 1;
}
