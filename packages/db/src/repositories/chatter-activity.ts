import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The activity of a chatter in the chat extension (0306, Chat Memory week 1):
// raw SQL over chatter_activity_minutes and chatter_activity_instances. The
// route (apps/runtime services/chatter-shifts.ts) decides which pages a beat
// may name; this file records it and reads it back. The shift itself is
// computed from the minutes when it is read.

const MINUTE_MS = 60_000;

/** The start of the minute of `at`, as the minutes table keys it. Pure. */
export function activityMinuteOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);
}

export interface ChatterActivityBeatInput {
  userId: number;
  instanceId: string;
  /** The hub's clock when the beat came. */
  at: Date;
  /** The pages the install has open, and when the person was last active on each (null: not since it opened). */
  pages: readonly { pageId: number; inputAt: Date | null }[];
  /** The beat closes the install: its last tab closed, or the person signed out. */
  closed: boolean;
}

/**
 * Records one beat: each page open in its minute, the minute of its last
 * activity marked active (a minute once active stays so), and the install's
 * last beat — closed or not — in one transaction.
 */
export async function recordChatterActivityBeat(db: Database, input: ChatterActivityBeatInput): Promise<void> {
  const rows = new Map<string, { pageId: number; minute: Date; input: boolean }>();
  const add = (pageId: number, minute: Date, active: boolean) => {
    const key = `${pageId}:${minute.getTime()}`;
    const known = rows.get(key);
    rows.set(key, { pageId, minute, input: active || (known?.input ?? false) });
  };
  for (const page of input.pages) {
    add(page.pageId, activityMinuteOf(input.at), false);
    if (page.inputAt !== null) add(page.pageId, activityMinuteOf(page.inputAt), true);
  }
  const minutes = [...rows.values()];

  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    if (minutes.length > 0) {
      await tx.execute(sql`
        insert into chatter_activity_minutes (user_id, page_id, minute, input)
        select ${input.userId}, f.page_id, f.minute, f.input
        from unnest(
          ${sql.param(minutes.map((row) => String(row.pageId)))}::bigint[],
          ${sql.param(minutes.map((row) => row.minute.toISOString()))}::timestamptz[],
          ${sql.param(minutes.map((row) => row.input))}::boolean[]
        ) as f(page_id, minute, input)
        on conflict (user_id, page_id, minute)
        do update set input = chatter_activity_minutes.input or excluded.input`);
    }
    await tx.execute(sql`
      insert into chatter_activity_instances (user_id, instance_id, last_beat_at, closed_at)
      values (${input.userId}, ${input.instanceId}, ${input.at.toISOString()}::timestamptz,
        ${input.closed ? input.at.toISOString() : null}::timestamptz)
      on conflict (user_id, instance_id)
      do update set last_beat_at = excluded.last_beat_at, closed_at = excluded.closed_at`);
  });
}

export interface ChatterActivityMinuteRow {
  userId: number;
  username: string;
  pageId: number;
  pageLabel: string;
  minute: Date;
  input: boolean;
}

/** The minutes of the pages in scope (`all` — every page) in [from, to), ordered by person and minute. */
export async function listChatterActivityMinutes(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[] },
): Promise<ChatterActivityMinuteRow[]> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const pageFilter = input.pages === "all"
    ? sql`true`
    : sql`m.page_id = any(${sql.param(input.pages.map(String))}::bigint[])`;
  const result = await db.execute<{
    user_id: string | number; username: string; page_id: string | number; page_label: string; minute: Date | string; input: boolean;
  }>(sql`
    select m.user_id, u.username, m.page_id, p.label as page_label, m.minute, m.input
    from chatter_activity_minutes m
    join users u on u.id = m.user_id
    join pages p on p.id = m.page_id
    where m.minute >= ${input.from.toISOString()}::timestamptz and m.minute < ${input.to.toISOString()}::timestamptz
      and ${pageFilter}
    order by m.user_id, m.minute, m.page_id`);
  return result.rows.map((row) => ({
    userId: Number(row.user_id),
    username: row.username,
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    minute: new Date(row.minute),
    input: row.input,
  }));
}

/** Messages with an author per person and minute, on the pages in scope, in [from, to). */
export async function countAuthoredSendsByMinute(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[] },
): Promise<Array<{ userId: number; minute: Date; sends: number }>> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const pageFilter = input.pages === "all"
    ? sql`true`
    : sql`a.page_id = any(${sql.param(input.pages.map(String))}::bigint[])`;
  const result = await db.execute<{ user_id: string | number; minute: Date | string; sends: string | number }>(sql`
    select a.user_id, date_trunc('minute', a.observed_at) as minute, count(*) as sends
    from client_send_attributions a
    where a.observed_at >= ${input.from.toISOString()}::timestamptz and a.observed_at < ${input.to.toISOString()}::timestamptz
      and ${pageFilter}
    group by 1, 2`);
  return result.rows.map((row) => ({ userId: Number(row.user_id), minute: new Date(row.minute), sends: Number(row.sends) }));
}

export interface RecentPageAuthorRow {
  fanRef: string;
  conversationRef: string | null;
  userId: number;
  username: string;
  lastSentAt: Date;
  /** The person's extension beat after this message. */
  heardSince: boolean;
  /** The person has an install that beats now and has not closed. */
  openNow: boolean;
}

/**
 * The authors of the page's messages of the last `minutes`, one row per fan
 * and person with their newest message, and what the person's installs said
 * since: whether one beat after it, and whether one is open now (not closed,
 * last beat within `lostMinutes`).
 */
export async function listRecentPageAuthors(
  db: Database,
  input: { pageId: number; now: Date; minutes: number; lostMinutes: number },
): Promise<RecentPageAuthorRow[]> {
  const now = input.now.toISOString();
  const result = await db.execute<{
    fan_ref: string; conversation_ref: string | null; user_id: string | number; username: string;
    last_sent_at: Date | string; heard_since: boolean; open_now: boolean;
  }>(sql`
    with recent as (
      select a.fan_ref, max(a.conversation_ref) as conversation_ref, a.user_id, max(a.observed_at) as last_sent_at
      from client_send_attributions a
      where a.page_id = ${input.pageId}
        and a.observed_at > ${now}::timestamptz - make_interval(mins => ${input.minutes})
      group by a.fan_ref, a.user_id
    )
    select r.fan_ref, r.conversation_ref, r.user_id, u.username, r.last_sent_at,
      exists (
        select 1 from chatter_activity_instances i
        where i.user_id = r.user_id and i.last_beat_at >= r.last_sent_at
      ) as heard_since,
      exists (
        select 1 from chatter_activity_instances i
        where i.user_id = r.user_id and i.closed_at is null
          and i.last_beat_at > ${now}::timestamptz - make_interval(mins => ${input.lostMinutes})
      ) as open_now
    from recent r
    join users u on u.id = r.user_id`);
  return result.rows.map((row) => ({
    fanRef: row.fan_ref,
    conversationRef: row.conversation_ref,
    userId: Number(row.user_id),
    username: row.username,
    lastSentAt: new Date(row.last_sent_at),
    heardSince: row.heard_since,
    openNow: row.open_now,
  }));
}
