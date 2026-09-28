// WP-F1 statistics core writers (migration 0132).
//
// Every writer here is a GUARDED UPSERT with the media-plane precedence rule:
// the newer OBSERVATION wins, with `source_account_seq` as the deterministic
// same-instant tie-break. Ledger order is APPEND order, not observation order,
// so a replay of an older capture must never overwrite a fresher head.
// `first_observed_at` only ever moves backwards.
//
// TWO THINGS THIS FILE REFUSES TO DO, both on purpose:
//
// 1. It never coalesces a NULL metric to 0. A metric the platform did not serve
//    is NULL forever; the read layer decides what to show. `/it/moie/statsnew`
//    serves no video fields at all, `saleStats` was populated on 2 of 85 media
//    rows, and `/trackinglinks.totalNet` came back 0 on every observed link
//    while totalGross was populated — a coalesce would turn all three into
//    measurements nobody made.
// 2. It never stores a label in place of a code. Storage holds the raw integer
//    (A22-2); labels are read-time and versioned.
//
// `capture_coverage` is the exception to the shape: it is CAPTURE-PLANE
// OPERATIONAL STATE (§3.4, A17-6), written by the capture handler rather than
// by a projector, and `projection:rebuild` never truncates it.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

export type FanslyStatsPlatform = "fansly" | "onlyfans";

/** Shared precedence guard: excluded wins on a newer observation instant, or on
 *  the same instant with a higher account_seq. */
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

/** Ratios travel as decimal STRINGS and land in `numeric` — never through a JS
 *  float, which is the whole reason the column is numeric. */
function numericParam(value: string | null): SQL {
  return value === null ? sql`null` : sql`${value}::numeric`;
}

/**
 * ONE bound parameter carrying a Postgres array literal, then cast.
 *
 * Not `sql`${array}`` — drizzle expands an array chunk into a comma-separated
 * parameter LIST, so an EMPTY array expands to nothing and the statement
 * becomes a syntax error at runtime on exactly the common case.
 */
function textArrayParam(values: readonly string[]): SQL {
  const literal = `{${
    values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")
  }}`;
  return sql`${literal}::text[]`;
}

export interface StatsLineage {
  observedAt: Date;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

// ── traffic buckets ──────────────────────────────────────────────────────────

export interface UpsertStatsTrafficBucketInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  subjectKind: "account_profile" | "account_media" | "media_offer" | "post";
  subjectRef: string;
  periodMs: number;
  bucketStart: Date;
  /** The RAW platform code, as text. Never a label. */
  sourceCode: string;
  mappingVersion: number;
  views: number | null;
  previewViews: number | null;
  uniqueViewers: number | null;
  previewUniqueViewers: number | null;
  videoViews: number | null;
  previewVideoViews: number | null;
  interactionTimeMs: number | null;
  previewInteractionTimeMs: number | null;
  /** Already a SUM on the wire; stored raw and divided only at read time. */
  videoPercentWatchedSum: string | null;
  previewVideoPercentWatchedSum: string | null;
  requestedStart: Date | null;
  requestedEnd: Date | null;
}

