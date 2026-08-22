/**
 * WP-S1 read side: the projections F1–F7 and F4 fill, queried for serving.
 *
 * READ-ONLY BY CONSTRUCTION. There is no writer in this file and there must
 * never be one: **serving never authorizes capture**. Nothing here schedules a
 * fetch, marks a subject dirty or touches a coverage row.
 *
 * Three rules the SQL below obeys, each because breaking it has a name:
 *
 *  * **Qualify every ORDER BY column.** A bare column name in ORDER BY resolves
 *    to a SELECT ALIAS in Postgres, and that trap has shipped twice in this
 *    repo. Every ordering here is `t.column`.
 *  * **Never coalesce a NULL metric to 0.** A metric the platform did not serve
 *    is NULL all the way to the wire. `coalesce(views, 0)` would turn "we never
 *    measured this" into "nobody watched", which is a different claim.
 *  * **Money leaves as TEXT.** `bigint` mills would lose precision through a JS
 *    number on the way out of the driver, so every mills column is cast to text
 *    here and reconstructed by the shared money constructors at the boundary.
 */

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

function date(value: unknown): Date | null {
  return value == null ? null : new Date(value as string | Date);
}

function requiredDate(value: unknown): Date {
  const parsed = date(value);
  if (parsed === null) {
    throw new Error("expected a non-null timestamp column");
  }
  return parsed;
}

