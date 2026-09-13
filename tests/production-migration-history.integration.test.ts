import { expect, it } from "vitest";
import type { PoolClient } from "pg";

import { runMigrations } from "../packages/db/src/migrate-runner.ts";

import { startIntegrationTestDatabase } from "./helpers/db.ts";

type MigrationHistoryRow = { id: string; applied_at: Date };

it("continues the deployed migration prefix without reapplying restored history", async () => {
  const testDb = await startIntegrationTestDatabase({
    through: "0186_ops_metrics_recent_series.sql",
  });
  if (!testDb) {
    return;
  }

  const restoredHistory = `
    select m.id, m.applied_at
    from schema_migrations m
    where m.id in (
      '0185_fansly_followers_membership_read.sql',
      '0186_ops_metrics_recent_series.sql'
    )
    order by m.id
  `;
  try {
    const before = await testDb.pool.query<MigrationHistoryRow>(restoredHistory);
    expect(before.rows.map((row) => row.id)).toEqual([
      "0185_fansly_followers_membership_read.sql",
      "0186_ops_metrics_recent_series.sql",
    ]);

    const client = await testDb.pool.connect();
    try {
      await runMigrations({ db: client });
    } finally {
      (client as PoolClient).release();
    }
    const after = await testDb.pool.query<MigrationHistoryRow>(restoredHistory);
    expect(after.rows).toEqual(before.rows);

    const next = await testDb.pool.query<{ id: string }>(`
      select m.id from schema_migrations m
      where m.id >= '0187' and m.id < '0192'
      order by m.id
    `);
    expect(next.rows.map((row) => row.id)).toEqual([
      "0187_fansly_earnings_audit_scope.sql",
      "0188_fansly_earnings_audit_observations.sql",
      "0189_fansly_earnings_audit_projection.sql",
      "0190_fansly_earnings_audit_bounded_payload.sql",
      "0191_fansly_earnings_audit_toast.sql",
    ]);
  } finally {
    await testDb.stop();
  }
}, 30_000);
