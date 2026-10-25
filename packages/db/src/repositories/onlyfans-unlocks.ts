import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Which OnlyFans message purchase paid for which unlocked message. OnlyFans
// marks the message bought (`page_dm_messages.purchased_at`) and books the
// money as a separate `message_purchase` transaction with no link between the
// two: Hub pairs them per chat, one to one — each unlock takes at most one
// purchase and each purchase pays for at most one unlock — within
// UNLOCK_WINDOW_MS, a pair at the message's price before one whose price Hub
// does not know, the closest in time first. Two PPVs of one price unlocked a
// few minutes apart get one purchase each; a purchase is never counted twice.
// Used by the shift report's sale facts and «Продажи».

export const UNLOCK_WINDOW_MS = 3 * 60_000;
/** How far around the asked times the pairing reads the chat: unlocks and purchases near the edges compete too. */
const READ_MARGIN_MS = 10 * 60_000;

export interface UnlockCandidate {
  messageRef: string;
  at: number;
  /** The message's price from the archive; null when Hub does not hold it. */
  priceMills: number | null;
}

export interface PurchaseCandidate {
  transactionId: number;
  at: number;
  grossMills: number;
  netMills: number;
}

/** One chat's unlocks paired with its purchases, one to one (see the file's header). Pure. */
export function pairUnlocksWithPurchases(
  unlocks: readonly UnlockCandidate[],
  purchases: readonly PurchaseCandidate[],
): Array<{ unlock: UnlockCandidate; purchase: PurchaseCandidate }> {
  const pairs: Array<{ unlock: UnlockCandidate; purchase: PurchaseCandidate; priced: boolean; gap: number }> = [];
  for (const unlock of unlocks) {
    for (const purchase of purchases) {
      const gap = Math.abs(unlock.at - purchase.at);
      if (gap > UNLOCK_WINDOW_MS) continue;
      if (unlock.priceMills !== null && unlock.priceMills !== purchase.grossMills) continue;
      pairs.push({ unlock, purchase, priced: unlock.priceMills !== null, gap });
    }
  }
  pairs.sort((a, b) => Number(b.priced) - Number(a.priced) || a.gap - b.gap || a.unlock.at - b.unlock.at
    || a.purchase.at - b.purchase.at || a.unlock.messageRef.localeCompare(b.unlock.messageRef) || a.purchase.transactionId - b.purchase.transactionId);
  const takenUnlocks = new Set<string>();
  const takenPurchases = new Set<number>();
  const matched: Array<{ unlock: UnlockCandidate; purchase: PurchaseCandidate }> = [];
  for (const pair of pairs) {
    if (takenUnlocks.has(pair.unlock.messageRef) || takenPurchases.has(pair.purchase.transactionId)) continue;
    takenUnlocks.add(pair.unlock.messageRef);
    takenPurchases.add(pair.purchase.transactionId);
    matched.push({ unlock: pair.unlock, purchase: pair.purchase });
  }
  return matched;
}

export interface OnlyfansUnlockMatch {
  pageId: number;
  /** The chat: on OnlyFans the fan's platform id. */
  fanRef: string;
  messageRef: string;
  transactionId: number;
  netMills: number;
}

/**
 * The pairs of these OnlyFans chats whose unlock or purchase lies in [from, to]
 * (both read with a margin, so the pairing does not depend on where the asked
 * window cuts the chat).
 */
export async function listOnlyfansUnlockMatches(
  db: Database,
  input: { chats: ReadonlyArray<{ pageId: number; fanRef: string }>; from: Date; to: Date },
): Promise<OnlyfansUnlockMatch[]> {
  const chats = [...new Map(input.chats.map((chat) => [`${chat.pageId}:${chat.fanRef}`, chat])).values()];
  if (chats.length === 0) return [];
  const pages = sql`${sql.param(chats.map((chat) => String(chat.pageId)))}::bigint[]`;
  const fans = sql`${sql.param(chats.map((chat) => chat.fanRef))}::text[]`;
  const from = sql`${new Date(input.from.getTime() - READ_MARGIN_MS).toISOString()}::timestamptz`;
  const to = sql`${new Date(input.to.getTime() + READ_MARGIN_MS).toISOString()}::timestamptz`;
  const [unlocks, purchases] = await Promise.all([
    db.execute<{ page_id: string | number; fan_ref: string; message_ref: string; at: Date | string; price_mills: string | number | null }>(sql`
      select th.platform_account_id as page_id, th.platform_conversation_id as fan_ref, d.platform_message_id as message_ref,
        d.purchased_at as at, ma.price_mills
      from unnest(${pages}, ${fans}) as c(page_id, fan_ref)
      join page_dm_threads th on th.platform_account_id = c.page_id and th.platform_conversation_id = c.fan_ref
      join page_dm_messages d on d.conversation_id = th.id
      left join message_archive ma on ma.account_id = th.platform_account_id and ma.platform = 'onlyfans' and ma.message_ref = d.platform_message_id
      where d.purchased_at >= ${from} and d.purchased_at <= ${to}`),
    db.execute<{ page_id: string | number; fan_ref: string; id: string | number; at: Date | string; gross: string | number; net: string | number }>(sql`
      select t.platform_account_id as page_id, f.platform_user_id as fan_ref, t.id, t.occurred_at as at,
        t.gross_amount_mills as gross, t.creator_net_amount_mills as net
      from unnest(${pages}, ${fans}) as c(page_id, fan_ref)
      join fans f on f.platform = 'onlyfans' and f.platform_user_id = c.fan_ref
      join transactions t on t.fan_id = f.id and t.platform_account_id = c.page_id
      where t.canonical_type = 'message_purchase' and t.is_active
        and t.occurred_at >= ${from} and t.occurred_at <= ${to}`),
  ]);
  const byChat = new Map<string, { unlocks: UnlockCandidate[]; purchases: PurchaseCandidate[] }>();
  const chatOf = (pageId: string | number, fanRef: string) => {
    const key = `${Number(pageId)}:${fanRef}`;
    const chat = byChat.get(key) ?? { unlocks: [], purchases: [] };
    byChat.set(key, chat);
    return chat;
  };
  for (const row of unlocks.rows) {
    chatOf(row.page_id, row.fan_ref).unlocks.push({
      messageRef: row.message_ref, at: new Date(row.at).getTime(), priceMills: row.price_mills === null ? null : Number(row.price_mills),
    });
  }
  for (const row of purchases.rows) {
    chatOf(row.page_id, row.fan_ref).purchases.push({
      transactionId: Number(row.id), at: new Date(row.at).getTime(), grossMills: Number(row.gross), netMills: Number(row.net),
    });
  }
  const matches: OnlyfansUnlockMatch[] = [];
  for (const [key, chat] of byChat) {
    const [pageId, fanRef] = [Number(key.slice(0, key.indexOf(":"))), key.slice(key.indexOf(":") + 1)];
    for (const { unlock, purchase } of pairUnlocksWithPurchases(chat.unlocks, chat.purchases)) {
      matches.push({ pageId, fanRef, messageRef: unlock.messageRef, transactionId: purchase.transactionId, netMills: purchase.netMills });
    }
  }
  return matches;
}
