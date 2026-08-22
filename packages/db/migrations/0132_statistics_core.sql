-- WP-F1: the statistics core — traffic, the revenue mix, tag counters, promo
-- links, the mass-DM broadcast surface, polls, the yearly recap, and the
-- capture-plane coverage row that says how far back any of it reaches.
--
-- FIVE RULES EVERY TABLE HERE OBEYS, each with a named cost for breaking it:
--
-- 1. NULL MEANS "THE PLATFORM DID NOT SERVE THIS", NEVER ZERO. Absence is a
--    property of the capture, never of the platform. `/it/moie/statsnew` serves
--    no video fields at all, `saleStats` is populated on 2 of 85 media rows, and
--    `/trackinglinks.totalNet` came back 0 on all five links while totalGross was
--    populated. Coalescing any of those to 0 would mint a measurement nobody made.
-- 2. RAW TYPE CODES, STORED AS TEXT/INTEGER, NEVER LABELS (A22-2). One visible
--    label maps to two live codes (legacy + current) on the wallet side —
--    2010/2110, 2016/2116, 7001/7101 — so keying by label silently merges legacy
--    into current, and keying against a closed set silently DROPS legacy rows.
--    The label table (packages/shared/src/fansly-stat-types.ts) is read-time only
--    and versioned; a re-derivation is a version bump plus a rebuild, never a
--    data rewrite.
-- 3. MONEY IS BIGINT MILLS, NULL-OR-NON-NEGATIVE, and net is never summed with
--    gross. `saleStats.total` is the creator's NET share (A12).
-- 4. RATIOS AND PERCENTS ARE `numeric`, NEVER float. `totalVideoPercentWatched`
--    is already a SUM over views on the wire (max observed 1275) and is stored as
--    the raw sum — dividing happens at read time, against `video_views`.
-- 5. NO SCHEDULED DELETER ANYWHERE. Provider ids are TEXT end to end (they are
--    snowflakes, not numbers); page FKs are ON DELETE RESTRICT.
--
-- A21: there is no `stats_capture_windows` table and no per-call window event.
-- The two top-N tables and the traffic buckets carry their window identity
-- INLINE (`period_ms`, `requested_start`, `requested_end`, `content_hash`);
-- "which window did we ask for, when, and what came back" is a query over
-- sync_raw_payloads, which already stores endpoint, request_params, status_code
-- and captured_at for 100 years.

