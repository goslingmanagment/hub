import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

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
    expect(material).not.toContain("CREATE INDEX");
    expect(indexes.startsWith("-- agency-hub:no-transaction")).toBe(true);
    expect(indexes).toContain("create index concurrently if not exists message_archive_ofapi_native_order_idx");
    expect(indexes).toContain("create unique index concurrently if not exists ofapi_credit_ledger_attempt_phase_uniq");
    expect(indexes).toContain("on only domain_events");
    expect(indexes).toContain("create index concurrently if not exists %I");
    expect(indexes).toContain("alter index domain_events_v2_deliverable_account_seq_idx attach partition");
  });
});
