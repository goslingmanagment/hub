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
});
