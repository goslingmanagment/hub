// Media-plane projection (WP-F0(b)). Consumes the projection-only commerce
// events the sync-pull family emits at v5, behind the standard per-account seq
// watermark (the fan-earnings pattern), and writes the four rebuildable tables
// of migration 0130:
//
//   media.observed                 → creator_media + creator_media_bundles
//   media.order_observed           → media_orders
//   message.attachments_observed   → message_media_offers
//   media.offer_location_observed  → media_offer_locations (WP-F1, A17-5)
//
// WP-F1 extends this projector rather than adding a second writer: `media.observed`
// now arrives from the account-statistics aggregation too (first_origin
// 'stats_agg', 85 media + 8 bundle rows per capture), and this file stays the
// SINGLE writer of creator_media. The new offer-location type is the media ↔
// offer ↔ bundle ↔ carrier join evidence — pure id-relations, no URLs.
//
// The fourth v5 type, `message.material_observed`, is deliberately NOT read
// here: it belongs to the message-archive projector, which already understands
// it. That is the whole of A17-4 variant B — the archive gains Fansly material
// coverage through a channel it already has, and purchase state is served by
// joining message_media_offers on (page_id, message_ref) instead of by adding
// columns to message_archive.
//
// Projectors read EVENTS only — never observations.payload, never
// sync_raw_payloads.

import {
  getPageTransactionsWriterInfo,
  getProjectionWatermark,
  listDetachedPartitionsHoldingAccount,
  listEventAccounts,
  listEventsSince,
  setProjectionWatermark,
  upsertCreatorMedia,
  upsertCreatorMediaBundle,
  upsertMediaOfferLocation,
  upsertMediaOrder,
  upsertMessageMediaOffer,
  type MediaPlanePlatform,
  type MessageMediaOfferPurchaseState,
} from "@agency_hub_core/db";
import { millsFromInteger, type Mills } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import type { AppContext } from "../../bootstrap.ts";

export const MEDIA_PLANE_PROJECTION = "media_plane";

const EVENT_PAGE_SIZE = 500;

const MEDIA_PLANE_EVENT_TYPES = new Set([
  "media.observed",
  "media.order_observed",
  "media.offer_location_observed",
  "message.attachments_observed",
]);

export interface MediaPlaneProjectionResult extends Record<string, unknown> {
  accounts: number;
  eventsSeen: number;
  media: number;
  bundles: number;
  orders: number;
  offers: number;
  locations: number;
}