function int(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function requiredInt(value: unknown): number {
  return Number(value ?? 0);
}

function text(value: unknown): string | null {
  return value == null ? null : String(value);
}

function bool(value: unknown): boolean | null {
  return value == null ? null : Boolean(value);
}

/**
 * ONE bound parameter carrying a Postgres array literal, then cast.
 *
 * NOT `sql`${array}`` — drizzle expands an array chunk into a comma-separated
 * PARAMETER LIST, so `= any($1, $2, $3)` is a syntax error and an EMPTY array
 * expands to nothing at all. The same trap is documented in
 * `fansly-stats.ts:textArrayParam`; this is the read side of it.
 */
function textArrayParam(values: readonly string[]): SQL {
  const literal = `{${
    values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")
  }}`;
  return sql`${literal}::text[]`;
}

// ── traffic buckets ──────────────────────────────────────────────────────────

export interface InsightsTrafficBucketRow {
  subjectKind: string;
  subjectRef: string;
  periodMs: number;
  bucketStart: Date;
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
  videoPercentWatchedSum: string | null;
  previewVideoPercentWatchedSum: string | null;
  revisionCount: number;
  lastObservedAt: Date;
}

const TRAFFIC_COLUMNS = sql`
  t.subject_kind as subject_kind,
  t.subject_ref as subject_ref,
  t.period_ms as period_ms,
  t.bucket_start as bucket_start,
  t.source_code as source_code,
  t.mapping_version as mapping_version,
  t.views as views,
  t.preview_views as preview_views,
  t.unique_viewers as unique_viewers,
  t.preview_unique_viewers as preview_unique_viewers,
  t.video_views as video_views,
  t.preview_video_views as preview_video_views,
  t.interaction_time_ms as interaction_time_ms,
  t.preview_interaction_time_ms as preview_interaction_time_ms,
  t.video_percent_watched_sum::text as video_percent_watched_sum,
  t.preview_video_percent_watched_sum::text as preview_video_percent_watched_sum,
  t.revision_count as revision_count,
  t.last_observed_at as last_observed_at
`;

function trafficRow(row: Record<string, unknown>): InsightsTrafficBucketRow {
  return {
    subjectKind: String(row.subject_kind),
    subjectRef: String(row.subject_ref ?? ""),
    periodMs: requiredInt(row.period_ms),
    bucketStart: requiredDate(row.bucket_start),
    sourceCode: String(row.source_code),
    mappingVersion: requiredInt(row.mapping_version),
    views: int(row.views),
    previewViews: int(row.preview_views),
    uniqueViewers: int(row.unique_viewers),
    previewUniqueViewers: int(row.preview_unique_viewers),
    videoViews: int(row.video_views),
    previewVideoViews: int(row.preview_video_views),
    interactionTimeMs: int(row.interaction_time_ms),
    previewInteractionTimeMs: int(row.preview_interaction_time_ms),
    videoPercentWatchedSum: text(row.video_percent_watched_sum),
    previewVideoPercentWatchedSum: text(row.preview_video_percent_watched_sum),
    revisionCount: requiredInt(row.revision_count),
    lastObservedAt: requiredDate(row.last_observed_at),
  };
}

/**
 * One page's traffic buckets inside `[from, to)`, keyset-ordered by
 * `(bucket_start, source_code)` so the cursor is total even when a bucket
 * carries eight source codes.
 */
export async function listInsightsTrafficBuckets(
  db: Database,
  input: {
    pageId: number;
    subjectKind: string;
    subjectRef?: string | undefined;
    periodMs: number;
    from: Date;
    to: Date;
    limit: number;
    after?: { bucketStart: Date; sourceCode: string } | undefined;
  },
): Promise<InsightsTrafficBucketRow[]> {
  const clauses = [
    sql`t.page_id = ${input.pageId}`,
    sql`t.subject_kind = ${input.subjectKind}`,
    sql`t.period_ms = ${input.periodMs}`,
    sql`t.bucket_start >= ${input.from}`,
    sql`t.bucket_start < ${input.to}`,
  ];
  if (input.subjectRef !== undefined) {
    clauses.push(sql`t.subject_ref = ${input.subjectRef}`);
  }
  if (input.after) {
    clauses.push(sql`(t.bucket_start, t.source_code) > (${input.after.bucketStart}, ${input.after.sourceCode})`);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${TRAFFIC_COLUMNS}
    from stats_traffic_buckets t
    where ${sql.join(clauses, sql` and `)}
    order by t.bucket_start asc, t.source_code asc
    limit ${input.limit}
  `);
  return result.rows.map(trafficRow);
}

/** The same buckets, restricted to a set of media offers. Bounded by a TOTAL
 *  row budget rather than per media: a caller must never be able to ask for one
 *  media × a year of hourly buckets and get an unbounded body. */
export async function listInsightsMediaTrafficBuckets(
  db: Database,
  input: {
    pageId: number;
    mediaOfferRefs: readonly string[];
    periodMs: number;
    from: Date;
    to: Date;
    limit: number;
  },
): Promise<InsightsTrafficBucketRow[]> {
  if (input.mediaOfferRefs.length === 0) {
    return [];
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select ${TRAFFIC_COLUMNS}
    from stats_traffic_buckets t
    where t.page_id = ${input.pageId}
      and t.subject_kind = 'media_offer'
      and t.subject_ref = any(${textArrayParam(input.mediaOfferRefs)})
      and t.period_ms = ${input.periodMs}
      and t.bucket_start >= ${input.from}
      and t.bucket_start < ${input.to}
    order by t.subject_ref asc, t.bucket_start asc, t.source_code asc
    limit ${input.limit}
  `);
  return result.rows.map(trafficRow);
}

// ── media catalogue heads ────────────────────────────────────────────────────

export interface InsightsMediaHeadRow {
  mediaOfferRef: string;
  mediaRef: string | null;
  bundleRefs: string[];
  mediaType: number | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  priceMills: string | null;
  likeCount: number | null;
  salesCount: number | null;
  salesNetMills: string | null;
  salesPendingMills: string | null;
  createdAtPlatform: Date | null;
  deletedAtPlatform: Date | null;
  firstObservedAt: Date;
  lastObservedAt: Date;
}

function mediaHeadRow(row: Record<string, unknown>): InsightsMediaHeadRow {
  return {
    mediaOfferRef: String(row.media_offer_ref),
    mediaRef: text(row.media_ref),
    bundleRefs: Array.isArray(row.bundle_refs) ? row.bundle_refs.map((entry) => String(entry)) : [],
    mediaType: int(row.media_type),
    mimeType: text(row.mime_type),
    width: int(row.width),
    height: int(row.height),
    durationMs: int(row.duration_ms),
    priceMills: text(row.price_mills),
    likeCount: int(row.like_count),
    salesCount: int(row.sales_count),
    salesNetMills: text(row.sales_net_mills),
    salesPendingMills: text(row.sales_pending_mills),
    createdAtPlatform: date(row.created_at_platform),
    deletedAtPlatform: date(row.deleted_at_platform),
    firstObservedAt: requiredDate(row.first_observed_at),
    lastObservedAt: requiredDate(row.last_observed_at),
  };
}

/** Catalogue heads, keyset-ordered by `media_offer_ref` — a stable text id, not
 *  a mutable timestamp, so a traversal cannot skip or repeat a row when a media
 *  is re-observed mid-walk. */
export async function listInsightsMediaHeads(
  db: Database,
  input: {
    pageId: number;
    mediaOfferRef?: string | undefined;
    limit: number;
    afterRef?: string | undefined;
  },
): Promise<InsightsMediaHeadRow[]> {
  const clauses = [sql`m.page_id = ${input.pageId}`];
  if (input.mediaOfferRef !== undefined) {
    clauses.push(sql`m.media_offer_ref = ${input.mediaOfferRef}`);
  }
  if (input.afterRef !== undefined) {
    clauses.push(sql`m.media_offer_ref > ${input.afterRef}`);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select m.media_offer_ref as media_offer_ref,
           m.media_ref as media_ref,
           m.bundle_refs as bundle_refs,
           m.media_type as media_type,
           m.mime_type as mime_type,
           m.width as width,
           m.height as height,
           m.duration_ms as duration_ms,
           m.price_mills::text as price_mills,
           m.like_count as like_count,
           m.sales_count as sales_count,
           m.sales_net_mills::text as sales_net_mills,
           m.sales_pending_mills::text as sales_pending_mills,
           m.created_at_platform as created_at_platform,
           m.deleted_at_platform as deleted_at_platform,
           m.first_observed_at as first_observed_at,
           m.last_observed_at as last_observed_at
    from creator_media m
    where ${sql.join(clauses, sql` and `)}
    order by m.media_offer_ref asc
    limit ${input.limit}
  `);
  return result.rows.map(mediaHeadRow);
}

// ── window aggregation sidecars ──────────────────────────────────────────────

export interface InsightsTopMediaRow {
  plane: string;
  rank: number;
  mediaOfferRef: string;
  bundleRef: string | null;
  periodMs: number;
  requestedStart: Date;
  requestedEnd: Date;
  views: number | null;
  previewViews: number | null;
  interactionTimeMs: number | null;
  previewInteractionTimeMs: number | null;
  observedAt: Date;
}

export async function listInsightsTopMedia(
  db: Database,
  input: { pageId: number; from: Date; to: Date; limit: number },
): Promise<InsightsTopMediaRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select t.plane as plane,
           t.rank as rank,
           t.media_offer_ref as media_offer_ref,
           t.bundle_ref as bundle_ref,
           t.period_ms as period_ms,
           t.requested_start as requested_start,
           t.requested_end as requested_end,
           t.views as views,
           t.preview_views as preview_views,
           t.interaction_time_ms as interaction_time_ms,
           t.preview_interaction_time_ms as preview_interaction_time_ms,
           t.observed_at as observed_at
    from stats_top_media t
    where t.page_id = ${input.pageId}
      and t.requested_end >= ${input.from}
      and t.requested_end < ${input.to}
    order by t.requested_end desc, t.plane asc, t.rank asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    plane: String(row.plane),
    rank: requiredInt(row.rank),
    mediaOfferRef: String(row.media_offer_ref),
    bundleRef: text(row.bundle_ref),
    periodMs: requiredInt(row.period_ms),
    requestedStart: requiredDate(row.requested_start),
    requestedEnd: requiredDate(row.requested_end),
    views: int(row.views),
    previewViews: int(row.preview_views),
    interactionTimeMs: int(row.interaction_time_ms),
    previewInteractionTimeMs: int(row.preview_interaction_time_ms),
    observedAt: requiredDate(row.observed_at),
  }));
}

export interface InsightsTopTagRow {
  plane: string;
  rank: number;
  tagRef: string;
  tagName: string | null;
  periodMs: number;
  requestedStart: Date;
  requestedEnd: Date;
  views: number | null;
  previewViews: number | null;
  interactionTimeMs: number | null;
  previewInteractionTimeMs: number | null;
  observedAt: Date;
}

export async function listInsightsTopTags(
  db: Database,
  input: {
    pageId: number;
    from: Date;
    to: Date;
    limit: number;
    after?: { requestedEnd: Date; plane: string; rank: number } | undefined;
  },
): Promise<InsightsTopTagRow[]> {
  const clauses = [
    sql`t.page_id = ${input.pageId}`,
    sql`t.requested_end >= ${input.from}`,
    sql`t.requested_end < ${input.to}`,
  ];
  if (input.after) {
    clauses.push(sql`
      (t.requested_end, t.plane, t.rank)
        < (${input.after.requestedEnd}, ${input.after.plane}, ${input.after.rank})
    `);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select t.plane as plane,
           t.rank as rank,
           t.tag_ref as tag_ref,
           t.tag_name as tag_name,
           t.period_ms as period_ms,
           t.requested_start as requested_start,
           t.requested_end as requested_end,
           t.views as views,
           t.preview_views as preview_views,
           t.interaction_time_ms as interaction_time_ms,
           t.preview_interaction_time_ms as preview_interaction_time_ms,
           t.observed_at as observed_at
    from stats_top_tags t
    where ${sql.join(clauses, sql` and `)}
    order by t.requested_end desc, t.plane asc, t.rank asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    plane: String(row.plane),
    rank: requiredInt(row.rank),
    tagRef: String(row.tag_ref),
    tagName: text(row.tag_name),
    periodMs: requiredInt(row.period_ms),
    requestedStart: requiredDate(row.requested_start),
    requestedEnd: requiredDate(row.requested_end),
    views: int(row.views),
    previewViews: int(row.preview_views),
    interactionTimeMs: int(row.interaction_time_ms),
    previewInteractionTimeMs: int(row.preview_interaction_time_ms),
    observedAt: requiredDate(row.observed_at),
  }));
}

export interface InsightsPlatformTagRow {
  tagRef: string;
  tagName: string | null;
  businessDate: string;
  viewCount: number | null;
  postCount: number | null;
  source: string;
  capturedAt: Date;
}

/**
 * The platform-GLOBAL tag counters.
 *
 * `platform_tag_daily` is sampled PER PAGE, and `source_account_seq` is
 * incomparable across pages — so the global value for a `(tag, date)` is
 * derived HERE, at read time: latest `captured_at` wins, ties break on
 * `page_id` ascending. Any other rule would make the answer depend on which
 * page's sync happened to run last.
 */
export async function listInsightsPlatformTags(
  db: Database,
  input: { platform: string; from: string; to: string; limit: number },
): Promise<InsightsPlatformTagRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select distinct on (d.tag_ref, d.business_date)
           d.tag_ref as tag_ref,
           d.tag_name as tag_name,
           d.business_date::text as business_date,
           d.view_count as view_count,
           d.post_count as post_count,
           d.source as source,
           d.captured_at as captured_at
    from platform_tag_daily d
    where d.platform = ${input.platform}
      and d.business_date >= ${input.from}::date
      and d.business_date <= ${input.to}::date
    order by d.tag_ref asc, d.business_date desc, d.captured_at desc, d.page_id asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    tagRef: String(row.tag_ref),
    tagName: text(row.tag_name),
    businessDate: String(row.business_date),
    viewCount: int(row.view_count),
    postCount: int(row.post_count),
    source: String(row.source),
    capturedAt: requiredDate(row.captured_at),
  }));
}

// ── coverage ─────────────────────────────────────────────────────────────────

export interface InsightsCoverageRow {
  plane: string;
  scopeRef: string;
  status: string;
  acquisitionMode: string;
  proof: string;
  oldestCapturedAt: Date | null;
  newestCapturedAt: Date | null;
  expectedCount: number | null;
  observedUniqueCount: number | null;
  reasonCode: string | null;
  nextProbeAt: Date | null;
  updatedAt: Date;
}

export async function listInsightsCoverage(
  db: Database,
  input: { pageId: number; planes?: readonly string[] | undefined },
): Promise<InsightsCoverageRow[]> {
  const clauses = [sql`c.page_id = ${input.pageId}`];
  if (input.planes !== undefined && input.planes.length > 0) {
    clauses.push(sql`c.plane = any(${textArrayParam(input.planes)})`);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select c.plane as plane,
           c.scope_ref as scope_ref,
           c.status as status,
           c.acquisition_mode as acquisition_mode,
           c.proof as proof,
           c.oldest_captured_at as oldest_captured_at,
           c.newest_captured_at as newest_captured_at,
           c.expected_count as expected_count,
           c.observed_unique_count as observed_unique_count,
           c.reason_code as reason_code,
           c.next_probe_at as next_probe_at,
           c.updated_at as updated_at
    from capture_coverage c
    where ${sql.join(clauses, sql` and `)}
    order by c.plane asc, c.scope_ref asc
  `);
  return result.rows.map((row) => ({
    plane: String(row.plane),
    scopeRef: String(row.scope_ref),
    status: String(row.status),
    acquisitionMode: String(row.acquisition_mode),
    proof: String(row.proof),
    oldestCapturedAt: date(row.oldest_captured_at),
    newestCapturedAt: date(row.newest_captured_at),
    expectedCount: int(row.expected_count),
    observedUniqueCount: int(row.observed_unique_count),
    reasonCode: text(row.reason_code),
    nextProbeAt: date(row.next_probe_at),
    updatedAt: requiredDate(row.updated_at),
  }));
}

export interface InsightsHoldingRow {
  projection: string;
  rowCount: number;
  oldestAt: Date | null;
  newestAt: Date | null;
}

/**
 * "What we hold", per projection: a row count and the range it spans.
 *
 * The table/column pairs are CODE CONSTANTS, never request text — this is the
 * same law the agent dataset registry states: a string from a caller never
 * becomes an identifier. A count of zero next to a coverage row is "captured
 * nothing yet"; a count of zero with no coverage row at all is "never started",
 * and the honesty panel shows them differently.
 */
const INSIGHTS_HOLDINGS: readonly { projection: string; table: string; column: string }[] = [
  { projection: "stats_traffic_buckets", table: "stats_traffic_buckets", column: "bucket_start" },
  { projection: "stats_top_media", table: "stats_top_media", column: "requested_end" },
  { projection: "stats_top_tags", table: "stats_top_tags", column: "requested_end" },
  { projection: "fansly_media_tag_stats", table: "fansly_media_tag_stats", column: "requested_end" },
  { projection: "platform_tag_daily", table: "platform_tag_daily", column: "captured_at" },
  { projection: "creator_media", table: "creator_media", column: "last_observed_at" },
  { projection: "media_orders", table: "media_orders", column: "occurred_at" },
  { projection: "message_media_offers", table: "message_media_offers", column: "last_observed_at" },
  { projection: "revenue_mix_daily", table: "revenue_mix_daily", column: "last_observed_at" },
  { projection: "revenue_month_totals", table: "revenue_month_totals", column: "last_observed_at" },
  { projection: "page_promo_links", table: "page_promo_links", column: "last_observed_at" },
  { projection: "platform_notifications", table: "platform_notifications", column: "occurred_at" },
  { projection: "post_likes", table: "post_likes", column: "occurred_at" },
  { projection: "post_comments", table: "post_comments", column: "occurred_at" },
  { projection: "creator_vault_albums", table: "creator_vault_albums", column: "last_observed_at" },
  { projection: "page_subscription_tiers", table: "page_subscription_tiers", column: "last_observed_at" },
  { projection: "page_walls", table: "page_walls", column: "last_observed_at" },
  { projection: "page_automated_messages", table: "page_automated_messages", column: "last_observed_at" },
  { projection: "page_payout_requests", table: "page_payout_requests", column: "requested_at" },
  { projection: "page_payout_methods", table: "page_payout_methods", column: "last_observed_at" },
];

export async function listInsightsHoldings(
  db: Database,
  input: { pageId: number },
): Promise<InsightsHoldingRow[]> {
  const parts = INSIGHTS_HOLDINGS.map((entry) => sql`
    select ${entry.projection}::text as projection,
           count(*)::int as row_count,
           min(h.${sql.identifier(entry.column)}) as oldest_at,
           max(h.${sql.identifier(entry.column)}) as newest_at
    from ${sql.identifier(entry.table)} h
    where h.page_id = ${input.pageId}
  `);
  const result = await db.execute<Record<string, unknown>>(
    sql.join(parts, sql` union all `),
  );
  const byProjection = new Map(result.rows.map((row) => [String(row.projection), row]));
  return INSIGHTS_HOLDINGS.map((entry) => {
    const row = byProjection.get(entry.projection);
    return {
      projection: entry.projection,
      rowCount: requiredInt(row?.row_count),
      oldestAt: date(row?.oldest_at),
      newestAt: date(row?.newest_at),
    };
  });
}

// ── catalogue ────────────────────────────────────────────────────────────────

export interface InsightsVaultAlbumRow {
  vaultKind: string;
  albumRef: string;
  title: string | null;
  albumType: number | null;
  status: number | null;
  pos: number | null;
  itemCount: number | null;
  missingSince: Date | null;
  lastObservedAt: Date;
}

export async function listInsightsVaultAlbums(
  db: Database,
  input: { pageId: number; limit: number },
): Promise<InsightsVaultAlbumRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select a.vault_kind as vault_kind,
           a.album_ref as album_ref,
           a.title as title,
           a.album_type as album_type,
           a.status as status,
           a.pos as pos,
           a.item_count as item_count,
           a.missing_since as missing_since,
           a.last_observed_at as last_observed_at
    from creator_vault_albums a
    where a.page_id = ${input.pageId}
    order by a.vault_kind asc, a.pos asc nulls last, a.album_ref asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    vaultKind: String(row.vault_kind),
    albumRef: String(row.album_ref),
    title: text(row.title),
    albumType: int(row.album_type),
    status: int(row.status),
    pos: int(row.pos),
    itemCount: int(row.item_count),
    missingSince: date(row.missing_since),
    lastObservedAt: requiredDate(row.last_observed_at),
  }));
}