-- ─────────────────────────────────────────────────────────────────────────────
-- Traffic buckets. ONE table serves Fansly profile datapoints, Fansly
-- account-level media datapoints, per-media (F4) datapoints and — later — OF
-- profile visitors, because they are the same fact at different subjects.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "stats_traffic_buckets" (
  "page_id"                  bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"                 text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  -- account_profile = profileDatapoints[]; account_media = the account response's
  -- media datapoints (where the video metrics actually live, §2.2);
  -- media_offer = /it/moie/statsnew (F4); post = reserved for the OF lane.
  "subject_kind"             text NOT NULL,
  -- '' for account-wide subjects: a subject ref is only meaningful per media.
  "subject_ref"              text NOT NULL,
  "period_ms"                bigint NOT NULL,
  "bucket_start"             timestamp with time zone NOT NULL,
  -- The RAW platform code, as text. 10000/10001/44000/44001/44010/44011/
  -- 44030/44031 on profile rows; 0/1 on media rows; anything else is stored
  -- exactly as served and raises `fansly_stats_unknown_type`.
  "source_code"              text NOT NULL,
  -- Which label table version the capture was read against. Storage keeps the
  -- code; this only says which map was current when the row was written.
  "mapping_version"          integer NOT NULL,
  "views"                    bigint,
  "preview_views"            bigint,
  "unique_viewers"           bigint,
  "preview_unique_viewers"   bigint,
  "video_views"              bigint,
  "preview_video_views"      bigint,
  "interaction_time_ms"      bigint,
  "preview_interaction_time_ms" bigint,
  "video_percent_watched_sum"         numeric(20,10),
  "preview_video_percent_watched_sum" numeric(20,10),
  -- Window identity, inline (A21). The requested bounds are what WE asked for;
  -- the provider's own returned bounds live in the event and in the journal.
  "requested_start"          timestamp with time zone,
  "requested_end"            timestamp with time zone,
  "content_hash"             char(64) NOT NULL,
  -- A revisable trailing bucket that the platform restates mints a new event
  -- and bumps this counter; the head always holds the newest revision.
  "revision_count"           integer NOT NULL DEFAULT 0,
  "first_observed_at"        timestamp with time zone NOT NULL,
  "last_observed_at"         timestamp with time zone NOT NULL,
  "source_event_id"          bigint NOT NULL,
  "source_observation_id"    bigint NOT NULL,
  "source_account_seq"       bigint NOT NULL,
  "created_at"               timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"               timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "stats_traffic_buckets_pkey" PRIMARY KEY (
    "page_id", "subject_kind", "subject_ref", "period_ms", "bucket_start", "source_code"
  ),
  CONSTRAINT "stats_traffic_buckets_subject_kind_check" CHECK (
    "subject_kind" IN ('account_profile', 'account_media', 'media_offer', 'post')
  ),
  CONSTRAINT "stats_traffic_buckets_source_code_check" CHECK (length("source_code") > 0),
  CONSTRAINT "stats_traffic_buckets_period_check" CHECK ("period_ms" > 0),
  CONSTRAINT "stats_traffic_buckets_counts_check" CHECK (
    ("views" IS NULL OR "views" >= 0)
    AND ("preview_views" IS NULL OR "preview_views" >= 0)
    AND ("unique_viewers" IS NULL OR "unique_viewers" >= 0)
    AND ("preview_unique_viewers" IS NULL OR "preview_unique_viewers" >= 0)
    AND ("video_views" IS NULL OR "video_views" >= 0)
    AND ("preview_video_views" IS NULL OR "preview_video_views" >= 0)
    AND ("interaction_time_ms" IS NULL OR "interaction_time_ms" >= 0)
    AND ("preview_interaction_time_ms" IS NULL OR "preview_interaction_time_ms" >= 0)
    AND ("video_percent_watched_sum" IS NULL OR "video_percent_watched_sum" >= 0)
    AND ("preview_video_percent_watched_sum" IS NULL
      OR "preview_video_percent_watched_sum" >= 0)
  ),
  CONSTRAINT "stats_traffic_buckets_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "stats_traffic_buckets_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "stats_traffic_buckets_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "stats_traffic_buckets_page_period_bucket_idx"
  ON "stats_traffic_buckets" ("page_id", "period_ms", "bucket_start" DESC, "subject_kind");
CREATE INDEX "stats_traffic_buckets_page_subject_bucket_idx"
  ON "stats_traffic_buckets" ("page_id", "subject_kind", "subject_ref", "bucket_start" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Top-N rankings. The WINDOW is the identity here (D-1): a ranking is only
-- meaningful as "the top 50 for exactly this window", so the window bounds are
-- part of the primary key rather than a FK into a table A21 deleted.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "stats_top_media" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  -- 'top_media' = dataset.topMediaOffers; 'top_fyp_media' = topFypMediaOffers.
  "plane"                  text NOT NULL,
  "period_ms"              bigint NOT NULL,
  "requested_start"        timestamp with time zone NOT NULL,
  "requested_end"          timestamp with time zone NOT NULL,
  "media_offer_ref"        text NOT NULL,
  "bundle_ref"             text,
  "rank"                   integer NOT NULL,
  "views"                  bigint,
  "preview_views"          bigint,
  "interaction_time_ms"    bigint,
  "preview_interaction_time_ms" bigint,
  "content_hash"           char(64) NOT NULL,
  "observed_at"            timestamp with time zone NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "stats_top_media_pkey" PRIMARY KEY (
    "page_id", "plane", "period_ms", "requested_start", "requested_end", "media_offer_ref"
  ),
  CONSTRAINT "stats_top_media_plane_check" CHECK ("plane" IN ('top_media', 'top_fyp_media')),
  CONSTRAINT "stats_top_media_refs_check" CHECK (
    length("media_offer_ref") > 0 AND ("bundle_ref" IS NULL OR length("bundle_ref") > 0)
  ),
  CONSTRAINT "stats_top_media_rank_check" CHECK ("rank" >= 0),
  CONSTRAINT "stats_top_media_counts_check" CHECK (
    ("views" IS NULL OR "views" >= 0)
    AND ("preview_views" IS NULL OR "preview_views" >= 0)
    AND ("interaction_time_ms" IS NULL OR "interaction_time_ms" >= 0)
    AND ("preview_interaction_time_ms" IS NULL OR "preview_interaction_time_ms" >= 0)
  ),
  CONSTRAINT "stats_top_media_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "stats_top_media_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "stats_top_media_window_check" CHECK ("requested_end" >= "requested_start")
);