function eventData(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Event mills travel as decimal STRINGS (JSON cannot carry a bigint, and a
 *  float would re-open the 1000x footgun). Anything else is not money.
 *
 *  Constructed through `millsFromInteger` — the named already-mills constructor
 *  (Stage 27), never a hand-rolled `BigInt(...)`. The shape guards stay in
 *  FRONT of it and are not decoration: the constructor THROWS on a non-digit
 *  string (SyntaxError) and on a non-finite number (RangeError), and a
 *  projector must skip a malformed money field, never crash the sweep. Digits
 *  only ⇒ no sign, no fraction, no exponent; safe non-negative integers only on
 *  the number path, so the constructor's truncation can never silently move a
 *  value. */
function millsOrNull(value: unknown): Mills | null {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return millsFromInteger(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return millsFromInteger(value);
  }
  return null;
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

/** Sale counters are NULL when the platform served no saleStats — never 0. */
function saleColumns(data: Record<string, unknown>) {
  return {
    salesCount: asInt(data.salesCount),
    salesNetMills: millsOrNull(data.salesNetMills),
    salesPendingMills: millsOrNull(data.salesPendingMills),
  };
}

export async function runMediaPlaneProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<MediaPlaneProjectionResult> {
  const totals: MediaPlaneProjectionResult = {
    accounts: 0,
    eventsSeen: 0,
    media: 0,
    bundles: 0,
    orders: 0,
    offers: 0,
    locations: 0,
  };
  const accounts = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);
  const platformCache = new Map<number, string | null>();

  for (const accountId of accounts) {
    totals.accounts += 1;
    if (!platformCache.has(accountId)) {
      const page = await getPageTransactionsWriterInfo(app.db, accountId);
      platformCache.set(accountId, page?.platform ?? null);
    }
    const platform = platformCache.get(accountId) ?? null;
    if (platform !== "fansly" && platform !== "onlyfans") {
      // No page, no platform: the rows would be unattributable. The events
      // stay in the ledger and project the moment the page mapping lands.
      continue;
    }
    const mediaPlatform: MediaPlanePlatform = platform;

    let watermark = await getProjectionWatermark(app.db, MEDIA_PLANE_PROJECTION, accountId);
    for (;;) {
      const events = await listEventsSince(app.db, {
        accountId,
        afterSeq: watermark,
        limit: EVENT_PAGE_SIZE,
      });
      if (events.length === 0) {
        break;
      }
      totals.eventsSeen += events.length;

      for (const event of events) {
        if (!MEDIA_PLANE_EVENT_TYPES.has(event.type)) {
          continue;
        }
        const data = eventData(event.data);
        const lineage = {
          sourceEventId: event.id,
          sourceObservationId: event.observationId,
          sourceAccountSeq: event.accountSeq,
          // Receipt-time events: occurredAt IS the observation instant, which
          // is exactly the freshness ordering these heads need.
          observedAt: event.occurredAt,
          contentHash: asText(data.contentHash) ?? "",
        };
        if (lineage.contentHash.length !== 64) {
          continue;
        }

        if (event.type === "media.observed" && data.subject === "media") {
          const mediaOfferRef = asText(data.mediaOfferRef);
          if (mediaOfferRef === null) continue;
          const result = await upsertCreatorMedia(app.db, {
            pageId: accountId,
            platform: mediaPlatform,
            mediaOfferRef,
            mediaRef: asText(data.mediaRef),
            previewRef: asText(data.previewRef),
            bundleRefs: stringArray(data.bundleRefs),
            mediaType: asInt(data.mediaType),
            mimeType: asText(data.mimeType),
            width: asInt(data.width),
            height: asInt(data.height),
            durationMs: asInt(data.durationMs),
            priceMills: millsOrNull(data.priceMills),
            permissionEntries: asRecordArray(data.permissionEntries),
            permissionFlags: asInt(data.permissionFlags),
            likeCount: asInt(data.likeCount),
            ...saleColumns(data),
            createdAtPlatform: isoDate(data.createdAtPlatform),
            deletedAtPlatform: isoDate(data.deletedAtPlatform),
            firstOrigin: asText(data.firstOrigin) ?? "dm_sidecar",
            ...lineage,
          });
          if (result.applied) totals.media += 1;
          continue;
        }

        if (event.type === "media.observed" && data.subject === "bundle") {
          const bundleRef = asText(data.bundleRef);
          if (bundleRef === null) continue;
          const result = await upsertCreatorMediaBundle(app.db, {
            pageId: accountId,
            platform: mediaPlatform,
            bundleRef,
            previewRef: asText(data.previewRef),
            priceMills: millsOrNull(data.priceMills),
            permissionEntries: asRecordArray(data.permissionEntries),
            permissionFlags: asInt(data.permissionFlags),
            memberRefs: stringArray(data.memberRefs),
            memberPositions: asRecordArray(data.memberPositions),
            ...saleColumns(data),
            createdAtPlatform: isoDate(data.createdAtPlatform),
            deletedAtPlatform: isoDate(data.deletedAtPlatform),
            ...lineage,
          });
          if (result.applied) totals.bundles += 1;
          continue;
        }

        if (event.type === "media.offer_location_observed") {
          // A17-5: stored PARSED. Pure id-relations — the payload also carries
          // signed CDN locations and every variant of every file, and those stay
          // raw-journal-only. Nothing here is a URL.
          const locationRef = asText(data.locationRef);
          if (locationRef === null) continue;
          const result = await upsertMediaOfferLocation(app.db, {
            pageId: accountId,
            platform: mediaPlatform,
            locationRef,
            mediaOfferRef: asText(data.mediaOfferRef),
            mediaOfferType: asInt(data.mediaOfferType),
            bundleRef: asText(data.bundleRef),
            mediaRef: asText(data.mediaRef),
            mediaType: asInt(data.mediaType),
            previewRef: asText(data.previewRef),
            ownerAccountRef: asText(data.ownerAccountRef),
            locationIdRef: asText(data.locationIdRef),
            correlationRef: asText(data.correlationRef),
            createdAtPlatform: isoDate(data.createdAtPlatform),
            ...lineage,
          });
          if (result.applied) totals.locations += 1;
          continue;
        }

        if (event.type === "media.order_observed") {
          const mediaOfferRef = asText(data.mediaOfferRef);
          const buyerRef = asText(data.buyerRef) ?? event.fanIdentityRef;
          const occurredAt = isoDate(data.orderedAt);
          if (mediaOfferRef === null || buyerRef === null || occurredAt === null) continue;
          const result = await upsertMediaOrder(app.db, {
            pageId: accountId,
            platform: mediaPlatform,
            mediaOfferRef,
            buyerPlatformUserId: buyerRef,
            // Dated from `data`, NEVER from event.occurredAt — the event is
            // receipt-time on purpose (§3.2b).
            occurredAt,
            orderRef: asText(data.orderRef),
            bundleRef: asText(data.bundleRef),
            orderType: asInt(data.orderType),
            priceMills: millsOrNull(data.priceMills),
            conversationRef: asText(data.conversationRef),
            messageRef: asText(data.messageRef),
            ...lineage,
          });
          if (result.applied) totals.orders += 1;
          continue;
        }

        // message.attachments_observed → one offer row per attachment.
        const messageRef = asText(data.messageId) ?? event.messageRef;
        if (messageRef === null) continue;
        const conversationRef = asText(data.conversationRef) ?? event.conversationRef;
        const senderRef = asText(data.senderRef);
        const messageCreatedAt = isoDate(data.messageCreatedAt);
        const attachments = asRecordArray(data.attachments);
        for (const [index, attachment] of attachments.entries()) {
          const purchaseState: MessageMediaOfferPurchaseState = attachment.purchased === true
            ? "purchased"
            : "unknown";
          const result = await upsertMessageMediaOffer(app.db, {
            pageId: accountId,
            platform: mediaPlatform,
            messageRef,
            offerOrdinal: asInt(attachment.pos) ?? index,
            mediaOfferRef: asText(attachment.mediaOfferRef) ?? asText(attachment.contentRef),
            bundleRef: asText(attachment.bundleRef),
            conversationRef,
            // The fan on a DM offer is the conversation partner; on a message
            // the model sent, the sender is us, so the buyer refs are the
            // honest fan evidence.
            fanPlatformUserId: stringArray(attachment.buyerRefs)[0]
              ?? (senderRef === null ? null : senderRef),
            messageCreatedAt,
            offerType: asInt(attachment.contentType),
            mimeType: asText(attachment.mimeType),
            durationMs: asInt(attachment.durationMs),
            priceMills: millsOrNull(attachment.priceMills),
            permissionEntries: asRecordArray(attachment.permissionEntries),
            purchaseState,
            orderRef: asText(attachment.orderRef),
            ...saleColumns(attachment),
            ...lineage,
          });
          if (result.applied) totals.offers += 1;
        }
      }

      watermark = events[events.length - 1]!.accountSeq;
      await setProjectionWatermark(app.db, MEDIA_PLANE_PROJECTION, accountId, watermark);
      if (events.length < EVENT_PAGE_SIZE) {
        break;
      }
    }
  }

  return totals;
}

/**
 * §3.2c(i) READ-SIDE PREFLIGHT — the rebuild refuses when any DETACHED
 * partition holds events for the account.
 *
 * Tiering exports and detaches domain_events monthlies older than ~6 months,
 * and `listEventsSince` sees only ATTACHED partitions. A rebuild that ran
 * anyway would truncate the projection, replay a truncated ledger, and call
 * the result authoritative — silently. Refusing is the only honest answer; the
 * recovery is the 0077 re-attach ritual (DETACH/ATTACH, never DROP) or a
 * hot + lake replay for the range.
 */
export async function assertMediaPlaneRebuildable(
  app: Pick<AppContext, "db">,
  accountIds: readonly number[],
): Promise<void> {
  for (const accountId of accountIds) {
    const holding = await listDetachedPartitionsHoldingAccount(app.db, accountId);
    if (holding.length > 0) {
      throw new Error(
        `media_plane rebuild REFUSED for account ${accountId}: `
          + `${holding.map((row) => `${row.schema}.${row.name} (${row.rows} rows)`).join(", ")} `
          + "is detached and holds this account's events, so a replay would produce a "
          + "TRUNCATED projection and call it authoritative. Recovery: re-attach the month "
          + "(the 0077 ritual — DETACH/ATTACH only, never DROP) or replay hot + lake for the "
          + "range, then re-run. See docs/runbooks/domain-event-partitions.md",
      );
    }
  }
}

/**
 * One-command rebuild: preflight, then truncate scope + reset watermark
 * atomically, then replay. The two deletes run in ONE transaction (the A37 /
 * decision #134 rule): a crash between them would leave an empty projection
 * behind a stale high watermark — permanently and silently empty.
 *
 * These deletes are a PROJECTION RESET — rebuildable state only, never
 * scheduled, which is the justification `tests/retention-deleters.test.ts`
 * carries for this file.
 */
export async function rebuildMediaPlaneProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<MediaPlaneProjectionResult> {
  const accountIds = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);
  await assertMediaPlaneRebuildable(app, accountIds);

  await app.db.transaction(async (tx) => {
    if (input?.accountId != null) {
      const pageId = input.accountId;
      await tx.execute(sql`delete from message_media_offers where page_id = ${pageId}`);
      await tx.execute(sql`delete from media_offer_locations where page_id = ${pageId}`);
      await tx.execute(sql`delete from media_orders where page_id = ${pageId}`);
      await tx.execute(sql`delete from creator_media_bundles where page_id = ${pageId}`);
      await tx.execute(sql`delete from creator_media where page_id = ${pageId}`);
      await tx.execute(sql`
        delete from projection_seq_watermarks
        where projection = ${MEDIA_PLANE_PROJECTION} and account_id = ${pageId}
      `);
    } else {
      await tx.execute(sql`delete from message_media_offers`);
      await tx.execute(sql`delete from media_offer_locations`);
      await tx.execute(sql`delete from media_orders`);
      await tx.execute(sql`delete from creator_media_bundles`);
      await tx.execute(sql`delete from creator_media`);
      await tx.execute(sql`
        delete from projection_seq_watermarks where projection = ${MEDIA_PLANE_PROJECTION}
      `);
    }
  });
  return runMediaPlaneProjection(app, input);
}
