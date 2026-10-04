import { describe, expect, it, vi } from "vitest";

import {
  computeSyncStreamSlotOffsetSeconds,
  ensureSyncProviderRateLimitProfile,
  getSyncRun,
  hasRecentTerminalProxyFailure,
  listPageSyncStates,
  listRunnablePageSync,
  listSyncMonitorStreamRows,
  listRecentSyncRuns,
  listRunningSyncRuns,
  listSyncRequestAttempts,
  listSyncRunEvents,
  reserveSyncProviderRateLimit,
  resolvePageSyncPriority,
} from "../packages/db/src/repositories/sync.ts";
import type { SQL } from "../packages/db/node_modules/drizzle-orm/index.js";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";

import { EVERY_PLATFORM } from "./helpers/page-sync-scope.ts";

const DIALECT = new PgDialect();

function renderSql(query: SQL) {
  return DIALECT.sqlToQuery(query).sql;
}

function extractQueryParams(query: {
  queryChunks?: unknown[];
}): unknown[] {
  const chunks = query.queryChunks ?? [];
  const values: unknown[] = [];

  for (const chunk of chunks) {
    if (typeof chunk === "object" && chunk !== null) {
      if ("queryChunks" in chunk && Array.isArray(chunk.queryChunks)) {
        values.push(...extractQueryParams(chunk as { queryChunks?: unknown[] }));
        continue;
      }

      if ("value" in chunk) {
        continue;
      }
    }

    values.push(chunk);
  }

  return values;
}

function extractSqlText(query: {
  queryChunks?: Array<{
    value?: string[];
  }>;
}): string {
  const chunks = query.queryChunks ?? [];
  return chunks.flatMap((chunk) => {
    if (typeof chunk === "object" && chunk !== null) {
      if ("queryChunks" in chunk && Array.isArray(chunk.queryChunks)) {
        return extractSqlText(chunk as { queryChunks?: Array<{ value?: string[] }> });
      }

      if ("value" in chunk && Array.isArray(chunk.value)) {
        return chunk.value;
      }
    }

    return [];
  }).join("");
}

