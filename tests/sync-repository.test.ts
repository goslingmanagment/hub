import { describe, expect, it, vi } from "vitest";

import {
  computeSyncStreamSlotOffsetSeconds,
  getSyncRun,
  listRecentSyncRuns,
  listRunningSyncRuns,
  listSyncRequestAttempts,
  listSyncRunEvents,
  reserveSyncProviderRateLimit,
  resolveSyncRequestPriority,
} from "../packages/db/src/repositories/sync.ts";

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
    expect(resolveSyncRequestPriority("followers_reconcile", "anomaly")).toBe(45);
    expect(resolveSyncRequestPriority("light", "manual")).toBeGreaterThan(
      resolveSyncRequestPriority("light", "scheduled"),
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
});
