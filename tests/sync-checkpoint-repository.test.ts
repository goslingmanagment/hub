import { describe, expect, it, vi } from "vitest";

import {
  upsertCheckpoint,
  upsertCheckpointProgress,
} from "../packages/db/src/repositories/sync.ts";
import {
  PageSyncLeaseLostError,
  runWithPageSyncExecutionContext,
} from "../packages/db/src/repositories/sync-context.ts";
import { sql, type SQL } from "../packages/db/node_modules/drizzle-orm/index.js";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { pageSyncCursors, pageSyncStates } from "../packages/db/src/schema.ts";

const DIALECT = new PgDialect();

function renderSql(query: SQL) {
  return DIALECT.sqlToQuery(query).sql;
}

describe("sync checkpoint repository schema alignment", () => {
  it("renders leased checkpoint writes against page_sync_cursors", async () => {
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
      query: {
        pageSyncCursors: {
          findFirst: vi.fn().mockResolvedValue({
            pageId: 55,
            stream: "transactions",
            cursorText: "cursor-a",
            cursorTimestamp: null,
            cursorSeq: 7,
            state: { phase: "a" },
            cursorLastSucceededRunId: null,
            cursorLastSucceededAt: null,
            updatedAt: new Date("2026-03-24T12:00:00.000Z"),
          }),
        },
      },
    } as never;

    await runWithPageSyncExecutionContext({
      pageId: 55,
      stream: "transactions",
      requestSeq: 7,
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
    const expectedFrom = renderSql(sql`from ${pageSyncStates}`);
    const expectedInsert = renderSql(sql`insert into ${pageSyncCursors}`);

    expect(statements).toHaveLength(2);

    for (const statement of statements) {
      expect(statement).toContain(expectedFrom);
      expect(statement).toContain(expectedInsert);
      expect(statement).toContain("on conflict (page_id, stream)");
      expect(statement.split(expectedInsert)).toHaveLength(2);
      expect(statement).toContain("stream");
      expect(statement).toContain("for update");
      expect(statement).not.toContain(["sync", "tasks"].join("_"));
      expect(statement).not.toContain(["sync", "checkpoints"].join("_"));
    }
  });

  it("throws PageSyncLeaseLostError when fenced checkpoint writes lose ownership", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{
        owned: false,
      }],
    });
    const db = {
      execute,
    } as never;

    await expect(runWithPageSyncExecutionContext({
      pageId: 55,
      stream: "transactions",
      requestSeq: 7,
      leaseToken: "lease-1",
    }, async () => upsertCheckpoint(db, {
      platformAccountId: 55,
      stream: "transactions",
      cursorText: "cursor-a",
      state: { phase: "a" },
      lastSuccessfulRunId: null,
    }))).rejects.toBeInstanceOf(PageSyncLeaseLostError);
  });
});
