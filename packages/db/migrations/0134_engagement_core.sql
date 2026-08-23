-- WP-F2 — the engagement core: the verbatim notification archive, the liker
-- state table it will one day feed, and the shared refresh queue every later
-- capture lane schedules from.
--
-- THREE TABLES, TWO STATE CLASSES (§3.4). `platform_notifications` and
-- `post_likes` are FACT PROJECTIONS: truncate + replay reproduces them from the
-- event ledger alone. `subject_refresh_state` is CAPTURE-PLANE OPERATIONAL
-- STATE: no event carries a due date or a cursor, so a rebuild that truncated
-- it would reset every refresh cycle and re-trigger "first sight" backfills for
-- the whole catalogue — an egress storm against a platform whose failure mode
-- is a model ban. The projection registry names it in OPERATIONAL_STATE_TABLES
-- and a test asserts no projection's `tables` intersects that list.
--
-- TYPE CODES ARE STORED RAW (A22-2), and the reason is now documented history
-- rather than theory: `reference/fansly_api_spec.md` §3.1 was wrong on eight of
-- sixteen notification codes, including BOTH purchase events. Storage that had
-- keyed on labels would have filed two live purchase streams under
-- "PostLikeUndo/Redo" and there would be no way back. Storage holds the
-- integer; `packages/shared/src/fansly-notification-types.ts` holds the labels,
-- versioned, and a re-derivation is a version bump plus a rebuild.

