import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { OFAPI_SPEND_PROJECTION_EVENT_TYPES } from "@agency_hub_core/db";
import { ofapiCaptureJobStates } from "@agency_hub_core/shared";

describe("database migration invariants", () => {
  it("ties sync observability rows to their run page and stream", async () => {
    const migration = await readFile(
      "packages/db/migrations/0012_sync_observability_run_scope.sql",
      "utf8",
    );

    expect(migration).toContain('UNIQUE ("id", "page_id", "stream")');
    expect(migration).toContain('FOREIGN KEY ("sync_run_id", "page_id", "stream")');
    expect(migration).toContain('REFERENCES "public"."sync_runs"("id", "page_id", "stream")');
    expect(migration).toContain('UPDATE "sync_http_attempts" AS a');
    expect(migration).toContain('UPDATE "sync_run_events" AS e');
  });

  it("keeps legacy sync-state repair inside platform-supported streams", async () => {
    const migration = await readFile(
      "packages/db/migrations/0014_repair_light_trusted_sync_states.sql",
      "utf8",
    );

    expect(migration).toContain("st.stream = 'transactions'::sync_stream");
    expect(migration).toContain("st.stream = 'subscribers'::sync_stream AND p.platform = 'fansly'");
  });

  it("keeps egress key repair idempotent and scoped to URL-like keys", async () => {
    const migration = await readFile(
      "packages/db/migrations/0015_repair_egress_rate_limit_scope_key.sql",
      "utf8",
    );

    expect(migration).toContain("rate_limit_scope_key IS NULL OR");
    expect(migration).toContain("rate_limit_scope_key ~ '^(http|https|socks5)://'");
    expect(migration).toContain("canonical.canonical_scope_key IS NOT DISTINCT FROM canonical.canonical_key");
    expect(migration).toContain("IS DISTINCT FROM");
    expect(migration).toContain("EXCEPTION WHEN others THEN");
  });

  it("reapplies corrected egress key repair as a new migration", async () => {
    const migration = await readFile(
      "packages/db/migrations/0017_reapply_egress_rate_limit_scope_key_repair.sql",
      "utf8",
    );

    expect(migration).toContain("canonical_proxy_egress_key(url) AS canonical_key");
    expect(migration).toContain("rate_limit_scope_key IS NULL OR");
    expect(migration).toContain("rate_limit_scope_key ~ '^(http|https|socks5)://'");
    expect(migration).toContain("canonical.canonical_scope_key IS NOT DISTINCT FROM canonical.canonical_key");
    expect(migration).toContain("IS DISTINCT FROM");
  });

  it("adds durable notification incident recovery watermarks", async () => {
    const migration = await readFile(
      "packages/db/migrations/0018_notification_incident_recovery_watermarks.sql",
      "utf8",
    );

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "notification_incident_recoveries"');
    expect(migration).toContain('"incident_key" text PRIMARY KEY');
    expect(migration).toContain('"recovered_at" timestamptz NOT NULL');
  });

  it("keeps OFAPI spend projection history when a page is deleted", async () => {
    const migration = await readFile(
      "packages/db/migrations/0049_audit_final_l17_operational_edges.sql",
      "utf8",
    );

    expect(migration).toContain('ALTER COLUMN "page_id" DROP NOT NULL');
    expect(migration).toContain("ON DELETE SET NULL");
    expect(migration).not.toContain("ON DELETE CASCADE");
  });

  it("backfills Telegram credential watermarks from the existing settings timestamp", async () => {
    const migration = await readFile(
      "packages/db/migrations/0050_telegram_credentials_updated_at.sql",
      "utf8",
    );

    expect(migration).toContain('ADD COLUMN "credentials_updated_at" timestamp with time zone;');
    expect(migration).toContain('SET "credentials_updated_at" = "updated_at"');
    expect(migration).toContain('ALTER COLUMN "credentials_updated_at" SET DEFAULT now()');
    expect(migration).toContain('ALTER COLUMN "credentials_updated_at" SET NOT NULL');
    expect(migration).not.toContain('ADD COLUMN "credentials_updated_at" timestamp with time zone DEFAULT now() NOT NULL');
  });

  it("separates the zero replay floor from the locked legacy cursor high-water", async () => {
    const migration = await readFile(
      "packages/db/migrations/0094_event_replay_continuity.sql",
      "utf8",
    );

    expect(migration).toContain('CREATE TABLE "ofapi_fanout_replay_state"');
    expect(migration).toContain('"singleton" boolean PRIMARY KEY');
    expect(migration).toContain('LOCK TABLE "ofapi_webhook_events" IN ACCESS EXCLUSIVE MODE');
    expect(migration).toContain('"legacy_high_water" bigint DEFAULT 0 NOT NULL');
    expect(migration).toContain('CASE WHEN "is_called" THEN "last_value" ELSE 0 END');
    expect(migration).toContain('FROM "ofapi_webhook_events_fanout_seq"');
    expect(migration).not.toContain('max("fanout_seq")');
    expect(migration).not.toContain('"fanout_seq" bigint PRIMARY KEY');
  });

  it("keeps the retired OnlyFans history lane fenced across application rollbacks", async () => {
    const migration = await readFile(
      "packages/db/migrations/0097_retire_onlyfans_legacy_dm_messages.sql",
      "utf8",
    );

    expect(migration).toContain("guard_retired_onlyfans_dm_messages");
    expect(migration).toContain("before insert or update on page_sync_states");
    expect(migration).toContain("p.platform = 'onlyfans'");
    expect(migration).toContain("new.status := 'paused'::page_sync_status");
    expect(migration).toContain("new.blocker_kind := 'retired'");
    expect(migration).toContain("new.lease_token := null");
    expect(migration).toContain("on conflict (page_id, stream) do nothing");
  });

  it("builds the harvest observation lookup concurrently and idempotently", async () => {
    const base = await readFile(
      "packages/db/migrations/0090_device_token_harvest_capability.sql",
      "utf8",
    );
    const index = await readFile(
      "packages/db/migrations/0096_observations_harvest_lookup_concurrently.sql",
      "utf8",
    );

    expect(base).not.toContain("observations_harvest_machine_client_event_idx");
    expect(index.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(index).toContain("on only observations");
    expect(index).toContain("-- agency-hub:execute-returned-statements");
    expect(index).toContain("drop index concurrently if exists %I.%I");
    expect(index).toContain("not index_state.indisvalid");
    expect(index).toContain("create index concurrently if not exists %I");
    expect(index).toContain("alter index observations_harvest_machine_client_event_idx attach partition");
  });

  it("keeps OF Mirror retained-table changes deploy-safe", async () => {
    const correctness = await readFile(
      "packages/db/migrations/0098_ofapi_capture_correctness_plane.sql",
      "utf8",
    );
    const material = await readFile(
      "packages/db/migrations/0099_ofapi_full_message_material.sql",
      "utf8",
    );
    const indexes = await readFile(
      "packages/db/migrations/0104_ofapi_existing_table_indexes_concurrently.sql",
      "utf8",
    );

    expect(correctness).toMatch(/observations_source_check check \([\s\S]*?\) not valid;/);
    expect(correctness).toContain("ofapi_credit_ledger_attempt_shape_check check");
    expect(correctness).toContain("foreign key (attempt_id)");
    expect(correctness).not.toContain("create unique index ofapi_credit_ledger_attempt_phase_uniq");
    const stateConstraint = correctness.match(
      /constraint ofapi_capture_jobs_state_check check \(\s*state in \(([^)]+)\)\s*\)/,
    );
    const migrationStates = stateConstraint?.[1]
      ?.match(/'([^']+)'/g)
      ?.map((state) => state.slice(1, -1));
    expect(migrationStates).toEqual([...ofapiCaptureJobStates]);
    expect(material).not.toContain("CREATE INDEX");
    expect(indexes.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(indexes).toContain("create index concurrently if not exists message_archive_ofapi_native_order_idx");
    expect(indexes).toContain("create unique index concurrently if not exists ofapi_credit_ledger_attempt_phase_uniq");
    expect(indexes).toContain("on only domain_events");
    expect(indexes).toContain("create index concurrently if not exists %I");
    expect(indexes).toContain("alter index domain_events_v2_deliverable_account_seq_idx attach partition");
  });

  it("drops the duplicate hydration event index in a NEW migration", async () => {
    const hydration = await readFile(
      "packages/db/migrations/0117_agent_hydration_requests.sql",
      "utf8",
    );
    const hygiene = await readFile(
      "packages/db/migrations/0118_agent_read_index_hygiene.sql",
      "utf8",
    );

    // 0117 declared a UNIQUE on (request_id, seq) AND a second btree on the same
    // pair, so every event insert maintained two identical indexes. The
    // constraint's own index is the one that serves the traversal.
    expect(hydration).toContain(
      'CONSTRAINT "agent_hydration_events_seq_uniq" UNIQUE ("request_id", "seq")',
    );
    expect(hydration).toContain('CREATE INDEX "agent_hydration_events_request_idx"');
    // Forward-only: an applied migration is corrected by a later file, never edited.
    expect(hydration.toLowerCase()).not.toContain("drop index");

    expect(hygiene.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(hygiene).toContain("-- agency-hub:statement");
    expect(hygiene).toContain(
      "drop index concurrently if exists agent_hydration_events_request_idx",
    );
    // The dangling "#8 coverage:" comment 0116 ends on is a DECISION, not a
    // missing index: every access path that operation walks is already covered.
    // The two indexes that cover it are named here so that nobody re-adds a
    // duplicate of the baseline UNIQUE under a new name.
    expect(hygiene).toContain("page_dm_threads_account_conversation_uniq");
    expect(hygiene).toContain("message_archive_account_conv_idx");
  });

  it("keeps error-handling Stage 1A additive and producer-free", async () => {
    const migration = await readFile(
      "packages/db/migrations/0114_error_handling_stage_1a.sql",
      "utf8",
    );

    expect(migration).toContain('ADD COLUMN "error_code" text');
    expect(migration).toContain('ADD COLUMN "failure_phase" text');
    expect(migration).toContain('ADD COLUMN "provider_http_status" integer');
    expect(migration).toContain('"ai_usage_events_failure_reason_window_idx"');
    expect(migration).toContain("ADD VALUE IF NOT EXISTS 'ai_provider_billing'");
    expect(migration).toContain("ADD VALUE IF NOT EXISTS 'ai_provider_failed'");
    expect(migration).toContain(
      'ADD COLUMN "ai_critical_alerts_enabled" boolean DEFAULT false NOT NULL',
    );
    expect(migration).toContain('CREATE TABLE "notification_delivery_outbox"');
    expect(migration).toContain('"paging_policy" text NOT NULL');
    expect(migration).toContain('"idempotency_key" text NOT NULL UNIQUE');
    expect(migration).toContain("'suppressed'");
    expect(migration).toContain("'exhausted'");
    expect(migration).not.toMatch(/\bUPDATE\s+"?ai_usage_events"?/i);
  });

  it("keeps the spend-candidate index predicate equal to the sweep's pinned event types", async () => {
    const migration = await readFile(
      "packages/db/migrations/0143_ofapi_webhook_events_spend_candidates_idx.sql",
      "utf8",
    );

    // The planner may only use a partial index when the query's clauses IMPLY
    // its predicate, and implication over a list of constants is structural: a
    // list that differs in content OR ORDER stops the index being used, and the
    // only symptom is that the minutely sweep silently goes back to walking the
    // whole journal. Pin the predicate to the one constant the query is built
    // from — same members, same order.
    const predicate = /where event_type in \(([^)]*)\)/.exec(migration)?.[1];
    expect(predicate).toBeDefined();
    const indexedEventTypes = predicate!
      .split(",")
      .map((value) => value.trim().replace(/^'|'$/g, ""));
    expect(indexedEventTypes).toEqual([...OFAPI_SPEND_PROJECTION_EVENT_TYPES]);

    // The rest of the predicate is the sweep's other two constant clauses,
    // verbatim, and the key is `id` alone so the same index serves `order by id`.
    expect(migration).toContain("on ofapi_webhook_events (id)");
    expect(migration).toContain("and status <> 'pending'");
    expect(migration).toContain("and platform_account_id is not null");

    // Capture-first (DP 7): building this index must never lock out the webhook
    // receiver, so it is non-transactional and CONCURRENTLY.
    expect(migration.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(migration).toContain("create index concurrently if not exists");
    expect(migration).toContain(
      "drop index concurrently if exists %I.%I",
    );
  });

  it("builds the webhook lifecycle lookup index concurrently, outside 0157's transaction", async () => {
    const lifecycle = await readFile(
      "packages/db/migrations/0157_ofapi_webhook_lifecycle.sql",
      "utf8",
    );
    const index = await readFile(
      "packages/db/migrations/0169_ofapi_webhook_lifecycle_index.sql",
      "utf8",
    );

    // 0157 runs inside the migration transaction: a plain CREATE INDEX there
    // would hold ACCESS EXCLUSIVE on the 570k-row webhook journal for the whole
    // build and stall inbound OFAPI deliveries past their 10 s timeout. The
    // migration keeps its row update and nothing that takes that lock.
    const lifecycleStatements = lifecycle
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(lifecycleStatements).not.toMatch(/create index/i);
    expect(lifecycleStatements).toMatch(/^UPDATE ofapi_webhook_events/m);

    // The index itself follows the 0143 shape: non-transactional, an INVALID
    // leftover from an interrupted attempt is dropped first, then CONCURRENTLY
    // and idempotently, with the 0157 definition unchanged.
    expect(index.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(index).toContain("drop index concurrently if exists %I.%I");
    expect(index).toContain("where i.relname = 'ofapi_webhook_lifecycle_resource_idx'");
    expect(index).toContain(
      "create index concurrently if not exists ofapi_webhook_lifecycle_resource_idx",
    );
    expect(index).toContain(
      "on ofapi_webhook_events ((payload->'payload'->>'id'), event_type, id desc)",
    );
    expect(index).toContain(
      "where capture_state = 'accepted' and projection_status = 'projected'",
    );
    // The review #136 rider: the attempt failure kind for a local
    // collection-policy refusal, idempotent, outside any transaction.
    expect(index).toContain("alter type sync_http_failure_kind add value if not exists 'policy';");
    // Every executable query is delimited for the no-transaction runner.
    expect(index.split("-- agency-hub:statement").length - 1).toBe(3);
  });

  it("builds the H2 delivery-attempt indexes concurrently, outside 0207's transaction", async () => {
    const intents = await readFile("packages/db/migrations/0207_ofapi_webhook_auto_redelivery.sql", "utf8");
    const index = await readFile("packages/db/migrations/0208_ofapi_webhook_delivery_business_key_idx.sql", "utf8");
    const recovery = await readFile("apps/runtime/src/services/ofapi-webhook-recovery.ts", "utf8");

    // 0207 is transactional and touches only the small intents table and a
    // new one; nothing in it may lock the live delivery-attempt table.
    const intentStatements = intents.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    expect(intentStatements).not.toMatch(/on ofapi_webhook_delivery_attempts/i);

    // 0208 follows the 0143/0169 shape.
    expect(index.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(index).toContain("drop index concurrently if exists %I.%I");
    expect(index).toContain("create index concurrently if not exists ofapi_webhook_delivery_failed_business_idx");
    expect(index).toContain("create index concurrently if not exists ofapi_webhook_delivery_business_key_idx");
    expect(index.split("-- agency-hub:statement").length - 1).toBe(3);

    // The partial predicate is a contract with the candidate scan: the query
    // spells the same clauses as constants, so it implies the predicate.
    expect(index).toContain("where not succeeded and idempotency_key is not null;");
    expect(recovery).toContain("not a.succeeded and a.idempotency_key is not null");
  });
});
