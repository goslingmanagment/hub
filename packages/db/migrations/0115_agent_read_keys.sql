-- Agent Read Plane, slice 0a: the tables the plane needs before a single route
-- exists. Nothing here changes an existing response: no route reads these tables
-- yet, and every companion config flag ships off/false.
--
-- Four objects:
--   agent_keys             — the machine principal (NOT a row in api_keys: the
--                            admin key routes must never issue or list one).
--   agent_key_usage_daily  — the per-key/per-UTC-day budget counter. Every write
--                            is ONE statement (insert .. on conflict do update
--                            .. returning): the first request of a day has no
--                            row yet, so a bare UPDATE .. RETURNING could not
--                            budget it, and two concurrent requests must sum.
--   agent_read_audit       — append-only record of what the plane served. Its
--                            request_summary carries NO free-form user text
--                            (docs/error-handling.md sink allowlist): a search
--                            string enters as {qSha256, qLength}, never verbatim.
--   archive_generation     — singleton counter bumped by the message_archive
--                            rebuild swap. A cursor minted before a swap must be
--                            refused after it, otherwise a resumed read silently
--                            skips rows and reports "I read everything".

CREATE TABLE "agent_keys" (
  "id"                   bigserial PRIMARY KEY,
  -- Owner-facing label; unique so a revoked key's name cannot be reused by
  -- accident and confuse the audit trail.
  "name"                 text NOT NULL UNIQUE,
  "key_prefix"           text NOT NULL,
  "key_digest"           text NOT NULL UNIQUE,
  -- Closed capability matrix. Unknown values are rejected at issuance (the
  -- code path) AND here (defense in depth); a test pins this list against
  -- AGENT_CAPABILITIES in packages/contracts so the two cannot drift.
  "capabilities"         text[] NOT NULL DEFAULT '{}',
  -- Explicit page grant. There is no wildcard: a page created after issuance is
  -- NOT granted, which is the whole point of a separate principal.
  "page_ids"             bigint[] NOT NULL DEFAULT '{}',
  "daily_request_budget" integer NOT NULL DEFAULT 5000,
  "daily_row_budget"     integer NOT NULL DEFAULT 500000,
  -- Mandatory expiry (device-token precedent): sliding 90 days on use, hard cap
  -- 365 days from created_at. The cap is a CHECK, not merely repository logic:
  -- a key that outlives its ceiling is exactly the failure a mandatory expiry
  -- exists to prevent, so NO path — issuance, sliding, or a hand-run UPDATE —
  -- may produce one.
  "expires_at"           timestamptz NOT NULL,
  "created_by"           bigint REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "revoked_at"           timestamptz,
  "last_used_at"         timestamptz,
  CONSTRAINT "agent_keys_capabilities_check" CHECK (
    "capabilities" <@ ARRAY[
      'read:messages',
      'read:money',
      'read:observations_envelope',
      'read:datasets',
      'request:hydration'
    ]::text[]
  ),
  CONSTRAINT "agent_keys_expires_at_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "agent_keys_max_lifetime_check" CHECK (
    "expires_at" <= "created_at" + interval '365 days'
  ),
  CONSTRAINT "agent_keys_daily_request_budget_check" CHECK ("daily_request_budget" >= 0),
  CONSTRAINT "agent_keys_daily_row_budget_check" CHECK ("daily_row_budget" >= 0)
);

CREATE INDEX "agent_keys_expiry_idx" ON "agent_keys" ("expires_at");

CREATE TABLE "agent_key_usage_daily" (
  "agent_key_id"  bigint NOT NULL REFERENCES "agent_keys"("id") ON DELETE RESTRICT,
  -- UTC business date, matching the house `businessDate` convention.
  "business_date" date NOT NULL,
  "requests"      integer NOT NULL DEFAULT 0,
  "rows_returned" bigint NOT NULL DEFAULT 0,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("agent_key_id", "business_date"),
  CONSTRAINT "agent_key_usage_daily_requests_check" CHECK ("requests" >= 0),
  CONSTRAINT "agent_key_usage_daily_rows_returned_check" CHECK ("rows_returned" >= 0)
);

CREATE TABLE "agent_read_audit" (
  "id"              bigserial PRIMARY KEY,
  -- Exactly one of the two principals is present: agent-key operations have no
  -- human, owner-session operations (#9b, #13) have no key.
  "agent_key_id"    bigint REFERENCES "agent_keys"("id") ON DELETE RESTRICT,
  "session_user_id" bigint REFERENCES "users"("id") ON DELETE RESTRICT,
  "operation"       text NOT NULL,
  "page_ids"        bigint[] NOT NULL DEFAULT '{}',
  -- True when the response carried verbatim fan/model text (transcript reads,
  -- search snippets, observation payloads). Acceptance of the read plane rests
  -- on this row existing.
  "verbatim_text"   boolean NOT NULL DEFAULT false,
  -- Bounded structured facts only. NEVER a search string, a hydration reason,
  -- or any other caller text.
  "request_summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at"     timestamptz NOT NULL DEFAULT now(),
  -- EXACTLY ONE principal. "At least one" would admit a row claiming both a
  -- machine and a human authored the same read, which is never true and would
  -- make the #9b per-session count over-report while attributing an agent read
  -- to a person.
  CONSTRAINT "agent_read_audit_principal_check" CHECK (
    num_nonnulls("agent_key_id", "session_user_id") = 1
  )
);

-- The owner-session daily cap on observation payload reads (#9b) counts rows
-- through exactly this index.
CREATE INDEX "agent_read_audit_session_operation_idx"
  ON "agent_read_audit" ("session_user_id", "operation", "occurred_at");

CREATE TABLE "archive_generation" (
  "id"         integer PRIMARY KEY,
  "generation" bigint NOT NULL DEFAULT 0,
  "bumped_at"  timestamptz NOT NULL DEFAULT now(),
  "reason"     text,
  CONSTRAINT "archive_generation_singleton_check" CHECK ("id" = 1)
);

INSERT INTO "archive_generation" ("id", "generation", "reason")
VALUES (1, 0, 'initial')
ON CONFLICT ("id") DO NOTHING;
