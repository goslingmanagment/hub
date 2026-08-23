-- WP-F5 — `post_comments`: the comment archive, with full bodies.
--
-- PLATFORM-NEUTRAL BY CONSTRUCTION. Fansly's replies walk writes it today
-- (`discovered_via = 'replies_walk'`); a comment-signal notification and the
-- OnlyFans comment list are the other two declared origins, and they write the
-- SAME table. That is why `platform` is a column rather than a table prefix,
-- and why `discovered_via` is a CHECKed vocabulary rather than a free string:
-- "where did this row come from" is the question a partial archive has to be
-- able to answer, and it must not be guessable from the row's shape.
--
-- IDENTITY IS `(page_id, comment_ref)`, on a surrogate id. The surrogate is
-- what lets an erasure predicate and a lineage row point at one comment
-- cheaply; the UNIQUE is what makes the upsert idempotent under replay.
--
-- `text_plain NOT NULL DEFAULT ''` — EMPTY-CONTENT REPLIES ARE STORED, not
-- skipped. One of the four replies in the 18 KB capture has `content: ""`, and
-- a fan who replied with only an attachment (or with nothing) still replied:
-- dropping the row would make the reply count disagree with the archive and
-- there would be no way to tell which of the two was wrong.
--
-- MONEY IS MILLS (Stage 27). `totalTipAmount` and `attachmentTipAmount` are
-- already mills on the wire and travel through the shared constructors; the
-- two are kept apart because a tip attached to the comment's media and a tip on
-- the comment itself have different bases and §2.3 forbids summing them.
--
-- `missing_since` IS HOW A DELETED COMMENT IS RECORDED (DP 7). A later walk
-- that returns an empty `posts[]` for a post that HAD comments marks the prior
-- rows missing at that instant; nothing here is ever deleted on a schedule, and
-- the only sanctioned deleters are the erasure module and the projection
-- rebuild (both enumerated in tests/retention-deleters.test.ts).
--
-- `possibly_truncated` IS TRUTHFULNESS ABOUT PAGINATION. `/post/{id}/replies`
-- has NO established pagination: no observed response carried more than four
-- replies, and no cursor form has ever been proven. Until one is, a page that
-- comes back suspiciously full marks its rows `possibly_truncated = true` and
-- the lane's coverage says `window_captured`, never complete. A column is the
-- honest place for that, because the doubt belongs to the ROW and survives the
-- sweep that created it.

CREATE TABLE "post_comments" (
  "id"                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "page_id"                 bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"                text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "comment_ref"             text NOT NULL,
  -- `inReplyTo` — the post (or comment) this reply hangs off.
  "parent_post_ref"         text NOT NULL,
  -- `inReplyToRoot` — the top of the thread. Equal to `parent_post_ref` in every
  -- observed reply so far; journaled and stored SEPARATELY anyway, because the
  -- day a nested reply arrives is the day the difference reconstructs a thread
  -- and no re-walk can recover it retroactively.
  "root_post_ref"           text,
  -- The comment's author. A TEXT platform ref with NO FK to `fans`, so only the
  -- explicit erasure predicate reaches it (declared in FAN_REF_ERASURE_COLUMNS).
  "author_ref"              text NOT NULL,
  -- Display fields carried by the `accounts[]` sidecar when it was populated —
  -- it was EMPTY in 2 of 5 captured responses, which is why the hydration
  -- fallback exists and why these are nullable.
  "author_username"         text,
  "author_display_name"     text,
  -- Empty-content replies are STORED. See the note above.
  "text_plain"              text NOT NULL DEFAULT '',
  "like_count"              integer,
  "media_like_count"        integer,
  -- MILLS. Two bases, never summed.
  "tip_total_mills"         bigint,
  "attachment_tip_mills"    bigint,
  "attachment_count"        integer,
  "pinned"                  boolean,
  -- The provider's own instant (SECONDS on the wire for this route).
  "occurred_at"             timestamp with time zone NOT NULL,
  -- When the stored content last CHANGED — an edited comment moves this, a
  -- re-observation of the same bytes does not.
  "changed_at"              timestamp with time zone NOT NULL,
  "discovered_via"          text NOT NULL,
  "possibly_truncated"      boolean NOT NULL DEFAULT false,
  -- Set when a later FULL walk of the parent stops naming this comment. NEVER a
  -- delete (DP 7).
  "missing_since"           timestamp with time zone,
  "first_observed_at"       timestamp with time zone NOT NULL,
  "last_observed_at"        timestamp with time zone NOT NULL,
  "content_hash"            char(64) NOT NULL,
  "source_event_id"         bigint NOT NULL,
  "source_observation_id"   bigint NOT NULL,
  "source_account_seq"      bigint NOT NULL,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"              timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "post_comments_page_comment_uniq" UNIQUE ("page_id", "comment_ref"),
  CONSTRAINT "post_comments_refs_check" CHECK (
    length("comment_ref") > 0
    AND length("parent_post_ref") > 0
    AND length("author_ref") > 0
    AND ("root_post_ref" IS NULL OR length("root_post_ref") > 0)
  ),
  CONSTRAINT "post_comments_discovered_via_check"
    CHECK ("discovered_via" IN ('replies_walk', 'notification', 'ofapi_list')),
  CONSTRAINT "post_comments_counts_check" CHECK (
    ("like_count" IS NULL OR "like_count" >= 0)
    AND ("media_like_count" IS NULL OR "media_like_count" >= 0)
    AND ("attachment_count" IS NULL OR "attachment_count" >= 0)
  ),
  CONSTRAINT "post_comments_mills_check" CHECK (
    ("tip_total_mills" IS NULL OR "tip_total_mills" >= 0)
    AND ("attachment_tip_mills" IS NULL OR "attachment_tip_mills" >= 0)
  ),
  CONSTRAINT "post_comments_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "post_comments_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "post_comments_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

-- "the comments under this post, newest first" — the read every serving surface
-- makes, and the one the `missing_since` reconcile walks.
CREATE INDEX "post_comments_page_parent_occurred_idx"
  ON "post_comments" ("page_id", "parent_post_ref", "occurred_at" DESC);
-- Erasure walks the author ref; so does "everything this fan ever said".
CREATE INDEX "post_comments_page_author_idx"
  ON "post_comments" ("page_id", "author_ref");
