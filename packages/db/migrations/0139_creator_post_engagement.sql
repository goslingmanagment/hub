-- WP-F6 — widening the EXISTING `posts` stream: engagement counters, thread
-- refs, wall/mention refs, derived hashtags and the attachment id-relations.
--
-- NO NEW TABLE AND NO NEW STREAM. Every column here is a field the timeline
-- (`/timelinenew`) and the batch post read (`GET /post?ids=`) have been serving
-- all along and this system was throwing away: the 2026-08-19 capture shows
-- `likeCount`, `mediaLikeCount`, `replyCount`, `fypFlags`, `expiresAt`,
-- `inReplyTo`, `inReplyToRoot`, `wallIds`, `accountMentions` and `attachments`
-- on the same post objects the `posts` lane already journals verbatim. The
-- widening is a canonicalizer version bump (5 → 6) plus these columns; the
-- historical journal is re-parsed into them by `events:replay --kind posts`.
--
-- ABSENT IS NULL, NEVER 0, and the payload makes that distinction real rather
-- than theoretical: `replyCount` was ABSENT on 6 of the 15 timeline posts in
-- the capture and PRESENT on the other 9, and `wallIds` does not appear on the
-- timeline route at all while `GET /post?ids=` serves it as `[]`. A NOT NULL
-- DEFAULT 0 here would record "nobody replied" for a post whose reply count the
-- provider simply did not state — and no re-read distinguishes the two
-- afterwards.
--
-- NO CONFLICT WITH 0120/0121 (verified against both files): 0120 created the
-- table with text/publication/lineage columns, 0121 added the nine
-- `tip_*`/`*_mills` monetization columns. None of the fourteen names below
-- appears in either.
--
-- NO FAN-REF-SHAPED COLUMN IS ADDED. `account_mention_refs` holds the account
-- ids a CAPTION mentions — on a creator's own post those are creators and the
-- page itself (the one live example mentions the page's own account id). It is
-- not a buyer, liker, sender or author ref, so the §9.3 erasure column-shape
-- ratchet does not reach it and none of its patterns match the name.
--
-- HASHTAGS ARE DERIVED, and stored as three paired columns so the derivation
-- can be re-done honestly: the raw token exactly as the caption wrote it, the
-- NFKC-lowercased form the joins use, and the parser version that produced
-- both. A22-2's lesson in a different key: store what was served plus the
-- version of the code that read it, so a re-derivation is a version bump and a
-- rebuild rather than an archaeology project.

ALTER TABLE "creator_posts"
  -- Engagement counters, as served. `like_count` is the post's own like count;
  -- `media_like_count` counts likes on its attached media and is a DIFFERENT
  -- number (30 vs 159 on the one post read through `GET /post?ids=`).
  ADD COLUMN "like_count"             bigint,
  ADD COLUMN "media_like_count"       bigint,
  ADD COLUMN "reply_count"            bigint,
  -- The raw FYP bitfield. Stored as the integer the platform served; no label
  -- table exists for it and inventing one would be A22-2's mistake again.
  ADD COLUMN "fyp_flags"              integer,
  ADD COLUMN "expires_at"             timestamp with time zone,
  -- Thread position. Stored SEPARATELY even though both were null on every
  -- observed creator post: the day a reply-post arrives, the difference between
  -- the immediate parent and the thread root is what reconstructs the thread,
  -- and no later re-read recovers it.
  ADD COLUMN "in_reply_to_ref"        text,
  ADD COLUMN "in_reply_to_root_ref"   text,
  -- Wall placement and caption mentions. NULL = the response did not carry the
  -- field; '{}' = it carried it and it was empty.
  ADD COLUMN "wall_refs"              text[],
  ADD COLUMN "account_mention_refs"   text[],
  -- DERIVED from `text_plain` only (A8: hashtags arrive as caption text; there
  -- is no structured tag field on any of the 60 post objects in the capture).
  ADD COLUMN "hashtags"               text[],
  ADD COLUMN "hashtags_normalized"    text[],
  ADD COLUMN "hashtag_parser_version" integer,
  -- The attachments' id-relations ONLY: `{pos, contentType, contentId}`. No
  -- URL, no CDN path, no variant — those live in the raw journal and are read
  -- by nothing.
  ADD COLUMN "attachment_refs"        jsonb,
  -- When the counters above were last OBSERVED. Set by the projector from the
  -- event's own `observedAt` whenever the event carried at least one counter,
  -- so it is reproduced by a rebuild rather than stamped by the capture lane.
  ADD COLUMN "engagement_observed_at" timestamp with time zone,

  ADD CONSTRAINT "creator_posts_engagement_counts_check" CHECK (
    ("like_count" IS NULL OR "like_count" >= 0)
    AND ("media_like_count" IS NULL OR "media_like_count" >= 0)
    AND ("reply_count" IS NULL OR "reply_count" >= 0)
    AND ("fyp_flags" IS NULL OR "fyp_flags" >= 0)
  ),
  ADD CONSTRAINT "creator_posts_thread_refs_check" CHECK (
    ("in_reply_to_ref" IS NULL OR length("in_reply_to_ref") > 0)
    AND ("in_reply_to_root_ref" IS NULL OR length("in_reply_to_root_ref") > 0)
  ),
  -- A NULL element in a ref array is neither a ref nor an absence; it is a
  -- parse that half-worked. Refuse it at the boundary.
  ADD CONSTRAINT "creator_posts_ref_arrays_check" CHECK (
    ("wall_refs" IS NULL OR array_position("wall_refs", NULL) IS NULL)
    AND ("account_mention_refs" IS NULL OR array_position("account_mention_refs", NULL) IS NULL)
    AND ("hashtags" IS NULL OR array_position("hashtags", NULL) IS NULL)
    AND ("hashtags_normalized" IS NULL OR array_position("hashtags_normalized", NULL) IS NULL)
  ),
  -- The three hashtag columns are ONE fact in three parts. A raw token with no
  -- normalized form cannot be joined; a normalized form with no parser version
  -- cannot be re-derived; and unequal cardinalities mean the pairing is lost.
  ADD CONSTRAINT "creator_posts_hashtag_pairing_check" CHECK (
    ("hashtags" IS NULL) = ("hashtags_normalized" IS NULL)
    AND ("hashtags" IS NULL) = ("hashtag_parser_version" IS NULL)
    AND (
      "hashtags" IS NULL
      OR cardinality("hashtags") = cardinality("hashtags_normalized")
    )
  );

-- Which posts have had their engagement observed, and when. The refresh lane
-- reads its work queue from `subject_refresh_state`, so this index serves the
-- operator/coverage question ("how stale are the counters on this page") rather
-- than the lane's own selection.
CREATE INDEX "creator_posts_engagement_observed_idx"
  ON "creator_posts" ("engagement_observed_at");
