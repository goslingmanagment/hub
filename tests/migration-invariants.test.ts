import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { LINK_FAN_JOURNAL_ENDPOINTS_SQL, OFAPI_SPEND_PROJECTION_EVENT_TYPES } from "@agency_hub_core/db";
import { LINK_FAN_JOURNAL_ENDPOINTS, ofapiCaptureJobStates } from "@agency_hub_core/shared";

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

  it("keeps the money-stamp index predicate equal to the constant its probe spells", async () => {
    const migration = await readFile(
      "packages/db/migrations/0250_ofapi_webhook_events_transactions_page_received_idx.sql",
      "utf8",
    );
    const repository = await readFile("packages/db/src/repositories/ofapi.ts", "utf8");

    // The probe in getOfapiMoneyStreamStates must imply the predicate, so both
    // spell the same constant; a bound parameter or another type silently
    // sends the probe back to walking every delivery of the page.
    expect(migration).toContain("on ofapi_webhook_events (platform_account_id, received_at)");
    expect(migration).toContain("where event_type = 'transactions.new';");
    expect(repository).toContain("where ${ofapiWebhookEvents.eventType} = 'transactions.new'");

    // Capture-first (DP 7): never lock out the webhook receiver.
    expect(migration.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(migration).toContain(
      "create index concurrently if not exists ofapi_webhook_events_transactions_page_received_idx",
    );
    expect(migration).toContain("drop index concurrently if exists %I.%I");
    expect(migration).toContain("where i.relname = 'ofapi_webhook_events_transactions_page_received_idx'");
    expect(migration.split("-- agency-hub:statement").length - 1).toBe(2);
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

  it("builds the purchase-history and DM 5xx-streak lookup indexes concurrently; their readers are gone and the indexes stay", async () => {
    const index = await readFile(
      "packages/db/migrations/0223_raw_payload_and_attempt_lookup_indexes.sql",
      "utf8",
    );
    const sync = await readFile("packages/db/src/repositories/sync.ts", "utf8");

    // Both tables are written by every lane; a plain build would block that.
    expect(index.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(index).toContain("drop index concurrently if exists %I.%I");
    expect(index).toContain(
      "where i.relname in ('sync_raw_payloads_purchase_history_idx', 'sync_http_attempts_dm_group_idx')",
    );
    expect(index).toContain(
      "create index concurrently if not exists sync_raw_payloads_purchase_history_idx",
    );
    expect(index).toContain("on sync_raw_payloads (page_id, endpoint, id)");
    expect(index).toContain("create index concurrently if not exists sync_http_attempts_dm_group_idx");
    expect(index).toContain("on sync_http_attempts (page_id, (request_shape ->> 'groupId'))");
    expect(index.split("-- agency-hub:statement").length - 1).toBe(3);

    // The raw-payload index is partial on the purchase-history endpoints. Its
    // readers went at step 4: the legacy lane that journaled the probe and
    // storm pages (S4-16), the switch import that read `purchase_history`
    // through it (S4-21) and the shadow report's window read (S4-22). The
    // index stays (migrations are forward-only) and no reader is pinned to
    // it; one that comes back must spell this list, or it scans the whole
    // 788 MB heap with no error.
    const predicate = /where endpoint in \(([^)]*)\)/.exec(index)?.[1];
    expect(predicate).toBeDefined();
    expect(predicate!.split(",").map((value) => value.trim().replace(/^'|'$/g, ""))).toEqual([
      "purchase_history",
      "purchase_history_contract_probe",
      "purchase_history_contract_storm",
    ]);
    const observability = await readFile("packages/db/src/repositories/sync/observability.ts", "utf8");
    expect(observability).not.toContain("sync_raw_payloads");

    // The attempt index served the legacy dm_messages 5xx breaker's streak
    // query, which went with the legacy DM handler at step 4 (S4-14); the
    // index stays (migrations are forward-only) and no reader is pinned to it.
    expect(index).toContain("where stream = 'dm_messages' and operation = 'messages';");
    expect(sync).not.toContain("a.request_shape ->> 'groupId' = ");

    // Index-only, so a failed deploy may still restore the previous image.
    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0])
      .toContain('"0223_raw_payload_and_attempt_lookup_indexes.sql"');
  });

  it("builds the link ↔ fan journal index concurrently, on exactly the projection's endpoint list", async () => {
    const index = await readFile("packages/db/migrations/0261_sync_raw_payloads_link_fans_idx.sql", "utf8");
    const reader = await readFile("packages/db/src/repositories/link-fans.ts", "utf8");

    // Every lane writes sync_raw_payloads; a plain build would block them.
    expect(index.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(index).toContain("drop index concurrently if exists %I.%I");
    expect(index).toContain("where i.relname = 'sync_raw_payloads_link_fans_idx'");
    expect(index).toContain("create index concurrently if not exists sync_raw_payloads_link_fans_idx");
    expect(index).toContain("on sync_raw_payloads (page_id, id)");
    expect(index.split("-- agency-hub:statement").length - 1).toBe(2);

    // The partial predicate is a contract with the reader: it spells the same
    // list as SQL constants (a bound parameter would not imply the predicate).
    const predicate = /where endpoint in \(([^)]*)\)/.exec(index)?.[1];
    expect(predicate!.split(",").map((value) => value.trim().replace(/^'|'$/g, "")))
      .toEqual([...LINK_FAN_JOURNAL_ENDPOINTS]);
    expect(LINK_FAN_JOURNAL_ENDPOINTS_SQL).toBe(`(${predicate})`);
    expect(reader).toContain("rp.endpoint in ${sql.raw(LINK_FAN_JOURNAL_ENDPOINTS_SQL)}");

    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    const compatible = deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0];
    expect(compatible).toContain('"0260_page_link_fans.sql"');
    expect(compatible).toContain('"0261_sync_raw_payloads_link_fans_idx.sql"');
  });

  it("adds the missed-alerts summary reference as a nullable self-reference and lifts the standing alert queue", async () => {
    const migration = await readFile("packages/db/migrations/0263_notification_outbox_reported_in.sql", "utf8");
    const statements = migration.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

    // Nullable, no default: the ALTER touches the catalog only.
    expect(statements).toMatch(
      /ADD COLUMN IF NOT EXISTS reported_in_outbox_id bigint\s+REFERENCES notification_delivery_outbox\(id\);/,
    );
    expect(statements).not.toMatch(/reported_in_outbox_id bigint[^;]*(NOT NULL|DEFAULT)/i);
    // Only the alerts still queued get the new horizon; the AI pair keeps 5.
    expect(statements).toContain("SET max_attempts = 400");
    expect(statements).toContain("WHERE paging_policy = 'sync_failure'");
    expect(statements).toContain("AND state IN ('pending', 'leased')");
    expect(statements).not.toContain("ai_critical");

    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0])
      .toContain('"0263_notification_outbox_reported_in.sql"');
  });

  it("keeps the browser transport's migrations (Project Browser PR 12) brief on the hot tables and rollback-compatible", async () => {
    const statementsOf = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    // sync_attempts is the running engine's journal: the 0271 pattern — a
    // nullable column without a default, the check swapped NOT VALID under a
    // 1 s lock wait (retried), validated apart.
    const attempts = await readFile("packages/db/migrations/0272_sync_attempts_browser_send.sql", "utf8");
    expect(attempts.startsWith("-- agency-hub:no-transaction")).toBe(true);
    const attemptStatements = statementsOf(attempts);
    expect(attemptStatements).toContain("alter table sync_attempts add column if not exists browser_request_id text;");
    expect(attemptStatements).not.toMatch(/browser_request_id text[^;]*(not null|default)/i);
    expect(attemptStatements).toContain("send_mark is null or send_mark in ('request_start', 'completion_fallback', 'transport_reported', 'shadow')");
    expect(attemptStatements).toContain(") not valid;");
    expect(attemptStatements).toContain("alter table sync_attempts validate constraint sync_attempts_send_mark_check;");
    expect(attemptStatements.match(/set local lock_timeout = '1s';/g)).toHaveLength(2);

    // observations is partitioned and written all the time: swapped NOT
    // VALID (as 0196), never scanned under the lock.
    const observations = await readFile("packages/db/migrations/0274_observations_source_browser_site.sql", "utf8");
    expect(observations.startsWith("-- agency-hub:no-transaction")).toBe(true);
    const observationStatements = statementsOf(observations);
    expect(observationStatements).toContain("'fansly_ws', 'browser_site'");
    expect(observationStatements).toContain(") not valid;");
    expect(observationStatements).not.toMatch(/validate constraint/);

    // The small tables: one transaction under a 5 s lock wait.
    for (const file of ["0273_fansly_ws_connections_browser.sql", "0275_page_browsers.sql"]) {
      const text = statementsOf(await readFile(`packages/db/migrations/${file}`, "utf8"));
      expect(text, file).toContain("set local lock_timeout = '5s';");
    }

    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    const compatible = deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0];
    for (const file of ["0272_sync_attempts_browser_send.sql", "0273_fansly_ws_connections_browser.sql", "0274_observations_source_browser_site.sql", "0275_page_browsers.sql"]) {
      expect(compatible, file).toContain(`"${file}"`);
    }
  });

  it("keeps the buffer intake's position (Project Browser PR 13) brief, nullable or constant-default, and rollback-compatible", async () => {
    const statementsOf = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    const intake = statementsOf(await readFile("packages/db/migrations/0276_page_browser_intake.sql", "utf8"));
    expect(intake).toContain("set local lock_timeout = '5s';");
    expect(intake).toContain("add column if not exists events_acked_seq bigint not null default 0");
    for (const column of ["events_buffer_id uuid", "events_last_wall timestamptz", "events_gap_since timestamptz", "events_updated_at timestamptz",
      "events_halted_buffer_id uuid", "events_halted_reason text", "events_halted_at timestamptz"]) {
      expect(intake).toContain(`add column if not exists ${column}`);
      // Nullable without a default: catalog only.
      expect(intake.split("\n").find((line) => line.includes(column))).not.toMatch(/not null|default/);
    }
    // The read role sees the new columns (page_browsers is granted by column).
    expect(intake).toMatch(/grant select \(events_buffer_id, events_acked_seq, events_last_wall, events_gap_since, events_updated_at,\s+events_halted_buffer_id, events_halted_reason, events_halted_at\)/);
    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain('"0276_page_browser_intake.sql"');
  });

  it("keeps the page transport column (Project Browser PR 14) brief, defaulted to node, and rollback-compatible", async () => {
    const statementsOf = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    const transport = statementsOf(await readFile("packages/db/migrations/0277_sync_pages_transport.sql", "utf8"));
    // A row lock of a running actor is waited for briefly, never queued behind.
    expect(transport).toContain("set local lock_timeout = '5s';");
    // A constant default: catalog only, and every existing page stays on node.
    expect(transport).toContain("alter table sync_pages add column if not exists transport text not null default 'node';");
    expect(transport).toMatch(/add constraint sync_pages_transport_check\s+check \(transport in \('node', 'browser'\)\) not valid;/);
    expect(transport).toContain("alter table sync_pages validate constraint sync_pages_transport_check;");
    // No statement moves a page off node: only the owner's lever does.
    expect(transport).not.toMatch(/update\s+sync_pages/i);
    for (const column of ["pinned_exit_ip text", "pinned_exit_ip_at timestamptz", "env jsonb", "handover_generation bigint",
      "handover_quiesced_at timestamptz", "handover_last_send_at timestamptz"]) {
      expect(transport).toContain(`add column if not exists ${column}`);
      // Nullable without a default: catalog only.
      expect(transport.split("\n").find((line) => line.includes(column))).not.toMatch(/not null|default/);
    }
    // The read role sees the new columns (page_browsers is granted by column).
    expect(transport).toMatch(/grant select \(pinned_exit_ip, pinned_exit_ip_at, env, handover_generation, handover_quiesced_at, handover_last_send_at\)\s+on page_browsers to read_only;/);
    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain('"0277_sync_pages_transport.sql"');
  });

  it("keeps a page browser's visibility and the owner's commands (Project Browser PR 17) brief, nullable and rollback-compatible", async () => {
    const statementsOf = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    const visibility = statementsOf(await readFile("packages/db/migrations/0281_page_browser_visibility.sql", "utf8"));
    expect(visibility).toContain("set local lock_timeout = '5s';");
    for (const column of ["retry_at timestamptz", "down_since timestamptz", "stop_since timestamptz", "delivery_p50_ms bigint",
      "delivery_p95_ms bigint", "delivery_at timestamptz", "alarm_kind text", "alarm_at timestamptz", "alarm_detail jsonb",
      "owner_stop_at timestamptz", "owner_stop_by text", "halt_reason text", "halt_at timestamptz", "halt_id text"]) {
      expect(visibility).toContain(`add column if not exists ${column}`);
      // Nullable without a default: catalog only.
      expect(visibility.split("\n").find((line) => line.includes(column))).not.toMatch(/not null|default/);
    }
    // A constant default: catalog only — on sync_pages too, where every actor
    // of the previous image holds a row lock (waited for 5 s at most).
    expect(visibility).toContain("alter table sync_pages add column if not exists browser_stop_paused boolean not null default false;");
    // The owner's commands: a profile's (they go with it), one run per id, never past their expiry.
    expect(visibility).toContain("profile_id uuid not null references page_browsers(profile_id) on delete cascade");
    expect(visibility).toContain("constraint page_browser_commands_command_id_key unique (command_id)");
    expect(visibility).toContain("check (kind in ('restartBrowser', 'stopPage', 'selfTest'))");
    // Every command ends: ok, failed, expired, unknown (Astra round 3).
    expect(visibility).toContain("check (outcome in ('ok', 'failed', 'unknown', 'expired'))");
    // No direct child of pages (the page erasure's inventory is unchanged).
    expect(visibility).not.toMatch(/references pages/);
    // No statement writes a row: only the engine and the owner's levers do.
    expect(visibility).not.toMatch(/^\s*(update|insert)\b/im);
    expect(visibility).toMatch(/grant select \(retry_at, down_since, stop_since, delivery_p50_ms, delivery_p95_ms, delivery_at, alarm_kind, alarm_at,\s+alarm_detail, owner_stop_at, owner_stop_by, halt_reason, halt_at, halt_id\)\s+on page_browsers to read_only;/);
    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain('"0281_page_browser_visibility.sql"');
  });

  it("keeps a page's leave of its browser (Project Browser PR 14) brief, nullable and rollback-compatible", async () => {
    const statementsOf = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    const leave = statementsOf(await readFile("packages/db/migrations/0278_sync_pages_browser_leave.sql", "utf8"));
    expect(leave).toContain("set local lock_timeout = '5s';");
    for (const column of ["browser_leave_generation bigint", "browser_leave_requested_at timestamptz", "browser_left_at timestamptz",
      "browser_left_by text", "browser_left_generation bigint", "buffer_undrained_since timestamptz"]) {
      expect(leave).toContain(`add column if not exists ${column}`);
      // Nullable without a default: catalog only.
      expect(leave.split("\n").find((line) => line.includes(column))).not.toMatch(/not null|default/);
    }
    expect(leave).toMatch(/check \([\s\S]*\) not valid;/);
    expect(leave).toContain("alter table sync_pages validate constraint sync_pages_browser_leave_check;");
    expect(leave).not.toMatch(/update\s+sync_pages/i);
    expect(leave).toContain("grant select (buffer_undrained_since) on page_browsers to read_only;");
    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain('"0278_sync_pages_browser_leave.sql"');
  });

  it("keeps a page's manual login (Project Browser PR 15) brief, defaulted to off, and rollback-compatible", async () => {
    const statementsOf = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    const login = statementsOf(await readFile("packages/db/migrations/0279_sync_pages_manual_login.sql", "utf8"));
    expect(login).toContain("set local lock_timeout = '5s';");
    // A constant default: catalog only, and every existing page stays off.
    expect(login).toContain("alter table sync_pages add column if not exists manual_login text not null default 'off';");
    expect(login).toContain("alter table sync_pages add column if not exists manual_login_paused boolean not null default false;");
    for (const column of ["manual_login_changed_at timestamptz", "manual_login_changed_by text"]) {
      expect(login).toContain(`add column if not exists ${column}`);
      expect(login.split("\n").find((line) => line.includes(column))).not.toMatch(/not null|default/);
    }
    expect(login).toMatch(/check \(manual_login in \('off', 'wanted', 'ending'\)\) not valid;/);
    expect(login).toContain("alter table sync_pages validate constraint sync_pages_manual_login_check;");
    // No statement opens a login: only the owner's lever does.
    expect(login).not.toMatch(/update\s+sync_pages/i);
    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain('"0279_sync_pages_manual_login.sql"');
  });

  it("keeps a new page's onboarding through its browser (Project Browser PR 16) brief, defaulted, sealed and rollback-compatible", async () => {
    const statementsOf = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    const onboarding = statementsOf(await readFile("packages/db/migrations/0280_page_browser_onboarding.sql", "utf8"));
    expect(onboarding).toContain("set local lock_timeout = '5s';");
    // Constant defaults: catalog only; every existing profile stays off.
    expect(onboarding).toContain("add column if not exists onboarding text not null default 'off'");
    expect(onboarding).toContain("add column if not exists link_generation bigint not null default 0");
    for (const column of ["onboarding_changed_at timestamptz", "onboarding_changed_by text", "socks_endpoint text", "onboarding_proxy_url text",
      "onboarding_proxy_auth text", "onboarding_proxy_key_version integer", "identity_request_id uuid", "identity_request_source text",
      "identity_requested_at timestamptz", "identity_result jsonb", "browser_profile_id uuid", "browser_attempt_id bigint"]) {
      expect(onboarding).toContain(`add column if not exists ${column}`);
      expect(onboarding.split("\n").find((line) => line.includes(column))).not.toMatch(/not null|default/);
    }
    // A bound profile is no onboarding's; nothing writes a row.
    expect(onboarding).toContain("check (page_id is null or onboarding = 'off')");
    expect(onboarding).not.toMatch(/^\s*(update|insert|delete)\b/im);
    // The read role sees every new column but the proxy's sealed auth.
    const grant = /grant select \(([^)]*)\)\s+on page_browsers to read_only;/.exec(onboarding)?.[1] ?? "";
    expect(grant).toContain("onboarding_proxy_url");
    expect(grant).not.toContain("onboarding_proxy_auth");
    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain('"0280_page_browser_onboarding.sql"');
  });
});
