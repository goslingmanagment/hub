// WP-F0(b) media plane: the four rebuildable projections behind
// "what was sold, to whom, for how much".
//
// Every writer here is a guarded upsert with the same precedence rule the
// creator-posts projection uses: the NEWER OBSERVATION wins, with account_seq
// as the deterministic same-instant tie-break — ledger order is append order,
// not observation order, so a replay of an older capture must never overwrite
// a fresher head. first_observed_at only ever moves backwards.
//
// Money is mills, and a NULL sale counter means "the platform did not serve
// this" — never zero. The read layer must not coalesce it.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  isDmArchiveScopeFenced,
  tryAcquireDmArchiveWriterFenceLock,
} from "./erasure-fence.ts";

export type MediaPlanePlatform = "fansly" | "onlyfans";

/** Shared precedence guard: excluded wins on a newer observation instant, or
 *  on the same instant with a higher account_seq. */
function newerWins(table: string) {
  const current = sql.identifier(table);
  return sql`
    excluded.last_observed_at > ${current}.last_observed_at
    or (
      excluded.last_observed_at = ${current}.last_observed_at
      and excluded.source_account_seq > ${current}.source_account_seq
    )
  `;
}

function pick(table: string, column: string): SQL {
  const current = sql.identifier(table);
  const name = sql.identifier(column);
  return sql`case when ${newerWins(table)} then excluded.${name} else ${current}.${name} end`;
}

function millsParam(value: bigint | null): SQL {
  return value === null ? sql`null` : sql`${value.toString()}::bigint`;
}

/**
 * ONE bound parameter carrying a Postgres array literal, then cast.
 *
 * Not `sql`${array}`` — drizzle expands an array chunk into a comma-separated
 * parameter LIST, so an EMPTY array expands to nothing and the statement
 * becomes `values (..., ::text[], ...)`: a syntax error at runtime, on exactly
 * the common case (a media row that belongs to no bundle).
 */
function textArrayParam(values: readonly string[]): SQL {
  const literal = `{${
    values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")
  }}`;
  return sql`${literal}::text[]`;
}

export interface UpsertCreatorMediaInput {
  pageId: number;
  platform: MediaPlanePlatform;
  mediaOfferRef: string;
  mediaRef: string | null;
  previewRef: string | null;
  bundleRefs: readonly string[];
  mediaType: number | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  priceMills: bigint | null;
  permissionEntries: unknown[];
  permissionFlags: number | null;
  likeCount: number | null;
  salesCount: number | null;
  salesNetMills: bigint | null;
  salesPendingMills: bigint | null;
  createdAtPlatform: Date | null;
  deletedAtPlatform: Date | null;
  firstOrigin: string;
  observedAt: Date;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
  /** The account the media belongs to (`accountMedia.accountId`). It gates the
   *  per-media statistics queue row only; the head is written whoever owns it.
   *  Unknown (null/absent) fails open: the item is queued. */
  ownerAccountRef?: string | null;
}

/**
 * The media head, AND — in the SAME TRANSACTION — the WP-F4 per-media
 * statistics queue row for it.
 *
 * Why the two writes are one transaction. The queue is capture-plane
 * operational state (§3.4) keyed on the media offer ref, and its whole contract
 * is "every media the PAGE OWNS has a refresh row". A media row
 * committed without its queue row is a media item the per-media lane will never
 * look at, and nothing downstream would notice: its traffic history would simply
 * be missing forever, with a healthy lane and a clean coverage row. Seeding on a
 * timer instead leaves the same hole for however long the timer is — and the
 * seeding sweep is itself bounded by a daily call budget, so "however long" can
 * be days. It is exactly the argument WP-F5 made for `creator_posts`, and it is
 * why WP-F4's own first-enable seeding only has to run ONCE.
 *
 * The queue insert is `ON CONFLICT DO NOTHING` and runs on every upsert, not
 * only the applied ones: the head upsert is guarded (a replayed older capture
 * writes nothing), and a media item whose head did not move still needs its
 * queue row to exist. It is a no-op the second time and every time after —
 * which is also what makes a `creator_media` truncate-and-replay leave the queue
 * untouched instead of re-marking the whole catalogue as first-sight.
 *
 * FANSLY ONLY, decided in SQL rather than in TypeScript — `/it/moie/statsnew`
 * is a Fansly route and an OnlyFans media item has no per-media series to queue.
 * The predicate lives in the statement so the platform seam stays where the
 * Stage 18 ratchet expects it: no new strict platform equality outside the
 * adapter packages.
 *
 * AND ONLY WHAT THE PAGE OWNS. A DM sidecar carries every media in the thread,
 * the ones fans SENT included, and the route cannot serve another account's
 * media offer: every such row was a guaranteed `error getting media offer`
 * (prod: ~3.6k queued, none ever answered). The media head is still written —
 * other readers want it — but the queue row is skipped when the media's owner
 * and the page's own account ref are both known and differ; either one unknown
 * fails open. Rows queued before this check stay queued: `creator_media` keeps
 * no owner, so neither the chunk query nor `seedMediaStatsQueue` (first enable
 * only) can tell them apart.
 */
