// WP-F1 — the `fansly-stats` canonicalizer family (v1, projection-only).
//
// Reads the journaled `stats_snapshot` responses and emits NATURAL-KEY
// projection-only events (D-1): one event per provider row/bucket/entity
// wherever the row has stable identity across captures, and one event per
// captured WINDOW wherever the window itself IS the identity (the ≤50-row
// top-N rankings, and the per-capture-day tracking-link snapshot).
//
// FOUR RULES, each with the cost of breaking it:
//
// 1. **TIME (§3.2b).** Every event here is RECEIPT-TIME: `occurredAt` is the
//    observation's `receivedAt`, and the provider instant is a typed field in
//    `data` AND part of the natural key. A receipt-time draft is by
//    construction inside `clampDraftOccurredAt`'s window, so an event from this
//    family can NEVER carry `occurredAtClamped` — its presence would prove the
//    family dated the draft at provider time after all, and the fixture asserts
//    exactly that. Projectors date rows from `data`, never from
//    `event.occurredAt`. The failure this prevents is concrete: `domain_events`
//    is monthly-partitioned and historical appends dated at provider time aim
//    inserts at cold or DETACHED partitions and fail ExecFindPartition (23514)
//    forever.
// 2. **CODES, NOT LABELS (A1, A22-2).** Every `type` is carried through raw.
//    An unrecognized code still writes its row AND raises
//    `fansly_stats_unknown_type` — journaled and surfaced, never dropped, and
//    never silently absorbed into a neighbouring family's label.
// 3. **MONEY IS MILLS, THROUGH THE SHARED CONSTRUCTORS.** Prices and totals
//    travel as decimal STRINGS built by `millsFromInteger` (JSON cannot carry a
//    bigint and a float would re-open the 1000x footgun). `saleStats.total` is
//    NET (A12). A sparse counter is NULL, never 0.
// 4. **ABSENCE IS ABSENCE.** A field the response did not carry is `null` in
//    `data`. `/it/moie/statsnew` serves no video fields at all and
//    `/trackinglinks.totalNet` came back 0 on every observed link while
//    totalGross was populated — coalescing either to 0 mints a measurement
//    nobody made.
//
// SECONDS VS MILLISECONDS, per field, because the payload mixes them and a
// wrong guess is a 1970 or a year-55000 row:
//   ms  — dataset.dateBefore/dateAfter, datapoints[].timestamp,
//         earnings rows' `timestamp`, monthlystats before/after,
//         trackinglinks.createdAt, tags[].createdAt,
//         creatorMediaOfferLocations[].createdAt
//   s   — accountMedia[].createdAt/deletedAt (the media-plane rule F0 already
//         encodes in `fanslyInstantIso`)
//   ?   — the broadcast/poll/recap routes were NOT in the HAR. Their instants
//         go through `asFanslyTimestamp`'s <1e12 heuristic, which is the same
//         rule the hot-table path has always used.

import { millsFromInteger } from "@agency_hub_core/shared";
import {
  FANSLY_STAT_LABEL_VERSION,
  isKnownMediaStatType,
  isKnownProfileStatType,
} from "@agency_hub_core/shared";

import {
  asFanslyTimestamp,
  asNumber,
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
  type CanonicalizeRunContext,
} from "./types.ts";
import {
  buildMediaPlaneIndex,
  contentHash,
  mediaObservedDrafts,
  mediaPlaneSources,
  millsString,
  nonNegativeCount,
  recordArray,
  saleSummary,
} from "./sync-pull.ts";

// v2 joins account-level top-FYP tag ids to aggregationData.tags[]. The version
// bump replays retained v1 observations so already-projected NULL names repair
// themselves without another platform call.
export const FANSLY_STATS_CANONICALIZER_VERSION = 2;
const SCHEMA_VERSION = 1;

/** The `observations.kind` values this family claims. Every one is registered
 *  in `observation-kinds.ts`; the ratchet fails otherwise. */
export const FANSLY_STATS_CANONICALIZED_KINDS = [
  "account_stats",
  "media_offer_stats",
  "earnings_stats_snapshot",
  "earnings_monthlystats_snapshot",
  "tracking_links",
  "discovery_feed",
  "broadcast_stats",
  "broadcast_stats_deleted",
  "broadcast_scheduled",
  "polls",
  "recapstats",
] as const;

const CANONICALIZED_KIND_SET: ReadonlySet<string> = new Set(FANSLY_STATS_CANONICALIZED_KINDS);

/** Anomaly code raised for a type code the label module does not know. */
export const FANSLY_STATS_UNKNOWN_TYPE_DIAGNOSTIC = "fansly_stats_unknown_type";

// ── small shared helpers ─────────────────────────────────────────────────────

function msInstantIso(value: unknown): string | null {
  const raw = asNumber(value);
  if (raw === null || raw <= 0) {
    return null;
  }
  return asFanslyTimestamp(raw, new Date(0)).toISOString();
}