export interface InsightsTierRow {
  tierRef: string;
  name: string | null;
  color: string | null;
  pos: number | null;
  basePriceMills: string | null;
  maxSubscribers: number | null;
  missingSince: Date | null;
}

export interface InsightsTierPlanRow {
  tierRef: string;
  planRef: string;
  status: number | null;
  durationDays: number | null;
  priceMills: string | null;
  useAmounts: number | null;
  promoCount: number;
  missingSince: Date | null;
}

export async function listInsightsTiers(
  db: Database,
  input: { pageId: number; limit: number },
): Promise<InsightsTierRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select t.tier_ref as tier_ref,
           t.name as name,
           t.color as color,
           t.pos as pos,
           t.base_price_mills::text as base_price_mills,
           t.max_subscribers as max_subscribers,
           t.missing_since as missing_since
    from page_subscription_tiers t
    where t.page_id = ${input.pageId}
    order by t.pos asc nulls last, t.tier_ref asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    tierRef: String(row.tier_ref),
    name: text(row.name),
    color: text(row.color),
    pos: int(row.pos),
    basePriceMills: text(row.base_price_mills),
    maxSubscribers: int(row.max_subscribers),
    missingSince: date(row.missing_since),
  }));
}

export async function listInsightsTierPlans(
  db: Database,
  input: { pageId: number; limit: number },
): Promise<InsightsTierPlanRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select p.tier_ref as tier_ref,
           p.plan_ref as plan_ref,
           p.status as status,
           p.duration_days as duration_days,
           p.price_mills::text as price_mills,
           p.use_amounts as use_amounts,
           jsonb_array_length(coalesce(p.promos, '[]'::jsonb))::int as promo_count,
           p.missing_since as missing_since
    from page_subscription_tier_plans p
    where p.page_id = ${input.pageId}
    order by p.tier_ref asc, p.duration_days asc nulls last, p.plan_ref asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    tierRef: String(row.tier_ref),
    planRef: String(row.plan_ref),
    status: int(row.status),
    durationDays: int(row.duration_days),
    priceMills: text(row.price_mills),
    useAmounts: int(row.use_amounts),
    promoCount: requiredInt(row.promo_count),
    missingSince: date(row.missing_since),
  }));
}

