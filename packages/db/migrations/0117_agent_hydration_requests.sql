-- Agent Read Plane, slice C: hydration requests and their execution record.
--
-- An agent cannot make this system talk to a platform. It can only WRITE DOWN
-- an intent; the owner decides; and only then does the executor hand the work
-- to machinery that already exists (the Fansly targeted thread backfill of
-- slice C', or an ofapi_capture_jobs row). Two tables encode exactly that:
--
--   agent_hydration_requests — one row per intent, carrying its own state
--                              machine, the CAS row_version, the owner's
--                              decision with explicit caps, and the reference
--                              to whatever executed it.
--   agent_hydration_events   — append-only journal of every transition. The
--                              request row is the CURRENT state; this table is
--                              the history, and nothing ever updates or deletes
--                              a row here.
--
-- BUSINESS FACTS, NOT CACHE. Both tables are captured decisions about spending
-- (vendor budget, egress quota, ban risk) and about consent (#158 mark-read).
-- Nothing deletes from them on a schedule; retention is the house 100 years.
--
-- NO FREE-FORM CALLER TEXT. The agent's `reason` and the owner's decision
-- `reason` are stored as {sha256, length} exactly like the audit table's
-- request_summary (docs/error-handling.md sink allowlist): enough to prove two
-- requests were the same and to bound their size, never enough to reconstruct
-- what somebody typed.

CREATE TABLE "agent_hydration_requests" (
  "id"                        bigserial PRIMARY KEY,
  -- The wire identifier. A uuid, never the serial: the serial leaks how many
  -- requests exist and in what order across every key.
  "request_ref"               uuid NOT NULL UNIQUE,
  -- The key that filed it. #12 serves the request only back to THIS key.
  "agent_key_id"              bigint NOT NULL REFERENCES "agent_keys"("id") ON DELETE RESTRICT,
  "page_id"                   bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "conversation_ref"          text NOT NULL,
  -- Resolved at creation time; the executor addresses page_dm_threads by id.
  "thread_id"                 bigint,

  -- The eight wire states of MERGED 17.11. `requested` is the only entry
  -- state; `completed`, `partially_completed`, `rejected`, `expired` and
  -- `failed` are terminal.
  "state"                     text NOT NULL DEFAULT 'requested',

  -- The target is a BOUNDARY, not a window: "everything in this thread older
  -- than X". Exactly one of the two bounds is set (the contract refines it and
  -- the CHECK repeats it).
  "target_kind"               text NOT NULL DEFAULT 'thread_backfill_before',
  "target_before_at"          timestamptz,
  "target_before_message_ref" text,

  -- Caller text, digested. See the header.
  "reason_sha256"             char(64) NOT NULL,
  "reason_length"             integer NOT NULL,
  -- What the AGENT asked for. The owner's cap is separate and always wins.
  "requested_max_calls"       integer,

  -- Idempotent create: the same key + the same idempotency key returns the same
  -- row when the normalized body matches (disposition "coalesced") and 409
  -- idempotency_mismatch when it does not.
  "idempotency_key"           uuid NOT NULL,
  "request_fingerprint"       char(64) NOT NULL,

  -- sha256 of the coverage state shown to the owner. The approval is bound to
  -- the content hash of exactly what was displayed: if the thread's capture
  -- state moved in between, the decision answers 409 hydration_proposal_stale
  -- rather than approving work against a picture that no longer exists.
  "coverage_fingerprint"      char(64) NOT NULL,

  -- Admissibility, evaluated at creation. free_local_replay is evaluated FIRST
  -- (a free lane must never lose to a paid one by accident).
  "lane_order_evaluated"      text[] NOT NULL DEFAULT '{}',
  "lane_selected"             text,
  "lane_cost_note"            text,
  "admissible"                boolean NOT NULL,
  "admissibility_reason"      text,

  -- CAS. Every transition carries the version it expected; a mismatch is a 409
  -- conflict, never a silent overwrite of somebody else's decision.
  "row_version"               integer NOT NULL DEFAULT 0,
  "expires_at"                timestamptz,

  -- The owner's decision.
  "decided_at"                timestamptz,
  "decided_by_user_id"        bigint REFERENCES "users"("id") ON DELETE RESTRICT,
  "decision_approved"         boolean,
  -- #158: the vendor GET .../messages MUTATES read state on the platform, so a
  -- silent hydration would mark a fan's chat read. An approval must state this
  -- explicitly; the value is carried into the execution record and the job.
  "decision_allow_mark_read"  boolean,
  "decision_max_calls"        integer,
  "decision_max_credits"      integer,
  "decision_max_pages"        integer,
  "decision_max_items"        integer,
  "decision_reason_sha256"    char(64),
  "decision_reason_length"    integer,
  "decision_idempotency_key"  uuid,
  "decision_fingerprint"      char(64),

  -- Execution. ONE ATTEMPT PER APPROVAL (outbox discipline): dispatch happens
  -- once, `dispatch_deadline_at` bounds it, and a crashed run ends `failed`.
  -- A re-run requires a FRESH request and a FRESH owner decision.
  "dispatched_at"             timestamptz,
  "dispatch_deadline_at"      timestamptz,
  "execution_lane"            text,
  -- The pg-boss job id (Fansly) or the ofapi_capture_jobs uuid (OnlyFans).
  "execution_ref"             text,
  "dispatch_count"            integer NOT NULL DEFAULT 0,
  "accepted_items"            bigint NOT NULL DEFAULT 0,
  "accepted_pages"            bigint NOT NULL DEFAULT 0,
  "spent_credits"             integer NOT NULL DEFAULT 0,
  "last_error"                text NOT NULL DEFAULT 'none',
  "settled_at"                timestamptz,

  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "agent_hydration_requests_state_check" CHECK ("state" IN (
    'requested', 'approved', 'dispatching', 'partially_completed',
    'completed', 'rejected', 'expired', 'failed'
  )),
  CONSTRAINT "agent_hydration_requests_target_kind_check" CHECK (
    "target_kind" = 'thread_backfill_before'
  ),
  -- Exactly one boundary. Both would be two different questions in one row;
  -- neither would be "backfill the whole thread", which this target cannot say.
  CONSTRAINT "agent_hydration_requests_target_bound_check" CHECK (
    num_nonnulls("target_before_at", "target_before_message_ref") = 1
  ),
  CONSTRAINT "agent_hydration_requests_lane_check" CHECK (
    "lane_selected" IS NULL OR "lane_selected" IN (
      'free_local_replay', 'vendor_paid_low', 'vendor_paid_high'
    )
  ),
  CONSTRAINT "agent_hydration_requests_cost_note_check" CHECK (
    "lane_cost_note" IS NULL OR "lane_cost_note" IN (
      'no_direct_cost', 'egress_quota_and_ban_risk', 'ofapi_credits'
    )
  ),
  CONSTRAINT "agent_hydration_requests_last_error_check" CHECK ("last_error" IN (
    'none', 'vendor_unavailable', 'proxy_missing', 'budget_exhausted',
    'retention_limit', 'quarantined', 'timeout'
  )),
  -- An approval without an expiry is an open-ended licence to spend. The
  -- contract requires one; so does the table.
  CONSTRAINT "agent_hydration_requests_approval_expiry_check" CHECK (
    "decision_approved" IS DISTINCT FROM true
    OR ("expires_at" IS NOT NULL AND "decision_allow_mark_read" IS NOT NULL)
  ),
  CONSTRAINT "agent_hydration_requests_reason_length_check" CHECK (
    "reason_length" >= 0 AND "reason_length" <= 1000
  ),
  CONSTRAINT "agent_hydration_requests_counters_check" CHECK (
    "dispatch_count" >= 0 AND "accepted_items" >= 0
    AND "accepted_pages" >= 0 AND "spent_credits" >= 0
  )
);

-- Idempotent create, per key. Two agents may legitimately use the same uuid;
-- the grant boundary is the key, so the uniqueness is too.
CREATE UNIQUE INDEX "agent_hydration_requests_idempotency_uniq"
  ON "agent_hydration_requests" ("agent_key_id", "idempotency_key");

-- The executor's pick list and the sweeper's stuck scan.
CREATE INDEX "agent_hydration_requests_state_idx"
  ON "agent_hydration_requests" ("state", "created_at");

-- The owner approval queue and the per-thread history.
CREATE INDEX "agent_hydration_requests_page_thread_idx"
  ON "agent_hydration_requests" ("page_id", "conversation_ref", "created_at");

CREATE TABLE "agent_hydration_events" (
  "id"              bigserial PRIMARY KEY,
  "request_id"      bigint NOT NULL REFERENCES "agent_hydration_requests"("id") ON DELETE RESTRICT,
  -- Gapless per request, allocated inside the same transaction as the
  -- transition it records.
  "seq"             integer NOT NULL,
  "kind"            text NOT NULL,
  "from_state"      text,
  "to_state"        text NOT NULL,
  -- The row_version the request carried AFTER this transition.
  "row_version"     integer NOT NULL,
  "actor"           text NOT NULL,
  "agent_key_id"    bigint REFERENCES "agent_keys"("id") ON DELETE RESTRICT,
  "session_user_id" bigint REFERENCES "users"("id") ON DELETE RESTRICT,
  -- Bounded structured facts only, same law as agent_read_audit.request_summary.
  "detail"          jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at"     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "agent_hydration_events_seq_uniq" UNIQUE ("request_id", "seq"),
  CONSTRAINT "agent_hydration_events_actor_check" CHECK ("actor" IN (
    'agent_key', 'owner_session', 'executor', 'sweeper'
  )),
  CONSTRAINT "agent_hydration_events_kind_check" CHECK ("kind" IN (
    'created', 'approved', 'rejected', 'dispatched', 'settled', 'expired', 'failed'
  ))
);

CREATE INDEX "agent_hydration_events_request_idx"
  ON "agent_hydration_events" ("request_id", "seq");
