-- WP-F3 — the content catalog: what the creator has to sell, at what price,
-- under which automation, on which wall, inside which album.
--
-- SIX NEW TABLES, ONE STATE CLASS. Every one of them is a FACT PROJECTION
-- (§3.4): truncate + replay reproduces it from the domain-event ledger alone.
-- Nothing here holds a cursor, a due date or a walk position — the vault walk's
-- per-album cursor lives in the stream checkpoint, which is capture-plane
-- operational state a rebuild never touches.
--
-- THE THREE RULES THIS MIGRATION IS BUILT AROUND:
--
-- 1. **PRICE TRUTH IS `plans[].price`, NOT `tier.price`** (§2.3, verified
--    2026-08-19). All five observed tiers carried `tier.price = 5 000` while
--    their plans ranged 10 000 … 499 990. A `page_subscription_tiers` row with
--    a single `price` column would therefore have reported every tier at $5 —
--    which is why the tier head keeps `base_price_mills` (named so it cannot be
--    mistaken for the price) and the queryable truth lives in
--    `page_subscription_tier_plans`. FEAT-002 reads the plans table.
--
-- 2. **`item_count` IS NOT A MEDIA COUNT.** Σ over the 27 observed albums is
--    16 939, but the system albums `type 38000` (7 574 rows) and `type 5000`
--    (3 154 rows) share one `last_item_ref` — they are VIEWS over the same
--    media. The column is stored exactly as served and documented as
--    NON-UNIQUE membership; M, the media denominator WP-F4 is sized against,
--    is `count(distinct media_offer_ref)` over `creator_media`, never a sum of
--    this column.
--
-- 3. **NO DELIVERY URLS, ANYWHERE.** `/vault/albumsnew` embeds
--    `aggregationData.media[]` with `location`, `locations[]` and `variants[]`
--    — signed CDN material. It is journaled verbatim (DP 7) and reaches NO
--    column here. The same rule that keeps `media_offer_locations` to pure
--    id-relations (A17-5) applies to every table below.
--
-- MISSING, NEVER DELETED. Each table carries `missing_since`: the instant a
-- FULL listing of that kind stopped naming the row. A deleted tier, a revoked
-- gift code and an album the creator removed all keep their history and gain a
-- timestamp. There is no deleter in this file and none anywhere in this
-- package — `tests/retention-deleters.test.ts` is what keeps that true.