export interface InsightsWallRow {
  wallRef: string;
  name: string | null;
  description: string | null;
  pos: number | null;
  mainWall: boolean | null;
  defaultWall: boolean | null;
  private: number | null;
  missingSince: Date | null;
}

export async function listInsightsWalls(
  db: Database,
  input: { pageId: number; limit: number },
): Promise<InsightsWallRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select w.wall_ref as wall_ref,
           w.name as name,
           w.description as description,
           w.pos as pos,
           w.main_wall as main_wall,
           w.default_wall as default_wall,
           w.private as private,
           w.missing_since as missing_since
    from page_walls w
    where w.page_id = ${input.pageId}
    order by w.pos asc nulls last, w.wall_ref asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    wallRef: String(row.wall_ref),
    name: text(row.name),
    description: text(row.description),
    pos: int(row.pos),
    mainWall: bool(row.main_wall),
    defaultWall: bool(row.default_wall),
    private: int(row.private),
    missingSince: date(row.missing_since),
  }));
}

export interface InsightsAutomationRow {
  automationRef: string;
  triggerType: number | null;
  delaySeconds: number | null;
  cooldownSeconds: number | null;
  templateType: number | null;
  senderRef: string | null;
  messageText: string | null;
  attachmentCount: number;
  parseOk: boolean;
  missingSince: Date | null;
}

