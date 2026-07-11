import { describe, expect, it, vi } from "vitest";

import {
  acquirePageSyncLease,
  computePageSyncSlotOffsetSeconds,
  heartbeatPageSyncLease,
  listPageSyncStates,
  listRunnablePageSync,
  normalizePageSyncRequestStreams,
  pausePageSync,
  requestPageSync,
  resetPageSync,
  resumePageSync,
  SYNC_STREAM_POLICY,
  SYNC_STREAMS,
  type SyncStream,
} from "../packages/db/src/repositories/page-sync.ts";
import { sql, type SQL } from "../packages/db/node_modules/drizzle-orm/index.js";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { pageSyncStates } from "../packages/db/src/schema.ts";

const DIALECT = new PgDialect();
const SYNC_STREAM_SET = new Set<string>(SYNC_STREAMS);

function renderSql(query: SQL) {
  return DIALECT.sqlToQuery(query).sql;
}

function findStreamParam(params: unknown[]) {
  return params.find((param) => typeof param === "string" && SYNC_STREAM_SET.has(param));
}

function expectPageSyncLockOrder(statement: string) {
  expect(statement).toContain("order by page_id asc");
  for (const stream of SYNC_STREAMS) {
    expect(statement).toContain(`when '${stream}' then ${SYNC_STREAM_POLICY[stream].streamIndex}`);
  }
  expect(statement.indexOf("order by page_id asc")).toBeLessThan(statement.indexOf("for update"));
}

