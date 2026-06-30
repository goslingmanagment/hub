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
});