export async function listInsightsAutomations(
  db: Database,
  input: { pageId: number; limit: number },
): Promise<InsightsAutomationRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select a.automation_ref as automation_ref,
           a.trigger_type as trigger_type,
           a.delay_seconds as delay_seconds,
           a.cooldown_seconds as cooldown_seconds,
           a.template_type as template_type,
           a.sender_ref as sender_ref,
           a.message_text as message_text,
           jsonb_array_length(coalesce(a.attachment_refs, '[]'::jsonb))::int as attachment_count,
           a.parse_ok as parse_ok,
           a.missing_since as missing_since
    from page_automated_messages a
    where a.page_id = ${input.pageId}
    order by a.trigger_type asc nulls last, a.automation_ref asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    automationRef: String(row.automation_ref),
    triggerType: int(row.trigger_type),
    delaySeconds: int(row.delay_seconds),
    cooldownSeconds: int(row.cooldown_seconds),
    templateType: int(row.template_type),
    senderRef: text(row.sender_ref),
    messageText: text(row.message_text),
    attachmentCount: requiredInt(row.attachment_count),
    parseOk: Boolean(row.parse_ok),
    missingSince: date(row.missing_since),
  }));
}

// ── comments and likers ──────────────────────────────────────────────────────

export interface InsightsCommentRow {
  commentRef: string;
  parentPostRef: string;
  rootPostRef: string | null;
  authorRef: string;
  authorUsername: string | null;
  authorDisplayName: string | null;
  textPlain: string;
  likeCount: number | null;
  mediaLikeCount: number | null;
  tipTotalMills: string | null;
  attachmentTipMills: string | null;
  attachmentCount: number | null;
  pinned: boolean | null;
  occurredAt: Date;
  changedAt: Date;
  discoveredVia: string;
  possiblyTruncated: boolean;
  missingSince: Date | null;
}

