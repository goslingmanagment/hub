// WP-F1 — the family-grouped statistics projector.
//
// ONE projector, ONE watermark, a reducer per table — not six independent
// ledger scans over the same event stream (F1(0).5). Every table it writes is a
// FACT PROJECTION: truncate + replay reproduces it from the event ledger alone.
// `capture_coverage` is deliberately NOT here — it is capture-plane operational
// state (§3.4, A17-6) written by the sync handler, and the rebuild below never
// touches it.
//
// THREE RULES IT SHARES WITH EVERY OTHER PROJECTOR IN THIS TREE:
//
// 1. Projectors read EVENTS only — never `observations.payload`, never
//    `sync_raw_payloads`.
// 2. Rows are dated from `data`, NEVER from `event.occurredAt`. The events are
//    receipt-time by construction (§3.2b); `occurredAt` is when we LOOKED, and
//    using it would stamp a 2025 revenue bucket with today's date.
// 3. Head precedence is by PROVIDER time in `data` where the fact has one, with
//    `source_account_seq` as the deterministic same-instant tie-break — never
//    by `account_seq` alone, because ledger order is append order and a replay
//    of an older capture must not overwrite a fresher head.

import {
  getPageTransactionsWriterInfo,
  getProjectionWatermark,
  listEventAccounts,
  listEventsSince,
  setProjectionWatermark,
  upsertPageBroadcast,
  upsertPagePoll,
  upsertPagePromoLink,
  upsertPageRecapStat,
  upsertFanslyMediaTagStat,
  upsertPlatformTagDaily,
  upsertRevenueMixDaily,
  upsertRevenueMonthTotal,
  upsertStatsTopMedia,
  upsertStatsTopTag,
  upsertStatsTrafficBucket,
  type FanslyStatsPlatform,
} from "@agency_hub_core/db";
import { millsFromInteger, type Mills } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import type { AppContext } from "../../bootstrap.ts";

export const FANSLY_STATS_PROJECTION = "fansly_stats";

const EVENT_PAGE_SIZE = 500;

const FANSLY_STATS_EVENT_TYPES = new Set([
  "traffic.datapoint_observed",
  "media_traffic.datapoint_observed",
  // WP-F4: per-media `topFypTags` rows.
  "media_tag.stats_observed",
  "stats.window_top_observed",
  "tag.counters_observed",
  "earnings.breakdown_observed",
  "earnings.month_observed",
  "tracking_link.snapshot_observed",
  "broadcast.stats_observed",
  "broadcast.scheduled_observed",
  "poll.observed",
  "recap.stat_observed",
]);

/** The tables this projector truncates on rebuild. `capture_coverage` is
 *  ABSENT and must stay absent (§3.4). */
/**
 * WP-F3 made `page_promo_links` a two-writer table: this projector owns the
 * `tracking` half, the catalog projector owns the `gift_code` half, and the
 * kind is part of the table's PRIMARY KEY so the two row sets are structurally
 * disjoint. Both rebuilds therefore scope their delete by kind — an unscoped
 * one truncates rows the other projector's ledger owns.
 */
export const PROMO_LINKS_TABLE = "page_promo_links";
export const STATS_PROMO_LINK_KIND = "tracking";

export const FANSLY_STATS_PROJECTION_TABLES = [
  "stats_traffic_buckets",
  "stats_top_media",
  "stats_top_tags",
  // WP-F4. Created by 0132 and left EMPTY by F1 on purpose; the per-media lane
  // is what fills it, and a rebuild has to be able to reset it like any other
  // fact projection.
  "fansly_media_tag_stats",
  "platform_tag_daily",
  "revenue_mix_daily",
  "revenue_month_totals",
  "page_promo_links",
  "page_broadcasts",
  "page_polls",
  "page_poll_options",
  "page_recap_stats",
] as const;

