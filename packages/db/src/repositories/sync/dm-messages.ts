import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { textArrayParam } from "./values.ts";

// The Fansly Sync Engine's DM message reads (design §5.4): what its
// `dm-messages` resource reads besides the thread and its chain — which order
// sidecars of a page the media plane has not recorded yet. Read-only.

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
