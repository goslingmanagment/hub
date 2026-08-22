-- WP-F0(b): the media plane — "what was sold, to whom, for how much".
--
-- Four REBUILDABLE projections over the four projection-only event types the
-- sync-pull family emits at v5 (message.attachments_observed, media.observed,
-- media.order_observed, message.material_observed). Capture stays in
-- observations, canonical material stays append-only in domain_events; every
-- row here is reproducible from the ledger by projection:rebuild media_plane.
--
-- THREE RULES THESE TABLES OBEY, each because breaking it has a named cost:
--
-- 1. NO URLs, NO LOCATIONS, NO VARIANTS — ever. The payload carries signed CDN
--    locations and every variant of every file; they stay raw-journal-only.
--    What is stored here is identity, price, shape and sale counters.
-- 2. NO QUEUE COLUMNS. Refresh scheduling is capture-plane operational state
--    (subject_refresh_state, WP-F1/F4) and does not belong in a table that
--    projection:rebuild truncates.
-- 3. MONEY IS MILLS, NULL-OR-NON-NEGATIVE. A sparse saleStats means "the
--    platform did not serve this", never zero — the read layer must not
--    coalesce. sales_net_mills is NET (A12: saleStats.total is what the
--    creator keeps, not the gross the fan paid).
--
-- Purchase state is NOT added to message_archive (A17-4, variant B): it is
-- served by joining message_media_offers on (page_id, message_ref). The
-- archive gains Fansly material coverage through the EXISTING
-- message.material_observed channel and gains no columns.