export async function listInsightsComments(
  db: Database,
  input: {
    pageId: number;
    postRef?: string | undefined;
    from: Date;
    to: Date;
    limit: number;
    after?: { occurredAt: Date; commentRef: string } | undefined;
  },
): Promise<InsightsCommentRow[]> {
  const clauses = [
    sql`c.page_id = ${input.pageId}`,
    sql`c.occurred_at >= ${input.from}`,
    sql`c.occurred_at < ${input.to}`,
  ];
  if (input.postRef !== undefined) {
    clauses.push(sql`c.parent_post_ref = ${input.postRef}`);
  }
  if (input.after) {
    clauses.push(sql`(c.occurred_at, c.comment_ref) < (${input.after.occurredAt}, ${input.after.commentRef})`);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select c.comment_ref as comment_ref,
           c.parent_post_ref as parent_post_ref,
           c.root_post_ref as root_post_ref,
           c.author_ref as author_ref,
           c.author_username as author_username,
           c.author_display_name as author_display_name,
           c.text_plain as text_plain,
           c.like_count as like_count,
           c.media_like_count as media_like_count,
           c.tip_total_mills::text as tip_total_mills,
           c.attachment_tip_mills::text as attachment_tip_mills,
           c.attachment_count as attachment_count,
           c.pinned as pinned,
           c.occurred_at as occurred_at,
           c.changed_at as changed_at,
           c.discovered_via as discovered_via,
           c.possibly_truncated as possibly_truncated,
           c.missing_since as missing_since
    from post_comments c
    where ${sql.join(clauses, sql` and `)}
    order by c.occurred_at desc, c.comment_ref desc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    commentRef: String(row.comment_ref),
    parentPostRef: String(row.parent_post_ref),
    rootPostRef: text(row.root_post_ref),
    authorRef: String(row.author_ref),
    authorUsername: text(row.author_username),
    authorDisplayName: text(row.author_display_name),
    textPlain: String(row.text_plain ?? ""),
    likeCount: int(row.like_count),
    mediaLikeCount: int(row.media_like_count),
    tipTotalMills: text(row.tip_total_mills),
    attachmentTipMills: text(row.attachment_tip_mills),
    attachmentCount: int(row.attachment_count),
    pinned: bool(row.pinned),
    occurredAt: requiredDate(row.occurred_at),
    changedAt: requiredDate(row.changed_at),
    discoveredVia: String(row.discovered_via),
    possiblyTruncated: Boolean(row.possibly_truncated),
    missingSince: date(row.missing_since),
  }));
}

