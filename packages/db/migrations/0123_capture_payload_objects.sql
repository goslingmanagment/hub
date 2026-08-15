-- 0123: G5 slice 0 — the content-addressed capture payload foundation.
--
-- ADDITIVE ONLY. Nothing writes these tables yet and nothing reads them: this
-- migration lands the object model so the later slices (dual-write, then
-- pointer-only writes) are pure application changes. Every existing capture
-- path keeps writing its inline body (observations.payload,
-- sync_raw_payloads.response_payload) and those columns remain the authority.
--
-- THE MODEL (canonical spec: investigations/storage-compaction-architecture-
-- 2026-08-11.md §6/§7, with the adversarial-verification corrections applied
-- here).
--
--   capture_payload_objects   identity catalog — WHO the body belongs to and
--                             WHAT it hashes to. Stays hot and small even after
--                             a body moves to a cold tier, so an envelope's
--                             composite reference never breaks on a cold move.
--   capture_json_hot_bodies   the body when it is semantic JSON (queryable
--                             jsonb, one copy — canonical octets are NOT stored
--                             alongside; that would be a second body copy).
--   capture_byte_hot_bodies   the body when it is exact wire octets (webhook
--                             raw bodies) — never JSON-reserialized.
--   capture_payload_locations where the body physically is (hot today; the cold
--                             tier fills segment_id/row_locator in S6).
--
-- IDENTITY, and why every column of it is load-bearing:
--   (bucket_month, platform_account_id, access_class, erasure_domain,
--    representation, codec_version, content_sha256, logical_bytes,
--    collision_ordinal)
-- ACL and erasure identity are explicit typed columns, never an opaque
-- scope_key: without them it is impossible to PROVE why two payloads may share
-- a body row. Restricted AI material (access_class='restricted_ai') therefore
-- structurally cannot coalesce with ordinary capture even when the bytes are
-- identical.
--
-- platform_account_id is NULLABLE and the uniqueness is NULLS NOT DISTINCT.
-- This is a correction to the spec's `not null`: observations.account_id is
-- genuinely null on live paths (ingest before the account is mapped, auth
-- audit capture). With ordinary SQL null semantics every unmapped capture
-- would be its own object and the dedup would silently do nothing for exactly
-- the rows that need it most.
--
-- MONTH SCOPE IS A LAW, not an optimization. A closed capture month is a
-- ref-closed cohort: envelopes plus every body they point at. A new month
-- creates a NEW object even for a digest already known in the previous month.
-- The cost is a slightly worse compression ratio; the payoff is that every
-- cold segment is self-contained and no eternal cross-month reference exists.
--
-- HASH IS NOT PROOF OF EQUALITY. content_sha256 narrows the candidate set; the
-- writer must then canonicalize the stored body and compare the FULL content.
-- A differing body under the same digest takes the next collision_ordinal —
-- durably, with its own body row — and the capture is never rolled back and
-- never coalesced. logical_bytes sits inside the unique tuple as a second
-- cheap discriminator, so the ordinal is allocated per
-- (scope, digest, logical_bytes) group.
--
-- DELIBERATELY ABSENT in this slice (each is a later, separately-gated step):
--   * no reference columns on observations / sync_raw_payloads /
--     ofapi_webhook_events — §6.3 adds those nullable composites in the
--     dual-write slice, when there is something to point at;
--   * no writers and no readers — the repository (capture-payloads.ts) and the
--     read seam (payload-reader.ts) ship in this change, but no production call
--     site uses them;
--   * no backfill of historical bodies;
--   * no deleter of any kind — the retention pin (tests/retention-deleters.
--     test.ts) is untouched on purpose;
--   * no refcount / reverse index for erasure. Erasure over a SHARED body
--     (a body may die only when the last surviving envelope reference is gone,
--     and the erasure scan has to substring-match whole bodies) is explicitly
--     out of scope here. The shape above stays compatible with it: the catalog
--     is per (scope, month, content), so per-envelope reference counting is a
--     later additive table keyed on (bucket_month, object_id) — nothing in this
--     migration forecloses it.
--
-- INDEXES ARE MINIMAL BY DESIGN: the PK and the identity UNIQUE, nothing else.
-- The write protocol probes by the identity prefix, which the unique index
-- already serves; a speculative secondary index on an empty table is bloat we
-- would then have to justify removing.
--
-- PARTITIONING follows the observations precedent (0054) and its future
-- catch-all backstop (0082): monthly ranges by bucket_month, and a
-- `*_future` partition FROM '2031-01-01' so a far-future bucket degrades to a
-- hot catch-all row instead of failing ExecFindPartition forever. Months
-- between the pre-created tail and 2031 are deliberately NOT covered: a write
-- into an uncreated month must fail loudly (23514), never land somewhere else.
-- The `*_future` name is outside the tiering detachment regex
-- (apps/runtime/src/services/tiering/index.ts PARTITION_NAME), and that job is
-- in any case scoped to ('observations','domain_events') — it structurally
-- cannot touch these tables.
--
-- No down-path: these tables will hold captured facts. Dropping a fact store is
-- an owner-gated erasure, not a rollback.

