import { describe, expect, it, vi } from "vitest";

import {
  acquireNextSyncTaskLeaseForPage,
  heartbeatSyncTaskLease,
  listRunnableSyncPagesV2,
  listSyncTaskRows,
} from "../packages/db/src/repositories/sync-v2.ts";
import { sql, type SQL } from "../packages/db/node_modules/drizzle-orm/index.js";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { syncTasks } from "../packages/db/src/schema.ts";

const DIALECT = new PgDialect();

function renderSql(query: SQL) {
  return DIALECT.sqlToQuery(query).sql;
}

describe("sync-v2 repository schema alignment", () => {
  it("renders raw SQL against the canonical sync_state table", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = {
      execute,
    } as never;
    const now = new Date("2026-03-24T12:00:00.000Z");

    await listSyncTaskRows(db, {
      platformAccountId: 55,
      tasks: ["light"],
    });
    await listRunnableSyncPagesV2(db, now);
    await heartbeatSyncTaskLease(db, {
      platformAccountId: 55,
      task: "light",
      leaseToken: "lease-1",
      leaseTtlMs: 60_000,
      now,
    });
    await acquireNextSyncTaskLeaseForPage(db, {
      platformAccountId: 55,
      workerId: "worker-1",
      leaseToken: "lease-1",
      leaseTtlMs: 60_000,
      now,
    });

    const statements = execute.mock.calls.map(([query]) => renderSql(query as SQL));
    const expectedFrom = renderSql(sql`from ${syncTasks}`);
    const expectedAliasedFrom = renderSql(sql`from ${syncTasks} st`);
    const expectedUpdate = renderSql(sql`update ${syncTasks}`);
    const expectedAliasedUpdate = renderSql(sql`update ${syncTasks} st`);

    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain(expectedFrom);
    expect(statements[1]).toContain(expectedAliasedFrom);
    expect(statements[2]).toContain(expectedUpdate);
    expect(statements[3]).toContain(expectedAliasedFrom);
    expect(statements[3]).toContain(expectedAliasedUpdate);

    for (const statement of statements) {
      expect(statement).not.toContain("sync_tasks");
    }
  });
});
