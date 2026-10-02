import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import type { DmSenderRole } from "../page-dm.ts";
import { textArrayParam, toDate, toRequiredDate } from "./values.ts";

// The Fansly Sync Engine's DM message reads (design §5.4): what its
// `dm-messages` resource reads besides the thread and its chain — the stored
// rows a journaled page is replayed against, and which order sidecars of a
// page the media plane has not recorded yet. Read-only.

export interface StoredDmMessageForReplay {
  platformMessageId: string;
  senderRole: DmSenderRole;
  createdAt: Date;
  content: string;
  totalTipAmountCents: number;
  syncedAt: Date;
  deletedAt: Date | null;
}

/** The stored rows of these message ids in one thread (deleted ones too). */
export async function listStoredDmMessagesForReplay(
  db: Database,
  input: { conversationId: number; platformMessageIds: readonly string[] },
): Promise<StoredDmMessageForReplay[]> {
  const ids = [...new Set(input.platformMessageIds)];
  if (ids.length === 0) return [];
  const result = await db.execute<{
    platformMessageId: string;
    senderRole: DmSenderRole;
    createdAt: Date | string;
    content: string;
    totalTipAmountCents: number | string;
    syncedAt: Date | string;
    deletedAt: Date | string | null;
  }>(sql`
    select m.platform_message_id as "platformMessageId",
           m.sender_role::text as "senderRole",
           m.created_at as "createdAt",
           m.content,
           m.total_tip_amount_cents as "totalTipAmountCents",
           m.synced_at as "syncedAt",
           m.deleted_at as "deletedAt"
      from page_dm_messages m
     where m.conversation_id = ${input.conversationId}
       and m.platform_message_id = any(${textArrayParam(ids)})
  `);
  return result.rows.map((row) => ({
    platformMessageId: row.platformMessageId,
    senderRole: row.senderRole,
    createdAt: toRequiredDate(row.createdAt),
    content: row.content,
    totalTipAmountCents: Number(row.totalTipAmountCents),
    syncedAt: toRequiredDate(row.syncedAt),
    deletedAt: toDate(row.deletedAt),
  }));
}

export interface SidecarOrderKey {
  /** `media_orders.media_offer_ref`: the bundle id, else the media id. */
  mediaOfferRef: string;
  buyerPlatformUserId: string;
  /** The order instant; compared to the second (the media plane's identity). */
  orderedAt: Date;
}

/**
 * Which of these order sidecars `media_orders` does not hold yet (by the
 * media plane's composite identity, to the second): the orders a DM page shows
 * for the first time. Returns their indexes in input order.
 */
export async function listUnrecordedMediaOrders(
  db: Database,
  input: { pageId: number; orders: readonly SidecarOrderKey[] },
): Promise<number[]> {
  if (input.orders.length === 0) return [];
  const result = await db.execute<{ ord: string }>(sql`
    select o.ord::text as ord
      from unnest(
             ${textArrayParam(input.orders.map((order) => order.mediaOfferRef))},
             ${textArrayParam(input.orders.map((order) => order.buyerPlatformUserId))},
             ${textArrayParam(input.orders.map((order) => order.orderedAt.toISOString()))}::timestamptz[]
           ) with ordinality as o(media_offer_ref, buyer, ordered_at, ord)
     where not exists (
       select 1 from media_orders mo
        where mo.page_id = ${input.pageId}
          and mo.media_offer_ref = o.media_offer_ref
          and mo.buyer_platform_user_id = o.buyer
          and date_trunc('second', mo.occurred_at) = date_trunc('second', o.ordered_at)
     )
     order by o.ord
  `);
  return result.rows.map((row) => Number(row.ord) - 1);
}
