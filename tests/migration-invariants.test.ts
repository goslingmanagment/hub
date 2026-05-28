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
});