CREATE INDEX "stats_top_media_page_window_rank_idx"
  ON "stats_top_media" ("page_id", "plane", "requested_end" DESC, "rank");

CREATE TABLE "stats_top_tags" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  -- Only one plane serves tag rankings today (dataset.topFypTags); the column
  -- exists so a second one does not need a migration to be told apart.
  "plane"                  text NOT NULL,
  "period_ms"              bigint NOT NULL,
  "requested_start"        timestamp with time zone NOT NULL,
  "requested_end"          timestamp with time zone NOT NULL,
  "tag_ref"                text NOT NULL,
  -- NULL when the aggregationData.tags[] join misses. NEVER fabricated from the
  -- id, and never backfilled by guessing: an unlabelled tag is an honest gap.
  "tag_name"               text,
  "rank"                   integer NOT NULL,
  "views"                  bigint,
  "preview_views"          bigint,
  "interaction_time_ms"    bigint,
  "preview_interaction_time_ms" bigint,
  "content_hash"           char(64) NOT NULL,
  "observed_at"            timestamp with time zone NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "stats_top_tags_pkey" PRIMARY KEY (
    "page_id", "plane", "period_ms", "requested_start", "requested_end", "tag_ref"
  ),
  CONSTRAINT "stats_top_tags_plane_check" CHECK ("plane" = 'top_fyp_tags'),
  CONSTRAINT "stats_top_tags_refs_check" CHECK (
    length("tag_ref") > 0 AND ("tag_name" IS NULL OR length("tag_name") > 0)
  ),
  CONSTRAINT "stats_top_tags_rank_check" CHECK ("rank" >= 0),
  CONSTRAINT "stats_top_tags_counts_check" CHECK (
    ("views" IS NULL OR "views" >= 0)
    AND ("preview_views" IS NULL OR "preview_views" >= 0)
    AND ("interaction_time_ms" IS NULL OR "interaction_time_ms" >= 0)
    AND ("preview_interaction_time_ms" IS NULL OR "preview_interaction_time_ms" >= 0)
  ),
  CONSTRAINT "stats_top_tags_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "stats_top_tags_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "stats_top_tags_window_check" CHECK ("requested_end" >= "requested_start")
);

CREATE INDEX "stats_top_tags_page_window_rank_idx"
  ON "stats_top_tags" ("page_id", "plane", "requested_end" DESC, "rank");

