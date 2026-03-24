import { describe, expect, it, vi } from "vitest";

import {
  countRecentTerminalDmMessageConversationFailureStreak,
  computeSyncStreamSlotOffsetSeconds,
  ensureSyncProviderRateLimitProfile,
  getSyncRun,
  hasRecentTerminalProxyFailure,
  listRecentSyncRuns,
  listRunningSyncRuns,
  listSyncRequestAttempts,
  listSyncRunEvents,
  rebalanceSyncStreamPriorities,
  reserveSyncProviderRateLimit,
  resolveSyncRequestPriority,
} from "../packages/db/src/repositories/sync.ts";

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

  it("counts the recent terminal dm_messages 5xx streak per conversation", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          logicalRequestId: "messages:3",
          terminalState: "failed",
          httpStatus: 503,
          terminalAt: "2026-03-10T10:03:00.000Z",
        },
        {
          logicalRequestId: "messages:2",
          terminalState: "failed",
          httpStatus: 500,
          terminalAt: "2026-03-10T10:02:00.000Z",
        },
        {
          logicalRequestId: "messages:1",
          terminalState: "success",
          httpStatus: 200,
          terminalAt: "2026-03-10T10:01:00.000Z",
        },
      ],
    });
    const db = {
      execute,
    } as never;

    const streak = await countRecentTerminalDmMessageConversationFailureStreak(db, {
      platformAccountId: 55,
      platformConversationId: "group-1",
      limit: 10,
    });

    expect(streak).toBe(2);

    const query = execute.mock.calls[0]?.[0];
    expect(extractSqlText(query)).toContain("a.state in ('success', 'failed')");
    expect(extractSqlText(query)).toContain("a.request_shape ->> 'groupId'");
    expect(extractQueryParams(query)).toEqual(expect.arrayContaining([
      55,
      "group-1",
      10,
    ]));
  });

  it("stops the dm_messages failure streak on the first non-5xx terminal result", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          logicalRequestId: "messages:4",
          terminalState: "failed",
          httpStatus: 502,
          terminalAt: "2026-03-10T10:04:00.000Z",
        },
        {
          logicalRequestId: "messages:3",
          terminalState: "failed",
          httpStatus: 404,
          terminalAt: "2026-03-10T10:03:00.000Z",
        },
        {
          logicalRequestId: "messages:2",
          terminalState: "failed",
          httpStatus: 500,
          terminalAt: "2026-03-10T10:02:00.000Z",
        },
      ],
    });
    const db = {
      execute,
    } as never;

    const streak = await countRecentTerminalDmMessageConversationFailureStreak(db, {
      platformAccountId: 55,
      platformConversationId: "group-1",
    });

    expect(streak).toBe(1);
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
    expect(resolveSyncRequestPriority("followers", "scheduled")).toBeGreaterThan(
      resolveSyncRequestPriority("dm_conversations", "scheduled"),
    );
    expect(resolveSyncRequestPriority("followers", "manual")).toBeGreaterThan(
      resolveSyncRequestPriority("dm_messages", "manual"),
    );
    expect(resolveSyncRequestPriority("followers_reconcile", "anomaly")).toBe(44);
    expect(resolveSyncRequestPriority("light", "manual")).toBeGreaterThan(
      resolveSyncRequestPriority("light", "scheduled"),
    );
  });

  it("rebalances existing stream-state priorities using pending reasons without touching revisions", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = { execute } as never;
    const now = new Date("2026-03-24T12:00:00.000Z");

    await rebalanceSyncStreamPriorities(db, {
      platformAccountId: 55,
      now,
    });

    const query = execute.mock.calls[0]?.[0];
    const sqlText = extractSqlText(query);
    const params = extractQueryParams(query);

    expect(sqlText).toContain("update sync_stream_state");
    expect(sqlText).toContain("set base_priority =");
    expect(sqlText).toContain("case stream");
    expect(sqlText).toContain("effective_priority = case");
    expect(sqlText).toContain("pending_reason");
    expect(sqlText).not.toContain("desired_revision =");
    expect(sqlText).not.toContain("satisfied_revision =");
    expect(params).toContain(55);
    expect(params).toContain(now);
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
          minSpacingMs: 7_500,
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
        { scope: "dm_messages", minSpacingMs: 7_500 },
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
      7_500,
      now,
    ]));
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
});