-- ─────────────────────────────────────────────────────────────────────────────
-- platform_notifications — EVERY row, EVERY code, verbatim.
--
-- Written from `notification.observed`, which layer 1 of the canonicalizer
-- emits for every notification row whether or not the label table can name its
-- type. That is what makes an unknown code reachable BY REPLAY: when a code
-- gets a meaning next year, the rows are already here.
--
-- HEAD PRECEDENCE IS THE PROVIDER'S `occurred_at`, NEVER `account_seq`
-- (WP-F2's blocking rule). The deep backfill appends OLDER facts at HIGHER
-- seq, so ledger order is the one ordering that is guaranteed wrong here. This
-- is `creator_posts`'s law generalized — and note the deliberate difference
-- from `creator_posts` itself, which uses `last_observed_at` because a post
-- head means "latest capture wins": a notification-fed state machine must be
-- ordered by when the EVENT happened, not by when we saw it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "platform_notifications" (
  "page_id"                 bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"                text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "notification_ref"        text NOT NULL,
  -- The RAW platform code. Never a label, never a closed set: an unrecognized
  -- code lands here exactly like a recognized one.
  "type_code"               integer NOT NULL,
  -- The subject the notification is about: a fan for purchase/follow/sub codes,
  -- a post or media id for engagement ones. Fan-ref-shaped, and therefore
  -- declared in FAN_REF_ERASURE_COLUMNS with the predicate that reaches it.
  "correlation_ref"         text,
  "correlation_group_ref"   text,
  -- The platform serves `metadata` as a JSON STRING. Parsed when it is valid
  -- JSON, `{"raw": "<the string>"}` when it is not — never dropped, never
  -- silently coerced.
  "metadata"                jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The provider's own instants (seconds on the wire, stored as timestamps).
  "occurred_at"             timestamp with time zone NOT NULL,
  "acknowledged_at"         timestamp with time zone,
  "first_observed_at"       timestamp with time zone NOT NULL,
  "last_observed_at"        timestamp with time zone NOT NULL,
  "content_hash"            char(64) NOT NULL,
  "source_event_id"         bigint NOT NULL,
  "source_observation_id"   bigint NOT NULL,
  "source_account_seq"      bigint NOT NULL,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"              timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "platform_notifications_pkey" PRIMARY KEY ("page_id", "notification_ref"),
  CONSTRAINT "platform_notifications_refs_check" CHECK (
    length("notification_ref") > 0
    AND ("correlation_ref" IS NULL OR length("correlation_ref") > 0)
    AND ("correlation_group_ref" IS NULL OR length("correlation_group_ref") > 0)
  ),
  CONSTRAINT "platform_notifications_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "platform_notifications_source_account_seq_check"
    CHECK ("source_account_seq" > 0),
  CONSTRAINT "platform_notifications_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

-- "every 2007 on this page, newest first" is the commerce read, and the same
-- shape answers every other per-code question.
CREATE INDEX "platform_notifications_page_type_occurred_idx"
  ON "platform_notifications" ("page_id", "type_code", "occurred_at" DESC);
-- Erasure and the commerce correlation join both walk the correlation ref.
CREATE INDEX "platform_notifications_page_correlation_idx"
  ON "platform_notifications" ("page_id", "correlation_ref")
  WHERE "correlation_ref" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- post_likes — latest-known ACTOR state, and it SHIPS EMPTY on Fansly.
--
-- Not a placeholder and not dead code: the OnlyFans `posts.liked` webhook
-- populates it independently, and the table has to exist and be correct before
-- a Fansly like code can ever be confirmed. What ships empty is the FANSLY
-- half — no like code is live-confirmed ([E4]: 1002/2002/5003/1004/1005 had
-- ZERO occurrences in the 200-row census, and the client-code labels prove the
-- client's intent, not the server's behaviour). Layer 2 of the canonicalizer
-- writes NOTHING here, and a test pins that a 2007 purchase row does not.
--
-- Its coverage row therefore reads `not_started` until a code is confirmed,
-- and the serving layer says so rather than showing an empty list as "no likes".
--
-- Head precedence: `occurred_at` DESC with `notification_ref` as the
-- deterministic tie-break — never `account_seq`. A like/undo pair arrives as
-- two notifications and the LATER EVENT wins, regardless of which one the
-- backfill happened to append second.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "post_likes" (
  "page_id"                 bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"                text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "subject_kind"            text NOT NULL,
  "subject_ref"             text NOT NULL,
  -- The liker. A TEXT platform ref with no FK to `fans`, so only the explicit
  -- erasure predicate reaches it (declared in FAN_REF_ERASURE_COLUMNS).
  "liker_platform_user_id"  text NOT NULL,
  "state"                   text NOT NULL,
  "occurred_at"             timestamp with time zone NOT NULL,
  -- The notification that carried this state, and the tie-break for two facts
  -- at the same instant.
  "notification_ref"        text,
  "discovered_via"          text NOT NULL,
  "first_observed_at"       timestamp with time zone NOT NULL,
  "last_observed_at"        timestamp with time zone NOT NULL,
  "content_hash"            char(64) NOT NULL,
  "source_event_id"         bigint NOT NULL,
  "source_observation_id"   bigint NOT NULL,
  "source_account_seq"      bigint NOT NULL,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"              timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "post_likes_pkey"
    PRIMARY KEY ("page_id", "subject_kind", "subject_ref", "liker_platform_user_id"),
  CONSTRAINT "post_likes_subject_kind_check"
    CHECK ("subject_kind" IN ('post', 'media', 'message')),
  CONSTRAINT "post_likes_state_check" CHECK ("state" IN ('active', 'undone')),
  CONSTRAINT "post_likes_discovered_via_check"
    CHECK ("discovered_via" IN ('notification', 'ofapi_webhook')),
  CONSTRAINT "post_likes_refs_check" CHECK (
    length("subject_ref") > 0
    AND length("liker_platform_user_id") > 0
    AND ("notification_ref" IS NULL OR length("notification_ref") > 0)
  ),
  CONSTRAINT "post_likes_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "post_likes_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "post_likes_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "post_likes_page_subject_occurred_idx"
  ON "post_likes" ("page_id", "subject_kind", "subject_ref", "occurred_at" DESC);
CREATE INDEX "post_likes_page_liker_idx"
  ON "post_likes" ("page_id", "liker_platform_user_id");

-- ─────────────────────────────────────────────────────────────────────────────
-- subject_refresh_state — CAPTURE-PLANE OPERATIONAL STATE (§3.4).
--
-- ONE narrow side table subordinate to the existing stream lease, shared by
-- every per-subject refresh lane: WP-F4's per-media statistics
-- (`plane='media_stats'`), WP-F5's reply walk (`plane='post_replies'`,
-- `known_count` = the known reply count), WP-F6's engagement refresh and the
-- later OF post-stats decay. It is NOT the rejected three-table control plane:
-- no reservations, no settlement, no second scheduler.
--
-- Why it is not four queue columns on `creator_media` (which v1 proposed):
-- `creator_media` is a rebuildable fact projection, and `projection:rebuild`
-- truncates it. Queue columns riding along would be wiped by an ordinary
-- repair, resetting every cycle and re-triggering first-sight backfills for the
-- whole catalogue. F5 had already kept its walk state out of `creator_posts`
-- for exactly this reason; this table is that instinct, generalized once.
--
-- WP-F2 writes exactly one kind of row into it: a purchase notification marks
-- the bought media DIRTY (`plane='media_stats'`, `refresh_class='dirty'`,
-- `dirty_reason='purchase_notification'`, `next_due_at = now`). Nothing in F2
-- fetches on it — F4 is the consumer.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "subject_refresh_state" (
  "page_id"               bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  -- Which refresh lane owns this row.
  "plane"                 text NOT NULL,
  -- The subject: a media offer id, a post id, …
  "subject_ref"           text NOT NULL,
  "refresh_class"         text,
  "next_due_at"           timestamp with time zone,
  "last_visited_at"       timestamp with time zone,
  "consecutive_failures"  integer NOT NULL DEFAULT 0,
  "dirty_reason"          text,
  -- e.g. known_reply_count for the post_replies plane.
  "known_count"           integer,
  "backfill_cursor"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "subject_refresh_state_pkey" PRIMARY KEY ("page_id", "plane", "subject_ref"),
  CONSTRAINT "subject_refresh_state_plane_check"
    CHECK ("plane" IN ('media_stats', 'post_replies', 'post_engagement', 'of_post_stats')),
  CONSTRAINT "subject_refresh_state_refresh_class_check" CHECK (
    "refresh_class" IS NULL
    OR "refresh_class" IN ('fresh', 'mid', 'long_tail', 'dirty')
  ),
  CONSTRAINT "subject_refresh_state_subject_ref_check" CHECK (length("subject_ref") > 0),
  CONSTRAINT "subject_refresh_state_failures_check" CHECK ("consecutive_failures" >= 0),
  CONSTRAINT "subject_refresh_state_known_count_check"
    CHECK ("known_count" IS NULL OR "known_count" >= 0)
);

-- The scheduler read: "what is due on this plane for this page". Partial, so
-- the rows with nothing scheduled cost the index nothing.
CREATE INDEX "subject_refresh_state_due_idx"
  ON "subject_refresh_state" ("page_id", "plane", "next_due_at")
  WHERE "next_due_at" IS NOT NULL;