-- Per-MEDIA tag rankings. Created here with the rest of the statistics core;
-- WP-F4's per-media lane is what fills it. An empty table is the honest state
-- until that lane ships — it is not evidence the platform serves nothing.
CREATE TABLE "fansly_media_tag_stats" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "media_offer_ref"        text NOT NULL,
  "tag_ref"                text NOT NULL,
  "period_ms"              bigint NOT NULL,
  "requested_start"        timestamp with time zone NOT NULL,
  "requested_end"          timestamp with time zone NOT NULL,
  "tag_name"               text,
  "rank"                   integer,
  "views"                  bigint,
  "preview_views"          bigint,
  "interaction_time_ms"    bigint,
  "preview_interaction_time_ms" bigint,
  "content_hash"           char(64) NOT NULL,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "fansly_media_tag_stats_pkey" PRIMARY KEY (
    "page_id", "media_offer_ref", "tag_ref", "period_ms", "requested_start", "requested_end"
  ),
  CONSTRAINT "fansly_media_tag_stats_refs_check" CHECK (
    length("media_offer_ref") > 0 AND length("tag_ref") > 0
    AND ("tag_name" IS NULL OR length("tag_name") > 0)
  ),
  CONSTRAINT "fansly_media_tag_stats_counts_check" CHECK (
    ("rank" IS NULL OR "rank" >= 0)
    AND ("views" IS NULL OR "views" >= 0)
    AND ("preview_views" IS NULL OR "preview_views" >= 0)
    AND ("interaction_time_ms" IS NULL OR "interaction_time_ms" >= 0)
    AND ("preview_interaction_time_ms" IS NULL OR "preview_interaction_time_ms" >= 0)
  ),
  CONSTRAINT "fansly_media_tag_stats_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "fansly_media_tag_stats_source_account_seq_check"
    CHECK ("source_account_seq" > 0),
  CONSTRAINT "fansly_media_tag_stats_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "fansly_media_tag_stats_page_media_idx"
  ON "fansly_media_tag_stats" ("page_id", "media_offer_ref", "requested_end" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Platform-GLOBAL tag counters, sampled PER PAGE.
--
-- `viewCount`/`postCount` on a tag object are the platform's global numbers, not
-- this page's — but the PK is per page anyway, deliberately: `account_seq` is
-- incomparable ACROSS pages, so a globally-keyed table would make a multi-page
-- replay order-dependent (whichever page replayed last would win). The global
-- value is DERIVED at read time from these samples with a stated precedence:
-- latest `captured_at` wins, ties break on `page_id` ascending.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "platform_tag_daily" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "tag_ref"                text NOT NULL,
  "business_date"          date NOT NULL,
  "tag_name"               text,
  "view_count"             bigint,
  "post_count"             bigint,
  "tag_created_at"         timestamp with time zone,
  -- 'stats_agg'  = aggregationData.tags[] on /it/amoie/stats
  -- 'discovery'  = postTags[] on /contentdiscovery/media/suggestionsnew
  "source"                 text NOT NULL,
  "captured_at"            timestamp with time zone NOT NULL,
  "content_hash"           char(64) NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "platform_tag_daily_pkey"
    PRIMARY KEY ("page_id", "platform", "tag_ref", "business_date"),
  CONSTRAINT "platform_tag_daily_refs_check" CHECK (
    length("tag_ref") > 0 AND ("tag_name" IS NULL OR length("tag_name") > 0)
  ),
  CONSTRAINT "platform_tag_daily_source_check" CHECK ("source" IN ('stats_agg', 'discovery')),
  CONSTRAINT "platform_tag_daily_counts_check" CHECK (
    ("view_count" IS NULL OR "view_count" >= 0)
    AND ("post_count" IS NULL OR "post_count" >= 0)
  ),
  CONSTRAINT "platform_tag_daily_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "platform_tag_daily_source_account_seq_check" CHECK ("source_account_seq" > 0)
);