export interface FanslyStatsProjectionResult extends Record<string, unknown> {
  accounts: number;
  eventsSeen: number;
  applied: number;
  trafficBuckets: number;
  topRows: number;
  mediaTagRows: number;
  tagSamples: number;
  revenueDays: number;
  revenueMonths: number;
  promoLinks: number;
  broadcasts: number;
  polls: number;
  recapStats: number;
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

/**
 * Event mills travel as decimal STRINGS (JSON cannot carry a bigint, and a
 * float would re-open the 1000x footgun), constructed through the named
 * already-mills constructor — never a hand-rolled `BigInt(...)`.
 *
 * The shape guards in FRONT of it are not decoration: the constructor THROWS on
 * a non-digit string and on a non-finite number, and a projector must SKIP a
 * malformed money field rather than crash the sweep.
 */
function millsOrNull(value: unknown): Mills | null {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return millsFromInteger(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return millsFromInteger(value);
  }
  return null;
}

/** A ratio as a decimal string. Anything else is not a ratio. */
function numericOrNull(value: unknown): string | null {
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value.toString();
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

/** `YYYY-MM-DD`, refused rather than guessed. */
function businessDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export async function runFanslyStatsProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanslyStatsProjectionResult> {
  const totals: FanslyStatsProjectionResult = {
    accounts: 0,
    eventsSeen: 0,
    applied: 0,
    trafficBuckets: 0,
    topRows: 0,
    mediaTagRows: 0,
    tagSamples: 0,
    revenueDays: 0,
    revenueMonths: 0,
    promoLinks: 0,
    broadcasts: 0,
    polls: 0,
    recapStats: 0,
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
      // No page, no platform: the rows would be unattributable. The events stay
      // in the ledger and project the moment the page mapping lands.
      continue;
    }
    const statsPlatform: FanslyStatsPlatform = platform;

    let watermark = await getProjectionWatermark(app.db, FANSLY_STATS_PROJECTION, accountId);
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
        if (!FANSLY_STATS_EVENT_TYPES.has(event.type)) {
          continue;
        }
        const data = eventData(event.data);
        const contentHash = asText(data.contentHash) ?? "";
        if (contentHash.length !== 64) {
          continue;
        }
        const lineage = {
          contentHash,
          sourceEventId: event.id,
          sourceObservationId: event.observationId,
          sourceAccountSeq: event.accountSeq,
          // Receipt-time events: occurredAt IS the observation instant, which is
          // exactly the freshness ordering these heads need.
          observedAt: event.occurredAt,
        };
        const base = { pageId: accountId, platform: statsPlatform, ...lineage };

        switch (event.type) {
          case "traffic.datapoint_observed":
          case "media_traffic.datapoint_observed": {
            const bucketStart = isoDate(data.bucketTs);
            const periodMs = asInt(data.periodMs);
            const rawType = asInt(data.rawType);
            const subjectKind = asText(data.subjectKind);
            if (
              bucketStart === null || periodMs === null || periodMs <= 0
              || rawType === null || subjectKind === null
            ) {
              continue;
            }
            const result = await upsertStatsTrafficBucket(app.db, {
              ...base,
              subjectKind: subjectKind as "account_profile" | "account_media" | "media_offer"
                | "post",
              subjectRef: asText(data.subjectRef) ?? "",
              periodMs,
              // Dated from `data`, never from event.occurredAt.
              bucketStart,
              // The RAW code, as text. Never a label.
              sourceCode: String(rawType),
              mappingVersion: asInt(data.mappingVersion) ?? 0,
              views: asInt(data.views),
              previewViews: asInt(data.previewViews),
              uniqueViewers: asInt(data.uniqueViewers),
              previewUniqueViewers: asInt(data.previewUniqueViewers),
              videoViews: asInt(data.videoViews),
              previewVideoViews: asInt(data.previewVideoViews),
              interactionTimeMs: asInt(data.interactionMs),
              previewInteractionTimeMs: asInt(data.previewInteractionMs),
              videoPercentWatchedSum: numericOrNull(data.videoPercentWatchedSum),
              previewVideoPercentWatchedSum:
                numericOrNull(data.previewVideoPercentWatchedSum),
              requestedStart: isoDate(data.requestedStart),
              requestedEnd: isoDate(data.requestedEnd),
            });
            if (result.applied) {
              totals.trafficBuckets += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "stats.window_top_observed": {
            const plane = asText(data.plane);
            const periodMs = asInt(data.periodMs);
            const requestedStart = isoDate(data.requestedStart);
            const requestedEnd = isoDate(data.requestedEnd);
            if (
              plane === null || periodMs === null || requestedStart === null
              || requestedEnd === null
            ) {
              continue;
            }
            const rows = asRecordArray(data.rows);
            const tagNames = eventData(data.tagNames);
            for (const [index, row] of rows.entries()) {
              if (plane === "top_fyp_tags") {
                const tagRef = asText(row.tagId);
                if (tagRef === null) continue;
                const result = await upsertStatsTopTag(app.db, {
                  ...base,
                  plane: "top_fyp_tags",
                  periodMs,
                  requestedStart,
                  requestedEnd,
                  tagRef,
                  // NULL when the join missed — never fabricated from the id.
                  tagName: asText(tagNames[tagRef]),
                  rank: index,
                  views: asInt(row.views),
                  previewViews: asInt(row.previewViews),
                  interactionTimeMs: asInt(row.interactionTime),
                  previewInteractionTimeMs: asInt(row.previewInteractionTime),
                });
                if (result.applied) {
                  totals.topRows += 1;
                  totals.applied += 1;
                }
                continue;
              }
              if (plane !== "top_media" && plane !== "top_fyp_media") {
                continue;
              }
              const mediaOfferRef = asText(row.mediaOfferId);
              if (mediaOfferRef === null) continue;
              const bundleRef = asText(row.mediaOfferBundleId);
              const result = await upsertStatsTopMedia(app.db, {
                ...base,
                plane,
                periodMs,
                requestedStart,
                requestedEnd,
                mediaOfferRef,
                // "0" is Fansly's sentinel for "no bundle", not a bundle id.
                bundleRef: bundleRef === "0" ? null : bundleRef,
                rank: index,
                views: asInt(row.views),
                previewViews: asInt(row.previewViews),
                interactionTimeMs: asInt(row.interactionTime),
                previewInteractionTimeMs: asInt(row.previewInteractionTime),
              });
              if (result.applied) {
                totals.topRows += 1;
                totals.applied += 1;
              }
            }
            continue;
          }

          case "media_tag.stats_observed": {
            // WP-F4. The WINDOW is part of the key: rank 2 of one window is not
            // the same fact as rank 2 of the next, and a row without its window
            // would let the newest ranking silently overwrite the history.
            const mediaOfferRef = asText(data.mediaOfferRef);
            const tagRef = asText(data.tagRef);
            const periodMs = asInt(data.periodMs);
            const requestedStart = isoDate(data.requestedStart);
            const requestedEnd = isoDate(data.requestedEnd);
            if (
              mediaOfferRef === null || tagRef === null || periodMs === null || periodMs <= 0
              || requestedStart === null || requestedEnd === null
            ) {
              continue;
            }
            const result = await upsertFanslyMediaTagStat(app.db, {
              ...base,
              mediaOfferRef,
              tagRef,
              periodMs,
              requestedStart,
              requestedEnd,
              // NULL when the response's own tags[] join missed — never
              // fabricated from the id.
              tagName: asText(data.tagName),
              rank: asInt(data.rank),
              views: asInt(data.views),
              previewViews: asInt(data.previewViews),
              interactionTimeMs: asInt(data.interactionMs),
              previewInteractionTimeMs: asInt(data.previewInteractionMs),
            });
            if (result.applied) {
              totals.mediaTagRows += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "tag.counters_observed": {
            const tagRef = asText(data.tagRef);
            const date = businessDate(data.businessDate);
            const source = asText(data.source);
            if (
              tagRef === null || date === null
              || (source !== "stats_agg" && source !== "discovery")
            ) {
              continue;
            }
            const result = await upsertPlatformTagDaily(app.db, {
              ...base,
              tagRef,
              businessDate: date,
              tagName: asText(data.tagName),
              viewCount: asInt(data.viewCount),
              postCount: asInt(data.postCount),
              tagCreatedAt: isoDate(data.tagCreatedAt),
              source,
              capturedAt: isoDate(data.capturedAt) ?? event.occurredAt,
            });
            if (result.applied) {
              totals.tagSamples += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "earnings.breakdown_observed": {
            const date = businessDate(data.businessDate);
            const typeCode = asInt(data.typeCode);
            if (date === null || typeCode === null) {
              continue;
            }
            const result = await upsertRevenueMixDaily(app.db, {
              ...base,
              businessDate: date,
              typeCode,
              grossMills: millsOrNull(data.grossMills),
              netMills: millsOrNull(data.netMills),
              correlationAccountRef: asText(data.correlationAccountRef),
            });
            if (result.applied) {
              totals.revenueDays += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "earnings.month_observed": {
            const year = asInt(data.year);
            const month = asInt(data.month);
            if (year === null || month === null) {
              continue;
            }
            const result = await upsertRevenueMonthTotal(app.db, {
              ...base,
              // (0, 0) is the rolling rollup — a row like any other, and the
              // read layer is what must not sum it with the real months.
              year,
              month,
              totalGrossMills: millsOrNull(data.totalGrossMills),
              totalNetMills: millsOrNull(data.totalNetMills),
              topPercent: numericOrNull(data.topPercent),
              maxTopPercent: numericOrNull(data.maxTopPercent),
              windowStart: isoDate(data.windowStart),
              windowEnd: isoDate(data.windowEnd),
              servedExtras: eventData(data.servedExtras),
            });
            if (result.applied) {
              totals.revenueMonths += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "tracking_link.snapshot_observed": {
            const linkRef = asText(data.linkRef);
            const date = businessDate(data.businessDate);
            const linkKind = asText(data.linkKind);
            if (
              linkRef === null || date === null
              || (linkKind !== "tracking" && linkKind !== "gift_code")
            ) {
              continue;
            }
            const result = await upsertPagePromoLink(app.db, {
              ...base,
              linkKind,
              linkRef,
              businessDate: date,
              internalRef: asText(data.internalRef),
              linkType: asInt(data.linkType),
              status: asInt(data.status),
              label: asText(data.label),
              description: typeof data.description === "string" ? data.description : null,
              metadata: eventData(data.metadata),
              createdAtPlatform: isoDate(data.createdAtPlatform),
              clicks: asInt(data.clicks),
              claims: asInt(data.claims),
              follows: asInt(data.follows),
              subscriptions: asInt(data.subscriptions),
              totalGrossMills: millsOrNull(data.totalGrossMills),
              // NULL when the platform served 0-or-null. The verbatim served
              // number stays in the event, so a later populated capture is
              // distinguishable from today's silence.
              totalNetMills: millsOrNull(data.totalNetMills),
              capturedAt: isoDate(data.capturedAt) ?? event.occurredAt,
            });
            if (result.applied) {
              totals.promoLinks += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "broadcast.stats_observed":
          case "broadcast.scheduled_observed": {
            const broadcastRef = asText(data.broadcastRef);
            const sourceList = asText(data.sourceList);
            if (
              broadcastRef === null
              || (sourceList !== "live" && sourceList !== "deleted" && sourceList !== "scheduled")
            ) {
              continue;
            }
            const result = await upsertPageBroadcast(app.db, {
              ...base,
              broadcastRef,
              sourceList,
              groupRef: asText(data.groupRef),
              senderRef: asText(data.senderRef),
              content: typeof data.content === "string" ? data.content : null,
              createdAtPlatform: isoDate(data.createdAtPlatform),
              scheduledFor: isoDate(data.scheduledFor),
              deletedAtPlatform: isoDate(data.deletedAtPlatform),
              statsTotal: asInt(data.statsTotal),
              statsDelivered: asInt(data.statsDelivered),
              statsRead: asInt(data.statsRead),
              totalTipAmountMills: millsOrNull(data.totalTipAmountMills),
              offeredMediaRefs: stringArray(data.offeredMediaRefs),
              offeredBundleRefs: stringArray(data.offeredBundleRefs),
              offerPrices: asRecordArray(data.offerPrices),
              salesCount: asInt(data.salesCount),
              // A12: NET.
              salesNetMills: millsOrNull(data.salesNetMills),
              salesPendingMills: millsOrNull(data.salesPendingMills),
            });
            if (result.applied) {
              totals.broadcasts += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "poll.observed": {
            const pollRef = asText(data.pollRef);
            if (pollRef === null) {
              continue;
            }
            const options = asRecordArray(data.options).flatMap((option, index) => {
              const optionRef = asText(option.optionRef);
              return optionRef === null ? [] : [{
                optionRef,
                optionOrdinal: asInt(option.optionOrdinal) ?? index,
                title: typeof option.title === "string" ? option.title : null,
                voteCount: asInt(option.voteCount),
              }];
            });
            const result = await upsertPagePoll(app.db, {
              ...base,
              pollRef,
              title: typeof data.title === "string" ? data.title : null,
              description: typeof data.description === "string" ? data.description : null,
              status: asInt(data.status),
              pollVersion: asInt(data.pollVersion),
              createdAtPlatform: isoDate(data.createdAtPlatform),
              options,
            });
            if (result.applied) {
              totals.polls += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "recap.stat_observed": {
            const statRef = asText(data.statRef);
            const recapYear = asInt(data.recapYear);
            if (statRef === null || recapYear === null) {
              continue;
            }
            const result = await upsertPageRecapStat(app.db, {
              ...base,
              recapYear,
              statRef,
              statName: asText(data.statName),
              // Verbatim string, never coerced.
              statValue: typeof data.statValue === "string" ? data.statValue : null,
              generatedAt: isoDate(data.generatedAt),
            });
            if (result.applied) {
              totals.recapStats += 1;
              totals.applied += 1;
            }
            continue;
          }

          default:
            continue;
        }
      }

      watermark = events[events.length - 1]!.accountSeq;
      await setProjectionWatermark(app.db, FANSLY_STATS_PROJECTION, accountId, watermark);
      if (events.length < EVENT_PAGE_SIZE) {
        break;
      }
    }
  }

  return totals;
}

/**
 * One-command rebuild: truncate scope + reset watermark ATOMICALLY, then
 * replay. The deletes run in ONE transaction (the decision #134 rule): a crash
 * between them would leave an empty projection behind a stale high watermark —
 * permanently and silently empty.
 *
 * These deletes are a PROJECTION RESET — rebuildable state only, never
 * scheduled, which is the justification `tests/retention-deleters.test.ts`
 * carries for this file. `capture_coverage` is NOT in the list and must never
 * be added: it is capture-plane operational state (§3.4, A17-6), and truncating
 * it would erase every retention floor the backfill paid egress to discover.
 *
 * The §3.2c(i) detached-partition preflight runs in the projection registry, in
 * front of every rebuild — so it is one gate for all of them rather than a
 * per-projector copy that a new projector can forget.
 */
export async function rebuildFanslyStatsProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanslyStatsProjectionResult> {
  await app.db.transaction(async (tx) => {
    if (input?.accountId != null) {
      const pageId = input.accountId;
      for (const table of FANSLY_STATS_PROJECTION_TABLES) {
        await tx.execute(
          table === PROMO_LINKS_TABLE
            // WP-F3: `page_promo_links` now has TWO writers, one per
            // `link_kind` — this projector owns 'tracking', the catalog
            // projector owns 'gift_code'. The kinds are disjoint by the table's
            // own primary key, so an UNSCOPED delete here would truncate rows
            // this replay cannot re-derive and leave a page's gift codes gone
            // until somebody rebuilt the other projection too.
            ? sql`
              delete from page_promo_links
               where page_id = ${pageId} and link_kind = ${STATS_PROMO_LINK_KIND}
            `
            : sql`delete from ${sql.identifier(table)} where page_id = ${pageId}`,
        );
      }
      await tx.execute(sql`
        delete from projection_seq_watermarks
        where projection = ${FANSLY_STATS_PROJECTION} and account_id = ${pageId}
      `);
    } else {
      for (const table of FANSLY_STATS_PROJECTION_TABLES) {
        await tx.execute(
          table === PROMO_LINKS_TABLE
            ? sql`delete from page_promo_links where link_kind = ${STATS_PROMO_LINK_KIND}`
            : sql`delete from ${sql.identifier(table)}`,
        );
      }
      await tx.execute(sql`
        delete from projection_seq_watermarks where projection = ${FANSLY_STATS_PROJECTION}
      `);
    }
  });
  return runFanslyStatsProjection(app, input);
}