-- ─────────────────────────────────────────────────────────────────────────────
-- creator_vault_albums — BOTH vaults, told apart by `vault_kind`.
--
-- `/vault/albumsnew` is the creator's REAL vault (27 albums, the inventory M is
-- measured from). `/uservault/albumsnew?accountId=` is a DIFFERENT resource:
-- the account's own Likes/Purchases shelves, which contain OTHER creators'
-- media. Merging them into one table with no discriminator would have made the
-- page's purchases indistinguishable from its inventory — so `vault_kind` is in
-- the PRIMARY KEY, not a nullable label.
--
-- `type` is the platform's raw integer and NULL for creator-made albums; the
-- system albums observed live are 38000, 5000 and 1000. `title` is NULL on
-- them, which is why nothing here treats a title as identity.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "creator_vault_albums" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  -- 'creator' = /vault/albumsnew (the inventory). 'user' = /uservault/albumsnew
  -- (Likes/Purchases — other creators' media, never counted into M).
  "vault_kind"             text NOT NULL,
  "album_ref"              text NOT NULL,
  "owner_account_ref"      text,
  "title"                  text,
  "description"            text,
  -- RAW platform integers. A label table would have to guess at 38000/5000/1000
  -- and the guess would be storage.
  "album_type"             integer,
  "status"                 integer,
  "pos"                    integer,
  -- STORED AS SERVED, and NON-UNIQUE by construction: the system albums are
  -- views over the same media, so Σ over a page DOUBLE-COUNTS (§2.3).
  "item_count"             bigint,
  -- The newest media offer in the album. The incremental walk re-visits an
  -- album's head exactly when this changes.
  "last_item_ref"          text,
  "thumbnail_ref"          text,
  "public"                 integer,
  "version"                integer,
  "created_at_platform"    timestamp with time zone,
  -- Set when a later FULL listing of the same vault_kind stops naming this
  -- album. The row is never deleted (DP 7).
  "missing_since"          timestamp with time zone,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "content_hash"           char(64) NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "creator_vault_albums_pkey" PRIMARY KEY ("page_id", "vault_kind", "album_ref"),
  CONSTRAINT "creator_vault_albums_kind_check"
    CHECK ("vault_kind" IN ('creator', 'user')),
  CONSTRAINT "creator_vault_albums_refs_check" CHECK (
    length("album_ref") > 0
    AND ("last_item_ref" IS NULL OR length("last_item_ref") > 0)
    AND ("thumbnail_ref" IS NULL OR length("thumbnail_ref") > 0)
    AND ("owner_account_ref" IS NULL OR length("owner_account_ref") > 0)
  ),
  CONSTRAINT "creator_vault_albums_counts_check"
    CHECK ("item_count" IS NULL OR "item_count" >= 0),
  CONSTRAINT "creator_vault_albums_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "creator_vault_albums_source_account_seq_check"
    CHECK ("source_account_seq" > 0),
  CONSTRAINT "creator_vault_albums_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

-- "the creator's albums, in the order the UI shows them" is the inventory read.
CREATE INDEX "creator_vault_albums_page_kind_pos_idx"
  ON "creator_vault_albums" ("page_id", "vault_kind", "pos");

-- ─────────────────────────────────────────────────────────────────────────────
-- creator_vault_album_members — album ↔ media-offer membership.
--
-- One row per (album, media offer). Both vaults write here; the album's own
-- `vault_kind` is one join away, and the PK deliberately does NOT carry it
-- because album ids are globally unique and a member is a member exactly once.
--
-- This is the overlap-aware evidence behind M: the union of `media_offer_ref`
-- over an exhausted CREATOR vault is the honest inventory size, and the
-- difference between that union and Σ `item_count` is the double-count the
-- system albums cause.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "creator_vault_album_members" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "album_ref"              text NOT NULL,
  "media_offer_ref"        text NOT NULL,
  -- The membership row's own id (`albumContent[].id` / `albumMedia[].id`) — the
  -- cursor the vault walk pages on, and NOT the same value as media_offer_ref.
  "member_ref"             text,
  "media_offer_type"       integer,
  "bundle_ref"             text,
  "media_ref"              text,
  "media_type"             integer,
  "preview_ref"            text,
  "vault_kind"             text NOT NULL,
  "created_at_platform"    timestamp with time zone,
  "missing_since"          timestamp with time zone,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "content_hash"           char(64) NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "creator_vault_album_members_pkey"
    PRIMARY KEY ("page_id", "album_ref", "media_offer_ref"),
  CONSTRAINT "creator_vault_album_members_kind_check"
    CHECK ("vault_kind" IN ('creator', 'user')),
  CONSTRAINT "creator_vault_album_members_refs_check" CHECK (
    length("album_ref") > 0
    AND length("media_offer_ref") > 0
    AND ("member_ref" IS NULL OR length("member_ref") > 0)
    AND ("bundle_ref" IS NULL OR length("bundle_ref") > 0)
    AND ("media_ref" IS NULL OR length("media_ref") > 0)
    AND ("preview_ref" IS NULL OR length("preview_ref") > 0)
  ),
  CONSTRAINT "creator_vault_album_members_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "creator_vault_album_members_source_account_seq_check"
    CHECK ("source_account_seq" > 0),
  CONSTRAINT "creator_vault_album_members_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

-- The M query: distinct media offers across the CREATOR vault.
CREATE INDEX "creator_vault_album_members_page_kind_offer_idx"
  ON "creator_vault_album_members" ("page_id", "vault_kind", "media_offer_ref");
-- The hydration queue: album members with no creator_media row yet.
CREATE INDEX "creator_vault_album_members_page_offer_idx"
  ON "creator_vault_album_members" ("page_id", "media_offer_ref");

-- ─────────────────────────────────────────────────────────────────────────────
-- page_subscription_tiers — the tier HEAD. `plans` is verbatim jsonb.
--
-- `base_price_mills` is `tier.price`, and the name is the whole point: it was
-- 5 000 on every observed tier while the real prices sat in the plans. Storing
-- it as `price_mills` would have shipped a column that reads like the answer
-- and is not.
--
-- `plans jsonb NOT NULL` keeps the served array whole — promos, statuses,
-- unnamed future keys and all — beside the normalized rows. The normalized
-- table is the query surface; the jsonb is the proof that nothing was dropped
-- on the way there.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "page_subscription_tiers" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "tier_ref"               text NOT NULL,
  "name"                   text,
  "color"                  text,
  "pos"                    integer,
  -- `tier.price` — a BASE, not a price. See the header.
  "base_price_mills"       bigint,
  "max_subscribers"        bigint,
  "subscription_benefits"  jsonb NOT NULL DEFAULT '[]'::jsonb,
  "included_tier_refs"     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The served `plans[]` array, VERBATIM.
  "plans"                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  "missing_since"          timestamp with time zone,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "content_hash"           char(64) NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_subscription_tiers_pkey" PRIMARY KEY ("page_id", "tier_ref"),
  CONSTRAINT "page_subscription_tiers_refs_check" CHECK (length("tier_ref") > 0),
  CONSTRAINT "page_subscription_tiers_money_check"
    CHECK ("base_price_mills" IS NULL OR "base_price_mills" >= 0),
  CONSTRAINT "page_subscription_tiers_counts_check"
    CHECK ("max_subscribers" IS NULL OR "max_subscribers" >= 0),
  CONSTRAINT "page_subscription_tiers_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_subscription_tiers_source_account_seq_check"
    CHECK ("source_account_seq" > 0),
  CONSTRAINT "page_subscription_tiers_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "page_subscription_tiers_page_pos_idx"
  ON "page_subscription_tiers" ("page_id", "pos");

-- ─────────────────────────────────────────────────────────────────────────────
-- page_subscription_tier_plans — THE PRICE TRUTH (FEAT-002).
--
-- One row per plan. `price_mills` is what a subscriber actually pays for
-- `duration_days` of access; the maximum observed live is 499 990 ($499.99),
-- which is why nothing in this package caps a plan price at the 100 000 the
-- superseded spec claimed was the ceiling.
--
-- `duration_days` reads `plans[].billingCycle` — VERIFIED on the 2026-08-19
-- capture, where the nine live plans carried `billingCycle` 30/60/90 and NO
-- `duration` key at all. (The plan document says `plans[].duration`; the
-- payload disagrees, and the payload is the contract. `duration` DOES exist —
-- one level down, on `promos[]` — which is exactly how a reader gets this
-- wrong.) The writer accepts either key so a provider rename is survivable.
--
-- `promos jsonb` keeps the nested promo array whole: discounted price, window,
-- max uses, description. A promo is money with a deadline and belongs with the
-- plan it discounts, not in a table of its own that nothing joins.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "page_subscription_tier_plans" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "tier_ref"               text NOT NULL,
  "plan_ref"               text NOT NULL,
  "status"                 integer,
  "duration_days"          integer,
  "price_mills"            bigint,
  "use_amounts"            integer,
  "promos"                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  "missing_since"          timestamp with time zone,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "content_hash"           char(64) NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_subscription_tier_plans_pkey"
    PRIMARY KEY ("page_id", "tier_ref", "plan_ref"),
  CONSTRAINT "page_subscription_tier_plans_refs_check"
    CHECK (length("tier_ref") > 0 AND length("plan_ref") > 0),
  CONSTRAINT "page_subscription_tier_plans_money_check"
    CHECK ("price_mills" IS NULL OR "price_mills" >= 0),
  CONSTRAINT "page_subscription_tier_plans_duration_check"
    CHECK ("duration_days" IS NULL OR "duration_days" >= 0),
  CONSTRAINT "page_subscription_tier_plans_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_subscription_tier_plans_source_account_seq_check"
    CHECK ("source_account_seq" > 0),
  CONSTRAINT "page_subscription_tier_plans_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

-- "what does this page charge, per duration" — the FEAT-002 read.
CREATE INDEX "page_subscription_tier_plans_page_price_idx"
  ON "page_subscription_tier_plans" ("page_id", "duration_days", "price_mills");

-- ─────────────────────────────────────────────────────────────────────────────
-- page_walls — the profile's content sections.
--
-- `pages.metadata.walls` already holds a current-state hint from `/account`;
-- it is a snapshot with no lineage and no history. This table is the lineage:
-- the first captured `/account/walls` read becomes the projection baseline, and
-- a renamed or deleted wall keeps its row.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "page_walls" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "wall_ref"               text NOT NULL,
  "name"                   text,
  "description"            text,
  "pos"                    integer,
  -- Two independent flags on the wire (`mainWall`, `defaultWall`); one wall can
  -- be neither, and collapsing them to a single boolean would lose which.
  "main_wall"              boolean,
  "default_wall"           boolean,
  "private"                integer,
  "metadata"               jsonb NOT NULL DEFAULT '{}'::jsonb,
  "missing_since"          timestamp with time zone,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "content_hash"           char(64) NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_walls_pkey" PRIMARY KEY ("page_id", "wall_ref"),
  CONSTRAINT "page_walls_refs_check" CHECK (length("wall_ref") > 0),
  CONSTRAINT "page_walls_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_walls_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "page_walls_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "page_walls_page_pos_idx" ON "page_walls" ("page_id", "pos");

-- ─────────────────────────────────────────────────────────────────────────────
-- page_automated_messages — what the page says without a human.
--
-- `messageTemplate` is a JSON OBJECT `{type, content, attachments[], senderId}`
-- in all seven live values (verified 2026-08-19). The superseded claim that it
-- is a Python-repr pseudo-JSON STRING is withdrawn — but the fallback branch
-- for that shape stays, covered by one fixture, and when it fires `parse_ok`
-- is FALSE and the raw stays in the journal. A parser that silently produced an
-- empty `message_text` would look exactly like an automation with no text.
--
-- `trigger_metadata` arrives as a JSON STRING (`{"subscriptionTierId": …}` on
-- the tier-triggered ones, `""` on the rest) — parsed when it parses, wrapped
-- as `{"raw": …}` when it does not.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "page_automated_messages" (
  "page_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"               text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "automation_ref"         text NOT NULL,
  -- RAW platform code (3 = welcome/new-follower band, 15 = per-tier band on the
  -- live capture). Never a label.
  "trigger_type"           integer,
  "trigger_metadata"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Both are the platform's own units on the wire and are stored as served.
  "delay_seconds"          bigint,
  "cooldown_seconds"       bigint,
  "template_type"          integer,
  "sender_ref"             text,
  "message_text"           text,
  -- `[{contentType, contentId}]` — id-relations only, never a URL.
  "attachment_refs"        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- FALSE when the template did not parse as an object. The row still exists.
  "parse_ok"               boolean NOT NULL DEFAULT true,
  "missing_since"          timestamp with time zone,
  "first_observed_at"      timestamp with time zone NOT NULL,
  "last_observed_at"       timestamp with time zone NOT NULL,
  "content_hash"           char(64) NOT NULL,
  "source_event_id"        bigint NOT NULL,
  "source_observation_id"  bigint NOT NULL,
  "source_account_seq"     bigint NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_automated_messages_pkey" PRIMARY KEY ("page_id", "automation_ref"),
  CONSTRAINT "page_automated_messages_refs_check" CHECK (
    length("automation_ref") > 0
    AND ("sender_ref" IS NULL OR length("sender_ref") > 0)
  ),
  CONSTRAINT "page_automated_messages_timing_check" CHECK (
    ("delay_seconds" IS NULL OR "delay_seconds" >= 0)
    AND ("cooldown_seconds" IS NULL OR "cooldown_seconds" >= 0)
  ),
  CONSTRAINT "page_automated_messages_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_automated_messages_source_account_seq_check"
    CHECK ("source_account_seq" > 0),
  CONSTRAINT "page_automated_messages_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "page_automated_messages_page_trigger_idx"
  ON "page_automated_messages" ("page_id", "trigger_type");

-- ─────────────────────────────────────────────────────────────────────────────
-- page_promo_links — GIFT CODES join the tracking links WP-F1 put here.
--
-- The table already exists (0132) with `link_kind IN ('tracking','gift_code')`
-- and the tracking half's counters. The gift-code half needs five columns the
-- tracking half has no use for, and they are added rather than borrowed:
-- `total_gross_mills` is REVENUE and `original_price_mills` is a LIST PRICE,
-- and §2.3's rule about never combining money of unknown basis applies inside
-- one table as much as across two.
--
-- `original_price` is snake_case on the wire, amid otherwise camelCase keys.
-- It is read by that exact name, with the camelCase spelling accepted as a
-- fallback, because a provider that tidies its casing must not silently produce
-- a NULL list price.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "page_promo_links"
  ADD COLUMN "uses"                  bigint,
  ADD COLUMN "max_uses"              bigint,
  -- What the code costs today (0 on a full-comp code) …
  ADD COLUMN "price_mills"           bigint,
  -- … and what it would have cost without it. Never summed with the revenue
  -- columns above.
  ADD COLUMN "original_price_mills"  bigint,
  ADD COLUMN "starts_at_platform"    timestamp with time zone,
  ADD COLUMN "ends_at_platform"      timestamp with time zone,
  ADD COLUMN "missing_since"         timestamp with time zone;

ALTER TABLE "page_promo_links"
  ADD CONSTRAINT "page_promo_links_gift_counts_check" CHECK (
    ("uses" IS NULL OR "uses" >= 0)
    AND ("max_uses" IS NULL OR "max_uses" >= 0)
  ),
  ADD CONSTRAINT "page_promo_links_gift_money_check" CHECK (
    ("price_mills" IS NULL OR "price_mills" >= 0)
    AND ("original_price_mills" IS NULL OR "original_price_mills" >= 0)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- creator_media.first_origin — one new origin, and the reason it is new.
--
-- 'vault' was already declared in 0130 for the vault walk. `/account/media?ids=`
-- is a SECOND vault-adjacent origin and a distinct one: the walk gives album
-- membership (ids), the batch call gives the media CARD (price, permissions,
-- sale counters). A media row whose card was hydrated by the batch route did
-- not come from the walk, and telling the two apart is how the walk's coverage
-- is auditable.
--
-- The constraint is REPLACED rather than widened in place — Postgres has no
-- ALTER CONSTRAINT for a CHECK, and 0120's replacement of
-- `ofapi_capture_jobs_kind_check` is the precedent.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "creator_media" DROP CONSTRAINT "creator_media_first_origin_check";
ALTER TABLE "creator_media" ADD CONSTRAINT "creator_media_first_origin_check" CHECK (
  "first_origin" IN (
    'dm_sidecar', 'vault', 'stats_agg', 'post', 'order_history', 'account_media_batch'
  )
);