/** A ratio as a decimal STRING (never a float in storage). Refuses a
 *  non-finite or negative value rather than rounding one into existence. */
function ratioString(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value.toString();
}

/** UTC business date of an instant, `YYYY-MM-DD`. */
function businessDate(iso: string): string {
  return iso.slice(0, 10);
}

function pageRefOf(observation: CanonicalizableObservation): string {
  return String(observation.accountId);
}

function envelopeArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  // Tolerant: some routes may wrap a list. Take the first array-valued key
  // rather than refusing — unknown keys stay in the journal either way.
  if (isRecord(payload)) {
    for (const value of Object.values(payload)) {
      if (Array.isArray(value)) {
        return value.filter(isRecord);
      }
    }
  }
  return [];
}

// ── /it/amoie/stats — the account statistics response ────────────────────────

interface StatsWindow {
  periodMs: number;
  requestedStartIso: string | null;
  requestedEndIso: string | null;
}

function statsWindow(dataset: Record<string, unknown>): StatsWindow {
  return {
    periodMs: asNumber(dataset.period) ?? 0,
    // The provider's OWN returned bounds. The backfill derives its next window
    // from these, not from what it asked for (§7) — so they are what identifies
    // the window everywhere downstream.
    requestedStartIso: msInstantIso(dataset.dateAfter),
    requestedEndIso: msInstantIso(dataset.dateBefore),
  };
}

/** Per `profileDatapoints[].stats[]` row — exactly four served keys. */
function profileTrafficDrafts(
  observation: CanonicalizableObservation,
  dataset: Record<string, unknown>,
  window: StatsWindow,
  diagnostics: CanonicalizeRunContext["diagnostics"],
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  for (const point of recordArray(dataset.profileDatapoints)) {
    const bucketIso = msInstantIso(point.timestamp);
    if (bucketIso === null) {
      continue;
    }
    for (const row of recordArray(point.stats)) {
      const rawType = asNumber(row.type);
      if (rawType === null) {
        continue;
      }
      if (!isKnownProfileStatType(rawType)) {
        // A1: the row is written ANYWAY. The anomaly is how a new code becomes
        // visible; dropping it would make a platform change look like silence.
        diagnostics?.record(FANSLY_STATS_UNKNOWN_TYPE_DIAGNOSTIC);
      }
      const material = {
        subjectKind: "account_profile" as const,
        subjectRef: "",
        periodMs: window.periodMs,
        bucketTs: bucketIso,
        rawType,
        mappingVersion: FANSLY_STAT_LABEL_VERSION,
        knownType: isKnownProfileStatType(rawType),
        views: nonNegativeCount(row.views),
        uniqueViewers: nonNegativeCount(row.uniqueViewers),
        interactionMs: nonNegativeCount(row.interactionTime),
        requestedStart: window.requestedStartIso,
        requestedEnd: window.requestedEndIso,
      };
      const hash = contentHash(material);
      drafts.push({
        type: "traffic.datapoint_observed",
        occurredAt: observation.receivedAt,
        data: { ...material, contentHash: hash },
        schemaVersion: SCHEMA_VERSION,
        dedupKey:
          `traffic:v1:${pageRef}:${window.periodMs}:${bucketIso}:${rawType}:${hash}`,
      });
    }
  }
  return drafts;
}

/**
 * Per account-level media `datapoints[].stats[]` row — ELEVEN metric keys.
 *
 * THIS, not `/it/moie/statsnew`, is where the video metrics live (verified
 * 2026-08-19: six per-media responses carried seven stat keys and NO video
 * fields at all). `totalVideoPercentWatched` is a SUMMED fraction on the wire —
 * max observed 1275 across a bucket — so it is stored as the raw sum and
 * divided by `videoViews` only at read time.
 */
function mediaTrafficDrafts(
  observation: CanonicalizableObservation,
  dataset: Record<string, unknown>,
  window: StatsWindow,
  diagnostics: CanonicalizeRunContext["diagnostics"],
  subjectRef = "",
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  for (const point of recordArray(dataset.datapoints)) {
    const bucketIso = msInstantIso(point.timestamp);
    if (bucketIso === null) {
      continue;
    }
    for (const row of recordArray(point.stats)) {
      const rawType = asNumber(row.type);
      if (rawType === null) {
        continue;
      }
      if (!isKnownMediaStatType(rawType)) {
        diagnostics?.record(FANSLY_STATS_UNKNOWN_TYPE_DIAGNOSTIC);
      }
      const material = {
        subjectKind: subjectRef === "" ? "account_media" as const : "media_offer" as const,
        subjectRef,
        periodMs: window.periodMs,
        bucketTs: bucketIso,
        rawType,
        mappingVersion: FANSLY_STAT_LABEL_VERSION,
        knownType: isKnownMediaStatType(rawType),
        // Absent = null everywhere below. The per-media route serves none of
        // the video fields; that is a property of the ROUTE, not of the asset.
        views: nonNegativeCount(row.views),
        previewViews: nonNegativeCount(row.previewViews),
        uniqueViewers: nonNegativeCount(row.uniqueViewers),
        previewUniqueViewers: nonNegativeCount(row.previewUniqueViewers),
        videoViews: nonNegativeCount(row.videoViews),
        previewVideoViews: nonNegativeCount(row.previewVideoViews),
        interactionMs: nonNegativeCount(row.interactionTime),
        previewInteractionMs: nonNegativeCount(row.previewInteractionTime),
        videoPercentWatchedSum: ratioString(row.totalVideoPercentWatched),
        previewVideoPercentWatchedSum: ratioString(row.previewTotalVideoPercentWatched),
        requestedStart: window.requestedStartIso,
        requestedEnd: window.requestedEndIso,
      };
      const hash = contentHash(material);
      drafts.push({
        type: "media_traffic.datapoint_observed",
        occurredAt: observation.receivedAt,
        data: { ...material, contentHash: hash },
        schemaVersion: SCHEMA_VERSION,
        dedupKey: `mediatraffic:v1:${pageRef}:${subjectRef}:${window.periodMs}:`
          + `${bucketIso}:${rawType}:${hash}`,
      });
    }
  }
  return drafts;
}

