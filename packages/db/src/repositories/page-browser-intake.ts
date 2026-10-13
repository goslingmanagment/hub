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
  /** The operator's instant of the last event committed, of any buffer. */
  lastWall: Date | null;
  /** A gap marked and not yet taken by a connection of the site's socket. */
  gapSince: Date | null;
}

type IntakeSqlRow = {
  profileId: string;
  bufferId: string | null;
  ackedSeq: string;
  lastWall: Date | string | null;
  gapSince: Date | string | null;
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
  };
}

const columns = sql`
  b.profile_id::text as "profileId",
  b.events_buffer_id::text as "bufferId",
  b.events_acked_seq::text as "ackedSeq",
  b.events_last_wall as "lastWall",
  b.events_gap_since as "gapSince"
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

/** The intake's new position, in the transaction of the batch it took. */
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
           updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid
    returning profile_id
  `);
  return result.rows.length === 1;
}