CREATE TABLE "capture_payload_objects" (
  "bucket_month"        date NOT NULL,
  "object_id"           bigint GENERATED ALWAYS AS IDENTITY,
  -- Nullable: unmapped/accountless capture is real (ingest, auth audit).
  "platform_account_id" bigint,
  -- Who may read the body. Enumerated here and mirrored by the repository's
  -- capture-time classifier:
  --   ordinary_capture  platform capture material (webhook bodies, pull
  --                     responses, command results) — the ordinary
  --                     envelope-authorized read path.
  --   restricted_ai     Stage 29 restricted class: verbatim prompts and
  --                     completions, owner-only routes. A separate class so it
  --                     can NEVER share a body row with ordinary capture.
  --   operator_audit    auth/authorization audit capture: principal-bearing,
  --                     no platform account.
  "access_class"        text NOT NULL,
  -- Which erasure sweep is allowed to rewrite the body later:
  --   platform_account  bound to one page/account (a null platform_account_id
  --                     here means "account-scoped but not yet mappable at
  --                     capture time" — the ingest case, same reasoning as
  --                     observations.account_id having no FK).
  --   fan_subject       fan-subject material; a subject erasure reaches it.
  --   system            no subject; no subject erasure may rewrite it.
  "erasure_domain"      text NOT NULL,
  --   canonical_json    semantic JSON, body in capture_json_hot_bodies.
  --   exact_bytes       exact wire octets, body in capture_byte_hot_bodies.
  "representation"      text NOT NULL,
  -- Frozen application codec version (packages/db/src/capture-payload-codec.ts).
  -- 0 = identity (exact_bytes: the wire octets ARE the content).
  "codec_version"       smallint NOT NULL,
  "content_sha256"      bytea NOT NULL,
  "collision_ordinal"   integer NOT NULL DEFAULT 0,
  "logical_bytes"       bigint NOT NULL,
  "content_type"        text,
  "first_seen_at"       timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("bucket_month", "object_id"),
  CONSTRAINT "capture_payload_objects_identity_uniq" UNIQUE NULLS NOT DISTINCT (
    "bucket_month", "platform_account_id", "access_class", "erasure_domain",
    "representation", "codec_version", "content_sha256", "logical_bytes",
    "collision_ordinal"
  ),
  CONSTRAINT "capture_payload_objects_bucket_month_check"
    CHECK (EXTRACT(DAY FROM "bucket_month") = 1),
  CONSTRAINT "capture_payload_objects_access_class_check"
    CHECK ("access_class" IN ('ordinary_capture', 'restricted_ai', 'operator_audit')),
  CONSTRAINT "capture_payload_objects_erasure_domain_check"
    CHECK ("erasure_domain" IN ('platform_account', 'fan_subject', 'system')),
  CONSTRAINT "capture_payload_objects_representation_check"
    CHECK ("representation" IN ('canonical_json', 'exact_bytes')),
  CONSTRAINT "capture_payload_objects_content_sha256_check"
    CHECK (octet_length("content_sha256") = 32),
  CONSTRAINT "capture_payload_objects_collision_ordinal_check"
    CHECK ("collision_ordinal" >= 0),
  CONSTRAINT "capture_payload_objects_logical_bytes_check"
    CHECK ("logical_bytes" >= 0),
  CONSTRAINT "capture_payload_objects_codec_version_check"
    CHECK ("codec_version" >= 0)
) PARTITION BY RANGE ("bucket_month");

CREATE TABLE "capture_payload_objects_2026_08" PARTITION OF "capture_payload_objects" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "capture_payload_objects_2026_09" PARTITION OF "capture_payload_objects" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "capture_payload_objects_2026_10" PARTITION OF "capture_payload_objects" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "capture_payload_objects_2026_11" PARTITION OF "capture_payload_objects" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "capture_payload_objects_2026_12" PARTITION OF "capture_payload_objects" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "capture_payload_objects_2027_01" PARTITION OF "capture_payload_objects" FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "capture_payload_objects_2027_02" PARTITION OF "capture_payload_objects" FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "capture_payload_objects_future" PARTITION OF "capture_payload_objects" FOR VALUES FROM ('2031-01-01') TO (MAXVALUE);

-- Bodies. ON DELETE RESTRICT on both: a catalog row can never take its body
-- with it by accident — unlinking a body is the erasure module's governed act,
-- and it does not exist for these tables yet.
CREATE TABLE "capture_json_hot_bodies" (
  "bucket_month" date NOT NULL,
  "object_id"    bigint NOT NULL,
  "body"         jsonb NOT NULL,
  PRIMARY KEY ("bucket_month", "object_id"),
  CONSTRAINT "capture_json_hot_bodies_object_fkey"
    FOREIGN KEY ("bucket_month", "object_id")
    REFERENCES "capture_payload_objects" ("bucket_month", "object_id")
    ON DELETE RESTRICT
) PARTITION BY RANGE ("bucket_month");