function buildPageSyncStateRow(pageId: number, stream: SyncStream, now: Date) {
  const policy = SYNC_STREAM_POLICY[stream];

  return {
    pageId,
    stream,
    status: "idle",
    requestSeq: 0,
    leasedSeq: null,
    appliedSeq: 1,
    requestSource: null,
    dispatchSource: "scheduled",
    requestPayload: {},
    cadenceSeconds: policy.cadenceSeconds,
    slotOffsetSeconds: computePageSyncSlotOffsetSeconds(pageId, stream),
    lastScheduledSlot: 0,
    requestedAt: null,
    enqueuedAt: null,
    startedAt: null,
    progressedAt: null,
    finishedAt: now,
    succeededAt: now,
    failedAt: null,
    retryKind: null,
    retryAt: null,
    blockerKind: null,
    blockerCode: null,
    blockerMessage: null,
    blockedAt: null,
    phase: null,
    workClass: policy.defaultWorkClass,
    progress: {},
    leaseOwner: null,
    leaseToken: null,
    leaseHeartbeatAt: null,
    leaseExpiresAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorSummary: null,
    createdAt: now,
    updatedAt: now,
  };
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

  it("requestPageSync locks page rows before updating requested streams in normalized order", async () => {
    const now = new Date("2026-03-24T12:00:00.000Z");
    const pageId = 55;
    const existingRows = [
      "light",
      "transactions",
      "top_spenders",
      "subscribers",
      "followers",
      "followers_reconcile",
      "dm_conversations",
      "dm_messages",
      "fan_earnings",
      "purchase_history",
    ].map((stream) => buildPageSyncStateRow(pageId, stream as SyncStream, now));
    const lockedStatements: string[] = [];
    const updatedStreams: unknown[] = [];
    const execute = vi.fn(async (query: SQL) => {
      const rendered = DIALECT.sqlToQuery(query).sql;
      const params = DIALECT.sqlToQuery(query).params;

      if (rendered.includes('from "page_sync_states"') && rendered.includes("for update")) {
        lockedStatements.push(rendered);
        return { rows: existingRows };
      }

      if (rendered.includes('as "leaseExpired"')) {
        return {
          rows: existingRows.map((row) => ({ stream: row.stream, leaseExpired: false })),
        };
      }

      if (rendered.includes('update "page_sync_states"') && rendered.includes("stream = $")) {
        updatedStreams.push(findStreamParam(params));
        return { rows: [] };
      }

      if (rendered.includes('from "pages" p') && rendered.includes("last_light_sync_at")) {
        return {
          rows: [{
            id: pageId,
            platform: "fansly",
            lastLightSyncAt: now,
            lastFollowerSyncAt: now,
            followerCount: 0,
            activeFollowerCount: 0,
          }],
        };
      }

      if (rendered.includes('from "page_sync_states"')) {
        return { rows: existingRows };
      }

      return { rows: [] };
    });
    const insert = vi.fn();
    const db = {
      execute,
      insert,
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ execute })),
    } as never;

    const result = await requestPageSync(db, {
      pageId,
      streams: ["dm_messages", "transactions", "light", "transactions", "dm_conversations"],
      source: "manual",
      now,
    });

    expect(insert).not.toHaveBeenCalled();
    expect(result.map((row) => row.stream)).toEqual([
      "light",
      "transactions",
      "dm_conversations",
      "dm_messages",
    ]);
    expect(lockedStatements).toHaveLength(1);
    expectPageSyncLockOrder(lockedStatements[0]!);
    expect(lockedStatements[0]).toContain("for update");
    expect(updatedStreams).toEqual([
      "light",
      "transactions",
      "dm_conversations",
      "dm_messages",
    ]);
  });

  it("manual multi-stream controls update rows in normalized stream order", async () => {
    const now = new Date("2026-03-24T12:00:00.000Z");
    const pageId = 55;
    const requestedStreams: SyncStream[] = ["dm_messages", "transactions", "light", "transactions", "dm_conversations"];

    async function captureControlQueryOrder(
      run: (db: never) => Promise<void>,
    ) {
      const updatedStreams: unknown[] = [];
      const lockedStatements: string[] = [];
      const execute = vi.fn(async (query: SQL) => {
        const rendered = DIALECT.sqlToQuery(query).sql;
        const params = DIALECT.sqlToQuery(query).params;

        if (rendered.includes('from "page_sync_states"') && rendered.includes("for update")) {
          lockedStatements.push(rendered);
        }
        if (rendered.includes('update "page_sync_states"') && rendered.includes("stream = $")) {
          updatedStreams.push(findStreamParam(params));
        }

        return { rows: [] };
      });
      const db = {
        execute: vi.fn(),
        transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ execute })),
      } as never;

      await run(db);

      expect((db as { transaction: ReturnType<typeof vi.fn> }).transaction).toHaveBeenCalledTimes(1);
      return { lockedStatements, updatedStreams };
    }

    const pauseControl = await captureControlQueryOrder((db) => pausePageSync(db, {
      pageId,
      streams: requestedStreams,
      now,
    }));
    expect(pauseControl.lockedStatements).toHaveLength(1);
    expectPageSyncLockOrder(pauseControl.lockedStatements[0]!);
    expect(pauseControl.lockedStatements[0]).toContain("for update");
    expect(pauseControl.updatedStreams).toEqual([
      "light",
      "transactions",
      "dm_conversations",
      "dm_messages",
    ]);

    const resumeControl = await captureControlQueryOrder((db) => resumePageSync(db, {
      pageId,
      streams: requestedStreams,
      now,
    }));
    expect(resumeControl.lockedStatements).toHaveLength(1);
    expectPageSyncLockOrder(resumeControl.lockedStatements[0]!);
    expect(resumeControl.lockedStatements[0]).toContain("for update");
    expect(resumeControl.updatedStreams).toEqual([
      "light",
      "transactions",
      "dm_conversations",
      "dm_messages",
    ]);

    const resetControl = await captureControlQueryOrder((db) => resetPageSync(db, {
      pageId,
      streams: requestedStreams,
      now,
    }));

    expect(resetControl.lockedStatements).toHaveLength(1);
    expectPageSyncLockOrder(resetControl.lockedStatements[0]!);
    expect(resetControl.lockedStatements[0]).toContain("for update");
    expect(resetControl.updatedStreams).toEqual([
      "light",
      "transactions",
      "dm_conversations",
      "dm_messages",
    ]);
  });
});
