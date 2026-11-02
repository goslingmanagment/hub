import { millsToNumber } from "@agency_hub_core/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { fans } from "../schema.ts";

/**
 * Where else a fan is with the agency: the OTHER pages of the asked page's
 * platform, any model, where he paid or lately wrote himself. It is the one mark
 * on a fan in a chatter's lists, so a fan who talks on lora-2 is not greeted on
 * lora-1 as a cold follower. Following a page is no reason by itself: more than
 * half of a page's audience also follows another one.
 *
 * One statement per answer, never one per fan: it rides the lists a client
 * already reads, «Онлайн» among them, every minute (16 ms for 200 fans on
 * production, 2026-11-02). A fan is `fans.id`, one identity across the pages of
 * one platform. Only the page's label, the sum, when he wrote and whether he
 * subscribes or follows leave here: a chatter may see them for a page they do
 * not work (as `clientFanCard` shows), never a message or a fact of that page.
 */

/** His own message counts this long, money however old: a word of last year with no money behind it says nothing today. */
const WROTE_WITHIN_DAYS = 90;

export interface OtherPage {
  pageLabel: string;
  /** What he paid there; 0: nothing. */
  grossMills: number;
  /** His own newest message there, however old; null: none known. */
  lastFanMessageAt: string | null;
  /** Whether he subscribes to or follows that page now; null: neither. */
  relation: "subscriber" | "follower" | null;
}

/** By fan: the biggest money first, then the freshest word. A fan with none has no entry. */
export async function readOtherPages(
  db: Database,
  input: { pageId: number; fanIds: readonly number[] },
): Promise<Map<number, OtherPage[]>> {
  const pages = new Map<number, OtherPage[]>();
  if (input.fanIds.length === 0) return pages;
  const result = await db.execute<{
    fan_id: string | number;
    label: string;
    gross: string | number;
    wrote_at: Date | string | null;
    is_subscriber: boolean;
    is_follower: boolean;
  }>(sql`
    select f.fan_id, other.label, coalesce(s.gross_amount_mills, 0) as gross, t.wrote_at,
           coalesce(pf.is_subscriber, false) as is_subscriber, coalesce(pf.is_follower, false) as is_follower
    from unnest(${sql.param(input.fanIds.map(String))}::bigint[]) as f(fan_id)
    join pages asked on asked.id = ${input.pageId}
    join pages other on other.platform = asked.platform and other.id <> asked.id and other.deleted_at is null
    left join fan_spend_lifetime s on s.platform_account_id = other.id and s.fan_id = f.fan_id
    left join page_fans pf on pf.platform_account_id = other.id and pf.fan_id = f.fan_id
    left join lateral (
      select max(th.last_fan_message_at) as wrote_at
      from page_dm_threads th
      where th.platform_account_id = other.id and th.fan_id = f.fan_id
    ) t on true
    where coalesce(s.gross_amount_mills, 0) > 0
       or t.wrote_at > now() - make_interval(days => ${WROTE_WITHIN_DAYS})
    order by coalesce(s.gross_amount_mills, 0) desc, t.wrote_at desc nulls last, other.label`);
  for (const row of result.rows) {
    const fanId = Number(row.fan_id);
    const fanPages = pages.get(fanId) ?? [];
    fanPages.push({
      pageLabel: row.label,
      grossMills: Math.max(0, millsToNumber(row.gross)),
      lastFanMessageAt: row.wrote_at === null ? null : new Date(row.wrote_at).toISOString(),
      relation: row.is_subscriber ? "subscriber" : row.is_follower ? "follower" : null,
    });
    pages.set(fanId, fanPages);
  }
  return pages;
}

/** The same for a list the client made itself: by the fans' platform ids, only those with another page. */
export async function readOtherPagesByRefs(
  db: Database,
  input: { pageId: number; platform: typeof fans.$inferSelect["platform"]; fanRefs: readonly string[] },
): Promise<Array<{ fanRef: string; otherPages: OtherPage[] }>> {
  if (input.fanRefs.length === 0) return [];
  const known = await db
    .select({ id: fans.id, fanRef: fans.platformUserId })
    .from(fans)
    .where(and(eq(fans.platform, input.platform), inArray(fans.platformUserId, [...input.fanRefs])));
  const pages = await readOtherPages(db, { pageId: input.pageId, fanIds: known.map((fan) => fan.id) });
  return known.flatMap(({ id, fanRef }) => {
    const otherPages = pages.get(id);
    return otherPages === undefined ? [] : [{ fanRef, otherPages }];
  });
}
