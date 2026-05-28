import { describe, expect, it, vi } from "vitest";

import {
  acquirePageSyncLease,
  heartbeatPageSyncLease,
  listPageSyncStates,
  listRunnablePageSync,
  normalizePageSyncRequestStreams,
} from "../packages/db/src/repositories/page-sync.ts";
import { sql, type SQL } from "../packages/db/node_modules/drizzle-orm/index.js";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { pageSyncStates } from "../packages/db/src/schema.ts";

const DIALECT = new PgDialect();

function renderSql(query: SQL) {
  return DIALECT.sqlToQuery(query).sql;
}

describe("page-sync repository schema alignment", () => {
  it("renders raw SQL against the canonical page_sync_states table", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = {
      execute,
    } as never;
    const now = new Date("2026-03-24T12:00:00.000Z");

    await listPageSyncStates(db, {
      pageId: 55,
      streams: ["light"],
    });
    await listRunnablePageSync(db, now);
    await heartbeatPageSyncLease(db, {
      pageId: 55,
      stream: "light",
      leaseToken: "lease-1",
      leaseTtlMs: 60_000,
      now,
    });
    await acquirePageSyncLease(db, {
      pageId: 55,
      workerId: "worker-1",
      leaseToken: "lease-1",
      leaseTtlMs: 60_000,
      now,
    });

    const statements = execute.mock.calls.map(([query]) => renderSql(query as SQL));
    const expectedFrom = renderSql(sql`from ${pageSyncStates}`);
    const expectedAliasedFrom = renderSql(sql`from ${pageSyncStates} st`);
    const expectedUpdate = renderSql(sql`update ${pageSyncStates}`);
    const expectedAliasedUpdate = renderSql(sql`update ${pageSyncStates} st`);

    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain(expectedFrom);
    expect(statements[1]).toContain(expectedAliasedFrom);
    expect(statements[2]).toContain(expectedUpdate);
    expect(statements[3]).toContain(expectedAliasedUpdate);
  });

  it("normalizes requested streams before row locks are taken", () => {
    expect(normalizePageSyncRequestStreams([
      "dm_messages",
      "transactions",
      "light",
      "transactions",
      "dm_conversations",
    ])).toEqual([
      "light",
      "transactions",
      "dm_conversations",
      "dm_messages",
    ]);
  });
});