function tagNameIndex(aggregation: Record<string, unknown>): Map<string, string> {
  const names = new Map<string, string>();
  for (const tag of recordArray(aggregation.tags)) {
    const tagRef = asString(tag.id);
    const name = asString(tag.tag);
    if (tagRef !== null && name !== null) {
      names.set(tagRef, name);
    }
  }
  return names;
}

/**
 * ONE event per top-N plane per capture — the WINDOW is the identity (D-1).
 *
 * Rows travel verbatim (≤50 of them; the largest event this family can mint is
 * ~15–20 KB, far under the 64 KiB sanity ceiling). A per-row event would be
 * wrong here: rank 7 of one window is not the same fact as rank 7 of the next.
 */
function windowTopDrafts(
  observation: CanonicalizableObservation,
  dataset: Record<string, unknown>,
  aggregation: Record<string, unknown>,
  window: StatsWindow,
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const planes: Array<{ plane: string; rows: Record<string, unknown>[] }> = [
    { plane: "top_media", rows: recordArray(dataset.topMediaOffers) },
    { plane: "top_fyp_media", rows: recordArray(dataset.topFypMediaOffers) },
    { plane: "top_fyp_tags", rows: recordArray(dataset.topFypTags) },
  ];
  const tagNames = tagNameIndex(aggregation);
  const drafts: CanonicalEventDraft[] = [];
  for (const plane of planes) {
    if (plane.rows.length === 0) {
      continue;
    }
    const material = {
      plane: plane.plane,
      periodMs: window.periodMs,
      requestedStart: window.requestedStartIso,
      requestedEnd: window.requestedEndIso,
      // Verbatim, capped defensively at the platform's own 50-row page.
      rows: plane.rows.slice(0, 50),
      tagNames: plane.plane === "top_fyp_tags" ? Object.fromEntries(tagNames) : undefined,
    };
    const hash = contentHash(material);
    drafts.push({
      type: "stats.window_top_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `statstop:v1:${pageRef}:${plane.plane}:${window.periodMs}:`
        + `${window.requestedStartIso}:${window.requestedEndIso}:${hash}`,
    });
  }
  return drafts;
}

/** Per `aggregationData.tags[]` row — PLATFORM-GLOBAL counters, sampled here. */
function tagCounterDrafts(
  observation: CanonicalizableObservation,
  rows: readonly Record<string, unknown>[],
  source: "stats_agg" | "discovery",
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const capturedAtIso = observation.receivedAt.toISOString();
  const date = businessDate(capturedAtIso);
  const drafts: CanonicalEventDraft[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const tagRef = asString(row.id);
    if (tagRef === null || seen.has(tagRef)) {
      continue;
    }
    seen.add(tagRef);
    // `capturedAt` is deliberately OUTSIDE the hashed material. The counters are
    // a DAILY sample: two polls on the same day that see the same numbers are
    // one fact, and hashing the instant would mint a fresh event on every call
    // forever — the same runaway A21 deleted the capture-window event for.
    const material = {
      tagRef,
      tagName: asString(row.tag),
      businessDate: date,
      // These are the PLATFORM's numbers, not this page's. The read layer
      // derives a global value from the per-page samples with a stated
      // precedence — it never compares account_seq across pages.
      viewCount: nonNegativeCount(row.viewCount),
      postCount: nonNegativeCount(row.postCount),
      tagCreatedAt: msInstantIso(row.createdAt),
      source,
    };
    const hash = contentHash(material);
    drafts.push({
      type: "tag.counters_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, capturedAt: capturedAtIso, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `tagcount:v1:${pageRef}:${tagRef}:${date}:${hash}`,
    });
  }
  return drafts;
}

/** Per `aggregationData.accountMedia[]` row WITH a non-null saleStats (2 of 85
 *  in the observed capture). A sparse saleStats yields no event at all — the
 *  absence of a sale record is not a record of zero sales. */
