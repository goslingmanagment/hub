import { describe, expect, it, vi } from "vitest";

import {
  upsertCheckpoint,
  upsertCheckpointProgress,
} from "../packages/db/src/repositories/sync.ts";
import { runWithSyncTaskExecutionContext } from "../packages/db/src/repositories/sync-context.ts";
import { sql, type SQL } from "../packages/db/node_modules/drizzle-orm/index.js";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { syncCursors, syncTasks } from "../packages/db/src/schema.ts";

const DIALECT = new PgDialect();

function renderSql(query: SQL) {
  return DIALECT.sqlToQuery(query).sql;
}

describe("sync checkpoint repository schema alignment", () => {
  it("renders leased control checkpoint writes against sync_cursors.task", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{
        owned: true,
        cursorText: "cursor-a",
        cursorTimestamp: null,
        state: { phase: "a" },
        lastSuccessfulRunId: null,
        lastSuccessfulAt: null,
        updatedAt: "2026-03-24T12:00:00.000Z",
      }],
    });
    const db = {
      execute,
    } as never;

    await runWithSyncTaskExecutionContext({
      platformAccountId: 55,
      task: "transactions",
      generation: 7,
      leaseToken: "lease-1",
    }, async () => {
      await upsertCheckpoint(db, {
        platformAccountId: 55,
        stream: "transactions",
        cursorText: "cursor-a",
        state: { phase: "a" },
        lastSuccessfulRunId: null,
      });
      await upsertCheckpointProgress(db, {
        platformAccountId: 55,
        stream: "transactions",
        state: { phase: "b" },
      });
    });

    const statements = execute.mock.calls.map(([query]) => renderSql(query as SQL));
    const expectedFrom = renderSql(sql`from ${syncTasks}`);
    const expectedInsert = renderSql(sql`insert into ${syncCursors}`);

    expect(statements).toHaveLength(2);

    for (const statement of statements) {
      expect(statement).toContain(expectedFrom);
      expect(statement).toContain(expectedInsert);
      expect(statement).toContain("on conflict (platform_account_id, task)");
      expect(statement.split(expectedInsert)).toHaveLength(2);
      expect(statement).not.toContain("sync_tasks");
      expect(statement).not.toContain("sync_checkpoints");
      expect(statement).not.toContain("stream");
    }
  });
});