CREATE INDEX "platform_tag_daily_tag_date_idx"
  ON "platform_tag_daily" ("platform", "tag_ref", "business_date" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- media_offer_locations — the media ↔ offer ↔ bundle ↔ carrier join evidence
-- (A17-5: STORE THEM PARSED; the RAW_ONLY alternative was rejected).
--
-- 82 rows in the observed capture, exactly 11 keys, and PURE ID RELATIONS: no
-- URLs, no CDN paths. Delivery URLs do exist in the payload
-- (`accountMedia.media.location`, `media.variants[]`) and those never leave the
-- raw journal — this table is why that separation can be kept cleanly.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "media_offer_locations" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  -- creatorMediaOfferLocations[].id — the row's own identity.
  "location_ref"           text NOT NULL,
  "media_offer_ref"        text,
  "media_offer_type"       integer,
  "bundle_ref"             text,
  "media_ref"              text,
  "media_type"             integer,
  "preview_ref"            text,
  "owner_account_ref"      text,
  -- The wall/location the offer is placed on, and the carrier object
  -- (a post id, a message id) the placement correlates to.
  "location_id_ref"        text,
  "correlation_ref"        text,
  "created_at_platform"    timestamp with time zone,
  "content_hash"           char(64) NOT NULL,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "media_offer_locations_pkey" PRIMARY KEY ("page_id", "platform", "location_ref"),
  CONSTRAINT "media_offer_locations_refs_check" CHECK (
    length("location_ref") > 0
    AND ("media_offer_ref" IS NULL OR length("media_offer_ref") > 0)
    AND ("bundle_ref" IS NULL OR length("bundle_ref") > 0)
    AND ("media_ref" IS NULL OR length("media_ref") > 0)
    AND ("preview_ref" IS NULL OR length("preview_ref") > 0)
    AND ("location_id_ref" IS NULL OR length("location_id_ref") > 0)
    AND ("correlation_ref" IS NULL OR length("correlation_ref") > 0)
  ),
  CONSTRAINT "media_offer_locations_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "media_offer_locations_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "media_offer_locations_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "media_offer_locations_page_offer_idx"
  ON "media_offer_locations" ("page_id", "media_offer_ref")
  WHERE "media_offer_ref" IS NOT NULL;
CREATE INDEX "media_offer_locations_page_correlation_idx"
  ON "media_offer_locations" ("page_id", "correlation_ref")
  WHERE "correlation_ref" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Revenue mix. `/account/wallets/earnings/stats` serves flat
-- {type, totalGross, totalNet, accountId, timestamp} rows — one per revenue
-- type per business day. The type code is stored verbatim (A22-2), gross AND
-- net are stored (never one derived from the other: the 0.8 factor is Fansly's
-- cut and could change).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "revenue_mix_daily" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "business_date"          date NOT NULL,
  "type_code"              integer NOT NULL,
  "gross_mills"            bigint,
  "net_mills"              bigint,
  "correlation_account_ref" text,
  "content_hash"           char(64) NOT NULL,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "revenue_mix_daily_pkey"
    PRIMARY KEY ("page_id", "platform", "business_date", "type_code"),
  CONSTRAINT "revenue_mix_daily_money_check" CHECK (
    ("gross_mills" IS NULL OR "gross_mills" >= 0)
    AND ("net_mills" IS NULL OR "net_mills" >= 0)
  ),
  CONSTRAINT "revenue_mix_daily_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "revenue_mix_daily_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "revenue_mix_daily_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "revenue_mix_daily_page_date_idx"
  ON "revenue_mix_daily" ("page_id", "business_date" DESC, "type_code");

-- `/monthlystats`. The served list includes a `year: 0, month: 0` ROLLING
-- ROLLUP row — the creator's own Statements header. It is kept as a row like
-- any other, keys on (page, 0, 0), and is NEVER summed with the real months.
CREATE TABLE "revenue_month_totals" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "year"                   integer NOT NULL,
  "month"                  integer NOT NULL,
  "total_gross_mills"      bigint,
  "total_net_mills"        bigint,
  -- Percent fields are `numeric`, never float: they are ratios the platform
  -- served and they must round-trip exactly.
  "top_percent"            numeric(12,8),
  "max_top_percent"        numeric(12,8),
  "window_start"           timestamp with time zone,
  "window_end"             timestamp with time zone,
  -- Anything else the row served (e.g. `brackets`, `timestamp`, `accountId`),
  -- verbatim. A field we do not name today is not a field we throw away.
  "served_extras"          jsonb NOT NULL DEFAULT '{}'::jsonb,
  "content_hash"           char(64) NOT NULL,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "revenue_month_totals_pkey" PRIMARY KEY ("page_id", "platform", "year", "month"),
  -- 0/0 is the rollup row; real months are 1..12 of a real year.
  CONSTRAINT "revenue_month_totals_period_check" CHECK (
    ("year" = 0 AND "month" = 0)
    OR ("year" BETWEEN 2000 AND 2999 AND "month" BETWEEN 1 AND 12)
  ),
  CONSTRAINT "revenue_month_totals_money_check" CHECK (
    ("total_gross_mills" IS NULL OR "total_gross_mills" >= 0)
    AND ("total_net_mills" IS NULL OR "total_net_mills" >= 0)
  ),
  CONSTRAINT "revenue_month_totals_percent_check" CHECK (
    ("top_percent" IS NULL OR "top_percent" >= 0)
    AND ("max_top_percent" IS NULL OR "max_top_percent" >= 0)
  ),
  CONSTRAINT "revenue_month_totals_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "revenue_month_totals_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "revenue_month_totals_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Promo links — a DAILY SNAPSHOT of cumulative counters. Consecutive-day diffs
-- ARE the daily series; the platform serves no per-day breakdown.
--
-- `total_net_mills` is NULL whenever the platform served 0-or-null, because it
-- did exactly that on all five observed links while `totalGross` was populated:
-- an unpopulated counter is not a zero-revenue link. The verbatim served value
-- survives in the event payload and in the journal either way.
--
-- `link_kind` is 'tracking' today; WP-F3's gift codes join on the same shape.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "page_promo_links" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "link_kind"              text NOT NULL,
  "link_ref"               text NOT NULL,
  "business_date"          date NOT NULL,
  "internal_ref"           text,
  "link_type"              integer,
  "status"                 integer,
  "label"                  text,
  "description"            text,
  "metadata"               jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at_platform"    timestamp with time zone,
  "clicks"                 bigint,
  "claims"                 bigint,
  "follows"                bigint,
  "subscriptions"          bigint,
  "total_gross_mills"      bigint,
  "total_net_mills"        bigint,
  "captured_at"            timestamp with time zone NOT NULL,
  "content_hash"           char(64) NOT NULL,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_promo_links_pkey"
    PRIMARY KEY ("page_id", "platform", "link_kind", "link_ref", "business_date"),
  CONSTRAINT "page_promo_links_kind_check" CHECK ("link_kind" IN ('tracking', 'gift_code')),
  CONSTRAINT "page_promo_links_refs_check" CHECK (length("link_ref") > 0),
  CONSTRAINT "page_promo_links_counts_check" CHECK (
    ("clicks" IS NULL OR "clicks" >= 0)
    AND ("claims" IS NULL OR "claims" >= 0)
    AND ("follows" IS NULL OR "follows" >= 0)
    AND ("subscriptions" IS NULL OR "subscriptions" >= 0)
  ),
  CONSTRAINT "page_promo_links_money_check" CHECK (
    ("total_gross_mills" IS NULL OR "total_gross_mills" >= 0)
    AND ("total_net_mills" IS NULL OR "total_net_mills" >= 0)
  ),
  CONSTRAINT "page_promo_links_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_promo_links_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "page_promo_links_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "page_promo_links_page_link_date_idx"
  ON "page_promo_links" ("page_id", "link_ref", "business_date" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Mass DM (A28-5). Three routes ride the stats_snapshot lane as steps:
-- /message/broadcast/stats (live), /stats/deleted (withdrawn — sales against a
-- broadcast that was pulled, which disappears entirely if only the live list is
-- ever read) and /scheduled (intent, before it is sent).
--
-- `stats {total, delivered, read}` is stored verbatim. Offer prices are mills;
-- `saleStats.total` is NET (A12). There is no fan reference on these rows —
-- a broadcast names a GROUP, never a fan — which is why nothing here is a
-- fan-scope erasure target.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "page_broadcasts" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "broadcast_ref"          text NOT NULL,
  -- 'live' | 'deleted' | 'scheduled' — WHICH LIST served this row. A broadcast
  -- that moves from live to deleted keeps its identity and changes this column;
  -- the two lists are never merged into a single "was it deleted" boolean,
  -- because "we have not looked at the deleted list yet" is a third state.
  "source_list"            text NOT NULL,
  "group_ref"              text,
  "sender_ref"             text,
  "content"                text,
  "created_at_platform"    timestamp with time zone,
  "scheduled_for"          timestamp with time zone,
  "deleted_at_platform"    timestamp with time zone,
  "stats_total"            bigint,
  "stats_delivered"        bigint,
  "stats_read"             bigint,
  "total_tip_amount_mills" bigint,
  "offered_media_refs"     text[] NOT NULL DEFAULT '{}',
  "offered_bundle_refs"    text[] NOT NULL DEFAULT '{}',
  -- Every offered price, verbatim, per offered subject — a broadcast can carry
  -- several priced items and collapsing them to one number picks a winner.
  "offer_prices"           jsonb NOT NULL DEFAULT '[]'::jsonb,
  "sales_count"            bigint,
  "sales_net_mills"        bigint,
  "sales_pending_mills"    bigint,
  "content_hash"           char(64) NOT NULL,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_broadcasts_pkey" PRIMARY KEY ("page_id", "platform", "broadcast_ref"),
  CONSTRAINT "page_broadcasts_source_list_check"
    CHECK ("source_list" IN ('live', 'deleted', 'scheduled')),
  CONSTRAINT "page_broadcasts_refs_check" CHECK (
    length("broadcast_ref") > 0
    AND ("group_ref" IS NULL OR length("group_ref") > 0)
    AND ("sender_ref" IS NULL OR length("sender_ref") > 0)
  ),
  CONSTRAINT "page_broadcasts_counts_check" CHECK (
    ("stats_total" IS NULL OR "stats_total" >= 0)
    AND ("stats_delivered" IS NULL OR "stats_delivered" >= 0)
    AND ("stats_read" IS NULL OR "stats_read" >= 0)
    AND ("sales_count" IS NULL OR "sales_count" >= 0)
  ),
  CONSTRAINT "page_broadcasts_money_check" CHECK (
    ("total_tip_amount_mills" IS NULL OR "total_tip_amount_mills" >= 0)
    AND ("sales_net_mills" IS NULL OR "sales_net_mills" >= 0)
    AND ("sales_pending_mills" IS NULL OR "sales_pending_mills" >= 0)
  ),
  CONSTRAINT "page_broadcasts_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_broadcasts_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "page_broadcasts_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "page_broadcasts_page_created_idx"
  ON "page_broadcasts" ("page_id", "created_at_platform" DESC NULLS LAST);
CREATE INDEX "page_broadcasts_page_list_idx"
  ON "page_broadcasts" ("page_id", "source_list", "last_observed_at" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Polls. Options and their vote counts are stored verbatim, one row per option.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "page_polls" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "poll_ref"               text NOT NULL,
  "title"                  text,
  "description"            text,
  "status"                 integer,
  "poll_version"           integer,
  "created_at_platform"    timestamp with time zone,
  "content_hash"           char(64) NOT NULL,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_polls_pkey" PRIMARY KEY ("page_id", "platform", "poll_ref"),
  CONSTRAINT "page_polls_refs_check" CHECK (length("poll_ref") > 0),
  CONSTRAINT "page_polls_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_polls_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "page_polls_observed_order_check" CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE TABLE "page_poll_options" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "poll_ref"               text NOT NULL,
  "option_ref"             text NOT NULL,
  "option_ordinal"         integer NOT NULL,
  "title"                  text,
  "vote_count"             bigint,
  "content_hash"           char(64) NOT NULL,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_poll_options_pkey"
    PRIMARY KEY ("page_id", "platform", "poll_ref", "option_ref"),
  CONSTRAINT "page_poll_options_refs_check" CHECK (
    length("poll_ref") > 0 AND length("option_ref") > 0 AND "option_ordinal" >= 0
  ),
  CONSTRAINT "page_poll_options_counts_check" CHECK ("vote_count" IS NULL OR "vote_count" >= 0),
  CONSTRAINT "page_poll_options_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_poll_options_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "page_poll_options_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "page_poll_options_page_poll_idx"
  ON "page_poll_options" ("page_id", "poll_ref", "option_ordinal");

-- ─────────────────────────────────────────────────────────────────────────────
-- The yearly recap. `statValue` is a STRING on the wire and is stored verbatim
-- as text — NEVER coerced. A recap value can be a count, a duration, a name or
-- a formatted phrase, and a number parsed out of it would be a guess about
-- which.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "page_recap_stats" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "recap_year"             integer NOT NULL,
  "stat_ref"               text NOT NULL,
  "stat_name"              text,
  "stat_value"             text,
  "generated_at"           timestamp with time zone,
  "content_hash"           char(64) NOT NULL,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_recap_stats_pkey"
    PRIMARY KEY ("page_id", "platform", "recap_year", "stat_ref"),
  CONSTRAINT "page_recap_stats_refs_check" CHECK (length("stat_ref") > 0),
  CONSTRAINT "page_recap_stats_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_recap_stats_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "page_recap_stats_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- capture_coverage — CAPTURE-PLANE OPERATIONAL STATE (§3.4, A17-6).
--
-- NOT a rebuildable projection: it holds cursors, floors and blockers that no
-- event carries, so `projection:rebuild` must never truncate it. A rebuild that
-- reset it would re-trigger every "first sight" backfill in the system.
--
-- It NEVER implies absence of fact. A gap here means "this capture did not do
-- that", never "the platform cannot serve that". `proof_observation_id` points
-- into the 100-year journal at the response that PROVES the claim — an empty
-- window IS the retention-floor evidence, which is why an empty response is
-- journaled like any other.
--
-- THE (status, acquisition_mode, proof) MAPPING. Every coverage phrase used
-- anywhere in the plan maps to exactly ONE triple; this table is that mapping,
-- and it lives beside the CHECKs so the two cannot drift:
--
--   phrase                       status                            mode          proof
--   ---------------------------  --------------------------------  ------------  ----------------------
--   never looked                 not_started                       forward_only  none
--   walking history now          in_progress                       retroactive   none
--   window captured, more left   window_captured                   retroactive   none
--   reached the platform floor   provider_exhausted                retroactive   empty_window
--   reached a terminal refusal   provider_exhausted                retroactive   terminal_response
--   counted every item served    window_captured                   retroactive   complete_count_matched
--   only a sample, by design     sampled                           forward_only  none
--   part of the surface only     partial_provider_surface          retroactive   none
--   route serves nothing here    unsupported_by_observed_surface   forward_only  terminal_response
--   stopped at the daily cap     budget_deferred                   retroactive   none
--   401/403 — session is dead    auth_blocked                      retroactive   terminal_response
--   response shape changed       contract_drift                    retroactive   none
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "capture_coverage" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  -- Which capture surface this row is about (e.g. 'stats_account_daily',
  -- 'stats_account_hourly', 'earnings_stats', 'tracking_links').
  "plane"                  text NOT NULL,
  -- '' for a page-wide plane; a subject id for a per-subject one.
  "scope_ref"              text NOT NULL,
  "status"                 text NOT NULL,
  "acquisition_mode"       text NOT NULL,
  "proof"                  text NOT NULL,
  "oldest_captured_at"     timestamp with time zone,
  "newest_captured_at"     timestamp with time zone,
  "cursor"                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  "expected_count"         bigint,
  "observed_unique_count"  bigint,
  -- The journaled response that proves the claim. NULL only while the claim is
  -- still 'none'-proofed.
  "proof_observation_id"   bigint,
  "reason_code"            text,
  "next_probe_at"          timestamp with time zone,
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "capture_coverage_pkey" PRIMARY KEY ("page_id", "platform", "plane", "scope_ref"),
  CONSTRAINT "capture_coverage_plane_check" CHECK (length("plane") > 0),
  CONSTRAINT "capture_coverage_status_check" CHECK ("status" IN (
    'not_started',
    'in_progress',
    'window_captured',
    'provider_exhausted',
    'sampled',
    'partial_provider_surface',
    'unsupported_by_observed_surface',
    'budget_deferred',
    'auth_blocked',
    'contract_drift'
  )),
  CONSTRAINT "capture_coverage_acquisition_mode_check"
    CHECK ("acquisition_mode" IN ('retroactive', 'forward_only')),
  CONSTRAINT "capture_coverage_proof_check" CHECK ("proof" IN (
    'none', 'terminal_response', 'complete_count_matched', 'empty_window'
  )),
  CONSTRAINT "capture_coverage_counts_check" CHECK (
    ("expected_count" IS NULL OR "expected_count" >= 0)
    AND ("observed_unique_count" IS NULL OR "observed_unique_count" >= 0)
  ),
  -- A proof that is not 'none' must name the response that proves it.
  CONSTRAINT "capture_coverage_proof_lineage_check" CHECK (
    "proof" = 'none' OR "proof_observation_id" IS NOT NULL
  )
);

CREATE INDEX "capture_coverage_page_plane_idx"
  ON "capture_coverage" ("page_id", "plane");
CREATE INDEX "capture_coverage_next_probe_idx"
  ON "capture_coverage" ("next_probe_at")
  WHERE "next_probe_at" IS NOT NULL;
