import { millsToNumber } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

/**
 * What fans paid on OTHER pages of the asked page's platform, any model: the
 * short mark on a fan in a chatter's lists, so a fan who spends on lora-2 is not
 * greeted on lora-1 as a cold follower.
 *
 * One statement per answer, never one per fan: it rides the lists a client
 * already reads, «Онлайн» among them, every minute (about 1 ms for 200 fans on
 * production, 2026-11-02). A fan is `fans.id`, one identity across the pages of
 * one platform. Only the page's label and the sum leave here: a chatter may see
 * them for a page they do not work (as `clientFanCard` shows), never a message
 * or a fact of that page.
 */

export interface OtherPageSpend {
  pageLabel: string;
  grossMills: number;
}

/** By fan, the biggest first, only sums above zero; a fan with none has no entry. */
export async function readOtherPagesSpend(
  db: Database,
  input: { pageId: number; fanIds: readonly number[] },
): Promise<Map<number, OtherPageSpend[]>> {
  const spend = new Map<number, OtherPageSpend[]>();
  if (input.fanIds.length === 0) return spend;
  const result = await db.execute<{ fan_id: string | number; label: string; gross: string | number }>(sql`
    select s.fan_id, other.label, s.gross_amount_mills as gross
    from fan_spend_lifetime s
    join pages asked on asked.id = ${input.pageId}
    join pages other on other.id = s.platform_account_id and other.platform = asked.platform and other.deleted_at is null
    where s.fan_id = any(${sql.param(input.fanIds.map(String))}::bigint[])
      and s.platform_account_id <> ${input.pageId}
      and s.gross_amount_mills > 0
    order by s.gross_amount_mills desc, other.label`);
  for (const row of result.rows) {
    const fanId = Number(row.fan_id);
    const pages = spend.get(fanId) ?? [];
    pages.push({ pageLabel: row.label, grossMills: millsToNumber(row.gross) });
    spend.set(fanId, pages);
  }
  return spend;
}