export async function upsertStatsTrafficBucket(
  db: Database,
  input: UpsertStatsTrafficBucketInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into stats_traffic_buckets (
      page_id, platform, subject_kind, subject_ref, period_ms, bucket_start,
      source_code, mapping_version, views, preview_views, unique_viewers,
      preview_unique_viewers, video_views, preview_video_views,
      interaction_time_ms, preview_interaction_time_ms,
      video_percent_watched_sum, preview_video_percent_watched_sum,
      requested_start, requested_end, content_hash, revision_count,
      first_observed_at, last_observed_at, source_event_id,
      source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.subjectKind}, ${input.subjectRef},
      ${input.periodMs}, ${input.bucketStart}, ${input.sourceCode}, ${input.mappingVersion},
      ${input.views}, ${input.previewViews}, ${input.uniqueViewers},
      ${input.previewUniqueViewers}, ${input.videoViews}, ${input.previewVideoViews},
      ${input.interactionTimeMs}, ${input.previewInteractionTimeMs},
      ${numericParam(input.videoPercentWatchedSum)},
      ${numericParam(input.previewVideoPercentWatchedSum)},
      ${input.requestedStart}, ${input.requestedEnd}, ${input.contentHash}, 0,
      ${input.observedAt}, ${input.observedAt}, ${input.sourceEventId},
      ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, subject_kind, subject_ref, period_ms, bucket_start, source_code)
    do update set
      mapping_version = ${pick("stats_traffic_buckets", "mapping_version")},
      views = ${pick("stats_traffic_buckets", "views")},
      preview_views = ${pick("stats_traffic_buckets", "preview_views")},
      unique_viewers = ${pick("stats_traffic_buckets", "unique_viewers")},
      preview_unique_viewers = ${pick("stats_traffic_buckets", "preview_unique_viewers")},
      video_views = ${pick("stats_traffic_buckets", "video_views")},
      preview_video_views = ${pick("stats_traffic_buckets", "preview_video_views")},
      interaction_time_ms = ${pick("stats_traffic_buckets", "interaction_time_ms")},
      preview_interaction_time_ms =
        ${pick("stats_traffic_buckets", "preview_interaction_time_ms")},
      video_percent_watched_sum =
        ${pick("stats_traffic_buckets", "video_percent_watched_sum")},
      preview_video_percent_watched_sum =
        ${pick("stats_traffic_buckets", "preview_video_percent_watched_sum")},
      requested_start = ${pick("stats_traffic_buckets", "requested_start")},
      requested_end = ${pick("stats_traffic_buckets", "requested_end")},
      content_hash = ${pick("stats_traffic_buckets", "content_hash")},
      source_event_id = ${pick("stats_traffic_buckets", "source_event_id")},
      source_observation_id = ${pick("stats_traffic_buckets", "source_observation_id")},
      source_account_seq = ${pick("stats_traffic_buckets", "source_account_seq")},
      -- A revisable trailing bucket the platform RESTATED. The content hash
      -- also carries the requested window (and the label mapping), and the
      -- window shifts on every daily look, so a hash change is a RE-CAPTURE
      -- as often as a revision. Only a changed metric counts.
      revision_count = case
        when (
          stats_traffic_buckets.views, stats_traffic_buckets.preview_views,
          stats_traffic_buckets.unique_viewers, stats_traffic_buckets.preview_unique_viewers,
          stats_traffic_buckets.video_views, stats_traffic_buckets.preview_video_views,
          stats_traffic_buckets.interaction_time_ms,
          stats_traffic_buckets.preview_interaction_time_ms,
          stats_traffic_buckets.video_percent_watched_sum,
          stats_traffic_buckets.preview_video_percent_watched_sum
        ) is distinct from (
          excluded.views, excluded.preview_views,
          excluded.unique_viewers, excluded.preview_unique_viewers,
          excluded.video_views, excluded.preview_video_views,
          excluded.interaction_time_ms, excluded.preview_interaction_time_ms,
          excluded.video_percent_watched_sum, excluded.preview_video_percent_watched_sum
        )
        then stats_traffic_buckets.revision_count + 1
        else stats_traffic_buckets.revision_count
      end,
      first_observed_at =
        least(stats_traffic_buckets.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(stats_traffic_buckets.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

// ── top-N rankings (window identity inline, A21) ─────────────────────────────

export interface UpsertStatsTopMediaInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  plane: "top_media" | "top_fyp_media";
  periodMs: number;
  requestedStart: Date;
  requestedEnd: Date;
  mediaOfferRef: string;
  bundleRef: string | null;
  rank: number;
  views: number | null;
  previewViews: number | null;
  interactionTimeMs: number | null;
  previewInteractionTimeMs: number | null;
}

export async function upsertStatsTopMedia(
  db: Database,
  input: UpsertStatsTopMediaInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into stats_top_media (
      page_id, platform, plane, period_ms, requested_start, requested_end,
      media_offer_ref, bundle_ref, rank, views, preview_views,
      interaction_time_ms, preview_interaction_time_ms, content_hash,
      observed_at, source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.plane}, ${input.periodMs},
      ${input.requestedStart}, ${input.requestedEnd}, ${input.mediaOfferRef},
      ${input.bundleRef}, ${input.rank}, ${input.views}, ${input.previewViews},
      ${input.interactionTimeMs}, ${input.previewInteractionTimeMs},
      ${input.contentHash}, ${input.observedAt}, ${input.sourceEventId},
      ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, plane, period_ms, requested_start, requested_end, media_offer_ref)
    do update set
      bundle_ref = case
        when excluded.observed_at > stats_top_media.observed_at
          or (excluded.observed_at = stats_top_media.observed_at
            and excluded.source_account_seq > stats_top_media.source_account_seq)
        then excluded.bundle_ref else stats_top_media.bundle_ref end,
      rank = case
        when excluded.observed_at > stats_top_media.observed_at
          or (excluded.observed_at = stats_top_media.observed_at
            and excluded.source_account_seq > stats_top_media.source_account_seq)
        then excluded.rank else stats_top_media.rank end,
      views = case
        when excluded.observed_at > stats_top_media.observed_at
          or (excluded.observed_at = stats_top_media.observed_at
            and excluded.source_account_seq > stats_top_media.source_account_seq)
        then excluded.views else stats_top_media.views end,
      preview_views = case
        when excluded.observed_at > stats_top_media.observed_at
          or (excluded.observed_at = stats_top_media.observed_at
            and excluded.source_account_seq > stats_top_media.source_account_seq)
        then excluded.preview_views else stats_top_media.preview_views end,
      interaction_time_ms = case
        when excluded.observed_at > stats_top_media.observed_at
          or (excluded.observed_at = stats_top_media.observed_at
            and excluded.source_account_seq > stats_top_media.source_account_seq)
        then excluded.interaction_time_ms else stats_top_media.interaction_time_ms end,
      preview_interaction_time_ms = case
        when excluded.observed_at > stats_top_media.observed_at
          or (excluded.observed_at = stats_top_media.observed_at
            and excluded.source_account_seq > stats_top_media.source_account_seq)
        then excluded.preview_interaction_time_ms
        else stats_top_media.preview_interaction_time_ms end,
      content_hash = case
        when excluded.observed_at > stats_top_media.observed_at
          or (excluded.observed_at = stats_top_media.observed_at
            and excluded.source_account_seq > stats_top_media.source_account_seq)
        then excluded.content_hash else stats_top_media.content_hash end,
      source_event_id = case
        when excluded.observed_at > stats_top_media.observed_at
          or (excluded.observed_at = stats_top_media.observed_at
            and excluded.source_account_seq > stats_top_media.source_account_seq)
        then excluded.source_event_id else stats_top_media.source_event_id end,
      source_observation_id = case
        when excluded.observed_at > stats_top_media.observed_at
          or (excluded.observed_at = stats_top_media.observed_at
            and excluded.source_account_seq > stats_top_media.source_account_seq)
        then excluded.source_observation_id else stats_top_media.source_observation_id end,
      source_account_seq = greatest(
        stats_top_media.source_account_seq, excluded.source_account_seq
      ),
      observed_at = greatest(stats_top_media.observed_at, excluded.observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export interface UpsertStatsTopTagInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  plane: "top_fyp_tags";
  periodMs: number;
  requestedStart: Date;
  requestedEnd: Date;
  tagRef: string;
  /** NULL when the tags[] join misses. NEVER fabricated from the id. */
  tagName: string | null;
  rank: number;
  views: number | null;
  previewViews: number | null;
  interactionTimeMs: number | null;
  previewInteractionTimeMs: number | null;
}

export async function upsertStatsTopTag(
  db: Database,
  input: UpsertStatsTopTagInput,
): Promise<{ applied: boolean }> {
  const fresher = sql`
    excluded.observed_at > stats_top_tags.observed_at
    or (excluded.observed_at = stats_top_tags.observed_at
      and excluded.source_account_seq > stats_top_tags.source_account_seq)
  `;
  const result = await db.execute(sql`
    insert into stats_top_tags (
      page_id, platform, plane, period_ms, requested_start, requested_end,
      tag_ref, tag_name, rank, views, preview_views, interaction_time_ms,
      preview_interaction_time_ms, content_hash, observed_at, source_event_id,
      source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.plane}, ${input.periodMs},
      ${input.requestedStart}, ${input.requestedEnd}, ${input.tagRef}, ${input.tagName},
      ${input.rank}, ${input.views}, ${input.previewViews}, ${input.interactionTimeMs},
      ${input.previewInteractionTimeMs}, ${input.contentHash}, ${input.observedAt},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, plane, period_ms, requested_start, requested_end, tag_ref)
    do update set
      tag_name = case when ${fresher} then excluded.tag_name else stats_top_tags.tag_name end,
      rank = case when ${fresher} then excluded.rank else stats_top_tags.rank end,
      views = case when ${fresher} then excluded.views else stats_top_tags.views end,
      preview_views = case
        when ${fresher} then excluded.preview_views else stats_top_tags.preview_views end,
      interaction_time_ms = case
        when ${fresher} then excluded.interaction_time_ms
        else stats_top_tags.interaction_time_ms end,
      preview_interaction_time_ms = case
        when ${fresher} then excluded.preview_interaction_time_ms
        else stats_top_tags.preview_interaction_time_ms end,
      content_hash = case
        when ${fresher} then excluded.content_hash else stats_top_tags.content_hash end,
      source_event_id = case
        when ${fresher} then excluded.source_event_id else stats_top_tags.source_event_id end,
      source_observation_id = case
        when ${fresher} then excluded.source_observation_id
        else stats_top_tags.source_observation_id end,
      source_account_seq = greatest(
        stats_top_tags.source_account_seq, excluded.source_account_seq
      ),
      observed_at = greatest(stats_top_tags.observed_at, excluded.observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

// ── per-media tag rankings (WP-F4) ───────────────────────────────────────────

export interface UpsertFanslyMediaTagStatInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  mediaOfferRef: string;
  tagRef: string;
  periodMs: number;
  requestedStart: Date;
  requestedEnd: Date;
  /** NULL when the response's `aggregationData.tags[]` join misses. NEVER
   *  fabricated from the id — an unnamed tag is a tag we cannot name. */
  tagName: string | null;
  rank: number | null;
  views: number | null;
  previewViews: number | null;
  interactionTimeMs: number | null;
  previewInteractionTimeMs: number | null;
}

/**
 * `dataset.topFypTags[]` from `/it/moie/statsnew` — the finest FYP attribution
 * Fansly exposes: which tags brought traffic to THIS media item in THIS window.
 *
 * The WINDOW is part of the key, exactly as it is on the two account-level top-N
 * tables: rank 2 of one window is not the same fact as rank 2 of the next, and
 * merging them would silently overwrite history with the newest ranking. F1
 * created the table and left it empty on purpose; this is what fills it.
 *
 * Precedence is the NEWER OBSERVATION, with `source_account_seq` as the
 * same-instant tie-break — ledger order is append order, so a replay of an older
 * capture must never overwrite a fresher head. `first_observed_at` only ever
 * moves backwards.
 */
export async function upsertFanslyMediaTagStat(
  db: Database,
  input: UpsertFanslyMediaTagStatInput,
): Promise<{ applied: boolean }> {
  const fresher = sql`
    excluded.last_observed_at > fansly_media_tag_stats.last_observed_at
    or (excluded.last_observed_at = fansly_media_tag_stats.last_observed_at
      and excluded.source_account_seq > fansly_media_tag_stats.source_account_seq)
  `;
  const pick = (column: string) => {
    const name = sql.identifier(column);
    return sql`case when ${fresher} then excluded.${name}
      else fansly_media_tag_stats.${name} end`;
  };
  const result = await db.execute(sql`
    insert into fansly_media_tag_stats (
      page_id, platform, media_offer_ref, tag_ref, period_ms, requested_start,
      requested_end, tag_name, rank, views, preview_views, interaction_time_ms,
      preview_interaction_time_ms, content_hash, first_observed_at,
      last_observed_at, source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.mediaOfferRef}, ${input.tagRef},
      ${input.periodMs}, ${input.requestedStart}, ${input.requestedEnd},
      ${input.tagName}, ${input.rank}, ${input.views}, ${input.previewViews},
      ${input.interactionTimeMs}, ${input.previewInteractionTimeMs},
      ${input.contentHash}, ${input.observedAt}, ${input.observedAt},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (
      page_id, media_offer_ref, tag_ref, period_ms, requested_start, requested_end
    ) do update set
      tag_name = ${pick("tag_name")},
      rank = ${pick("rank")},
      views = ${pick("views")},
      preview_views = ${pick("preview_views")},
      interaction_time_ms = ${pick("interaction_time_ms")},
      preview_interaction_time_ms = ${pick("preview_interaction_time_ms")},
      content_hash = ${pick("content_hash")},
      source_event_id = ${pick("source_event_id")},
      source_observation_id = ${pick("source_observation_id")},
      source_account_seq = greatest(
        fansly_media_tag_stats.source_account_seq, excluded.source_account_seq
      ),
      first_observed_at = least(
        fansly_media_tag_stats.first_observed_at, excluded.first_observed_at
      ),
      last_observed_at = greatest(
        fansly_media_tag_stats.last_observed_at, excluded.last_observed_at
      ),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

// ── platform-global tag samples ──────────────────────────────────────────────

export interface UpsertPlatformTagDailyInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  tagRef: string;
  businessDate: string;
  tagName: string | null;
  viewCount: number | null;
  postCount: number | null;
  tagCreatedAt: Date | null;
  source: "stats_agg" | "discovery";
  capturedAt: Date;
}

export async function upsertPlatformTagDaily(
  db: Database,
  input: UpsertPlatformTagDailyInput,
): Promise<{ applied: boolean }> {
  const fresher = sql`
    excluded.captured_at > platform_tag_daily.captured_at
    or (excluded.captured_at = platform_tag_daily.captured_at
      and excluded.source_account_seq > platform_tag_daily.source_account_seq)
  `;
  const result = await db.execute(sql`
    insert into platform_tag_daily (
      page_id, platform, tag_ref, business_date, tag_name, view_count, post_count,
      tag_created_at, source, captured_at, content_hash, source_event_id,
      source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.tagRef}, ${input.businessDate}::date,
      ${input.tagName}, ${input.viewCount}, ${input.postCount}, ${input.tagCreatedAt},
      ${input.source}, ${input.capturedAt}, ${input.contentHash}, ${input.sourceEventId},
      ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, platform, tag_ref, business_date) do update set
      tag_name = case
        when ${fresher} then excluded.tag_name else platform_tag_daily.tag_name end,
      view_count = case
        when ${fresher} then excluded.view_count else platform_tag_daily.view_count end,
      post_count = case
        when ${fresher} then excluded.post_count else platform_tag_daily.post_count end,
      tag_created_at = case
        when ${fresher} then excluded.tag_created_at
        else platform_tag_daily.tag_created_at end,
      source = case when ${fresher} then excluded.source else platform_tag_daily.source end,
      content_hash = case
        when ${fresher} then excluded.content_hash else platform_tag_daily.content_hash end,
      source_event_id = case
        when ${fresher} then excluded.source_event_id
        else platform_tag_daily.source_event_id end,
      source_observation_id = case
        when ${fresher} then excluded.source_observation_id
        else platform_tag_daily.source_observation_id end,
      source_account_seq = greatest(
        platform_tag_daily.source_account_seq, excluded.source_account_seq
      ),
      captured_at = greatest(platform_tag_daily.captured_at, excluded.captured_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

// ── media offer locations (A17-5) ────────────────────────────────────────────

export interface UpsertMediaOfferLocationInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  locationRef: string;
  mediaOfferRef: string | null;
  mediaOfferType: number | null;
  bundleRef: string | null;
  mediaRef: string | null;
  mediaType: number | null;
  previewRef: string | null;
  ownerAccountRef: string | null;
  locationIdRef: string | null;
  correlationRef: string | null;
  createdAtPlatform: Date | null;
}

export async function upsertMediaOfferLocation(
  db: Database,
  input: UpsertMediaOfferLocationInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into media_offer_locations (
      page_id, platform, location_ref, media_offer_ref, media_offer_type, bundle_ref,
      media_ref, media_type, preview_ref, owner_account_ref, location_id_ref,
      correlation_ref, created_at_platform, content_hash, first_observed_at,
      last_observed_at, source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.locationRef}, ${input.mediaOfferRef},
      ${input.mediaOfferType}, ${input.bundleRef}, ${input.mediaRef}, ${input.mediaType},
      ${input.previewRef}, ${input.ownerAccountRef}, ${input.locationIdRef},
      ${input.correlationRef}, ${input.createdAtPlatform}, ${input.contentHash},
      ${input.observedAt}, ${input.observedAt}, ${input.sourceEventId},
      ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, platform, location_ref) do update set
      media_offer_ref = ${pick("media_offer_locations", "media_offer_ref")},
      media_offer_type = ${pick("media_offer_locations", "media_offer_type")},
      bundle_ref = ${pick("media_offer_locations", "bundle_ref")},
      media_ref = ${pick("media_offer_locations", "media_ref")},
      media_type = ${pick("media_offer_locations", "media_type")},
      preview_ref = ${pick("media_offer_locations", "preview_ref")},
      owner_account_ref = ${pick("media_offer_locations", "owner_account_ref")},
      location_id_ref = ${pick("media_offer_locations", "location_id_ref")},
      correlation_ref = ${pick("media_offer_locations", "correlation_ref")},
      created_at_platform = ${pick("media_offer_locations", "created_at_platform")},
      content_hash = ${pick("media_offer_locations", "content_hash")},
      source_event_id = ${pick("media_offer_locations", "source_event_id")},
      source_observation_id = ${pick("media_offer_locations", "source_observation_id")},
      source_account_seq = ${pick("media_offer_locations", "source_account_seq")},
      first_observed_at =
        least(media_offer_locations.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(media_offer_locations.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

// ── revenue ──────────────────────────────────────────────────────────────────

export interface UpsertRevenueMixDailyInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  businessDate: string;
  /** RAW revenue-type code (A22-2). */
  typeCode: number;
  grossMills: bigint | null;
  netMills: bigint | null;
  correlationAccountRef: string | null;
}

export async function upsertRevenueMixDaily(
  db: Database,
  input: UpsertRevenueMixDailyInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into revenue_mix_daily (
      page_id, platform, business_date, type_code, gross_mills, net_mills,
      correlation_account_ref, content_hash, first_observed_at, last_observed_at,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.businessDate}::date, ${input.typeCode},
      ${millsParam(input.grossMills)}, ${millsParam(input.netMills)},
      ${input.correlationAccountRef}, ${input.contentHash}, ${input.observedAt},
      ${input.observedAt}, ${input.sourceEventId}, ${input.sourceObservationId},
      ${input.sourceAccountSeq}
    )
    on conflict (page_id, platform, business_date, type_code) do update set
      gross_mills = ${pick("revenue_mix_daily", "gross_mills")},
      net_mills = ${pick("revenue_mix_daily", "net_mills")},
      correlation_account_ref = ${pick("revenue_mix_daily", "correlation_account_ref")},
      content_hash = ${pick("revenue_mix_daily", "content_hash")},
      source_event_id = ${pick("revenue_mix_daily", "source_event_id")},
      source_observation_id = ${pick("revenue_mix_daily", "source_observation_id")},
      source_account_seq = ${pick("revenue_mix_daily", "source_account_seq")},
      first_observed_at =
        least(revenue_mix_daily.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(revenue_mix_daily.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export interface UpsertRevenueMonthTotalInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  /** 0/0 is the rolling-rollup row — a row like any other, never summed in. */
  year: number;
  month: number;
  totalGrossMills: bigint | null;
  totalNetMills: bigint | null;
  topPercent: string | null;
  maxTopPercent: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  servedExtras: Record<string, unknown>;
}

export async function upsertRevenueMonthTotal(
  db: Database,
  input: UpsertRevenueMonthTotalInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into revenue_month_totals (
      page_id, platform, year, month, total_gross_mills, total_net_mills,
      top_percent, max_top_percent, window_start, window_end, served_extras,
      content_hash, first_observed_at, last_observed_at, source_event_id,
      source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.year}, ${input.month},
      ${millsParam(input.totalGrossMills)}, ${millsParam(input.totalNetMills)},
      ${numericParam(input.topPercent)}, ${numericParam(input.maxTopPercent)},
      ${input.windowStart}, ${input.windowEnd},
      ${JSON.stringify(input.servedExtras)}::jsonb, ${input.contentHash},
      ${input.observedAt}, ${input.observedAt}, ${input.sourceEventId},
      ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, platform, year, month) do update set
      total_gross_mills = ${pick("revenue_month_totals", "total_gross_mills")},
      total_net_mills = ${pick("revenue_month_totals", "total_net_mills")},
      top_percent = ${pick("revenue_month_totals", "top_percent")},
      max_top_percent = ${pick("revenue_month_totals", "max_top_percent")},
      window_start = ${pick("revenue_month_totals", "window_start")},
      window_end = ${pick("revenue_month_totals", "window_end")},
      served_extras = ${pick("revenue_month_totals", "served_extras")},
      content_hash = ${pick("revenue_month_totals", "content_hash")},
      source_event_id = ${pick("revenue_month_totals", "source_event_id")},
      source_observation_id = ${pick("revenue_month_totals", "source_observation_id")},
      source_account_seq = ${pick("revenue_month_totals", "source_account_seq")},
      first_observed_at =
        least(revenue_month_totals.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(revenue_month_totals.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

// ── promo links ──────────────────────────────────────────────────────────────

export interface UpsertPagePromoLinkInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  linkKind: "tracking" | "gift_code";
  linkRef: string;
  businessDate: string;
  internalRef: string | null;
  linkType: number | null;
  status: number | null;
  label: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAtPlatform: Date | null;
  clicks: number | null;
  claims: number | null;
  follows: number | null;
  subscriptions: number | null;
  totalGrossMills: bigint | null;
  /** NULL when the platform served 0-or-null — unpopulated, never a real zero. */
  totalNetMills: bigint | null;
  capturedAt: Date;
}

export async function upsertPagePromoLink(
  db: Database,
  input: UpsertPagePromoLinkInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into page_promo_links (
      page_id, platform, link_kind, link_ref, business_date, internal_ref, link_type,
      status, label, description, metadata, created_at_platform, clicks, claims,
      follows, subscriptions, total_gross_mills, total_net_mills, captured_at,
      content_hash, first_observed_at, last_observed_at, source_event_id,
      source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.linkKind}, ${input.linkRef},
      ${input.businessDate}::date, ${input.internalRef}, ${input.linkType}, ${input.status},
      ${input.label}, ${input.description}, ${JSON.stringify(input.metadata)}::jsonb,
      ${input.createdAtPlatform}, ${input.clicks}, ${input.claims}, ${input.follows},
      ${input.subscriptions}, ${millsParam(input.totalGrossMills)},
      ${millsParam(input.totalNetMills)}, ${input.capturedAt}, ${input.contentHash},
      ${input.observedAt}, ${input.observedAt}, ${input.sourceEventId},
      ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, platform, link_kind, link_ref, business_date) do update set
      internal_ref = ${pick("page_promo_links", "internal_ref")},
      link_type = ${pick("page_promo_links", "link_type")},
      status = ${pick("page_promo_links", "status")},
      label = ${pick("page_promo_links", "label")},
      description = ${pick("page_promo_links", "description")},
      metadata = ${pick("page_promo_links", "metadata")},
      created_at_platform = ${pick("page_promo_links", "created_at_platform")},
      clicks = ${pick("page_promo_links", "clicks")},
      claims = ${pick("page_promo_links", "claims")},
      follows = ${pick("page_promo_links", "follows")},
      subscriptions = ${pick("page_promo_links", "subscriptions")},
      total_gross_mills = ${pick("page_promo_links", "total_gross_mills")},
      total_net_mills = ${pick("page_promo_links", "total_net_mills")},
      captured_at = ${pick("page_promo_links", "captured_at")},
      content_hash = ${pick("page_promo_links", "content_hash")},
      source_event_id = ${pick("page_promo_links", "source_event_id")},
      source_observation_id = ${pick("page_promo_links", "source_observation_id")},
      source_account_seq = ${pick("page_promo_links", "source_account_seq")},
      first_observed_at =
        least(page_promo_links.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(page_promo_links.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

// ── mass DM (A28-5) ──────────────────────────────────────────────────────────

export interface UpsertPageBroadcastInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  broadcastRef: string;
  sourceList: "live" | "deleted" | "scheduled";
  groupRef: string | null;
  senderRef: string | null;
  content: string | null;
  createdAtPlatform: Date | null;
  scheduledFor: Date | null;
  deletedAtPlatform: Date | null;
  statsTotal: number | null;
  statsDelivered: number | null;
  statsRead: number | null;
  totalTipAmountMills: bigint | null;
  offeredMediaRefs: readonly string[];
  offeredBundleRefs: readonly string[];
  offerPrices: unknown[];
  salesCount: number | null;
  /** A12: NET. */
  salesNetMills: bigint | null;
  salesPendingMills: bigint | null;
}

export async function upsertPageBroadcast(
  db: Database,
  input: UpsertPageBroadcastInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into page_broadcasts (
      page_id, platform, broadcast_ref, source_list, group_ref, sender_ref, content,
      created_at_platform, scheduled_for, deleted_at_platform, stats_total,
      stats_delivered, stats_read, total_tip_amount_mills, offered_media_refs,
      offered_bundle_refs, offer_prices, sales_count, sales_net_mills,
      sales_pending_mills, content_hash, first_observed_at, last_observed_at,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.broadcastRef}, ${input.sourceList},
      ${input.groupRef}, ${input.senderRef}, ${input.content}, ${input.createdAtPlatform},
      ${input.scheduledFor}, ${input.deletedAtPlatform}, ${input.statsTotal},
      ${input.statsDelivered}, ${input.statsRead}, ${millsParam(input.totalTipAmountMills)},
      ${textArrayParam(input.offeredMediaRefs)}, ${textArrayParam(input.offeredBundleRefs)},
      ${JSON.stringify(input.offerPrices)}::jsonb, ${input.salesCount},
      ${millsParam(input.salesNetMills)}, ${millsParam(input.salesPendingMills)},
      ${input.contentHash}, ${input.observedAt}, ${input.observedAt},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, platform, broadcast_ref) do update set
      source_list = ${pick("page_broadcasts", "source_list")},
      group_ref = ${pick("page_broadcasts", "group_ref")},
      sender_ref = ${pick("page_broadcasts", "sender_ref")},
      content = ${pick("page_broadcasts", "content")},
      created_at_platform = ${pick("page_broadcasts", "created_at_platform")},
      scheduled_for = ${pick("page_broadcasts", "scheduled_for")},
      deleted_at_platform = ${pick("page_broadcasts", "deleted_at_platform")},
      stats_total = ${pick("page_broadcasts", "stats_total")},
      stats_delivered = ${pick("page_broadcasts", "stats_delivered")},
      stats_read = ${pick("page_broadcasts", "stats_read")},
      total_tip_amount_mills = ${pick("page_broadcasts", "total_tip_amount_mills")},
      offered_media_refs = ${pick("page_broadcasts", "offered_media_refs")},
      offered_bundle_refs = ${pick("page_broadcasts", "offered_bundle_refs")},
      offer_prices = ${pick("page_broadcasts", "offer_prices")},
      sales_count = ${pick("page_broadcasts", "sales_count")},
      sales_net_mills = ${pick("page_broadcasts", "sales_net_mills")},
      sales_pending_mills = ${pick("page_broadcasts", "sales_pending_mills")},
      content_hash = ${pick("page_broadcasts", "content_hash")},
      source_event_id = ${pick("page_broadcasts", "source_event_id")},
      source_observation_id = ${pick("page_broadcasts", "source_observation_id")},
      source_account_seq = ${pick("page_broadcasts", "source_account_seq")},
      first_observed_at =
        least(page_broadcasts.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(page_broadcasts.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export interface UpsertPagePollInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  pollRef: string;
  title: string | null;
  description: string | null;
  status: number | null;
  pollVersion: number | null;
  createdAtPlatform: Date | null;
  options: ReadonlyArray<{
    optionRef: string;
    optionOrdinal: number;
    title: string | null;
    voteCount: number | null;
  }>;
}

export async function upsertPagePoll(
  db: Database,
  input: UpsertPagePollInput,
): Promise<{ applied: boolean; options: number }> {
  const head = await db.execute(sql`
    insert into page_polls (
      page_id, platform, poll_ref, title, description, status, poll_version,
      created_at_platform, content_hash, first_observed_at, last_observed_at,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.pollRef}, ${input.title},
      ${input.description}, ${input.status}, ${input.pollVersion},
      ${input.createdAtPlatform}, ${input.contentHash}, ${input.observedAt},
      ${input.observedAt}, ${input.sourceEventId}, ${input.sourceObservationId},
      ${input.sourceAccountSeq}
    )
    on conflict (page_id, platform, poll_ref) do update set
      title = ${pick("page_polls", "title")},
      description = ${pick("page_polls", "description")},
      status = ${pick("page_polls", "status")},
      poll_version = ${pick("page_polls", "poll_version")},
      created_at_platform = ${pick("page_polls", "created_at_platform")},
      content_hash = ${pick("page_polls", "content_hash")},
      source_event_id = ${pick("page_polls", "source_event_id")},
      source_observation_id = ${pick("page_polls", "source_observation_id")},
      source_account_seq = ${pick("page_polls", "source_account_seq")},
      first_observed_at = least(page_polls.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(page_polls.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);

  let options = 0;
  for (const option of input.options) {
    // An option that disappears from a later capture is NOT deleted: the row
    // stays with its last observed vote count, because "the platform stopped
    // listing it" is not "it never existed". DP 7 applies to projections too.
    const result = await db.execute(sql`
      insert into page_poll_options (
        page_id, platform, poll_ref, option_ref, option_ordinal, title, vote_count,
        content_hash, first_observed_at, last_observed_at, source_event_id,
        source_observation_id, source_account_seq
      ) values (
        ${input.pageId}, ${input.platform}, ${input.pollRef}, ${option.optionRef},
        ${option.optionOrdinal}, ${option.title}, ${option.voteCount}, ${input.contentHash},
        ${input.observedAt}, ${input.observedAt}, ${input.sourceEventId},
        ${input.sourceObservationId}, ${input.sourceAccountSeq}
      )
      on conflict (page_id, platform, poll_ref, option_ref) do update set
        option_ordinal = ${pick("page_poll_options", "option_ordinal")},
        title = ${pick("page_poll_options", "title")},
        vote_count = ${pick("page_poll_options", "vote_count")},
        content_hash = ${pick("page_poll_options", "content_hash")},
        source_event_id = ${pick("page_poll_options", "source_event_id")},
        source_observation_id = ${pick("page_poll_options", "source_observation_id")},
        source_account_seq = ${pick("page_poll_options", "source_account_seq")},
        first_observed_at =
          least(page_poll_options.first_observed_at, excluded.first_observed_at),
        last_observed_at =
          greatest(page_poll_options.last_observed_at, excluded.last_observed_at),
        updated_at = now()
      returning page_id
    `);
    if ((result.rowCount ?? 0) > 0) options += 1;
  }

  return { applied: (head.rowCount ?? 0) > 0, options };
}

export interface UpsertPageRecapStatInput extends StatsLineage {
  pageId: number;
  platform: FanslyStatsPlatform;
  recapYear: number;
  statRef: string;
  statName: string | null;
  /** A STRING on the wire; stored verbatim and NEVER coerced to a number. */
  statValue: string | null;
  generatedAt: Date | null;
}

export async function upsertPageRecapStat(
  db: Database,
  input: UpsertPageRecapStatInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into page_recap_stats (
      page_id, platform, recap_year, stat_ref, stat_name, stat_value, generated_at,
      content_hash, first_observed_at, last_observed_at, source_event_id,
      source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.recapYear}, ${input.statRef},
      ${input.statName}, ${input.statValue}, ${input.generatedAt}, ${input.contentHash},
      ${input.observedAt}, ${input.observedAt}, ${input.sourceEventId},
      ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, platform, recap_year, stat_ref) do update set
      stat_name = ${pick("page_recap_stats", "stat_name")},
      stat_value = ${pick("page_recap_stats", "stat_value")},
      generated_at = ${pick("page_recap_stats", "generated_at")},
      content_hash = ${pick("page_recap_stats", "content_hash")},
      source_event_id = ${pick("page_recap_stats", "source_event_id")},
      source_observation_id = ${pick("page_recap_stats", "source_observation_id")},
      source_account_seq = ${pick("page_recap_stats", "source_account_seq")},
      first_observed_at =
        least(page_recap_stats.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(page_recap_stats.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

// ── capture coverage — CAPTURE-PLANE OPERATIONAL STATE (§3.4, A17-6) ─────────

export type CaptureCoverageStatus =
  | "not_started"
  | "in_progress"
  | "window_captured"
  | "provider_exhausted"
  | "sampled"
  | "partial_provider_surface"
  | "unsupported_by_observed_surface"
  | "budget_deferred"
  | "auth_blocked"
  | "contract_drift";

export type CaptureCoverageAcquisitionMode = "retroactive" | "forward_only";

export type CaptureCoverageProof =
  | "none"
  | "terminal_response"
  | "complete_count_matched"
  | "empty_window";

export interface UpsertCaptureCoverageInput {
  pageId: number;
  platform: FanslyStatsPlatform;
  plane: string;
  scopeRef: string;
  status: CaptureCoverageStatus;
  acquisitionMode: CaptureCoverageAcquisitionMode;
  proof: CaptureCoverageProof;
  oldestCapturedAt?: Date | null;
  newestCapturedAt?: Date | null;
  /** A separately scoped snapshot describes its latest window, not a union
   * across successful polls separated by an unknown capture gap. */
  replaceWindowBounds?: boolean;
  cursor?: Record<string, unknown>;
  expectedCount?: number | null;
  observedUniqueCount?: number | null;
  /** The journaled response that PROVES the claim. Required unless proof=none. */
  proofObservationId?: number | null;
  reasonCode?: string | null;
  nextProbeAt?: Date | null;
}

/**
 * Coverage is a HEAD, not a log: the newest claim replaces the old one, but
 * `oldest_captured_at` only ever moves BACKWARDS and `newest_captured_at` only
 * forwards — a backfill chunk that reaches further into history must never be
 * undone by the next steady-state sweep writing today's window. A separately
 * scoped snapshot can explicitly replace its bounds: min/max would invent
 * continuous coverage across two polls separated by a capture gap.
 */
export async function upsertCaptureCoverage(
  db: Database,
  input: UpsertCaptureCoverageInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into capture_coverage (
      page_id, platform, plane, scope_ref, status, acquisition_mode, proof,
      oldest_captured_at, newest_captured_at, cursor, expected_count,
      observed_unique_count, proof_observation_id, reason_code, next_probe_at
    ) values (
      ${input.pageId}, ${input.platform}, ${input.plane}, ${input.scopeRef},
      ${input.status}, ${input.acquisitionMode}, ${input.proof},
      ${input.oldestCapturedAt ?? null}, ${input.newestCapturedAt ?? null},
      ${JSON.stringify(input.cursor ?? {})}::jsonb, ${input.expectedCount ?? null},
      ${input.observedUniqueCount ?? null}, ${input.proofObservationId ?? null},
      ${input.reasonCode ?? null}, ${input.nextProbeAt ?? null}
    )
    on conflict (page_id, platform, plane, scope_ref) do update set
      status = excluded.status,
      acquisition_mode = excluded.acquisition_mode,
      proof = excluded.proof,
      oldest_captured_at = case when ${input.replaceWindowBounds ?? false}
        then excluded.oldest_captured_at else least(
        capture_coverage.oldest_captured_at, excluded.oldest_captured_at
      ) end,
      newest_captured_at = case when ${input.replaceWindowBounds ?? false}
        then excluded.newest_captured_at else greatest(
        capture_coverage.newest_captured_at, excluded.newest_captured_at
      ) end,
      cursor = excluded.cursor,
      expected_count = excluded.expected_count,
      observed_unique_count = excluded.observed_unique_count,
      -- A proof of 'none' must not erase the observation that proved an earlier,
      -- stronger claim: the floor evidence outlives the sweep that found it.
      proof_observation_id = coalesce(
        excluded.proof_observation_id, capture_coverage.proof_observation_id
      ),
      reason_code = excluded.reason_code,
      next_probe_at = excluded.next_probe_at,
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export interface CaptureCoverageRow {
  pageId: number;
  platform: string;
  plane: string;
  scopeRef: string;
  status: CaptureCoverageStatus;
  acquisitionMode: CaptureCoverageAcquisitionMode;
  proof: CaptureCoverageProof;
  oldestCapturedAt: Date | null;
  newestCapturedAt: Date | null;
  cursor: Record<string, unknown>;
  proofObservationId: number | null;
  reasonCode: string | null;
}

export async function listCaptureCoverage(
  db: Database,
  input: { pageId: number; plane?: string },
): Promise<CaptureCoverageRow[]> {
  const planeFilter = input.plane === undefined
    ? sql``
    : sql` and plane = ${input.plane}`;
  const result = await db.execute(sql`
    select
      page_id as "pageId", platform, plane, scope_ref as "scopeRef", status,
      acquisition_mode as "acquisitionMode", proof,
      oldest_captured_at as "oldestCapturedAt", newest_captured_at as "newestCapturedAt",
      cursor, proof_observation_id as "proofObservationId", reason_code as "reasonCode"
    from capture_coverage
    where page_id = ${input.pageId}${planeFilter}
    order by plane asc, scope_ref asc
  `);
  return (result.rows as unknown[]).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      pageId: Number(record.pageId),
      platform: String(record.platform),
      plane: String(record.plane),
      scopeRef: String(record.scopeRef),
      status: record.status as CaptureCoverageStatus,
      acquisitionMode: record.acquisitionMode as CaptureCoverageAcquisitionMode,
      proof: record.proof as CaptureCoverageProof,
      oldestCapturedAt: record.oldestCapturedAt === null
        ? null
        : new Date(record.oldestCapturedAt as string),
      newestCapturedAt: record.newestCapturedAt === null
        ? null
        : new Date(record.newestCapturedAt as string),
      cursor: (record.cursor ?? {}) as Record<string, unknown>,
      proofObservationId: record.proofObservationId === null
        ? null
        : Number(record.proofObservationId),
      reasonCode: record.reasonCode === null ? null : String(record.reasonCode),
    };
  });
}