export interface InsightsCommentPerPostRow {
  postRef: string;
  commentCount: number;
  possiblyTruncatedCount: number;
  missingCount: number;
  oldestAt: Date | null;
  newestAt: Date | null;
}

/** Per-post rollup over the SAME window the rows came from. `possiblyTruncated`
 *  is carried up because per-post completeness is exactly what the comment lane
 *  cannot promise without terminal evidence. */
export async function listInsightsCommentsPerPost(
  db: Database,
  input: {
    pageId: number;
    postRef?: string | undefined;
    from: Date;
    to: Date;
    limit: number;
  },
): Promise<InsightsCommentPerPostRow[]> {
  const clauses = [
    sql`c.page_id = ${input.pageId}`,
    sql`c.occurred_at >= ${input.from}`,
    sql`c.occurred_at < ${input.to}`,
  ];
  if (input.postRef !== undefined) {
    clauses.push(sql`c.parent_post_ref = ${input.postRef}`);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select c.parent_post_ref as post_ref,
           count(*)::int as comment_count,
           count(*) filter (where c.possibly_truncated)::int as truncated_count,
           count(*) filter (where c.missing_since is not null)::int as missing_count,
           min(c.occurred_at) as oldest_at,
           max(c.occurred_at) as newest_at
    from post_comments c
    where ${sql.join(clauses, sql` and `)}
    group by c.parent_post_ref
    order by max(c.occurred_at) desc, c.parent_post_ref desc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    postRef: String(row.post_ref),
    commentCount: requiredInt(row.comment_count),
    possiblyTruncatedCount: requiredInt(row.truncated_count),
    missingCount: requiredInt(row.missing_count),
    oldestAt: date(row.oldest_at),
    newestAt: date(row.newest_at),
  }));
}

export interface InsightsLikeRow {
  subjectKind: string;
  subjectRef: string;
  likerPlatformUserId: string;
  state: string;
  occurredAt: Date;
  discoveredVia: string;
}

/**
 * Likers. SHIPS EMPTY on Fansly — no like code is live-confirmed ([E4]), so
 * WP-F2's layer 2 writes nothing here. The query exists anyway: the day a code
 * is confirmed, the panel fills without a serving change, and until then the
 * caller gets `state: "not_started"` beside an empty array rather than a
 * missing panel.
 *
 * Head precedence in this table is provider `occurred_at`, never `account_seq`
 * — the deep backfill appends OLDER facts at HIGHER seq — so the ordering here
 * matches the table's own contract.
 */
export async function listInsightsPostLikes(
  db: Database,
  input: {
    pageId: number;
    subjectRef?: string | undefined;
    from: Date;
    to: Date;
    limit: number;
  },
): Promise<InsightsLikeRow[]> {
  const clauses = [
    sql`l.page_id = ${input.pageId}`,
    sql`l.occurred_at >= ${input.from}`,
    sql`l.occurred_at < ${input.to}`,
  ];
  if (input.subjectRef !== undefined) {
    clauses.push(sql`l.subject_ref = ${input.subjectRef}`);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select l.subject_kind as subject_kind,
           l.subject_ref as subject_ref,
           l.liker_platform_user_id as liker_platform_user_id,
           l.state as state,
           l.occurred_at as occurred_at,
           l.discovered_via as discovered_via
    from post_likes l
    where ${sql.join(clauses, sql` and `)}
    order by l.occurred_at desc, l.notification_ref desc nulls last
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    subjectKind: String(row.subject_kind),
    subjectRef: String(row.subject_ref),
    likerPlatformUserId: String(row.liker_platform_user_id),
    state: String(row.state),
    occurredAt: requiredDate(row.occurred_at),
    discoveredVia: String(row.discovered_via),
  }));
}

// ── money ────────────────────────────────────────────────────────────────────

export interface InsightsRevenueMixRow {
  businessDate: string;
  typeCode: number;
  grossMills: string | null;
  netMills: string | null;
  lastObservedAt: Date;
}

export async function listInsightsRevenueMix(
  db: Database,
  input: {
    pageId: number;
    from: string;
    to: string;
    limit: number;
    after?: { businessDate: string; typeCode: number } | undefined;
  },
): Promise<InsightsRevenueMixRow[]> {
  const clauses = [
    sql`r.page_id = ${input.pageId}`,
    sql`r.business_date >= ${input.from}::date`,
    sql`r.business_date <= ${input.to}::date`,
  ];
  if (input.after) {
    clauses.push(sql`
      (r.business_date, r.type_code) < (${input.after.businessDate}::date, ${input.after.typeCode})
    `);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select r.business_date::text as business_date,
           r.type_code as type_code,
           r.gross_mills::text as gross_mills,
           r.net_mills::text as net_mills,
           r.last_observed_at as last_observed_at
    from revenue_mix_daily r
    where ${sql.join(clauses, sql` and `)}
    order by r.business_date desc, r.type_code desc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    businessDate: String(row.business_date),
    typeCode: requiredInt(row.type_code),
    grossMills: text(row.gross_mills),
    netMills: text(row.net_mills),
    lastObservedAt: requiredDate(row.last_observed_at),
  }));
}

