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
 * The observation origins that queue a media item for per-media statistics:
 * the ones that show it OUTSIDE a DM. `post` is a post's own media and the
 * members of a bundle on a post (the timeline serves both as `accountMedia`);
 * `stats_agg` is the account statistics' top-media ranking, which is what names
 * an item in `stats_top_media`.
 *
 * Everything else is left out, and on purpose. `dm_sidecar` is a DM thread, and
 * the per-media views of media the model sent only in DMs are not wanted (owner
 * decision 2026-09-29: ~10 k of a 19 k queue, 3 % of the views).
 * `order_history` shares the DM sidecar shapes and names what fans bought,
 * mostly DM PPV. `vault` and `account_media_batch` list the whole vault, DM-only
 * media included. A post's media seen first through any of them is queued the
 * day a post observation carries it.
 */
export const MEDIA_STATS_QUEUE_ORIGINS: ReadonlySet<string> = new Set(["post", "stats_agg"]);

/**
 * The media head, AND — in the SAME TRANSACTION — the WP-F4 per-media
 * statistics queue row for it.
 *
 * Why the two writes are one transaction. The queue is capture-plane
 * operational state (§3.4) keyed on the media offer ref, and its whole contract
 * is "every media the PAGE OWNS and shows OUTSIDE A DM has a refresh row" (the
 * two checks at the end of this comment). Such a media row committed without
 * its queue row is a media item the per-media lane will never
 * look at, and nothing downstream would notice: its traffic history would simply
 * be missing forever, with a healthy lane and a clean coverage row. Seeding on a
 * timer instead leaves the same hole for however long the timer is — and the
 * seeding sweep is itself bounded by a daily call budget, so "however long" can
 * be days. It is exactly the argument WP-F5 made for `creator_posts`, and it is
 * why WP-F4's own first-enable seeding only has to run ONCE.
 *
 * The queue insert runs on every upsert, not only the applied ones: the head
 * upsert is guarded (a replayed older capture writes nothing), and a media item
 * whose head did not move still needs its queue row to exist. On an existing
 * row it writes one column only, `media_shown_outside_dm_at` (below), and only
 * when that moves earlier. The visit state is never touched, which is what
 * makes a `creator_media` truncate-and-replay leave it as it was instead of
 * re-marking the whole catalogue as first-sight.
 *
 * FANSLY ONLY, decided in SQL rather than in TypeScript — `/it/moie/statsnew`
 * is a Fansly route and an OnlyFans media item has no per-media series to queue.
 *
 * AND ONLY WHAT THE PAGE OWNS. A DM sidecar carries every media in the thread,
 * the ones fans SENT included, and the route cannot serve another account's
 * media offer: every such row was a guaranteed `error getting media offer`
 * (prod: ~3.6k queued, none ever answered). The media head is still written —
 * other readers want it — but the queue row is skipped when the media's owner
 * and the page's own account ref are both known and differ; either one unknown
 * fails open. `creator_media` keeps no owner, so the chunk query cannot tell
 * such rows apart; the ones queued before this check are removed by the
 * owner-run one-off `fansly:media-stats-prune-foreign`, which reads the owner
 * from the events.
 *
 * AND ONLY FROM AN ORIGIN THAT SHOWS IT OUTSIDE A DM (`MEDIA_STATS_QUEUE_ORIGINS`).
 * The origin is the observation's, not the head's `first_origin`: a media first
 * seen in a DM keeps that first origin for good, and is queued by the first
 * post observation that carries it. A DM-only head with no queue row is this
 * rule working, not the hole above. The rows queued before this check are
 * removed by the owner-run one-off `fansly:media-stats-prune-dm-only`.
 *
 * AND THE ROW RECORDS THAT IT WAS SHOWN (`media_shown_outside_dm_at`, 0222):
 * the earliest such observation's instant, set on a new row and on one a DM
 * sidecar queued before the check. It is the repair's evidence that the media
 * is not DM-only, and it is written HERE, in the statement that queues, because
 * the repair's other evidence is not: a post's attachments reach
 * `creator_posts` through another projector, which may run after this one. On a
 * row the repair is deleting at the same moment, the upsert waits for it and
 * then inserts the row again.
 */