function saleStatsDrafts(
  observation: CanonicalizableObservation,
  media: readonly Record<string, unknown>[],
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  for (const row of media) {
    const mediaOfferRef = asString(row.id);
    if (mediaOfferRef === null || !isRecord(row.saleStats)) {
      continue;
    }
    const sales = saleSummary(row);
    const material = {
      mediaOfferRef,
      ...sales,
      observedAt: observation.receivedAt.toISOString(),
    };
    const hash = contentHash(material);
    drafts.push({
      type: "media.sale_stats_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `mediasale:v1:${pageRef}:${mediaOfferRef}:${hash}`,
    });
  }
  return drafts;
}

/** Per `creatorMediaOfferLocations[]` row — 11 keys, pure id-relations, no URLs
 *  (A17-5: stored parsed). `createdAt` on these rows is MILLISECONDS. */
function offerLocationDrafts(
  observation: CanonicalizableObservation,
  aggregation: Record<string, unknown>,
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  for (const row of recordArray(aggregation.creatorMediaOfferLocations)) {
    const locationRef = asString(row.id);
    if (locationRef === null) {
      continue;
    }
    const material = {
      locationRef,
      mediaOfferRef: asString(row.mediaOfferId),
      mediaOfferType: asNumber(row.mediaOfferType),
      bundleRef: asString(row.mediaOfferBundleId),
      mediaRef: asString(row.mediaId),
      mediaType: asNumber(row.mediaType),
      previewRef: asString(row.previewId),
      ownerAccountRef: asString(row.accountId),
      locationIdRef: asString(row.locationId),
      correlationRef: asString(row.correlationId),
      createdAtPlatform: msInstantIso(row.createdAt),
    };
    const hash = contentHash(material);
    drafts.push({
      type: "media.offer_location_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `mediaoffloc:v1:${pageRef}:${locationRef}:${hash}`,
    });
  }
  return drafts;
}

function accountStatsDrafts(
  observation: CanonicalizableObservation,
  context: CanonicalizeRunContext | undefined,
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const payload = observation.payload;
  const dataset = isRecord(payload.dataset) ? payload.dataset : null;
  if (dataset === null) {
    return [];
  }
  const aggregation = isRecord(payload.aggregationData) ? payload.aggregationData : {};
  const window = statsWindow(dataset);
  const sources = mediaPlaneSources(payload);
  const index = buildMediaPlaneIndex(sources);

  return [
    ...profileTrafficDrafts(observation, dataset, window, context?.diagnostics),
    ...mediaTrafficDrafts(observation, dataset, window, context?.diagnostics),
    ...windowTopDrafts(observation, dataset, aggregation, window),
    ...tagCounterDrafts(observation, recordArray(aggregation.tags), "stats_agg"),
    ...saleStatsDrafts(observation, sources.media),
    // The SAME shapes and dedup keys F0(b) mints from the DM sidecars, with a
    // different origin. Without this, `creator_media.first_origin='stats_agg'`
    // names an origin no event can produce and 83 of 85 rows would be
    // unreachable by replay.
    ...mediaObservedDrafts(observation, sources, index, "stats_agg"),
    ...offerLocationDrafts(observation, aggregation),
  ];
}

/**
 * Per `dataset.topFypTags[]` row of a PER-MEDIA response — the finest FYP
 * attribution Fansly exposes: which tags brought traffic to THIS item in THIS
 * window.
 *
 * The rows carry five keys and no name (`{tagId, views, previewViews,
 * interactionTime, previewInteractionTime}`, HAR 2026-08-19). The name is joined
 * from the same response's `aggregationData.tags[]` and stays NULL when that
 * join misses — never fabricated from the id, which is the same rule
 * `stats_top_tags` follows.
 *
 * ONE EVENT PER TAG PER WINDOW, not one per window carrying all the tags: unlike
 * the account response's ≤50-row top-N rankings, a per-media tag row has stable
 * identity across captures — `(media, tag, window)` — and the projection is keyed
 * on exactly that. The window IS part of the key, so rank 2 of one window never
 * overwrites rank 2 of the next.
 */