CREATE TABLE "capture_json_hot_bodies_2026_08" PARTITION OF "capture_json_hot_bodies" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "capture_json_hot_bodies_2026_09" PARTITION OF "capture_json_hot_bodies" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "capture_json_hot_bodies_2026_10" PARTITION OF "capture_json_hot_bodies" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "capture_json_hot_bodies_2026_11" PARTITION OF "capture_json_hot_bodies" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "capture_json_hot_bodies_2026_12" PARTITION OF "capture_json_hot_bodies" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "capture_json_hot_bodies_2027_01" PARTITION OF "capture_json_hot_bodies" FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "capture_json_hot_bodies_2027_02" PARTITION OF "capture_json_hot_bodies" FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "capture_json_hot_bodies_future" PARTITION OF "capture_json_hot_bodies" FOR VALUES FROM ('2031-01-01') TO (MAXVALUE);

CREATE TABLE "capture_byte_hot_bodies" (
  "bucket_month" date NOT NULL,
  "object_id"    bigint NOT NULL,
  "body"         bytea NOT NULL,
  PRIMARY KEY ("bucket_month", "object_id"),
  CONSTRAINT "capture_byte_hot_bodies_object_fkey"
    FOREIGN KEY ("bucket_month", "object_id")
    REFERENCES "capture_payload_objects" ("bucket_month", "object_id")
    ON DELETE RESTRICT
) PARTITION BY RANGE ("bucket_month");

CREATE TABLE "capture_byte_hot_bodies_2026_08" PARTITION OF "capture_byte_hot_bodies" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "capture_byte_hot_bodies_2026_09" PARTITION OF "capture_byte_hot_bodies" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "capture_byte_hot_bodies_2026_10" PARTITION OF "capture_byte_hot_bodies" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "capture_byte_hot_bodies_2026_11" PARTITION OF "capture_byte_hot_bodies" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "capture_byte_hot_bodies_2026_12" PARTITION OF "capture_byte_hot_bodies" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "capture_byte_hot_bodies_2027_01" PARTITION OF "capture_byte_hot_bodies" FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "capture_byte_hot_bodies_2027_02" PARTITION OF "capture_byte_hot_bodies" FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "capture_byte_hot_bodies_future" PARTITION OF "capture_byte_hot_bodies" FOR VALUES FROM ('2031-01-01') TO (MAXVALUE);

-- Physical placement, one row per object. storage_tier='hot' means the body is
-- in the matching *_hot_bodies table; 'cold' means it lives in an S6 cold
-- segment and the locator pair says which row of which segment.
--
-- The locator CHECK is two-directional on purpose. A 'cold' row with null
-- locators would be a body the system believes it has moved and cannot find —
-- silent data loss wearing the shape of a valid row — and a 'hot' row carrying
-- locators would be two contradictory answers to "where is this body". Both
-- are rejected; the columns stay nullable because 'hot' REQUIRES them null.
CREATE TABLE "capture_payload_locations" (
  "bucket_month" date NOT NULL,
  "object_id"    bigint NOT NULL,
  "storage_tier" text NOT NULL,
  "segment_id"   bigint,
  "row_locator"  bigint,
  PRIMARY KEY ("bucket_month", "object_id"),
  CONSTRAINT "capture_payload_locations_storage_tier_check"
    CHECK ("storage_tier" IN ('hot', 'cold')),
  CONSTRAINT "capture_payload_locations_locator_check"
    CHECK (
      ("storage_tier" = 'hot'
        AND "segment_id" IS NULL AND "row_locator" IS NULL)
      OR ("storage_tier" = 'cold'
        AND "segment_id" IS NOT NULL AND "row_locator" IS NOT NULL)
    ),
  CONSTRAINT "capture_payload_locations_object_fkey"
    FOREIGN KEY ("bucket_month", "object_id")
    REFERENCES "capture_payload_objects" ("bucket_month", "object_id")
    ON DELETE RESTRICT
) PARTITION BY RANGE ("bucket_month");

CREATE TABLE "capture_payload_locations_2026_08" PARTITION OF "capture_payload_locations" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "capture_payload_locations_2026_09" PARTITION OF "capture_payload_locations" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "capture_payload_locations_2026_10" PARTITION OF "capture_payload_locations" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "capture_payload_locations_2026_11" PARTITION OF "capture_payload_locations" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "capture_payload_locations_2026_12" PARTITION OF "capture_payload_locations" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "capture_payload_locations_2027_01" PARTITION OF "capture_payload_locations" FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "capture_payload_locations_2027_02" PARTITION OF "capture_payload_locations" FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "capture_payload_locations_future" PARTITION OF "capture_payload_locations" FOR VALUES FROM ('2031-01-01') TO (MAXVALUE);