export async function upsertCreatorMedia(
  db: Database,
  input: UpsertCreatorMediaInput,
): Promise<{ applied: boolean }> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const head = await upsertCreatorMediaHead(database, input);
    if (!MEDIA_STATS_QUEUE_ORIGINS.has(input.firstOrigin)) {
      return head;
    }
    await database.execute(sql`
      insert into subject_refresh_state (
        page_id, plane, subject_ref, refresh_class, next_due_at,
        media_shown_outside_dm_at
      )
      select ${input.pageId}, 'media_stats', ${input.mediaOfferRef}, 'fresh',
             ${input.observedAt}, ${input.observedAt}
       where ${input.platform} = 'fansly'
         and coalesce(
           ${input.ownerAccountRef ?? null}::text = (
             select p.external_page_id from pages p where p.id = ${input.pageId}
           ),
           true
         )
      on conflict (page_id, plane, subject_ref) do update
        set media_shown_outside_dm_at = excluded.media_shown_outside_dm_at,
            updated_at = now()
        where subject_refresh_state.media_shown_outside_dm_at is null
           or subject_refresh_state.media_shown_outside_dm_at
                > excluded.media_shown_outside_dm_at
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

// ── R20 HF-7а: the Fansly transcript's media labels ─────────────────────────
//
// The archive row keeps a Fansly message's attachments as `media_metadata`
// (id, MIME type, `bundle` or `other`), in id order. Three things it does not
// keep are read here, from the media plane of the same observations: where
// each attachment sits in the message and what kind of content it is (a
// tip's attachment is not media), the members of a bundle, and the kind of a
// media the archive row never named (a socket message carries ids only).

/** One attachment of a Fansly message, as the media plane recorded it. */
export interface FanslyMessageOfferRow {
  messageRef: string;
  /** The attachment's content id: a media offer, a bundle, a tip... */
  contentRef: string;
  /** Its place in the message: Fansly's `pos`, else its index. */
  ordinal: number;
  /** Fansly's attachment `contentType`: 1 a media, 2 a bundle, 7 a tip. */
  contentType: number | null;
  /** R20 HF-7в: the `permissions.permissionFlags[]` rows the page served for
   *  the attachment's media or bundle, verbatim (empty when it served none):
   *  whether the attachment is paid, and its price, are read from them. */
  permissionEntries: unknown[];
}

/** The attachments of these Fansly messages of a page, each message's in
 *  position order. A message the media plane has not recorded is absent. */
export async function listFanslyMessageOffers(
  db: Database,
  input: { pageId: number; messageRefs: readonly string[] },
): Promise<FanslyMessageOfferRow[]> {
  if (input.messageRefs.length === 0) {
    return [];
  }
  const result = await db.execute<{
    message_ref: string;
    media_offer_ref: string;
    offer_ordinal: number;
    offer_type: number | null;
    permission_entries: unknown;
  }>(sql`
    select message_ref, media_offer_ref, offer_ordinal, offer_type, permission_entries
    from message_media_offers
    where page_id = ${input.pageId}
      and platform = 'fansly'
      and message_ref = any(${textArrayParam(input.messageRefs)})
      and media_offer_ref is not null
    order by message_ref, offer_ordinal
  `);
  return result.rows.map((row) => ({
    messageRef: row.message_ref,
    contentRef: row.media_offer_ref,
    ordinal: Number(row.offer_ordinal),
    contentType: row.offer_type === null ? null : Number(row.offer_type),
    permissionEntries: Array.isArray(row.permission_entries) ? row.permission_entries : [],
  }));
}

/** What kind of file a Fansly media offer is: Fansly's media `type` and the
 *  file's MIME type, as the page served them. */
export interface FanslyMediaKindRow {
  mediaType: number | null;
  mimeType: string | null;
}

export interface FanslyMediaKinds {
  /** Bundle ref → its members in order, each with its kind, or null for a
   *  member the page never served. A bundle the page never served is absent. */
  bundles: Map<string, Array<{ ref: string; media: FanslyMediaKindRow | null }>>;
  /** Media offer ref → its kind; a media the page never served is absent. */
  media: Map<string, FanslyMediaKindRow>;
}

/** The members of these Fansly bundles and the kinds of these media offers
 *  of a page (creator_media_bundles, creator_media). */
export async function readFanslyMediaKinds(
  db: Database,
  input: { pageId: number; bundleRefs: readonly string[]; mediaRefs: readonly string[] },
): Promise<FanslyMediaKinds> {
  const kinds: FanslyMediaKinds = { bundles: new Map(), media: new Map() };
  const kindOf = (row: { media_type: number | null; mime_type: string | null }): FanslyMediaKindRow => ({
    mediaType: row.media_type === null ? null : Number(row.media_type),
    mimeType: row.mime_type,
  });
  if (input.bundleRefs.length > 0) {
    const result = await db.execute<{
      bundle_ref: string;
      member_ref: string | null;
      known: boolean;
      media_type: number | null;
      mime_type: string | null;
    }>(sql`
      select b.bundle_ref, m.ref as member_ref, cm.media_offer_ref is not null as known,
        cm.media_type, cm.mime_type
      from creator_media_bundles b
      left join lateral unnest(b.member_refs) with ordinality as m(ref, ord) on true
      left join creator_media cm
        on cm.page_id = b.page_id and cm.platform = b.platform and cm.media_offer_ref = m.ref
      where b.page_id = ${input.pageId}
        and b.platform = 'fansly'
        and b.bundle_ref = any(${textArrayParam(input.bundleRefs)})
      order by b.bundle_ref, m.ord
    `);
    for (const row of result.rows) {
      const members = kinds.bundles.get(row.bundle_ref) ?? [];
      kinds.bundles.set(row.bundle_ref, members);
      if (row.member_ref !== null) {
        members.push({ ref: row.member_ref, media: row.known === true ? kindOf(row) : null });
      }
    }
  }
  if (input.mediaRefs.length > 0) {
    const result = await db.execute<{
      media_offer_ref: string;
      media_type: number | null;
      mime_type: string | null;
    }>(sql`
      select media_offer_ref, media_type, mime_type
      from creator_media
      where page_id = ${input.pageId}
        and platform = 'fansly'
        and media_offer_ref = any(${textArrayParam(input.mediaRefs)})
    `);
    for (const row of result.rows) {
      kinds.media.set(row.media_offer_ref, kindOf(row));
    }
  }
  return kinds;
}

/** A Fansly media offer as the image notes of a hub-loaded transcript read it
 *  (modules/ai/context/fansly-media-notes.ts): its kind, whether it has a
 *  free teaser, and its permission rows (whether it is paid). */
export interface FanslyMediaNoteFactsRow extends FanslyMediaKindRow {
  previewRef: string | null;
  permissionEntries: unknown[];
}

/** These Fansly media offers of a page as creator_media holds them; a media
 *  the page never served is absent. */
export async function readFanslyMediaNoteFacts(
  db: Database,
  input: { pageId: number; mediaRefs: readonly string[] },
): Promise<Map<string, FanslyMediaNoteFactsRow>> {
  const facts = new Map<string, FanslyMediaNoteFactsRow>();
  if (input.mediaRefs.length === 0) {
    return facts;
  }
  const result = await db.execute<{
    media_offer_ref: string;
    media_type: number | null;
    mime_type: string | null;
    preview_ref: string | null;
    permission_entries: unknown;
  }>(sql`
    select media_offer_ref, media_type, mime_type, preview_ref, permission_entries
    from creator_media
    where page_id = ${input.pageId}
      and platform = 'fansly'
      and media_offer_ref = any(${textArrayParam([...new Set(input.mediaRefs)])})
  `);
  for (const row of result.rows) {
    facts.set(row.media_offer_ref, {
      mediaType: row.media_type === null ? null : Number(row.media_type),
      mimeType: row.mime_type,
      previewRef: row.preview_ref === "" ? null : row.preview_ref,
      permissionEntries: Array.isArray(row.permission_entries) ? row.permission_entries : [],
    });
  }
  return facts;
}

// ── R20 HF-7в: did the Fansly fan buy a paid attachment ─────────────────────
//
// «Bought» is an order of the fan in media_orders. «Not bought» needs more than
// the absence of one: the hub must have read the target's whole order history
// (the Sync Engine's `purchases.targets` walk, one work row per media or
// bundle, apps/runtime/src/sync/fansly/resources/purchases.ts) and every order
// that walk read must have reached media_orders. Three facts per target say
// whether it has: the target's latest walk, whether every page its walks read
// is canonicalized (the engine journals a page; the minutely driver turns it
// into `media.order_observed`), and whether an order of this fan still waits
// above the media plane's watermark.

/** The Sync Engine's purchase walks (`PURCHASES_TARGETS_KEY`). */
export const FANSLY_PURCHASE_WALK_RESOURCE = "purchases.targets";
/** The media-plane projector (`MEDIA_PLANE_PROJECTION`): the writer of media_orders. */
export const MEDIA_PLANE_PROJECTION_NAME = "media_plane";

export type FanslyPurchaseTargetKind = "media" | "bundle";

/** A target's walk subject, as the purchases resource names it. */
export function fanslyPurchaseWalkSubject(target: { kind: FanslyPurchaseTargetKind; ref: string }): string {
  return `${target.kind}:${target.ref}`;
}

export interface FanslyPurchaseOrderRow {
  /** The order's media or bundle (a bundle order's bundle id). */
  mediaOfferRef: string;
  /** Set when the order row named its bundle apart (`accountMediaBundleId`). */
  bundleRef: string | null;
  /** Fansly's order `type`: 1 a single media, 2 a bundle. */
  orderType: number | null;
}

export interface FanslyPurchaseWalkRow {
  /** The latest walk's state and why it closed. */
  state: string;
  closeReason: string | null;
  /** A page one of the target's walks read is not canonicalized yet. */
  pagesPending: boolean;
}

export interface FanslyPurchaseFacts {
  /** The fan's orders of the targets (media_orders). */
  orders: FanslyPurchaseOrderRow[];
  /** By walk subject (`media:<id>` | `bundle:<id>`); a target never walked is absent. */
  walks: Map<string, FanslyPurchaseWalkRow>;
  /** The targets with an order of the fan the media plane has not projected yet. */
  ordersPending: Set<string>;
}

/**
 * What the hub knows about one fan's purchases of these targets of a Fansly
 * page. Three indexed reads: media_orders by its key, the targets' walk rows
 * (`sync_work_key_recent`), and the page's events above the media plane's
 * watermark (`(account_id, account_seq)`). Shadow walks are not the page's.
 */
export async function readFanslyPurchaseFacts(
  db: Database,
  input: {
    pageId: number;
    buyerRef: string;
    targets: ReadonlyArray<{ kind: FanslyPurchaseTargetKind; ref: string }>;
  },
): Promise<FanslyPurchaseFacts> {
  const facts: FanslyPurchaseFacts = { orders: [], walks: new Map(), ordersPending: new Set() };
  if (input.targets.length === 0) {
    return facts;
  }
  const refs = textArrayParam([...new Set(input.targets.map((target) => target.ref))]);
  const subjects = textArrayParam([...new Set(input.targets.map(fanslyPurchaseWalkSubject))]);

  const orders = await db.execute<{ media_offer_ref: string; bundle_ref: string | null; order_type: number | null }>(sql`
    select media_offer_ref, bundle_ref, order_type
    from media_orders
    where page_id = ${input.pageId}
      and platform = 'fansly'
      and buyer_platform_user_id = ${input.buyerRef}
      and media_offer_ref = any(${refs})
    order by media_offer_ref, occurred_at
  `);
  facts.orders = orders.rows.map((row) => ({
    mediaOfferRef: row.media_offer_ref,
    bundleRef: row.bundle_ref,
    orderType: row.order_type === null ? null : Number(row.order_type),
  }));

  const walks = await db.execute<{ subject: string; state: string; close_reason: string | null; pages_pending: boolean }>(sql`
    select distinct on (w.subject) w.subject, w.state, w.close_reason,
      exists (
        select 1
          from sync_work earlier
          join sync_attempts a on a.work_id = earlier.id
          join observations o on o.id = a.observation_id and o.received_at = a.observation_received_at
         where earlier.page_id = w.page_id
           and earlier.resource = w.resource
           and earlier.subject = w.subject
           and earlier.shadow = false
           and earlier.id <= w.id
           and o.kind = 'purchase_history'
           and o.parse_version = 0
      ) as pages_pending
    from sync_work w
    where w.page_id = ${input.pageId}
      and w.resource = ${FANSLY_PURCHASE_WALK_RESOURCE}
      and w.shadow = false
      and w.subject = any(${subjects})
    order by w.subject, w.id desc
  `);
  for (const row of walks.rows) {
    facts.walks.set(row.subject, {
      state: row.state,
      closeReason: row.close_reason,
      pagesPending: row.pages_pending === true,
    });
  }

  const pending = await db.execute<{ ref: string }>(sql`
    select distinct de.data->>'mediaOfferRef' as ref
    from domain_events de
    where de.account_id = ${input.pageId}
      and de.account_seq > coalesce((
        select w.high_seq from projection_seq_watermarks w
         where w.projection = ${MEDIA_PLANE_PROJECTION_NAME} and w.account_id = ${input.pageId}
      ), 0)
      and de.type = 'media.order_observed'
      and de.fan_identity_ref = ${input.buyerRef}
      and de.data->>'mediaOfferRef' = any(${refs})
  `);
  for (const row of pending.rows) {
    if (row.ref !== null) facts.ordersPending.add(row.ref);
  }
  return facts;
}