CREATE TABLE "creator_media" (
  "id"                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "page_id"               bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"              text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  -- accountMedia.id — the offer identity a message attachment and an order row
  -- both point at. Provider ids are TEXT: they are snowflakes, not numbers.
  "media_offer_ref"       text NOT NULL,
  "media_ref"             text,
  "preview_ref"           text,
  "bundle_refs"           text[] NOT NULL DEFAULT '{}',
  "media_type"            integer,
  "mime_type"             text,
  "width"                 integer,
  "height"                integer,
  "duration_ms"           bigint,
  -- The primary permission entry's price. permission_entries keeps EVERY
  -- permissions.permissionFlags[] row verbatim — a media row can carry several
  -- prices (tier-gated, promo, verification-gated) and collapsing them to one
  -- number would silently pick a winner.
  "price_mills"           bigint,
  "permission_entries"    jsonb NOT NULL DEFAULT '[]'::jsonb,
  "permission_flags"      integer,
  "like_count"            bigint,
  "sales_count"           bigint,
  "sales_net_mills"       bigint,
  "sales_pending_mills"   bigint,
  "created_at_platform"   timestamp with time zone,
  "deleted_at_platform"   timestamp with time zone,
  -- Which plane saw this offer first. Later planes (vault, per-media stats,
  -- posts, order history) fill the same row without rewriting its origin.
  "first_origin"          text NOT NULL,
  "first_observed_at"     timestamp with time zone NOT NULL,
  "last_observed_at"      timestamp with time zone NOT NULL,
  "content_hash"          char(64) NOT NULL,
  "source_event_id"       bigint NOT NULL,
  "source_observation_id" bigint NOT NULL,
  "source_account_seq"    bigint NOT NULL,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "creator_media_page_offer_uniq" UNIQUE ("page_id", "platform", "media_offer_ref"),
  CONSTRAINT "creator_media_refs_check" CHECK (
    length("media_offer_ref") > 0
    AND ("media_ref" IS NULL OR length("media_ref") > 0)
    AND ("preview_ref" IS NULL OR length("preview_ref") > 0)
  ),
  CONSTRAINT "creator_media_money_check" CHECK (
    ("price_mills" IS NULL OR "price_mills" >= 0)
    AND ("sales_net_mills" IS NULL OR "sales_net_mills" >= 0)
    AND ("sales_pending_mills" IS NULL OR "sales_pending_mills" >= 0)
  ),
  CONSTRAINT "creator_media_counts_check" CHECK (
    ("sales_count" IS NULL OR "sales_count" >= 0)
    AND ("like_count" IS NULL OR "like_count" >= 0)
    AND ("duration_ms" IS NULL OR "duration_ms" >= 0)
  ),
  CONSTRAINT "creator_media_first_origin_check" CHECK (
    "first_origin" IN ('dm_sidecar', 'vault', 'stats_agg', 'post', 'order_history')
  ),
  CONSTRAINT "creator_media_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "creator_media_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "creator_media_observed_order_check" CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "creator_media_page_observed_idx"
  ON "creator_media" ("page_id", "last_observed_at" DESC, "id" DESC);
CREATE INDEX "creator_media_page_created_idx"
  ON "creator_media" ("page_id", "created_at_platform" DESC NULLS LAST, "id" DESC);

CREATE TABLE "creator_media_bundles" (
  "page_id"               bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"              text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "bundle_ref"            text NOT NULL,
  "preview_ref"           text,
  "price_mills"           bigint,
  "permission_entries"    jsonb NOT NULL DEFAULT '[]'::jsonb,
  "permission_flags"      integer,
  -- Members, twice: the flat id list for joins and the served bundleContent
  -- (accountMediaId + pos) for the order the creator arranged.
  "member_refs"           text[] NOT NULL DEFAULT '{}',
  "member_positions"      jsonb NOT NULL DEFAULT '[]'::jsonb,
  "sales_count"           bigint,
  "sales_net_mills"       bigint,
  "sales_pending_mills"   bigint,
  "created_at_platform"   timestamp with time zone,
  "deleted_at_platform"   timestamp with time zone,
  "first_observed_at"     timestamp with time zone NOT NULL,
  "last_observed_at"      timestamp with time zone NOT NULL,
  "content_hash"          char(64) NOT NULL,
  "source_event_id"       bigint NOT NULL,
  "source_observation_id" bigint NOT NULL,
  "source_account_seq"    bigint NOT NULL,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "creator_media_bundles_pkey" PRIMARY KEY ("page_id", "bundle_ref"),
  CONSTRAINT "creator_media_bundles_refs_check" CHECK (
    length("bundle_ref") > 0
    AND ("preview_ref" IS NULL OR length("preview_ref") > 0)
  ),
  CONSTRAINT "creator_media_bundles_money_check" CHECK (
    ("price_mills" IS NULL OR "price_mills" >= 0)
    AND ("sales_net_mills" IS NULL OR "sales_net_mills" >= 0)
    AND ("sales_pending_mills" IS NULL OR "sales_pending_mills" >= 0)
  ),
  CONSTRAINT "creator_media_bundles_counts_check" CHECK (
    "sales_count" IS NULL OR "sales_count" >= 0
  ),
  CONSTRAINT "creator_media_bundles_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "creator_media_bundles_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "creator_media_bundles_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "creator_media_bundles_page_observed_idx"
  ON "creator_media_bundles" ("page_id", "last_observed_at" DESC);

-- The composite natural key IS the primary key: the live order shape carries
-- NO order id (verified 2026-08-19 — {accountId, accountMediaId, type,
-- createdAt} and nothing else). order_ref stays nullable for the day a
-- response supplies one; it becomes the key only after a live observation and
-- a versioned change, never before.
CREATE TABLE "media_orders" (
  "page_id"                 bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"                text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "media_offer_ref"         text NOT NULL,
  "buyer_platform_user_id"  text NOT NULL,
  "occurred_at"             timestamp with time zone NOT NULL,
  "order_ref"               text,
  "bundle_ref"              text,
  "order_type"              integer,
  "price_mills"             bigint,
  "conversation_ref"        text,
  "message_ref"             text,
  "first_observed_at"       timestamp with time zone NOT NULL,
  "last_observed_at"        timestamp with time zone NOT NULL,
  "content_hash"            char(64) NOT NULL,
  "source_event_id"         bigint NOT NULL,
  "source_observation_id"   bigint NOT NULL,
  "source_account_seq"      bigint NOT NULL,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"              timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "media_orders_pkey"
    PRIMARY KEY ("page_id", "media_offer_ref", "buyer_platform_user_id", "occurred_at"),
  CONSTRAINT "media_orders_refs_check" CHECK (
    length("media_offer_ref") > 0
    AND length("buyer_platform_user_id") > 0
    AND ("order_ref" IS NULL OR length("order_ref") > 0)
    AND ("bundle_ref" IS NULL OR length("bundle_ref") > 0)
  ),
  CONSTRAINT "media_orders_money_check" CHECK ("price_mills" IS NULL OR "price_mills" >= 0),
  CONSTRAINT "media_orders_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "media_orders_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "media_orders_observed_order_check" CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "media_orders_page_occurred_idx"
  ON "media_orders" ("page_id", "occurred_at" DESC);
CREATE INDEX "media_orders_page_buyer_occurred_idx"
  ON "media_orders" ("page_id", "buyer_platform_user_id", "occurred_at" DESC);
CREATE INDEX "media_orders_page_message_idx"
  ON "media_orders" ("page_id", "message_ref")
  WHERE "message_ref" IS NOT NULL;

-- What was OFFERED in which conversation. A17-4 variant B makes this the
-- queryable home of purchase state: message_archive joins it on
-- (page_id, message_ref) at read time and gains no columns of its own.
CREATE TABLE "message_media_offers" (
  "page_id"                 bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"                text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "message_ref"             text NOT NULL,
  "offer_ordinal"           integer NOT NULL,
  "media_offer_ref"         text,
  "bundle_ref"              text,
  "conversation_ref"        text,
  "fan_platform_user_id"    text,
  "message_created_at"      timestamp with time zone,
  "offer_type"              integer,
  "mime_type"               text,
  "duration_ms"             bigint,
  "price_mills"             bigint,
  "permission_entries"      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 'purchased' | 'unpurchased' | 'unknown' — 'unknown' is the honest answer
  -- when the response carried no access/purchased evidence at all.
  "purchase_state"          text NOT NULL DEFAULT 'unknown',
  "order_ref"               text,
  "sales_count"             bigint,
  "sales_net_mills"         bigint,
  "sales_pending_mills"     bigint,
  "first_observed_at"       timestamp with time zone NOT NULL,
  "last_observed_at"        timestamp with time zone NOT NULL,
  "content_hash"            char(64) NOT NULL,
  "source_event_id"         bigint NOT NULL,
  "source_observation_id"   bigint NOT NULL,
  "source_account_seq"      bigint NOT NULL,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"              timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "message_media_offers_pkey" PRIMARY KEY ("page_id", "message_ref", "offer_ordinal"),
  CONSTRAINT "message_media_offers_refs_check" CHECK (
    length("message_ref") > 0
    AND "offer_ordinal" >= 0
    AND ("media_offer_ref" IS NULL OR length("media_offer_ref") > 0)
    AND ("bundle_ref" IS NULL OR length("bundle_ref") > 0)
    AND ("fan_platform_user_id" IS NULL OR length("fan_platform_user_id") > 0)
    AND ("order_ref" IS NULL OR length("order_ref") > 0)
  ),
  CONSTRAINT "message_media_offers_money_check" CHECK (
    ("price_mills" IS NULL OR "price_mills" >= 0)
    AND ("sales_net_mills" IS NULL OR "sales_net_mills" >= 0)
    AND ("sales_pending_mills" IS NULL OR "sales_pending_mills" >= 0)
  ),
  CONSTRAINT "message_media_offers_counts_check" CHECK (
    ("sales_count" IS NULL OR "sales_count" >= 0)
    AND ("duration_ms" IS NULL OR "duration_ms" >= 0)
  ),
  CONSTRAINT "message_media_offers_purchase_state_check" CHECK (
    "purchase_state" IN ('purchased', 'unpurchased', 'unknown')
  ),
  CONSTRAINT "message_media_offers_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "message_media_offers_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "message_media_offers_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "message_media_offers_page_message_idx"
  ON "message_media_offers" ("page_id", "message_ref");
CREATE INDEX "message_media_offers_page_offer_idx"
  ON "message_media_offers" ("page_id", "media_offer_ref")
  WHERE "media_offer_ref" IS NOT NULL;
CREATE INDEX "message_media_offers_page_fan_idx"
  ON "message_media_offers" ("page_id", "fan_platform_user_id")
  WHERE "fan_platform_user_id" IS NOT NULL;

-- [E2] instrumentation (F0(a)): the measured size of the body a capture
-- journaled, taken from the serialized payload object at the capture site —
-- NOT Content-Length, which counts compressed transport bytes and does not
-- exist on a replayed body. It is a disk-trend input and nothing else: [A20]
-- deleted the byte ceiling, so no code path may defer any lane on it.
ALTER TABLE "sync_http_attempts"
  ADD COLUMN "response_body_bytes" bigint,
  ADD CONSTRAINT "sync_http_attempts_response_body_bytes_check" CHECK (
    "response_body_bytes" IS NULL OR "response_body_bytes" >= 0
  );