describe("sync repository timestamp normalization", () => {

  it("normalizes run timestamps returned from raw sync run queries", async () => {
    const execute = vi.fn();
    const db = {
      execute,
    } as never;

    execute
      .mockResolvedValueOnce({
        rows: [{
          runId: 8,
          platformAccountId: 1,
          pageLabel: "lana",
          platform: "fansly",
          stream: "light",
          trigger: "cli",
          status: "success",
          startedAt: "2026-03-10T10:00:00.000Z",
          finishedAt: "2026-03-10T10:00:05.000Z",
          errorSummary: null,
          stats: { health: "healthy" },
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          runId: 8,
          platformAccountId: 1,
          pageLabel: "lana",
          platform: "fansly",
          stream: "light",
          trigger: "cli",
          status: "success",
          startedAt: "2026-03-10T10:00:00.000Z",
          finishedAt: null,
          errorSummary: null,
          stats: { health: "healthy" },
        }],
      });

    const recentRuns = await listRecentSyncRuns(db, { limit: 1 });
    const run = await getSyncRun(db, 8);

    expect(recentRuns[0]?.startedAt).toBeInstanceOf(Date);
    expect(recentRuns[0]?.finishedAt).toBeInstanceOf(Date);
    expect(run?.startedAt).toBeInstanceOf(Date);
    expect(run?.finishedAt).toBeNull();
  });

  it("normalizes event and request timestamps returned from raw observability queries", async () => {
    const execute = vi.fn();
    const db = {
      execute,
    } as never;

    execute
      .mockResolvedValueOnce({
        rows: [{
          id: 11,
          runId: 8,
          platformAccountId: 1,
          pageLabel: "lana",
          provider: "fansly",
          stream: "light",
          eventType: "run_started",
          severity: "info",
          message: "Sync run started",
          details: {},
          emittedAt: "2026-03-10T10:00:00.000Z",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          attemptId: 21,
          runId: 8,
          platformAccountId: 1,
          pageLabel: "lana",
          provider: "fansly",
          stream: "light",
          operation: "account_me",
          logicalRequestId: "account_me:8",
          attemptNumber: 1,
          state: "success",
          failureKind: null,
          httpStatus: 200,
          retryDelayMs: null,
          durationMs: 120,
          requestShape: {},
          responseShape: {},
          errorMessage: null,
          startedAt: "2026-03-10T10:00:00.000Z",
          finishedAt: "2026-03-10T10:00:00.120Z",
        }],
      });

    const events = await listSyncRunEvents(db, { runId: 8, limit: 5 });
    const attempts = await listSyncRequestAttempts(db, { runId: 8, limit: 5 });

    expect(events[0]?.emittedAt).toBeInstanceOf(Date);
    expect(attempts[0]?.startedAt).toBeInstanceOf(Date);
    expect(attempts[0]?.finishedAt).toBeInstanceOf(Date);
  });

  it("checks only the latest request attempts when detecting terminal proxy failures", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{
        hasFailure: true,
      }],
    });
    const db = {
      execute,
    } as never;

    const hasFailure = await hasRecentTerminalProxyFailure(db, {
      runId: 8,
      limit: 2_000,
    });

    expect(hasFailure).toBe(true);

    const query = execute.mock.calls[0]?.[0];
    expect(extractSqlText(query)).toContain("order by a.started_at desc, a.id desc");
    expect(extractQueryParams(query)).toContain(8);
    expect(extractQueryParams(query)).toContain(2_000);
  });

  it("normalizes last activity timestamps for running run snapshots", async () => {
    const execute = vi.fn();
    const db = {
      execute,
    } as never;

    execute.mockResolvedValueOnce({
      rows: [{
        runId: 9,
        platformAccountId: 1,
        pageLabel: "lana",
        platform: "fansly",
        stream: "light",
        trigger: "worker",
        status: "running",
        startedAt: "2026-03-10T10:10:00.000Z",
        finishedAt: null,
        errorSummary: null,
        stats: {},
        lastActivityAt: "2026-03-10T10:10:03.000Z",
      }],
    });

    const runningRuns = await listRunningSyncRuns(db, { limit: 5 });

    expect(runningRuns[0]?.startedAt).toBeInstanceOf(Date);
    expect(runningRuns[0]?.lastActivityAt).toBeInstanceOf(Date);
  });

  it("derives deterministic slot jitter and request priorities for control-plane streams", () => {
    expect(computeSyncStreamSlotOffsetSeconds(42, "light")).toBe(
      computeSyncStreamSlotOffsetSeconds(42, "light"),
    );
    expect(computeSyncStreamSlotOffsetSeconds(42, "light")).not.toBe(
      computeSyncStreamSlotOffsetSeconds(42, "followers"),
    );
    expect(resolvePageSyncPriority("transactions", "scheduled")).toBeGreaterThan(
      resolvePageSyncPriority("top_spenders", "scheduled"),
    );
    expect(resolvePageSyncPriority("top_spenders", "manual")).toBeGreaterThan(
      resolvePageSyncPriority("subscribers", "manual"),
    );
    expect(resolvePageSyncPriority("followers", "scheduled")).toBeGreaterThan(
      resolvePageSyncPriority("dm_conversations", "scheduled"),
    );
    expect(resolvePageSyncPriority("followers", "manual")).toBeGreaterThan(
      resolvePageSyncPriority("dm_messages", "manual"),
    );
    expect(resolvePageSyncPriority("followers_reconcile", "anomaly")).toBe(44);
    expect(resolvePageSyncPriority("light", "manual")).toBeGreaterThan(
      resolvePageSyncPriority("light", "scheduled"),
    );
  });

  it("reserves shared provider rate-limit rows at the latest available slot", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          provider: "fansly",
          scope: "global",
          egressKey: "global",
          minSpacingMs: 2_600,
          nextAvailableAt: new Date("2026-03-14T12:00:01.000Z"),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          provider: "fansly",
          scope: "followers_page",
          egressKey: "global",
          minSpacingMs: 5_000,
          nextAvailableAt: new Date("2026-03-14T12:00:03.000Z"),
        }],
      })
      .mockResolvedValue({ rows: [] });
    const db = {
      transaction: async (run: (tx: unknown) => Promise<Date>) => run({ execute }),
    } as never;

    const reservedAt = await reserveSyncProviderRateLimit(db, {
      scopes: [
        { provider: "fansly", scope: "global", egressKey: "global" },
        { provider: "fansly", scope: "followers_page", egressKey: "global" },
      ],
      now: new Date("2026-03-14T12:00:00.000Z"),
    });

    expect(reservedAt.toISOString()).toBe("2026-03-14T12:00:03.000Z");
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("normalizes string next_available_at values before computing reservations", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          provider: "fansly",
          scope: "global",
          egressKey: "global",
          minSpacingMs: 2_600,
          nextAvailableAt: "2026-03-14T12:00:01.000Z",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          provider: "fansly",
          scope: "dm_messages",
          egressKey: "global",
          minSpacingMs: 5_000,
          nextAvailableAt: "2026-03-14T12:00:03.000Z",
        }],
      })
      .mockResolvedValue({ rows: [] });
    const db = {
      transaction: async (run: (tx: unknown) => Promise<Date>) => run({ execute }),
    } as never;

    const reservedAt = await reserveSyncProviderRateLimit(db, {
      scopes: [
        { provider: "fansly", scope: "global", egressKey: "global" },
        { provider: "fansly", scope: "dm_messages", egressKey: "global" },
      ],
      now: new Date("2026-03-14T12:00:00.000Z"),
    });

    expect(reservedAt.toISOString()).toBe("2026-03-14T12:00:03.000Z");
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("upserts per-egress rate-limit profiles without resetting next_available_at", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = {
      execute,
    } as never;
    const now = new Date("2026-03-14T12:00:00.000Z");

    await ensureSyncProviderRateLimitProfile(db, {
      provider: "fansly",
      egressKey: "socks5://proxy.example:1080",
      scopes: [
        { scope: "global", minSpacingMs: 2_600 },
        { scope: "dm_conversations", minSpacingMs: 5_000 },
        { scope: "dm_messages", minSpacingMs: 5_000 },
      ],
      now,
    });

    expect(execute).toHaveBeenCalledTimes(1);

    const query = execute.mock.calls[0]?.[0];
    expect(extractSqlText(query)).toContain("on conflict (provider, scope, egress_key) do update");
    expect(extractSqlText(query)).toContain("min_spacing_ms = excluded.min_spacing_ms");
    expect(extractSqlText(query)).not.toContain("next_available_at");
    expect(extractQueryParams(query)).toEqual(expect.arrayContaining([
      "fansly",
      "global",
      "socks5://proxy.example:1080",
      2_600,
      "dm_conversations",
      5_000,
      "dm_messages",
      5_000,
      now,
    ]));
  });

  it("reads runnable sync pages from the canonical page_sync_states table", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = { execute } as never;
    const now = new Date("2026-03-24T12:00:00.000Z");

    await listRunnablePageSync(db, now, { platforms: EVERY_PLATFORM });

    const query = execute.mock.calls[0]?.[0];

    expect(extractSqlText(query)).toContain('with runnable_streams as (');
    expect(extractSqlText(query)).toContain('select st.page_id as "pageId"');
    expect(extractQueryParams(query)).toContain(now);
  });

  it("counts capped DM message windows as ready in monitor rows", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = { execute } as never;

    await listSyncMonitorStreamRows(db, {
      pageIds: [55],
      windowStart: new Date("2026-03-24T12:00:00.000Z"),
    });

    const query = execute.mock.calls[0]?.[0];
    const sqlText = extractSqlText(query);

    expect(sqlText).toContain("c.message_coverage_status in (");
    expect(sqlText).toContain("'complete'::dm_message_coverage_status");
    expect(sqlText).toContain("'partial_window'::dm_message_coverage_status");
  });

  it("scopes monitor rate-limit rows to the page egress key", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = { execute } as never;

    await listSyncMonitorStreamRows(db, {
      pageIds: [55],
      windowStart: new Date("2026-03-24T12:00:00.000Z"),
    });

    const query = execute.mock.calls[0]?.[0];
    const sqlText = extractSqlText(query);
    const renderedSql = renderSql(query as SQL);

    expect(renderedSql).toContain('"egress_endpoints"."rate_limit_scope_key"');
    expect(renderedSql).toContain('canonical_proxy_egress_key("egress_endpoints"."url")');
    expect(sqlText).toContain('left join  on  = ');
    expect(sqlText).toContain('rl.egress_key as "egressKey"');
    expect(sqlText).toContain('group by rl.provider, rl.egress_key');
    expect(sqlText).toContain('and prl."egressKey" = ps."egressKey"');
  });

  it("derives physical request health from attempts instead of logical chunks", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = { execute } as never;

    await listSyncMonitorStreamRows(db, {
      pageIds: [55],
      windowStart: new Date("2026-03-24T12:00:00.000Z"),
    });

    const sqlText = extractSqlText(execute.mock.calls[0]?.[0]);
    expect(sqlText).toContain("attempts_with_last_success as (");
    expect(sqlText).toContain("physical_attempt_health as (");
    expect(sqlText).toContain('as "recentPhysicalAttemptCount"');
    expect(sqlText).toContain('as "recentPhysicalSuccessCount"');
    expect(sqlText).toContain('as "stalePhysicalAttemptCount"');
    expect(sqlText).toContain('as "physicalAttemptsSinceLastSuccess"');
    expect(sqlText).toContain("attempts.\"state\" in ('retry', 'failed')");
    expect(sqlText).toContain("attempts.\"state\" = 'started'");
  });

  it("sorts rate-limit locks deterministically before taking row locks", async () => {
    const lockedScopes: Array<[unknown, unknown, unknown]> = [];
    const execute = vi.fn().mockImplementation(async (query) => {
      const sqlText = extractSqlText(query);
      if (!sqlText.includes("for update")) {
        return { rows: [] };
      }

      const [provider, scope, egressKey] = extractQueryParams(query);
      lockedScopes.push([provider, scope, egressKey]);
      return {
        rows: [{
          provider,
          scope,
          egressKey,
          minSpacingMs: 1_000,
          nextAvailableAt: new Date("2026-03-14T12:00:00.000Z"),
        }],
      };
    });
    const db = {
      transaction: async (run: (tx: unknown) => Promise<Date>) => run({ execute }),
    } as never;

    await reserveSyncProviderRateLimit(db, {
      scopes: [
        { provider: "onlyfans", scope: "global", egressKey: "direct" },
        { provider: "fansly", scope: "global", egressKey: "direct" },
        { provider: "fansly", scope: "dm_conversations", egressKey: "socks5://proxy-a:1080" },
      ],
      now: new Date("2026-03-14T12:00:00.000Z"),
    });

    expect(lockedScopes).toEqual([
      ["fansly", "dm_conversations", "socks5://proxy-a:1080"],
      ["fansly", "global", "direct"],
      ["onlyfans", "global", "direct"],
    ]);
  });

  it("parameterizes runtime stream filters instead of interpolating them into SQL", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = { execute } as never;
    const injected = "light'::sync_stream[]); drop table page_sync_states; --";

    await listPageSyncStates(db, {
      pageId: 55,
      streams: [injected as never],
    });

    const query = execute.mock.calls[0]?.[0];
    expect(extractSqlText(query)).not.toContain("drop table page_sync_states");
    expect(extractQueryParams(query)).toEqual(expect.arrayContaining([
      55,
      injected,
    ]));
  });
});