function mediaTagStatsDrafts(
  observation: CanonicalizableObservation,
  dataset: Record<string, unknown>,
  aggregation: Record<string, unknown>,
  window: StatsWindow,
  mediaOfferRef: string,
): CanonicalEventDraft[] {
  const rows = recordArray(dataset.topFypTags);
  if (rows.length === 0) {
    return [];
  }
  const pageRef = pageRefOf(observation);
  const tagNames = tagNameIndex(aggregation);
  const drafts: CanonicalEventDraft[] = [];
  const seen = new Set<string>();
  for (const [rank, row] of rows.entries()) {
    const tagRef = asString(row.tagId) ?? asString(row.id);
    if (tagRef === null || seen.has(tagRef)) {
      continue;
    }
    seen.add(tagRef);
    const material = {
      mediaOfferRef,
      tagRef,
      // NULL when the join missed. An unnamed tag is a tag we cannot name.
      tagName: tagNames.get(tagRef) ?? null,
      rank,
      periodMs: window.periodMs,
      requestedStart: window.requestedStartIso,
      requestedEnd: window.requestedEndIso,
      // Absent = null. These rows carry no video fields either.
      views: nonNegativeCount(row.views),
      previewViews: nonNegativeCount(row.previewViews),
      interactionMs: nonNegativeCount(row.interactionTime),
      previewInteractionMs: nonNegativeCount(row.previewInteractionTime),
    };
    const hash = contentHash(material);
    drafts.push({
      type: "media_tag.stats_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `mediatag:v1:${pageRef}:${mediaOfferRef}:${tagRef}:${window.periodMs}:`
        + `${window.requestedStartIso}:${window.requestedEndIso}:${hash}`,
    });
  }
  return drafts;
}

/**
 * `/it/moie/statsnew` — the WP-F4 per-media response.
 *
 * The kind was registered by F1 so it would be parseable the day the capture
 * could write it; WP-F4 is what completes it. Two event families come out:
 * `media_traffic.datapoint_observed` per bucket row (the SAME type and shape the
 * account-level media datapoints mint, with `subjectKind='media_offer'`), and
 * `media_tag.stats_observed` per `topFypTags` row.
 *
 * THE SUBJECT IS `dataset.datasetMediaOfferId` — that is the key the route
 * actually serves (6/6 live responses). The other two spellings are tried after
 * it because a body that cannot be attributed has unusable buckets and
 * tolerating a rename costs nothing.
 *
 * VIDEO FIELDS ARE ABSENT BY CONSTRUCTION HERE. All six observed responses
 * carried exactly seven stat keys and no video keys, even for a video asset, so
 * those columns come out NULL — absence, never zero ([E5]).
 */
function mediaOfferStatsDrafts(
  observation: CanonicalizableObservation,
  context: CanonicalizeRunContext | undefined,
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const payload = observation.payload;
  const dataset = isRecord(payload.dataset) ? payload.dataset : null;
  if (dataset === null) {
    return [];
  }
  const subjectRef = asString(dataset.datasetMediaOfferId)
    ?? asString(dataset.mediaOfferId)
    ?? asString(payload.mediaOfferId)
    ?? "";
  if (subjectRef === "") {
    // Without the subject the buckets are unattributable. The body stays in the
    // journal and a later version can attribute it from request_params.
    return [];
  }
  const aggregation = isRecord(payload.aggregationData) ? payload.aggregationData : {};
  const window = statsWindow(dataset);
  return [
    ...mediaTrafficDrafts(
      observation,
      dataset,
      window,
      context?.diagnostics,
      subjectRef,
    ),
    ...mediaTagStatsDrafts(observation, dataset, aggregation, window, subjectRef),
  ];
}

// ── earnings ─────────────────────────────────────────────────────────────────

/** Flat `{type, totalGross, totalNet, accountId, timestamp}` rows, one per
 *  revenue type per business day. Gross AND net are stored: the 0.8 factor is
 *  Fansly's cut and could change, so neither is derived from the other. */
function earningsBreakdownDrafts(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  for (const row of envelopeArray(observation.payload)) {
    const typeCode = asNumber(row.type);
    const bucketIso = msInstantIso(row.timestamp);
    if (typeCode === null || bucketIso === null) {
      continue;
    }
    const date = businessDate(bucketIso);
    const material = {
      businessDate: date,
      bucketTs: bucketIso,
      typeCode,
      grossMills: millsString(row.totalGross),
      netMills: millsString(row.totalNet),
      correlationAccountRef: asString(row.accountId),
    };
    const hash = contentHash(material);
    drafts.push({
      type: "earnings.breakdown_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `earnbreak:v1:${pageRef}:${date}:${typeCode}:${hash}`,
    });
  }
  return drafts;
}

/**
 * `/monthlystats` — ONE event per SERVED row, the `year: 0, month: 0` rolling
 * rollup included.
 *
 * The rollup is the creator's own Statements header and keys on (page, 0, 0)
 * like any other row; it is never summed with the real months. The daily
 * breakdown event structurally cannot carry this: `/monthlystats` has no
 * revenue type code and no business date, so without its own event
 * `revenue_month_totals` would have no replayable source at all.
 */
function earningsMonthDrafts(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  for (const row of envelopeArray(observation.payload)) {
    const year = asNumber(row.year);
    const month = asNumber(row.month);
    if (year === null || month === null) {
      continue;
    }
    const named = new Set([
      "year",
      "month",
      "totalGross",
      "totalNet",
      "before",
      "after",
      "topPercent",
      "maxTopPercent",
    ]);
    const servedExtras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!named.has(key)) {
        servedExtras[key] = value;
      }
    }
    const material = {
      year,
      month,
      isRollup: year === 0 && month === 0,
      totalGrossMills: millsString(row.totalGross),
      totalNetMills: millsString(row.totalNet),
      // `numeric`, never float — served as decimal strings end to end.
      topPercent: ratioString(row.topPercent),
      maxTopPercent: ratioString(row.maxTopPercent),
      windowStart: msInstantIso(row.after),
      windowEnd: msInstantIso(row.before),
      servedExtras,
    };
    const hash = contentHash(material);
    drafts.push({
      type: "earnings.month_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `earnmonth:v1:${pageRef}:${year}:${month}:${hash}`,
    });
  }
  return drafts;
}