export async function upsertCreatorMedia(
  db: Database,
  input: UpsertCreatorMediaInput,
): Promise<{ applied: boolean }> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const head = await upsertCreatorMediaHead(database, input);
    await database.execute(sql`
      insert into subject_refresh_state (
        page_id, plane, subject_ref, refresh_class, next_due_at
      )
      select ${input.pageId}, 'media_stats', ${input.mediaOfferRef}, 'fresh',
             ${input.observedAt}
       where ${input.platform} = 'fansly'
         and coalesce(
           ${input.ownerAccountRef ?? null}::text = (
             select p.external_page_id from pages p where p.id = ${input.pageId}
           ),
           true
         )
      on conflict (page_id, plane, subject_ref) do nothing
    `);
    return head;
  });
}

async function upsertCreatorMediaHead(
  db: Database,
  input: UpsertCreatorMediaInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into creator_media (
      page_id, platform, media_offer_ref, media_ref, preview_ref, bundle_refs,
      media_type, mime_type, width, height, duration_ms, price_mills,
      permission_entries, permission_flags, like_count, sales_count,
      sales_net_mills, sales_pending_mills, created_at_platform,
      deleted_at_platform, first_origin, first_observed_at, last_observed_at,
      content_hash, source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.mediaOfferRef}, ${input.mediaRef},
      ${input.previewRef}, ${textArrayParam(input.bundleRefs)},
      ${input.mediaType}, ${input.mimeType}, ${input.width}, ${input.height},
      ${input.durationMs}, ${millsParam(input.priceMills)},
      ${JSON.stringify(input.permissionEntries)}::jsonb, ${input.permissionFlags},
      ${input.likeCount}, ${input.salesCount}, ${millsParam(input.salesNetMills)},
      ${millsParam(input.salesPendingMills)}, ${input.createdAtPlatform},
      ${input.deletedAtPlatform}, ${input.firstOrigin}, ${input.observedAt},
      ${input.observedAt}, ${input.contentHash}, ${input.sourceEventId},
      ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, platform, media_offer_ref) do update set
      media_ref = ${pick("creator_media", "media_ref")},
      preview_ref = ${pick("creator_media", "preview_ref")},
      bundle_refs = ${pick("creator_media", "bundle_refs")},
      media_type = ${pick("creator_media", "media_type")},
      mime_type = ${pick("creator_media", "mime_type")},
      width = ${pick("creator_media", "width")},
      height = ${pick("creator_media", "height")},
      duration_ms = ${pick("creator_media", "duration_ms")},
      price_mills = ${pick("creator_media", "price_mills")},
      permission_entries = ${pick("creator_media", "permission_entries")},
      permission_flags = ${pick("creator_media", "permission_flags")},
      like_count = ${pick("creator_media", "like_count")},
      sales_count = ${pick("creator_media", "sales_count")},
      sales_net_mills = ${pick("creator_media", "sales_net_mills")},
      sales_pending_mills = ${pick("creator_media", "sales_pending_mills")},
      created_at_platform = ${pick("creator_media", "created_at_platform")},
      deleted_at_platform = ${pick("creator_media", "deleted_at_platform")},
      content_hash = ${pick("creator_media", "content_hash")},
      source_event_id = ${pick("creator_media", "source_event_id")},
      source_observation_id = ${pick("creator_media", "source_observation_id")},
      source_account_seq = ${pick("creator_media", "source_account_seq")},
      first_observed_at = least(creator_media.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(creator_media.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export interface UpsertCreatorMediaBundleInput {
  pageId: number;
  platform: MediaPlanePlatform;
  bundleRef: string;
  previewRef: string | null;
  priceMills: bigint | null;
  permissionEntries: unknown[];
  permissionFlags: number | null;
  memberRefs: readonly string[];
  memberPositions: unknown[];
  salesCount: number | null;
  salesNetMills: bigint | null;
  salesPendingMills: bigint | null;
  createdAtPlatform: Date | null;
  deletedAtPlatform: Date | null;
  observedAt: Date;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

export async function upsertCreatorMediaBundle(
  db: Database,
  input: UpsertCreatorMediaBundleInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into creator_media_bundles (
      page_id, platform, bundle_ref, preview_ref, price_mills, permission_entries,
      permission_flags, member_refs, member_positions, sales_count,
      sales_net_mills, sales_pending_mills, created_at_platform,
      deleted_at_platform, first_observed_at, last_observed_at, content_hash,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.bundleRef}, ${input.previewRef},
      ${millsParam(input.priceMills)}, ${JSON.stringify(input.permissionEntries)}::jsonb,
      ${input.permissionFlags}, ${textArrayParam(input.memberRefs)},
      ${JSON.stringify(input.memberPositions)}::jsonb, ${input.salesCount},
      ${millsParam(input.salesNetMills)}, ${millsParam(input.salesPendingMills)},
      ${input.createdAtPlatform}, ${input.deletedAtPlatform}, ${input.observedAt},
      ${input.observedAt}, ${input.contentHash}, ${input.sourceEventId},
      ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, bundle_ref) do update set
      preview_ref = ${pick("creator_media_bundles", "preview_ref")},
      price_mills = ${pick("creator_media_bundles", "price_mills")},
      permission_entries = ${pick("creator_media_bundles", "permission_entries")},
      permission_flags = ${pick("creator_media_bundles", "permission_flags")},
      member_refs = ${pick("creator_media_bundles", "member_refs")},
      member_positions = ${pick("creator_media_bundles", "member_positions")},
      sales_count = ${pick("creator_media_bundles", "sales_count")},
      sales_net_mills = ${pick("creator_media_bundles", "sales_net_mills")},
      sales_pending_mills = ${pick("creator_media_bundles", "sales_pending_mills")},
      created_at_platform = ${pick("creator_media_bundles", "created_at_platform")},
      deleted_at_platform = ${pick("creator_media_bundles", "deleted_at_platform")},
      content_hash = ${pick("creator_media_bundles", "content_hash")},
      source_event_id = ${pick("creator_media_bundles", "source_event_id")},
      source_observation_id = ${pick("creator_media_bundles", "source_observation_id")},
      source_account_seq = ${pick("creator_media_bundles", "source_account_seq")},
      first_observed_at = least(
        creator_media_bundles.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(
        creator_media_bundles.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export interface UpsertMediaOrderInput {
  pageId: number;
  platform: MediaPlanePlatform;
  mediaOfferRef: string;
  buyerPlatformUserId: string;
  occurredAt: Date;
  orderRef: string | null;
  bundleRef: string | null;
  orderType: number | null;
  priceMills: bigint | null;
  conversationRef: string | null;
  messageRef: string | null;
  observedAt: Date;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

export async function upsertMediaOrder(
  db: Database,
  input: UpsertMediaOrderInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into media_orders (
      page_id, platform, media_offer_ref, buyer_platform_user_id, occurred_at,
      order_ref, bundle_ref, order_type, price_mills, conversation_ref,
      message_ref, first_observed_at, last_observed_at, content_hash,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.mediaOfferRef},
      ${input.buyerPlatformUserId}, ${input.occurredAt}, ${input.orderRef},
      ${input.bundleRef}, ${input.orderType}, ${millsParam(input.priceMills)},
      ${input.conversationRef}, ${input.messageRef}, ${input.observedAt},
      ${input.observedAt}, ${input.contentHash}, ${input.sourceEventId},
      ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, media_offer_ref, buyer_platform_user_id, occurred_at) do update set
      order_ref = ${pick("media_orders", "order_ref")},
      bundle_ref = ${pick("media_orders", "bundle_ref")},
      order_type = ${pick("media_orders", "order_type")},
      price_mills = ${pick("media_orders", "price_mills")},
      conversation_ref = ${pick("media_orders", "conversation_ref")},
      message_ref = ${pick("media_orders", "message_ref")},
      content_hash = ${pick("media_orders", "content_hash")},
      source_event_id = ${pick("media_orders", "source_event_id")},
      source_observation_id = ${pick("media_orders", "source_observation_id")},
      source_account_seq = ${pick("media_orders", "source_account_seq")},
      first_observed_at = least(media_orders.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(media_orders.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export type MessageMediaOfferPurchaseState = "purchased" | "unpurchased" | "unknown";

export interface UpsertMessageMediaOfferInput {
  pageId: number;
  platform: MediaPlanePlatform;
  messageRef: string;
  offerOrdinal: number;
  mediaOfferRef: string | null;
  bundleRef: string | null;
  conversationRef: string | null;
  fanPlatformUserId: string | null;
  messageCreatedAt: Date | null;
  offerType: number | null;
  mimeType: string | null;
  durationMs: number | null;
  priceMills: bigint | null;
  permissionEntries: unknown[];
  purchaseState: MessageMediaOfferPurchaseState;
  orderRef: string | null;
  salesCount: number | null;
  salesNetMills: bigint | null;
  salesPendingMills: bigint | null;
  observedAt: Date;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

export async function upsertMessageMediaOffer(
  db: Database,
  input: UpsertMessageMediaOfferInput,
): Promise<
  | { status: "applied"; applied: true }
  | { status: "unchanged" | "deferred" | "erasure_fenced"; applied: false }
> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    if (!(await tryAcquireDmArchiveWriterFenceLock(database, input.pageId))) {
      return { status: "deferred", applied: false } as const;
    }
    const materialAt = input.messageCreatedAt !== null && input.messageCreatedAt < input.observedAt
      ? input.messageCreatedAt
      : input.observedAt;
    if (
      await isDmArchiveScopeFenced(database, {
        pageId: input.pageId,
        platform: input.platform,
        refs: [input.fanPlatformUserId, input.conversationRef],
        materialAt,
      })
    ) {
      return { status: "erasure_fenced", applied: false } as const;
    }
    return upsertMessageMediaOfferUnfenced(database, input);
  });
}

async function upsertMessageMediaOfferUnfenced(
  db: Database,
  input: UpsertMessageMediaOfferInput,
): Promise<
  | { status: "applied"; applied: true }
  | { status: "unchanged"; applied: false }
> {
  const result = await db.execute(sql`
    insert into message_media_offers (
      page_id, platform, message_ref, offer_ordinal, media_offer_ref, bundle_ref,
      conversation_ref, fan_platform_user_id, message_created_at, offer_type,
      mime_type, duration_ms, price_mills, permission_entries, purchase_state,
      order_ref, sales_count, sales_net_mills, sales_pending_mills,
      first_observed_at, last_observed_at, content_hash, source_event_id,
      source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.messageRef}, ${input.offerOrdinal},
      ${input.mediaOfferRef}, ${input.bundleRef}, ${input.conversationRef},
      ${input.fanPlatformUserId}, ${input.messageCreatedAt}, ${input.offerType},
      ${input.mimeType}, ${input.durationMs}, ${millsParam(input.priceMills)},
      ${JSON.stringify(input.permissionEntries)}::jsonb, ${input.purchaseState},
      ${input.orderRef}, ${input.salesCount}, ${millsParam(input.salesNetMills)},
      ${millsParam(input.salesPendingMills)}, ${input.observedAt}, ${input.observedAt},
      ${input.contentHash}, ${input.sourceEventId}, ${input.sourceObservationId},
      ${input.sourceAccountSeq}
    )
    on conflict (page_id, message_ref, offer_ordinal) do update set
      media_offer_ref = ${pick("message_media_offers", "media_offer_ref")},
      bundle_ref = ${pick("message_media_offers", "bundle_ref")},
      conversation_ref = ${pick("message_media_offers", "conversation_ref")},
      fan_platform_user_id = ${pick("message_media_offers", "fan_platform_user_id")},
      message_created_at = ${pick("message_media_offers", "message_created_at")},
      offer_type = ${pick("message_media_offers", "offer_type")},
      mime_type = ${pick("message_media_offers", "mime_type")},
      duration_ms = ${pick("message_media_offers", "duration_ms")},
      price_mills = ${pick("message_media_offers", "price_mills")},
      permission_entries = ${pick("message_media_offers", "permission_entries")},
      purchase_state = ${pick("message_media_offers", "purchase_state")},
      order_ref = ${pick("message_media_offers", "order_ref")},
      sales_count = ${pick("message_media_offers", "sales_count")},
      sales_net_mills = ${pick("message_media_offers", "sales_net_mills")},
      sales_pending_mills = ${pick("message_media_offers", "sales_pending_mills")},
      content_hash = ${pick("message_media_offers", "content_hash")},
      source_event_id = ${pick("message_media_offers", "source_event_id")},
      source_observation_id = ${pick("message_media_offers", "source_observation_id")},
      source_account_seq = ${pick("message_media_offers", "source_account_seq")},
      first_observed_at = least(
        message_media_offers.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(
        message_media_offers.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return (result.rowCount ?? 0) > 0
    ? { status: "applied", applied: true }
    : { status: "unchanged", applied: false };
}

export interface ArchiveMessagePurchaseStateRow {
  messageRef: string;
  purchaseState: MessageMediaOfferPurchaseState;
  offerCount: number;
  purchasedCount: number;
  priceMills: string | null;
  orderRef: string | null;
}

/**
 * A17-4 VARIANT B, in one query: purchase state for archived messages, served
 * by JOINING message_media_offers on (page_id, message_ref).
 *
 * This function is the reason `message_archive` gained no columns. A message
 * whose offers are all purchased reads `purchased`; any unpurchased offer
 * makes the message `unpurchased` (something is still for sale in it); no
 * evidence at all reads `unknown`. Messages with no offer row do not appear —
 * absence here means "this capture recorded no offer", never "nothing was
 * sold".
 */
export async function listArchiveMessagePurchaseState(
  db: Database,
  input: { accountId: number; messageRefs: readonly string[] },
): Promise<ArchiveMessagePurchaseStateRow[]> {
  if (input.messageRefs.length === 0) {
    return [];
  }
  const result = await db.execute<{
    message_ref: string;
    purchase_state: string;
    offer_count: string;
    purchased_count: string;
    price_mills: string | null;
    order_ref: string | null;
  }>(sql`
    select
      o.message_ref,
      case
        when count(*) filter (where o.purchase_state = 'unpurchased') > 0 then 'unpurchased'
        when count(*) filter (where o.purchase_state = 'purchased') > 0 then 'purchased'
        else 'unknown'
      end as purchase_state,
      count(*)::text as offer_count,
      count(*) filter (where o.purchase_state = 'purchased')::text as purchased_count,
      max(o.price_mills)::text as price_mills,
      min(o.order_ref) as order_ref
    from message_archive a
    join message_media_offers o
      on o.page_id = a.account_id
     and o.message_ref = a.message_ref
    where a.account_id = ${input.accountId}
      and a.message_ref in ${input.messageRefs}
    group by o.message_ref
    order by o.message_ref
  `);
  return result.rows.map((row) => ({
    messageRef: row.message_ref,
    purchaseState: row.purchase_state as MessageMediaOfferPurchaseState,
    offerCount: Number(row.offer_count),
    purchasedCount: Number(row.purchased_count),
    priceMills: row.price_mills,
    orderRef: row.order_ref,
  }));
}