export interface InsightsRevenueMonthRow {
  year: number;
  month: number;
  totalGrossMills: string | null;
  totalNetMills: string | null;
  topPercent: string | null;
  maxTopPercent: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  lastObservedAt: Date;
}

/** Every month row this page holds, INCLUDING the `(0, 0)` rolling-rollup row.
 *  It is returned rather than filtered out so the serving layer can flag it —
 *  a rollup silently summed with the real months double-counts the year. */
export async function listInsightsRevenueMonths(
  db: Database,
  input: { pageId: number; limit: number },
): Promise<InsightsRevenueMonthRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select m.year as year,
           m.month as month,
           m.total_gross_mills::text as total_gross_mills,
           m.total_net_mills::text as total_net_mills,
           m.top_percent::text as top_percent,
           m.max_top_percent::text as max_top_percent,
           m.window_start as window_start,
           m.window_end as window_end,
           m.last_observed_at as last_observed_at
    from revenue_month_totals m
    where m.page_id = ${input.pageId}
    order by m.year desc, m.month desc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    year: requiredInt(row.year),
    month: requiredInt(row.month),
    totalGrossMills: text(row.total_gross_mills),
    totalNetMills: text(row.total_net_mills),
    topPercent: text(row.top_percent),
    maxTopPercent: text(row.max_top_percent),
    windowStart: date(row.window_start),
    windowEnd: date(row.window_end),
    lastObservedAt: requiredDate(row.last_observed_at),
  }));
}

export interface InsightsPayoutRequestRow {
  payoutRef: string;
  amountMills: string | null;
  methodRef: string | null;
  statusCode: number | null;
  statusLabel: string | null;
  statusConfidence: string;
  requestedAt: Date | null;
  updatedAtPlatform: Date | null;
  version: number | null;
}

export async function listInsightsPayoutRequests(
  db: Database,
  input: {
    pageId: number;
    limit: number;
    after?: { requestedAt: Date | null; payoutRef: string } | undefined;
  },
): Promise<InsightsPayoutRequestRow[]> {
  const clauses = [sql`p.page_id = ${input.pageId}`];
  if (input.after) {
    // `requested_at` is nullable, so the keyset compares the coalesced pair the
    // ORDER BY uses. NULLS LAST on the way down means a null sorts as -infinity.
    clauses.push(sql`
      (coalesce(p.requested_at, '-infinity'::timestamptz), p.payout_ref)
        < (${input.after.requestedAt ?? new Date(-8_640_000_000_000)}, ${input.after.payoutRef})
    `);
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select p.payout_ref as payout_ref,
           p.amount_mills::text as amount_mills,
           p.method_ref as method_ref,
           p.status_code as status_code,
           p.status_label as status_label,
           p.status_confidence as status_confidence,
           p.requested_at as requested_at,
           p.updated_at_platform as updated_at_platform,
           p.version as version
    from page_payout_requests p
    where ${sql.join(clauses, sql` and `)}
    order by coalesce(p.requested_at, '-infinity'::timestamptz) desc, p.payout_ref desc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    payoutRef: String(row.payout_ref),
    amountMills: text(row.amount_mills),
    methodRef: text(row.method_ref),
    statusCode: int(row.status_code),
    statusLabel: text(row.status_label),
    statusConfidence: String(row.status_confidence),
    requestedAt: date(row.requested_at),
    updatedAtPlatform: date(row.updated_at_platform),
    version: int(row.version),
  }));
}

export interface InsightsPayoutMethodRow {
  methodRef: string;
  providerId: number | null;
  providerLabel: string;
  type: number | null;
  flags: number | null;
  status: number | null;
  maskedLabel: string | null;
  metadataParseOk: boolean;
  missingSince: Date | null;
}

/**
 * Payout methods, MASKED.
 *
 * `metadata` is NOT selected and must never be: provider 2 (Paxum) returns a
 * full plaintext email address there, and the only sanctioned reader of that
 * column is the WP-F7 canonicalizer, which turned it into `masked_label`.
 */
export async function listInsightsPayoutMethods(
  db: Database,
  input: { pageId: number; limit: number },
): Promise<InsightsPayoutMethodRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select m.method_ref as method_ref,
           m.provider_id as provider_id,
           m.provider_label as provider_label,
           m.type as type,
           m.flags as flags,
           m.status as status,
           m.masked_label as masked_label,
           m.metadata_parse_ok as metadata_parse_ok,
           m.missing_since as missing_since
    from page_payout_methods m
    where m.page_id = ${input.pageId}
    order by m.method_ref asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    methodRef: String(row.method_ref),
    providerId: int(row.provider_id),
    providerLabel: String(row.provider_label),
    type: int(row.type),
    flags: int(row.flags),
    status: int(row.status),
    maskedLabel: text(row.masked_label),
    metadataParseOk: Boolean(row.metadata_parse_ok),
    missingSince: date(row.missing_since),
  }));
}