// ── tracking links ───────────────────────────────────────────────────────────

/**
 * One snapshot per link per capture DAY. The counters are cumulative, so
 * consecutive-day diffs ARE the daily series.
 *
 * `totalNet` came back 0 on all five observed links while `totalGross` was
 * populated: an unpopulated counter, not a zero-revenue link. It is carried as
 * NULL and the raw served value is preserved beside it, so a later capture that
 * populates it is distinguishable from today's silence.
 */
function trackingLinkDrafts(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const capturedAtIso = observation.receivedAt.toISOString();
  const date = businessDate(capturedAtIso);
  const drafts: CanonicalEventDraft[] = [];
  for (const row of envelopeArray(observation.payload)) {
    const linkRef = asString(row.id);
    if (linkRef === null) {
      continue;
    }
    const servedNet = asNumber(row.totalNet);
    const material = {
      linkKind: "tracking" as const,
      linkRef,
      businessDate: date,
      internalRef: asString(row.internalId),
      linkType: asNumber(row.type),
      status: asNumber(row.status),
      label: asString(row.label),
      description: typeof row.description === "string" ? row.description : null,
      metadata: typeof row.metadata === "string"
        ? { raw: row.metadata }
        : isRecord(row.metadata)
        ? row.metadata
        : {},
      createdAtPlatform: msInstantIso(row.createdAt),
      clicks: nonNegativeCount(row.clicks),
      claims: nonNegativeCount(row.claims),
      follows: nonNegativeCount(row.follows),
      subscriptions: nonNegativeCount(row.subscriptions),
      totalGrossMills: millsString(row.totalGross),
      totalNetMills: servedNet !== null && servedNet > 0 ? millsString(servedNet) : null,
      /** The number the platform actually sent, so "0" and "absent" stay apart. */
      totalNetServed: servedNet,
    };
    // Same rule as the tag counters: the snapshot is per link per DAY, so the
    // capture instant travels beside the hash rather than inside it.
    const hash = contentHash(material);
    drafts.push({
      type: "tracking_link.snapshot_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, capturedAt: capturedAtIso, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `tracklink:v1:${pageRef}:${linkRef}:${date}:${hash}`,
    });
  }
  return drafts;
}

// ── discovery feed ───────────────────────────────────────────────────────────

/**
 * The tag counters ARE the payload here. The suggestion rows themselves are a
 * SAMPLE of the discovery feed — journaled, labelled sampled, and never called
 * "the global FYP corpus".
 */
function discoveryFeedDrafts(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const suggestions = recordArray(observation.payload.mediaOfferSuggestions);
  const tags: Record<string, unknown>[] = [];
  for (const suggestion of suggestions) {
    tags.push(...recordArray(suggestion.postTags), ...recordArray(suggestion.tags));
  }
  return tagCounterDrafts(observation, tags, "discovery");
}

// ── mass DM, polls, recap (A28-5) ────────────────────────────────────────────

function broadcastRows(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) {
    return Array.isArray(payload) ? payload.filter(isRecord) : [];
  }
  const messages = recordArray(payload.messages);
  if (messages.length > 0) {
    return messages;
  }
  return recordArray(payload.scheduledBroadcastMessages);
}

/**
 * `/message/broadcast/stats` and its `/deleted` sibling.
 *
 * The `/deleted` list is not a duplicate of the live one: it carries sales
 * against a mass-DM that was later WITHDRAWN, a fact that disappears entirely
 * if only the live list is read. `sourceList` is which list served the row, and
 * a broadcast that moves between them keeps its identity.
 *
 * Offer prices come from the response's `accountMedia[]`/`accountMediaBundles[]`
 * sidecars, in mills; `saleStats.total` is NET (A12).
 */
