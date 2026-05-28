import { describe, expect, it, vi } from "vitest";

import {
  acquirePageSyncLease,
  computePageSyncSlotOffsetSeconds,
  heartbeatPageSyncLease,
  listPageSyncStates,
  listRunnablePageSync,
  normalizePageSyncRequestStreams,
  requestPageSync,
  SYNC_STREAM_POLICY,
  type SyncStream,
} from "../packages/db/src/repositories/page-sync.ts";
import { sql, type SQL } from "../packages/db/node_modules/drizzle-orm/index.js";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { pageSyncStates } from "../packages/db/src/schema.ts";

const DIALECT = new PgDialect();

function renderSql(query: SQL) {
  return DIALECT.sqlToQuery(query).sql;
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

  it("requestPageSync takes row locks in normalized stream order", async () => {
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
    ].map((stream) => buildPageSyncStateRow(pageId, stream as SyncStream, now));
    const lockedStreams: unknown[] = [];
    const execute = vi.fn(async (query: SQL) => {
      const rendered = DIALECT.sqlToQuery(query).sql;
      const params = DIALECT.sqlToQuery(query).params;

      if (rendered.includes("for update")) {
        lockedStreams.push(params[1]);
        return {
          rows: [{
            requestSeq: 0,
            status: "idle",
          }],
        };
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
    expect(lockedStreams).toEqual([
      "light",
      "transactions",
      "dm_conversations",
      "dm_messages",
    ]);
  });
});