function broadcastStatsDrafts(
  observation: CanonicalizableObservation,
  sourceList: "live" | "deleted",
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const payload = isRecord(observation.payload) ? observation.payload : {};
  const sources = mediaPlaneSources(payload);
  const offerByRef = new Map<string, Record<string, unknown>>();
  for (const row of [...sources.media, ...sources.bundles]) {
    const ref = asString(row.id);
    if (ref !== null) {
      offerByRef.set(ref, row);
    }
  }

  const drafts: CanonicalEventDraft[] = [];
  for (const message of broadcastRows(payload)) {
    const broadcastRef = asString(message.id);
    if (broadcastRef === null) {
      continue;
    }
    const stats = isRecord(message.stats) ? message.stats : {};
    const attachments = recordArray(message.attachments);
    const mediaRefs: string[] = [];
    const bundleRefs: string[] = [];
    const offerPrices: Array<Record<string, unknown>> = [];
    for (const attachment of attachments) {
      const contentRef = asString(attachment.contentId) ?? asString(attachment.contentID);
      if (contentRef === null) {
        continue;
      }
      const offer = offerByRef.get(contentRef);
      const isBundle = offer !== undefined && Array.isArray(offer.accountMediaIds);
      if (isBundle) {
        bundleRefs.push(contentRef);
      } else {
        mediaRefs.push(contentRef);
      }
      // Every permission entry, verbatim — one offer can carry several prices
      // and picking one silently would invent a winner.
      const permissions = offer !== undefined && isRecord(offer.permissions)
        ? recordArray(offer.permissions.permissionFlags)
        : [];
      offerPrices.push({
        offerRef: contentRef,
        subject: isBundle ? "bundle" : "media",
        priceMills: offer === undefined ? null : millsString(offer.price),
        permissionEntries: permissions.map((entry) => ({
          ...entry,
          priceMills: millsString(entry.price),
        })),
      });
    }

    // The sale counters ride whichever sidecar carried them; the `/deleted`
    // response is where bundle saleStats were observed.
    let salesCount: number | null = null;
    let salesNetMills: string | null = null;
    let salesPendingMills: string | null = null;
    for (const ref of [...mediaRefs, ...bundleRefs]) {
      const offer = offerByRef.get(ref);
      if (offer === undefined || !isRecord(offer.saleStats)) {
        continue;
      }
      const sales = saleSummary(offer);
      salesCount = (salesCount ?? 0) + (sales.salesCount ?? 0);
      if (sales.salesNetMills !== null) {
        salesNetMills = (BigInt(salesNetMills ?? "0") + BigInt(sales.salesNetMills)).toString();
      }
      if (sales.salesPendingMills !== null) {
        salesPendingMills =
          (BigInt(salesPendingMills ?? "0") + BigInt(sales.salesPendingMills)).toString();
      }
    }

    const material = {
      broadcastRef,
      sourceList,
      groupRef: asString(message.groupId),
      senderRef: asString(message.senderId),
      content: typeof message.content === "string" ? message.content : null,
      createdAtPlatform: message.createdAt === undefined
        ? null
        : asFanslyTimestamp(message.createdAt, new Date(0)).toISOString(),
      deletedAtPlatform: sourceList === "deleted"
        ? message.deletedAt === undefined || message.deletedAt === null
          ? null
          : asFanslyTimestamp(message.deletedAt, new Date(0)).toISOString()
        : null,
      // Verbatim: total/delivered/read as the platform reported them.
      statsTotal: nonNegativeCount(stats.total),
      statsDelivered: nonNegativeCount(stats.delivered),
      statsRead: nonNegativeCount(stats.read),
      totalTipAmountMills: millsString(message.totalTipAmount),
      offeredMediaRefs: mediaRefs,
      offeredBundleRefs: bundleRefs,
      offerPrices,
      salesCount,
      salesNetMills,
      salesPendingMills,
    };
    const hash = contentHash(material);
    drafts.push({
      type: "broadcast.stats_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `broadcast:v1:${pageRef}:${broadcastRef}:${hash}`,
    });
  }
  return drafts;
}

/** `/message/broadcast/scheduled` — intent, before it is sent. */
function broadcastScheduledDrafts(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const payload = isRecord(observation.payload) ? observation.payload : {};
  const drafts: CanonicalEventDraft[] = [];
  for (const message of broadcastRows(payload)) {
    const broadcastRef = asString(message.id);
    if (broadcastRef === null) {
      continue;
    }
    const scheduledRaw = message.scheduledAt ?? message.sendAt ?? message.scheduledFor;
    const material = {
      broadcastRef,
      sourceList: "scheduled" as const,
      groupRef: asString(message.groupId),
      senderRef: asString(message.senderId),
      content: typeof message.content === "string" ? message.content : null,
      createdAtPlatform: message.createdAt === undefined
        ? null
        : asFanslyTimestamp(message.createdAt, new Date(0)).toISOString(),
      scheduledFor: scheduledRaw === undefined || scheduledRaw === null
        ? null
        : asFanslyTimestamp(scheduledRaw, new Date(0)).toISOString(),
      // Unknown keys are preserved here rather than dropped: this route's shape
      // is a redacted skeleton, not a contract (WP-F9 item 5's caveat).
      servedExtras: message,
    };
    const hash = contentHash(material);
    drafts.push({
      type: "broadcast.scheduled_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `broadcastsched:v1:${pageRef}:${broadcastRef}:${hash}`,
    });
  }
  return drafts;
}

/** `/polls` — options and their vote counts, verbatim. */
function pollDrafts(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  for (const poll of envelopeArray(observation.payload)) {
    const pollRef = asString(poll.id);
    if (pollRef === null) {
      continue;
    }
    const options = recordArray(poll.options).flatMap((option, ordinal) => {
      const optionRef = asString(option.id);
      return optionRef === null ? [] : [{
        optionRef,
        optionOrdinal: ordinal,
        title: typeof option.title === "string" ? option.title : null,
        voteCount: nonNegativeCount(option.voteCount),
      }];
    });
    const material = {
      pollRef,
      title: typeof poll.title === "string" ? poll.title : null,
      description: typeof poll.description === "string" ? poll.description : null,
      status: asNumber(poll.status),
      pollVersion: asNumber(poll.version),
      createdAtPlatform: poll.createdAt === undefined
        ? null
        : asFanslyTimestamp(poll.createdAt, new Date(0)).toISOString(),
      options,
    };
    const hash = contentHash(material);
    drafts.push({
      type: "poll.observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `poll:v1:${pageRef}:${pollRef}:${hash}`,
    });
  }
  return drafts;
}

/** `/recapstats` — a yearly recap. `statValue` is a STRING and stays one. */
function recapDrafts(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  for (const row of envelopeArray(observation.payload)) {
    const statRef = asString(row.statId);
    const recapYear = asNumber(row.recapYear);
    if (statRef === null || recapYear === null) {
      continue;
    }
    const material = {
      recapYear,
      statRef,
      statName: typeof row.statName === "string" ? row.statName : null,
      // VERBATIM. A recap value can be a count, a duration, a name or a
      // formatted phrase, and a number parsed out of it would be a guess about
      // which — so it is never coerced, not even when it looks numeric.
      statValue: typeof row.statValue === "string"
        ? row.statValue
        : row.statValue === null || row.statValue === undefined
        ? null
        : String(row.statValue),
      statValueWasString: typeof row.statValue === "string",
      generatedAt: row.generatedAt === undefined
        ? null
        : asFanslyTimestamp(row.generatedAt, new Date(0)).toISOString(),
    };
    const hash = contentHash(material);
    drafts.push({
      type: "recap.stat_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `recap:v1:${pageRef}:${recapYear}:${statRef}:${hash}`,
    });
  }
  return drafts;
}

// ── family entry points ──────────────────────────────────────────────────────

/**
 * Shape gate. `false` leaves the row UNSTAMPED for a future parser instead of
 * consuming it with zero events — without it a drifted payload is
 * indistinguishable from a legitimately EMPTY snapshot, and "capture now, parse
 * later" quietly becomes "capture now, never parse".
 *
 * An EMPTY response is deliberately parseable: an empty window IS the
 * retention-floor evidence the backfill is looking for, and refusing to stamp
 * it would make the sweep re-read it forever.
 */
export function canParseFanslyStatsObservation(
  observation: Pick<CanonicalizableObservation, "kind" | "payload" | "accountId">,
): boolean {
  if (!CANONICALIZED_KIND_SET.has(observation.kind) || observation.accountId === null) {
    return false;
  }
  const payload = observation.payload;
  switch (observation.kind) {
    case "account_stats":
    case "media_offer_stats":
      return isRecord(payload) && isRecord(payload.dataset);
    case "earnings_stats_snapshot":
    case "earnings_monthlystats_snapshot":
    case "tracking_links":
    case "polls":
    case "recapstats":
      return Array.isArray(payload) || isRecord(payload);
    case "discovery_feed":
      return isRecord(payload) && Array.isArray(payload.mediaOfferSuggestions);
    case "broadcast_stats":
    case "broadcast_stats_deleted":
    case "broadcast_scheduled":
      // The skeletons come from a redacted probe, not a contract: accept any
      // object or array and let the tolerant parser take what it recognizes.
      return isRecord(payload) || Array.isArray(payload);
    default:
      return false;
  }
}

export function canonicalizeFanslyStatsObservation(
  observation: CanonicalizableObservation,
  context?: CanonicalizeRunContext,
): CanonicalEventDraft[] {
  if (observation.accountId === null) {
    return [];
  }
  switch (observation.kind) {
    case "account_stats":
      return accountStatsDrafts(observation, context);
    case "media_offer_stats":
      return mediaOfferStatsDrafts(observation, context);
    case "earnings_stats_snapshot":
      return earningsBreakdownDrafts(observation);
    case "earnings_monthlystats_snapshot":
      return earningsMonthDrafts(observation);
    case "tracking_links":
      return trackingLinkDrafts(observation);
    case "discovery_feed":
      return discoveryFeedDrafts(observation);
    case "broadcast_stats":
      return broadcastStatsDrafts(observation, "live");
    case "broadcast_stats_deleted":
      return broadcastStatsDrafts(observation, "deleted");
    case "broadcast_scheduled":
      return broadcastScheduledDrafts(observation);
    case "polls":
      return pollDrafts(observation);
    case "recapstats":
      return recapDrafts(observation);
    default:
      return [];
  }
}

/** Re-exported so the tests and the projector share one mills convention. */
export { millsFromInteger };
