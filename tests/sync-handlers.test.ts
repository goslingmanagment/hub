import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as FanHydrationModule from "../apps/runtime/src/services/sync/fan-hydration.ts";
import type * as FanHydrationWritersModule from "../apps/runtime/src/sync/fansly/lib/fan-hydration.ts";

const dbMocks = vi.hoisted(() => ({
  // The transactions executor now resolves live effective config (one read per
  // chunk); these chunk tests use a bare db so stub it to "no overrides".
  getConfigOverrides: vi.fn(async () => new Map()),
  countActivePageFollows: vi.fn(),
  countCurrentPageSubscriptionsByGeneration: vi.fn(),
  countPageFollowsByGeneration: vi.fn(),
  deactivatePageFollowsByGeneration: vi.fn(),
  deactivatePageSubscriptionsByGeneration: vi.fn(),
  getCheckpoint: vi.fn(),
  getCurrentSubscribers: vi.fn(),
  maxPageFollowGeneration: vi.fn(),
  maxPageSubscriptionGeneration: vi.fn(),
  rebuildFollowerRollups: vi.fn(),
  rebuildSubscriberRollups: vi.fn(),
  readPageFollowDeactivationGenerationBuckets: vi.fn(),
  readPageFollowReconcileActivity: vi.fn(),
  requestPageSync: vi.fn(),
  updatePageSyncTimestampCache: vi.fn(),
  upsertArchivedPageSubscriptions: vi.fn(),
  upsertCheckpoint: vi.fn(),
  upsertCheckpointProgress: vi.fn(),
  upsertFanPageExternalPresences: vi.fn(),
  upsertFanPages: vi.fn(),
  upsertFans: vi.fn(),
  upsertPageFollows: vi.fn(),
  upsertPageSubscriptions: vi.fn(),
  refreshFanPageFollowerState: vi.fn(),
  refreshFanPageSubscriberState: vi.fn(),
}));


// The capture trims and their capture-shape versions are pure helpers
// (apps/runtime/src/sync/fansly/lib/) and run for real.
const sharedMocks = vi.hoisted(() => ({
  persistRawPayload: vi.fn(),
  refreshPageMetadata: vi.fn(),
  retentionDate: vi.fn(() => new Date("2026-09-10T00:00:00.000Z")),
}));

const fanHydrationMocks = vi.hoisted(() => ({
  hydrateFans: vi.fn(),
  lookupHydratedFans: vi.fn(),
  upsertHydratedFansForPage: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});
vi.mock("../apps/runtime/src/services/sync/shared.ts", () => sharedMocks);
vi.mock("../apps/runtime/src/services/sync/fan-hydration.ts", async () => {
  const actual = await vi.importActual<typeof FanHydrationModule>(
    "../apps/runtime/src/services/sync/fan-hydration.ts",
  );
  return {
    ...actual,
    hydrateFans: fanHydrationMocks.hydrateFans,
    lookupHydratedFans: fanHydrationMocks.lookupHydratedFans,
  };
});
vi.mock("../apps/runtime/src/sync/fansly/lib/fan-hydration.ts", async () => {
  const actual = await vi.importActual<typeof FanHydrationWritersModule>(
    "../apps/runtime/src/sync/fansly/lib/fan-hydration.ts",
  );
  return {
    ...actual,
    upsertHydratedFansForPage: fanHydrationMocks.upsertHydratedFansForPage,
  };
});

import {
  executeFollowersChunk,
  executeFollowersReconcileChunk,
  executeStreamChunk,
  fanslySubscribersChunk,
  onlyfansTransactionsChunk,
} from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";

function createTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    getRequestObserver: vi.fn(() => null),
  };
}

async function recordStartedRequest(requestObserver: { onRequestEvent(event: unknown): Promise<void> } | null | undefined, operation: string) {
  await requestObserver?.onRequestEvent({
    requestId: `${operation}-request`,
    operation,
    endpointTemplate: `/${operation}`,
    method: "GET",
    attemptNumber: 1,
    timestamp: new Date("2026-03-10T00:00:00.000Z"),
    state: "started",
  });
}

const FOLLOWER_SWEEP_STARTED_AT = "2026-08-24T20:00:00.000Z";

describe("sync executor handlers", () => {
  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) {
      if (typeof mock === "function" && "mockReset" in mock) {
        mock.mockReset();
      }
    }
    sharedMocks.persistRawPayload.mockReset();
    sharedMocks.refreshPageMetadata.mockReset();
    fanHydrationMocks.hydrateFans.mockReset();
    fanHydrationMocks.lookupHydratedFans.mockReset();
    fanHydrationMocks.upsertHydratedFansForPage.mockReset();

    dbMocks.upsertCheckpointProgress.mockResolvedValue({});
    dbMocks.upsertCheckpoint.mockResolvedValue({});
    dbMocks.maxPageFollowGeneration.mockResolvedValue(0);
    dbMocks.maxPageSubscriptionGeneration.mockResolvedValue(0);
    dbMocks.countPageFollowsByGeneration.mockResolvedValue(0);
    dbMocks.readPageFollowDeactivationGenerationBuckets.mockResolvedValue([]);
    dbMocks.deactivatePageFollowsByGeneration.mockResolvedValue([]);
    dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
      firstSeenDuringSweepOutsideGeneration: 0,
      activeFollowerCount: 0,
      deactivationCandidateCount: 0,
    });
    dbMocks.rebuildFollowerRollups.mockResolvedValue(undefined);
    dbMocks.rebuildSubscriberRollups.mockResolvedValue(undefined);
    dbMocks.updatePageSyncTimestampCache.mockResolvedValue(undefined);
    dbMocks.upsertFanPages.mockResolvedValue(undefined);
    dbMocks.upsertFanPageExternalPresences.mockResolvedValue(undefined);
    dbMocks.upsertFans.mockResolvedValue([]);
    dbMocks.upsertPageFollows.mockResolvedValue(undefined);
    dbMocks.upsertArchivedPageSubscriptions.mockResolvedValue(undefined);
    dbMocks.upsertPageSubscriptions.mockResolvedValue(undefined);
    dbMocks.refreshFanPageFollowerState.mockResolvedValue(undefined);
    dbMocks.refreshFanPageSubscriberState.mockResolvedValue(undefined);
    sharedMocks.persistRawPayload.mockResolvedValue({
      id: 444,
      capturedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    fanHydrationMocks.hydrateFans.mockResolvedValue(new Map());
    fanHydrationMocks.lookupHydratedFans.mockImplementation(async (
      app: { adapter?: { getAccountsByIdsPage?: ((requestContext: unknown, ids: string[]) => Promise<{ parsed: Array<{ id: string; username: string | null; displayName: string | null; createdAt?: number | null }> }>) | undefined } },
      input: {
        requestContext: unknown;
        platformUserIds: string[];
      },
    ) => {
      const uniqueIds = Array.from(new Set(input.platformUserIds.filter(Boolean)));

      if (typeof app.adapter?.getAccountsByIdsPage === "function") {
        const response = await app.adapter.getAccountsByIdsPage(input.requestContext, uniqueIds);
        const accounts = response.parsed;
        return {
          accounts,
          fallbackIds: uniqueIds.filter((id) => !accounts.some((account) => account.id === id)),
          reusedIds: [],
          lookup: null,
        };
      }

      return {
        accounts: uniqueIds.map((id) => ({
          id,
          username: id,
          displayName: id,
          createdAt: 1_770_000_000_000,
        })),
        fallbackIds: [],
        reusedIds: [],
        lookup: null,
      };
    });
    fanHydrationMocks.upsertHydratedFansForPage.mockImplementation(async (
      db: object,
      input: {
        platformAccountId: number;
        accounts: Array<{
          id: string;
          username: string | null;
          displayName: string | null;
          createdAt?: number | null;
        }>;
        fallbackIds?: string[];
        unverifiedIds?: string[];
      },
    ) => {
      const fans: Array<{ id: number; platformUserId: string }> = await dbMocks.upsertFans(db, [
        ...input.accounts.map((account: {
          id: string;
          username: string | null;
          displayName: string | null;
          createdAt?: number | null;
        }) => ({
          platform: "fansly" as const,
          platformUserId: account.id,
          username: account.username,
          displayName: account.displayName,
          createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
          metadata: {},
        })),
        ...(input.fallbackIds ?? []).map((platformUserId: string) => ({
          platform: "fansly" as const,
          platformUserId,
          metadata: {},
        })),
        ...(input.unverifiedIds ?? []).map((platformUserId: string) => ({
          platform: "fansly" as const,
          platformUserId,
        })),
      ]);

      if (fans.length > 0) {
        await dbMocks.upsertFanPages(db, fans.map((fan: { id: number; platformUserId: string }) => ({
          fanId: fan.id,
          platformAccountId: input.platformAccountId,
        })));
      }

      return new Map(fans.map((fan: { id: number; platformUserId: string }) => [fan.platformUserId, fan.id] as const));
    });
  });

  it("rejects the retired history stream before registry dispatch", async () => {
    const telemetry = createTelemetry();
    await expect(executeStreamChunk({
      db: {},
      config: {
        onlyFansDmPollingEnabled: false,
      },
    } as never, {
      pageContext: {
        platform: "onlyfans",
        page: {
          id: 55,
          label: "onlyfans-page",
          platformAccountId: "of-55",
          metadata: {},
        },
        auth: { token: "secret" },
        proxy: null,
      },
      streamState: {
        stream: "dm_messages",
      },
      syncRunId: 910,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never)).rejects.toThrow(/Unsupported executor stream "dm_messages"/);
    expect(telemetry.addNote).not.toHaveBeenCalled();
  });

  it("guards against destructive subscriber finalization on an empty first page", async () => {
    const telemetry = createTelemetry();
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getSubscribersPage: vi.fn(async () => ({
          total: 0,
          items: [],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.getCurrentSubscribers.mockResolvedValue({
      rows: [{ id: 1 }],
    });
    fanHydrationMocks.hydrateFans.mockResolvedValue(new Map());

    await expect(fanslySubscribersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 10,
          label: "fansly-page",
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        requestSeq: 5,
      },
      syncRunId: 100,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never)).rejects.toThrow("refusing destructive finalization");

    expect(telemetry.addAnomaly).toHaveBeenCalledTimes(1);
    expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
  });

  it("guards against destructive subscriber finalization on a partial non-empty first page", async () => {
    const telemetry = createTelemetry();
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback({})),
    };
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getSubscribersPage: vi.fn(async () => ({
          total: 2,
          items: [{
            id: "sub-1",
            subscriberId: "fan-1",
            historyId: null,
            subscriptionTierId: null,
            subscriptionTierName: null,
            subscriptionTierColor: null,
            planId: null,
            status: 3,
            price: 5000,
            renewPrice: 5000,
            autoRenew: 1,
            billingCycle: 30,
            duration: 30,
            renewDate: null,
            createdAt: new Date("2026-03-10T00:00:00.000Z").toISOString(),
            updatedAt: null,
            endsAt: new Date("2026-04-09T00:00:00.000Z").toISOString(),
          }],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);

    await expect(fanslySubscribersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 10,
          label: "fansly-page",
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        requestSeq: 5,
      },
      syncRunId: 100,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never)).rejects.toThrow("refusing destructive finalization");

    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "subscribers_partial_page_guard",
      details: {
        providerReportedTotal: 2,
        observedCount: 1,
        pageCount: 1,
        mode: "active",
      },
    }));
    expect(db.transaction).not.toHaveBeenCalled();
    expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  });

  it("promotes followers_reconcile when follower drift is detected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T01:00:00.000Z"));

    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const app = {
      db,
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getFollowersPage: vi.fn(async () => ({
          items: [{
            id: "1000",
            followerId: "fan-1",
            lastSeenAt: 1_775_782_500_000,
          }],
          accounts: [{
            id: "fan-1",
            username: "fan_1",
            displayName: "Fan 1",
            createdAt: 1_770_000_000_000,
            lastSeenAt: 1_775_782_500_000,
          }],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      cursorText: "known-follow",
      state: {
        revision: 3,
        knownFollowId: "known-follow",
        newestFollowId: null,
        offset: 0,
        pageCount: 0,
        sourceFollowerCount: 1,
      },
    });
    dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);
    dbMocks.countActivePageFollows.mockResolvedValue(0);
    dbMocks.requestPageSync.mockResolvedValue([{
      stream: "followers_reconcile",
      requestedSeq: 7,
      coalesced: true,
      queueBefore: { requestedSeq: 7, appliedSeq: 6 },
    }]);

    try {
      const result = await executeFollowersChunk(app, {
        pageContext: {
          platform: "fansly",
          page: {
            id: 12,
            label: "fansly-page",
            platformAccountId: "acct-12",
            metadata: {},
          },
          session: { authorization: "token" },
          proxy: null,
        },
        streamState: {
          requestSeq: 3,
        },
        syncRunId: 101,
        telemetry: telemetry as never,
        budget: new SyncChunkBudget(),
      } as never);

      expect(result.satisfied).toBe(true);
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(dbMocks.upsertPageFollows).toHaveBeenCalledWith(tx, expect.any(Array));
      expect(dbMocks.upsertFanPages).toHaveBeenCalledWith(tx, expect.any(Array));
      expect(dbMocks.upsertFanPageExternalPresences).toHaveBeenCalledWith(tx, [{
        fanId: 91,
        platformAccountId: 12,
        externalPresenceAt: expect.any(Date),
        externalPresenceObservedAt: expect.any(Date),
        externalPresenceSource: "fansly_followers_last_seen",
      }]);
      expect(dbMocks.rebuildFollowerRollups).toHaveBeenCalledWith(tx, 12, 1);
      expect(dbMocks.updatePageSyncTimestampCache).toHaveBeenCalledWith(tx, {
        pageId: 12,
        syncType: "followers",
      });
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
        platformAccountId: 12,
        stream: "followers",
      }));
      expect(dbMocks.countActivePageFollows).toHaveBeenCalledWith(db, 12);
      expect(dbMocks.requestPageSync).toHaveBeenCalledWith(db, {
        pageId: 12,
        streams: ["followers_reconcile"],
        source: "anomaly",
        includeQueueState: true,
        coalesceOutstanding: true,
      });
      expect(telemetry.addNote).toHaveBeenCalledWith("Fansly followers reconcile decision", {
        followersReconcile: expect.objectContaining({
          countMismatch: true,
          requested: true,
          requestedSeq: 7,
          queueBefore: { requestedSeq: 7, appliedSeq: 6 },
          coalesced: true,
        }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  describe("the daily floor on a fresh follower walk", () => {
    const HOUR_MS = 60 * 60 * 1000;
    const walked = new Error("the walk began");

    function floorFixture(input: {
      checkpointState: Record<string, unknown> | null;
      requestSeq: number;
      requestSource: DbModule.SyncRequestSource | null;
      succeededAt?: Date | null;
    }) {
      const telemetry = createTelemetry();
      const getFollowersPage = vi.fn(async () => {
        throw walked;
      });
      const app = {
        db: { transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback({})) },
        config: { followerPageDelayMs: 0, syncSharedRateLimitEnabled: false },
        adapter: { getFollowersPage },
      } as never;
      dbMocks.getCheckpoint.mockResolvedValue(input.checkpointState ? { state: input.checkpointState } : null);
      dbMocks.maxPageFollowGeneration.mockResolvedValue(40);
      sharedMocks.refreshPageMetadata.mockResolvedValue({ parsed: { account: { followCount: 10 } } });
      const run = () => executeFollowersReconcileChunk(app, {
        pageContext: {
          platform: "fansly",
          page: { id: 13, label: "fansly-page", platformAccountId: "acct-13", metadata: {} },
          session: { authorization: "token" },
          proxy: null,
        },
        streamState: {
          stream: "followers_reconcile",
          requestSeq: input.requestSeq,
          requestSource: input.requestSource,
          succeededAt: input.succeededAt ?? null,
        },
        syncRunId: 102,
        telemetry: telemetry as never,
        budget: new SyncChunkBudget(),
      } as never);
      return { run, getFollowersPage, telemetry };
    }

    const completedWalk = (revision: number, startedAt: Date) => ({
      revision, generation: 40, fullSweepStartedAt: startedAt.toISOString(), offset: 0,
      observedCount: 10, pageCount: 1, sourceFollowerCount: 10, snapshotRestartCount: 0,
      restartReason: null, verificationPending: false,
    });

    it.each(["anomaly", "scheduled", "recovery"] as const)(
      "holds a %s request a day from the start of the last walk without a request or a checkpoint write",
      async (requestSource) => {
        const startedAt = new Date(Date.now() - 2 * HOUR_MS);
        const until = new Date(startedAt.getTime() + 24 * HOUR_MS);
        const fixture = floorFixture({
          checkpointState: completedWalk(4, startedAt), requestSeq: 5, requestSource,
          succeededAt: new Date(startedAt.getTime() + 10 * 60_000),
        });

        await expect(fixture.run()).resolves.toEqual({
          satisfied: false,
          yieldReason: null,
          continuationRetryAt: until,
          continuationRequestSource: "scheduled",
          deferral: "followers_reconcile_min_interval",
          stats: {
            followersReconcileFloorUntil: until.toISOString(),
            followersReconcileFloorAnchor: startedAt.toISOString(),
          },
        });
        expect(sharedMocks.refreshPageMetadata).not.toHaveBeenCalled();
        expect(fixture.getFollowersPage).not.toHaveBeenCalled();
        expect(dbMocks.upsertCheckpointProgress).not.toHaveBeenCalled();
        expect(dbMocks.maxPageFollowGeneration).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["a manual request", "manual", 2],
      ["a reset", "reset", 2],
      ["an onboarding request", "onboarding", 2],
      ["an anomaly a day and an hour after the last walk began", "anomaly", 25],
    ] as const)("starts a new generation for %s", async (_name, requestSource, hoursSinceWalk) => {
      const startedAt = new Date(Date.now() - hoursSinceWalk * HOUR_MS);
      const fixture = floorFixture({
        checkpointState: completedWalk(4, startedAt), requestSeq: 5, requestSource, succeededAt: startedAt,
      });

      await expect(fixture.run()).rejects.toBe(walked);
      expect(sharedMocks.refreshPageMetadata).toHaveBeenCalledTimes(1);
      expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(expect.anything(), {
        platformAccountId: 13,
        stream: "followers_reconcile",
        state: expect.objectContaining({ revision: 5, generation: 41, offset: 0 }),
      });
      expect(fixture.getFollowersPage).toHaveBeenCalledTimes(1);
    });

    it("restarts this request's own walk after a snapshot mismatch, however recent the last success", async () => {
      const fixture = floorFixture({
        checkpointState: { revision: 5, generation: 41, snapshotRestartCount: 1, restartReason: "snapshot_mismatch" },
        requestSeq: 5, requestSource: "anomaly", succeededAt: new Date(Date.now() - HOUR_MS),
      });

      await expect(fixture.run()).rejects.toBe(walked);
      expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        state: expect.objectContaining({ revision: 5, generation: 42, restartReason: "snapshot_mismatch" }),
      }));
    });

    it("continues a walk already under way for this request", async () => {
      const fixture = floorFixture({
        checkpointState: { ...completedWalk(5, new Date(Date.now() - HOUR_MS)), offset: 300, pageCount: 3 },
        requestSeq: 5, requestSource: "anomaly", succeededAt: new Date(Date.now() - 2 * HOUR_MS),
      });

      await expect(fixture.run()).rejects.toBe(walked);
      expect(sharedMocks.refreshPageMetadata).not.toHaveBeenCalled();
      expect(fixture.getFollowersPage).toHaveBeenCalledWith(expect.anything(), "acct-13", expect.objectContaining({
        offset: 300,
      }));
    });
  });

  describe("an incremental followers walk whose known follow id is gone", () => {
    // Rows arrive newest first by follow snowflake; K is the head of the last walk.
    const K = "961321050841313280";
    const NEWER_2 = "961340000000000000";
    const NEWER_1 = "961330000000000000";
    const OLDER_1 = "961291922045943816";
    const OLDER_2 = "961280000000000000";
    const OLDER_3 = "961270000000000000";

    type Row = { id: string; followerId: string };
    const followerPage = (rows: Row[], done: boolean) => {
      // Recent enough to count as presence.
      const lastSeenAt = Date.now() - 60_000;
      return {
        items: rows.map(row => ({ ...row, lastSeenAt })),
        accounts: rows.map(row => ({
          id: row.followerId,
          username: row.followerId,
          displayName: row.followerId,
          createdAt: 1_770_000_000_000,
          lastSeenAt,
        })),
        done,
        raw: {},
      };
    };

    async function runWalk(input: {
      pages: Array<ReturnType<typeof followerPage>>;
      state?: Record<string, unknown>;
      activeFollowerCount?: number;
    }) {
      const telemetry = createTelemetry();
      const tx = {};
      const getFollowersPage = vi.fn();
      for (const page of input.pages) {
        getFollowersPage.mockResolvedValueOnce(page);
      }
      const app = {
        db: { transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)) },
        config: { followerPageDelayMs: 0, syncSharedRateLimitEnabled: false },
        adapter: { getFollowersPage },
      } as never;
      const state = {
        revision: 3,
        knownFollowId: K,
        newestFollowId: null,
        offset: 0,
        pageCount: 0,
        sourceFollowerCount: 4,
        ...input.state,
      };
      dbMocks.getCheckpoint.mockResolvedValue({ cursorText: state.knownFollowId, state });
      const fanIds = new Map<string, number>();
      dbMocks.upsertFans.mockImplementation(async (_db: unknown, rows: Array<{ platformUserId: string }>) => (
        rows.map(row => {
          if (!fanIds.has(row.platformUserId)) fanIds.set(row.platformUserId, 100 + fanIds.size);
          return { id: fanIds.get(row.platformUserId)!, platformUserId: row.platformUserId };
        })
      ));
      dbMocks.countActivePageFollows.mockResolvedValue(input.activeFollowerCount ?? state.sourceFollowerCount);
      dbMocks.requestPageSync.mockResolvedValue([{
        stream: "followers_reconcile",
        requestedSeq: 7,
        coalesced: false,
        queueBefore: { requestedSeq: 6, appliedSeq: 6 },
      }]);

      const result = await executeFollowersChunk(app, {
        pageContext: {
          platform: "fansly",
          page: { id: 12, label: "fansly-page", platformAccountId: "acct-12", metadata: {} },
          session: { authorization: "token" },
          proxy: null,
        },
        streamState: { requestSeq: 3 },
        syncRunId: 101,
        telemetry: telemetry as never,
        budget: new SyncChunkBudget(),
      } as never);
      const storedFollowIds = dbMocks.upsertPageFollows.mock.calls
        .flatMap(([, rows]) => (rows as Array<{ platformFollowId: string }>).map(row => row.platformFollowId));
      const decision = (telemetry.addNote.mock.calls as unknown as Array<[string, { followersReconcile: unknown }]>)
        .find(([message]) => message === "Fansly followers reconcile decision")?.[1].followersReconcile;
      return { result, getFollowersPage, storedFollowIds, decision };
    }

    it("stops at the first row older than the cursor instead of walking the rest of the list", async () => {
      const { result, getFollowersPage, storedFollowIds, decision } = await runWalk({
        pages: [
          followerPage([
            { id: NEWER_2, followerId: "fan-n2" },
            { id: NEWER_1, followerId: "fan-n1" },
            { id: OLDER_1, followerId: "fan-o1" },
            { id: OLDER_2, followerId: "fan-o2" },
          ], false),
          followerPage([{ id: OLDER_3, followerId: "fan-o3" }], true),
        ],
      });

      expect(result).toMatchObject({
        satisfied: true,
        stats: { pageCount: 1, processedThisChunk: 2, sawKnownCheckpoint: false, crossedKnownBoundary: true },
      });
      expect(getFollowersPage).toHaveBeenCalledTimes(1);
      expect(storedFollowIds).toEqual([NEWER_2, NEWER_1]);
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        stream: "followers",
        cursorText: NEWER_2,
      }));
      // Presence still covers every row the page returned.
      expect(dbMocks.upsertFanPageExternalPresences.mock.calls[0]?.[1]).toHaveLength(4);
      // The vanished cursor still asks the reconcile to sweep what lies below it.
      expect(decision).toMatchObject({
        countMismatch: false,
        exhaustedWithoutKnown: true,
        unchangedHeadWithRows: false,
        requested: true,
        pageDone: false,
        requestedSeq: 7,
      });
      expect(dbMocks.requestPageSync).toHaveBeenCalledTimes(1);
    });

    it("keeps a re-follow at the head, whose new follow id is above the cursor", async () => {
      // fan-k owned K, unfollowed and followed again under a fresh, larger id.
      const { getFollowersPage, storedFollowIds } = await runWalk({
        pages: [
          followerPage([
            { id: NEWER_2, followerId: "fan-k" },
            { id: NEWER_1, followerId: "fan-n1" },
            { id: OLDER_1, followerId: "fan-o1" },
          ], false),
          followerPage([{ id: OLDER_2, followerId: "fan-o2" }], true),
        ],
      });

      expect(getFollowersPage).toHaveBeenCalledTimes(1);
      expect(storedFollowIds).toEqual([NEWER_2, NEWER_1]);
    });

    it("stops on the first page when the newest known followers left and one new follower came", async () => {
      const { getFollowersPage, storedFollowIds, decision } = await runWalk({
        pages: [
          followerPage([
            { id: NEWER_1, followerId: "fan-n1" },
            { id: OLDER_2, followerId: "fan-o2" },
            { id: OLDER_3, followerId: "fan-o3" },
          ], false),
          followerPage([], true),
        ],
      });

      expect(getFollowersPage).toHaveBeenCalledTimes(1);
      expect(storedFollowIds).toEqual([NEWER_1]);
      expect(decision).toMatchObject({ exhaustedWithoutKnown: true, requested: true });
    });

    it("moves the cursor back to the surviving head when nobody new followed", async () => {
      const { getFollowersPage, storedFollowIds, decision } = await runWalk({
        pages: [
          followerPage([
            { id: OLDER_1, followerId: "fan-o1" },
            { id: OLDER_2, followerId: "fan-o2" },
          ], false),
          followerPage([], true),
        ],
      });

      expect(getFollowersPage).toHaveBeenCalledTimes(1);
      expect(storedFollowIds).toEqual([]);
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        cursorText: OLDER_1,
      }));
      expect(decision).toMatchObject({ exhaustedWithoutKnown: true, requested: true });
    });

    it("finishes a deep walk resumed after a deploy on the page it resumes at", async () => {
      const { result, getFollowersPage, storedFollowIds, decision } = await runWalk({
        state: { offset: 300, pageCount: 3, newestFollowId: NEWER_1 },
        pages: [
          followerPage([
            { id: OLDER_2, followerId: "fan-o2" },
            { id: OLDER_3, followerId: "fan-o3" },
          ], false),
          followerPage([], true),
        ],
      });

      expect(result).toMatchObject({ satisfied: true, stats: { pageCount: 4 } });
      expect(getFollowersPage).toHaveBeenCalledTimes(1);
      expect(getFollowersPage).toHaveBeenCalledWith(expect.anything(), "acct-12", expect.objectContaining({
        offset: 300,
      }));
      expect(storedFollowIds).toEqual([]);
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        cursorText: NEWER_1,
      }));
      expect(decision).toMatchObject({ exhaustedWithoutKnown: true, requested: true, pageDone: false });
    });

    it("keeps every row above the cursor on the stopping page even if one older row came out of order", async () => {
      const { getFollowersPage, storedFollowIds } = await runWalk({
        pages: [
          followerPage([
            { id: NEWER_2, followerId: "fan-n2" },
            { id: OLDER_1, followerId: "fan-o1" },
            { id: NEWER_1, followerId: "fan-n1" },
          ], false),
          followerPage([], true),
        ],
      });

      expect(getFollowersPage).toHaveBeenCalledTimes(1);
      expect(storedFollowIds).toEqual([NEWER_2, NEWER_1]);
    });

    it("still stops exactly at the known follow when it is present", async () => {
      const { result, getFollowersPage, storedFollowIds, decision } = await runWalk({
        pages: [
          followerPage([
            { id: NEWER_1, followerId: "fan-n1" },
            { id: K, followerId: "fan-k" },
            { id: OLDER_1, followerId: "fan-o1" },
          ], false),
          followerPage([], true),
        ],
      });

      expect(result).toMatchObject({ stats: { sawKnownCheckpoint: true } });
      expect(getFollowersPage).toHaveBeenCalledTimes(1);
      expect(storedFollowIds).toEqual([NEWER_1]);
      expect(decision).toMatchObject({ exhaustedWithoutKnown: false, requested: false });
      expect(dbMocks.requestPageSync).not.toHaveBeenCalled();
    });

    it("walks to the end of the list when the known id has no numeric order", async () => {
      const { getFollowersPage, storedFollowIds, decision } = await runWalk({
        state: { knownFollowId: "known-follow" },
        pages: [
          followerPage([
            { id: NEWER_1, followerId: "fan-n1" },
            { id: OLDER_1, followerId: "fan-o1" },
          ], false),
          followerPage([{ id: OLDER_2, followerId: "fan-o2" }], true),
        ],
      });

      expect(getFollowersPage).toHaveBeenCalledTimes(2);
      expect(storedFollowIds).toEqual([NEWER_1, OLDER_1, OLDER_2]);
      expect(decision).toMatchObject({ exhaustedWithoutKnown: true, pageDone: true });
    });
  });

it("guards against empty first-page follower reconcile wipes when active followers already exist", async () => {
  const telemetry = createTelemetry();
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback({})),
  };
  const app = {
    db,
    config: {
      followerPageDelayMs: 0,
      syncSharedRateLimitEnabled: false,
    },
    adapter: {
      getFollowersPage: vi.fn(async () => ({
        items: [],
        accounts: [],
        done: true,
        raw: {},
      })),
    },
  } as never;

  dbMocks.getCheckpoint.mockResolvedValue(null);
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: {
      account: {
        followCount: 5,
      },
    },
  });
  dbMocks.countActivePageFollows.mockResolvedValue(3);

  await expect(executeFollowersReconcileChunk(app, {
    pageContext: {
      platform: "fansly",
      page: {
        id: 13,
        label: "fansly-page",
        platformAccountId: "acct-13",
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: null,
    },
    streamState: {
      requestSeq: 4,
    },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never)).rejects.toThrow("refusing destructive finalization");

  expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
    code: "followers_reconcile_empty_first_page_guard",
    details: {
      sourceFollowerCount: 5,
      existingActiveFollowers: 3,
    },
  }));
  expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  expect(dbMocks.refreshFanPageFollowerState).not.toHaveBeenCalled();
  expect(dbMocks.rebuildFollowerRollups).not.toHaveBeenCalled();
  expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
});

it("does not carry a restart marker into a newer follower revision", async () => {
  const telemetry = createTelemetry();
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback({})),
  };
  const app = {
    db,
    config: {
      followerPageDelayMs: 0,
      syncSharedRateLimitEnabled: false,
    },
    adapter: {
      getFollowersPage: vi.fn(async () => ({
        items: [{
          id: "1000",
          followerId: "fan-1",
          lastSeenAt: 1_775_782_500_000,
        }],
        accounts: [{
          id: "fan-1",
          username: "fan_1",
          displayName: "Fan 1",
          createdAt: 1_770_000_000_000,
          lastSeenAt: 1_775_782_500_000,
        }],
        done: true,
        raw: {},
      })),
    },
  } as never;

  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 3,
      generation: 613,
      snapshotRestartCount: 1,
      restartReason: "snapshot_mismatch",
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: {
      account: {
        followCount: 2,
      },
    },
  });
  dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(1);

  const result = await executeFollowersReconcileChunk(app, {
    pageContext: {
      platform: "fansly",
      page: {
        id: 13,
        label: "fansly-page",
        platformAccountId: "acct-13",
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: null,
    },
    streamState: {
      requestSeq: 4,
    },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: false,
    continuationRetryAt: expect.any(Date),
    stats: {
      snapshotRestartCount: 1,
      destructiveFinalization: false,
      finalizationWithheld: true,
    },
  });

  expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
    code: "followers_reconcile_generation_guard",
    details: expect.objectContaining({
      sourceFollowerCount: 2,
      observedCount: 1,
      generationObservedCount: 1,
      pageCount: 1,
    }),
  }));
  expect(db.transaction).toHaveBeenCalledTimes(2);
  expect(dbMocks.upsertPageFollows).toHaveBeenCalled();
  expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  expect(dbMocks.refreshFanPageFollowerState).not.toHaveBeenCalled();
  expect(dbMocks.rebuildFollowerRollups).not.toHaveBeenCalled();
  expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  expect(dbMocks.upsertCheckpointProgress).toHaveBeenLastCalledWith(expect.anything(), {
    platformAccountId: 13,
    stream: "followers_reconcile",
    state: {
      revision: 4,
      generation: 614,
      snapshotRestartCount: 1,
      restartReason: "snapshot_mismatch",
      verificationPending: false,
    },
  });
});

it("delays a second follower mismatch inside the same restart scope", async () => {
  const telemetry = createTelemetry();
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback({})),
  };
  const app = {
    db,
    config: {
      followerPageDelayMs: 0,
      syncSharedRateLimitEnabled: false,
    },
    adapter: {
      getFollowersPage: vi.fn(async () => ({
        items: [{
          id: "1000",
          followerId: "fan-1",
          lastSeenAt: 1_775_782_500_000,
        }],
        accounts: [{
          id: "fan-1",
          username: "fan_1",
          displayName: "Fan 1",
          createdAt: 1_770_000_000_000,
          lastSeenAt: 1_775_782_500_000,
        }],
        done: true,
        raw: {},
      })),
    },
  } as never;

  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 614,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 0,
      observedCount: 0,
      pageCount: 0,
      sourceFollowerCount: 2,
      snapshotRestartCount: 1,
      restartReason: "snapshot_mismatch",
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: {
      account: {
        followCount: 2,
      },
    },
  });
  dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(1);

  const result = await executeFollowersReconcileChunk(app, {
    pageContext: {
      platform: "fansly",
      page: {
        id: 13,
        label: "fansly-page",
        platformAccountId: "acct-13",
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: null,
    },
    streamState: {
      requestSeq: 4,
    },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: false,
    continuationRetryAt: expect.any(Date),
    stats: {
      snapshotRestartCount: 2,
      destructiveFinalization: false,
      finalizationWithheld: true,
    },
  });

  expect(sharedMocks.refreshPageMetadata).toHaveBeenCalledTimes(1);
  expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    platformAccountId: 13,
    stream: "followers_reconcile",
    state: expect.objectContaining({ verificationPending: true }),
  }));
  expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  expect(dbMocks.upsertCheckpointProgress).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      state: expect.objectContaining({ snapshotRestartCount: 2 }),
    }),
  );
});

it("closes follower reconcile non-destructively after two fresh retries", async () => {
  const telemetry = createTelemetry();
  const tx = {};
  const getFollowersPage = vi.fn();
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
  };
  const app = {
    db,
    config: {
      followerPageDelayMs: 0,
      syncSharedRateLimitEnabled: false,
    },
    adapter: { getFollowersPage },
  } as never;

  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 615,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 0,
      observedCount: 1,
      pageCount: 1,
      sourceFollowerCount: 2,
      snapshotRestartCount: 2,
      restartReason: "snapshot_mismatch",
      verificationPending: true,
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: { account: { followCount: 2 } },
  });
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(1);

  const result = await executeFollowersReconcileChunk(app, {
    pageContext: {
      platform: "fansly",
      page: {
        id: 13,
        label: "fansly-page",
        platformAccountId: "acct-13",
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: null,
    },
    streamState: { requestSeq: 4 },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: true,
    stats: {
      destructiveFinalization: false,
      finalizationWithheld: true,
      nonDestructiveClose: true,
    },
  });
  expect(getFollowersPage).not.toHaveBeenCalled();
  expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  expect(dbMocks.refreshFanPageFollowerState).not.toHaveBeenCalled();
  expect(dbMocks.updatePageSyncTimestampCache).not.toHaveBeenCalled();
  expect(dbMocks.rebuildFollowerRollups).toHaveBeenCalledWith(tx, 13, 2);
  expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
    state: expect.objectContaining({
      destructiveFinalization: false,
      membershipCertified: false,
    }),
    lastSuccessfulRunId: 102,
  }));
  expect(telemetry.addNote).toHaveBeenCalledWith(
    "Follower reconcile completed non-destructively after two fresh generations could not certify terminal membership",
    expect.objectContaining({ code: "followers_reconcile_nondestructive_close" }),
  );
});

it("finalizes follower reconcile against a freshly captured terminal headline", async () => {
  const telemetry = createTelemetry();
  const tx = {};
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
  };
  const app = {
    db,
    config: {
      followerPageDelayMs: 0,
      syncSharedRateLimitEnabled: false,
    },
    adapter: {
      getFollowersPage: vi.fn(async () => ({
        items: [{
          id: "1002",
          followerId: "fan-2",
          lastSeenAt: 1_775_782_500_000,
        }],
        accounts: [{
          id: "fan-2",
          username: "fan_2",
          displayName: "Fan 2",
          createdAt: 1_770_000_000_000,
          lastSeenAt: 1_775_782_500_000,
        }],
        done: true,
        raw: {},
      })),
    },
  } as never;

  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 613,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 100,
      observedCount: 1,
      pageCount: 1,
      sourceFollowerCount: 3,
      snapshotRestartCount: 0,
      restartReason: null,
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: {
      account: {
        followCount: 2,
      },
    },
  });
  dbMocks.upsertFans.mockResolvedValue([{ id: 92, platformUserId: "fan-2" }]);
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(2);

  const result = await executeFollowersReconcileChunk(app, {
    pageContext: {
      platform: "fansly",
      page: {
        id: 13,
        label: "fansly-page",
        platformAccountId: "acct-13",
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: null,
    },
    streamState: {
      requestSeq: 4,
    },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: true,
    stats: {
      sourceFollowerCount: 2,
      startingSourceFollowerCount: 3,
      generationObservedCount: 2,
    },
  });
  expect(sharedMocks.refreshPageMetadata).toHaveBeenCalledTimes(1);
  expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
    platformAccountId: 13,
    generation: 613,
    lastSeenBefore: expect.any(Date),
  });
  expect(dbMocks.rebuildFollowerRollups).toHaveBeenCalledWith(tx, 13, 2);
  expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
    state: expect.objectContaining({
      sourceFollowerCount: 2,
      snapshotRestartCount: 0,
    }),
  }));
  expect(telemetry.addNote).toHaveBeenCalledWith(
    "Follower headline changed during reconcile; terminal membership proof passed",
    {
      code: "followers_reconcile_terminal_headline_changed",
      startingSourceFollowerCount: 3,
      terminalSourceFollowerCount: 2,
      generationObservedCount: 2,
      pageCount: 2,
      membershipProof: "exact_generation",
    },
  );
  expect(telemetry.addAnomaly).not.toHaveBeenCalledWith(expect.objectContaining({
    code: "followers_reconcile_generation_guard",
  }));
  expect(sharedMocks.persistRawPayload).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      requestParams: {
        offset: 100,
        limit: 100,
        mode: "reconcile",
        generation: 613,
        fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      },
    }),
    expect.anything(),
  );
});

it("resumes terminal follower verification without refetching the list and charges its request", async () => {
  const telemetry = createTelemetry();
  const tx = {};
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
  };
  const getFollowersPage = vi.fn();
  const app = {
    db,
    config: {
      followerPageDelayMs: 0,
      syncSharedRateLimitEnabled: false,
    },
    adapter: { getFollowersPage },
  } as never;
  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 613,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 100,
      observedCount: 1,
      pageCount: 2,
      sourceFollowerCount: 1,
      snapshotRestartCount: 0,
      restartReason: null,
      verificationPending: true,
    },
  });
  sharedMocks.refreshPageMetadata.mockImplementation(async (
    _app: unknown,
    _pageContext: unknown,
    _syncType: unknown,
    _telemetry: unknown,
    requestObserver: { onRequestEvent(event: unknown): Promise<void> } | null,
  ) => {
    await recordStartedRequest(requestObserver, "account_me");
    return { parsed: { account: { followCount: 1 } } };
  });
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(1);
  const budget = new SyncChunkBudget(1);

  const result = await executeFollowersReconcileChunk(app, {
    pageContext: {
      platform: "fansly",
      page: {
        id: 13,
        label: "fansly-page",
        platformAccountId: "acct-13",
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: null,
    },
    streamState: { requestSeq: 4 },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget,
  } as never);

  expect(result.satisfied).toBe(true);
  expect(getFollowersPage).not.toHaveBeenCalled();
  expect(budget.totalRequests).toBe(1);
  expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
    platformAccountId: 13,
    generation: 613,
    lastSeenBefore: expect.any(Date),
  });
});

it("certifies a terminal join only from a first-seen row outside the completed generation", async () => {
  const telemetry = createTelemetry();
  const tx = {};
  const getFollowersPage = vi.fn();
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
  };
  const app = {
    db,
    config: { followerPageDelayMs: 0, syncSharedRateLimitEnabled: false },
    adapter: { getFollowersPage },
  } as never;
  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 613,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 0,
      observedCount: 1,
      pageCount: 1,
      sourceFollowerCount: 1,
      snapshotRestartCount: 0,
      restartReason: null,
      verificationPending: true,
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: { account: { followCount: 2 } },
  });
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(1);
  dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
    firstSeenDuringSweepOutsideGeneration: 1,
    activeFollowerCount: 2,
    deactivationCandidateCount: 0,
  });

  const result = await executeFollowersReconcileChunk(app, {
    pageContext: {
      platform: "fansly",
      page: {
        id: 13,
        label: "fansly-page",
        platformAccountId: "acct-13",
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: null,
    },
    streamState: { requestSeq: 4 },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: true,
    stats: {
      membershipProof: "new_followers_seen_during_sweep",
      destructiveFinalization: true,
    },
  });
  expect(getFollowersPage).not.toHaveBeenCalled();
  expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
    platformAccountId: 13,
    generation: 613,
    lastSeenBefore: new Date(FOLLOWER_SWEEP_STARTED_AT),
  });
});

it("blocks a certified follower wipe above the one-percent safety ceiling", async () => {
  const telemetry = createTelemetry();
  const tx = {};
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
  };
  const app = {
    db,
    config: { followerPageDelayMs: 0, syncSharedRateLimitEnabled: false },
    adapter: { getFollowersPage: vi.fn() },
  } as never;
  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 613,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 100,
      observedCount: 100,
      pageCount: 2,
      sourceFollowerCount: 100,
      snapshotRestartCount: 0,
      restartReason: null,
      verificationPending: true,
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: { account: { followCount: 100 } },
  });
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(100);
  dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
    firstSeenDuringSweepOutsideGeneration: 0,
    activeFollowerCount: 1_000,
    deactivationCandidateCount: 51,
  });
  dbMocks.readPageFollowDeactivationGenerationBuckets.mockResolvedValue([
    { lastSeenGeneration: null, count: 40 },
    { lastSeenGeneration: 610, count: 11 },
  ]);

  await expect(executeFollowersReconcileChunk(app, {
    pageContext: {
      platform: "fansly",
      page: {
        id: 13,
        label: "fansly-page",
        platformAccountId: "acct-13",
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: null,
    },
    streamState: { requestSeq: 4 },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never)).rejects.toMatchObject({
    code: "followers_reconcile_deactivation_blast_radius",
    retryable: false,
  });

  expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
    code: "followers_reconcile_deactivation_blast_radius",
    details: expect.objectContaining({
      deactivationCandidateCount: 51,
      deactivationLimit: 50,
      candidateGenerationBuckets: [
        { lastSeenGeneration: null, count: 40 },
        { lastSeenGeneration: 610, count: 11 },
      ],
    }),
  }));
});

it("finalizes follower reconcile when offset drift duplicates raw rows but the unique generation is complete", async () => {
  const telemetry = createTelemetry();
  const tx = {};
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
  };
  const app = {
    db,
    config: {
      followerPageDelayMs: 0,
      syncSharedRateLimitEnabled: false,
    },
    adapter: {
      getFollowersPage: vi.fn(async () => ({
        items: [{
          id: "1002",
          followerId: "fan-2",
          lastSeenAt: 1_775_782_500_000,
        }],
        accounts: [{
          id: "fan-2",
          username: "fan_2",
          displayName: "Fan 2",
          createdAt: 1_770_000_000_000,
          lastSeenAt: 1_775_782_500_000,
        }],
        done: true,
        raw: {},
      })),
    },
  } as never;

  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 613,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 7200,
      observedCount: 2,
      pageCount: 2,
      sourceFollowerCount: 2,
      snapshotRestartCount: 1,
      restartReason: "snapshot_mismatch",
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: {
      account: {
        followCount: 2,
      },
    },
  });
  dbMocks.upsertFans.mockResolvedValue([{ id: 92, platformUserId: "fan-2" }]);
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(2);

  const result = await executeFollowersReconcileChunk(app, {
    pageContext: {
      platform: "fansly",
      page: {
        id: 13,
        label: "fansly-page",
        platformAccountId: "acct-13",
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: null,
    },
    streamState: {
      requestSeq: 4,
    },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: true,
    stats: {
      sourceFollowerCount: 2,
      generationObservedCount: 2,
    },
  });
  expect(dbMocks.countPageFollowsByGeneration).toHaveBeenCalledWith(tx, {
    platformAccountId: 13,
    generation: 613,
  });
  expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
    platformAccountId: 13,
    generation: 613,
    lastSeenBefore: expect.any(Date),
  });
  const completedCheckpoint = dbMocks.upsertCheckpoint.mock.calls.at(-1)?.[1];
  expect(completedCheckpoint?.state).toMatchObject({
    snapshotRestartCount: 0,
  });
  expect(completedCheckpoint?.state).not.toHaveProperty("restartReason");
  expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
    code: "followers_reconcile_offset_drift_tolerated",
    details: {
      sourceFollowerCount: 2,
      observedCount: 3,
      generationObservedCount: 2,
      pageCount: 3,
      membershipProof: "exact_generation",
    },
  }));
});

  it("hydrates incremental follower rows by fallback ID when aggregation accounts are missing", async () => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const app = {
      db,
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getFollowersPage: vi.fn(async () => ({
          items: [{
            id: "1000",
            followerId: "fan-1",
            lastSeenAt: 1_775_782_500_000,
          }],
          accounts: [],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    sharedMocks.refreshPageMetadata.mockResolvedValue({
      parsed: {
        account: {
          followCount: 1,
        },
      },
    });
    fanHydrationMocks.lookupHydratedFans.mockResolvedValue({
      accounts: [],
      fallbackIds: ["fan-1"],
      reusedIds: [],
      lookup: null,
    });
    dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);
    dbMocks.countActivePageFollows.mockResolvedValue(1);

    const result = await executeFollowersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 12,
          label: "fansly-page",
          platformAccountId: "acct-12",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        requestSeq: 3,
      },
      syncRunId: 101,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(fanHydrationMocks.lookupHydratedFans).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformUserIds: ["fan-1"],
    }));
    expect(fanHydrationMocks.upsertHydratedFansForPage).toHaveBeenCalledWith(tx, {
      platformAccountId: 12,
      accounts: [],
      fallbackIds: ["fan-1"],
      reusedIds: [],
      lookup: null,
    });
    expect(dbMocks.upsertPageFollows).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        platformAccountId: 12,
        fanId: 91,
        platformFollowId: "1000",
      }),
    ]);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "followers_missing_aggregation_accounts",
      severity: "warn",
    }));
  });

  it("maps partially aggregated follower reconcile rows before generation finalization", async () => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const app = {
      db,
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getFollowersPage: vi.fn(async () => ({
          items: [
            {
              id: "1002",
              followerId: "fan-1",
              lastSeenAt: 1_775_782_500_000,
            },
            {
              id: "1001",
              followerId: "fan-2",
              lastSeenAt: 1_775_782_400_000,
            },
          ],
          accounts: [{
            id: "fan-1",
            username: "fan_1",
            displayName: "Fan 1",
            createdAt: 1_770_000_000_000,
            lastSeenAt: 1_775_782_500_000,
          }],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    sharedMocks.refreshPageMetadata.mockResolvedValue({
      parsed: {
        account: {
          followCount: 2,
        },
      },
    });
    fanHydrationMocks.lookupHydratedFans.mockResolvedValue({
      accounts: [],
      fallbackIds: ["fan-2"],
      reusedIds: [],
      lookup: null,
    });
    dbMocks.upsertFans.mockResolvedValue([
      { id: 91, platformUserId: "fan-1" },
      { id: 92, platformUserId: "fan-2" },
    ]);
    dbMocks.countPageFollowsByGeneration.mockResolvedValue(2);

    const result = await executeFollowersReconcileChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 13,
          label: "fansly-page",
          platformAccountId: "acct-13",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        requestSeq: 4,
      },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(fanHydrationMocks.lookupHydratedFans).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformUserIds: ["fan-2"],
    }));
    expect(fanHydrationMocks.upsertHydratedFansForPage).toHaveBeenCalledWith(tx, {
      platformAccountId: 13,
      accounts: [expect.objectContaining({ id: "fan-1" })],
      fallbackIds: ["fan-2"],
      reusedIds: [],
      lookup: null,
    });
    expect(dbMocks.upsertPageFollows).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        fanId: 91,
        platformFollowId: "1002",
        lastSeenGeneration: 1,
      }),
      expect.objectContaining({
        fanId: 92,
        platformFollowId: "1001",
        lastSeenGeneration: 1,
      }),
    ]);
    expect(dbMocks.upsertPageFollows.mock.invocationCallOrder[0]).toBeLessThan(
      dbMocks.deactivatePageFollowsByGeneration.mock.invocationCallOrder[0],
    );
    expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
      platformAccountId: 13,
      generation: 1,
      lastSeenBefore: expect.any(Date),
    });
  });

  it.for([
    { stream: "followers", pageId: 12 },
    { stream: "followers_reconcile", pageId: 13 },
  ] as const)("maps a $stream row whose fallback lookup ran within a day from its stored fan row", async ({ stream, pageId }) => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const app = {
      db,
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getFollowersPage: vi.fn(async () => ({
          items: [{
            id: "1000",
            followerId: "fan-gone",
            lastSeenAt: 1_775_782_500_000,
          }],
          accounts: [],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    sharedMocks.refreshPageMetadata.mockResolvedValue({
      parsed: {
        account: {
          followCount: 1,
        },
      },
    });
    fanHydrationMocks.lookupHydratedFans.mockResolvedValue({
      accounts: [],
      fallbackIds: [],
      reusedIds: ["fan-gone"],
      lookup: null,
    });
    fanHydrationMocks.upsertHydratedFansForPage.mockResolvedValue(new Map([["fan-gone", 93]]));
    dbMocks.countActivePageFollows.mockResolvedValue(1);
    dbMocks.countPageFollowsByGeneration.mockResolvedValue(1);

    const execute = stream === "followers" ? executeFollowersChunk : executeFollowersReconcileChunk;
    const result = await execute(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: pageId,
          label: "fansly-page",
          platformAccountId: `acct-${pageId}`,
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        requestSeq: 3,
      },
      syncRunId: 101,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(fanHydrationMocks.lookupHydratedFans).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: pageId,
      platformUserIds: ["fan-gone"],
    }));
    expect(fanHydrationMocks.upsertHydratedFansForPage).toHaveBeenCalledWith(tx, {
      platformAccountId: pageId,
      accounts: [],
      fallbackIds: [],
      reusedIds: ["fan-gone"],
      lookup: null,
    });
    expect(dbMocks.upsertPageFollows).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        platformAccountId: pageId,
        fanId: 93,
        platformFollowId: "1000",
      }),
    ]);
    // The page still omitted the account: the warn stays, and says the
    // fallback answer came from the stored lookup.
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "followers_missing_aggregation_accounts",
      severity: "warn",
      details: expect.objectContaining({
        missingAggregationAccountCount: 1,
        fallbackHydrationMisses: 0,
        fallbackLookupsReused: 1,
      }),
    }));
  });

  it("keys the daily subscriber lookup on the page and maps reused subscribers from their stored rows", async () => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const subscription = (id: string, subscriberId: string) => ({
      id,
      subscriberId,
      historyId: null,
      subscriptionTierId: null,
      subscriptionTierName: null,
      subscriptionTierColor: null,
      planId: null,
      status: 3,
      price: 5000,
      renewPrice: 5000,
      autoRenew: 1,
      billingCycle: 30,
      duration: 30,
      renewDate: null,
      createdAt: new Date("2026-03-10T00:00:00.000Z").toISOString(),
      updatedAt: null,
      endsAt: new Date("2026-04-09T00:00:00.000Z").toISOString(),
    });
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getSubscribersPage: vi.fn(async () => ({
          total: 2,
          items: [subscription("sub-1", "fan-known"), subscription("sub-2", "fan-new")],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        revision: 5,
        generation: 0,
        historyBackfilledAt: "2026-07-01T00:00:00.000Z",
      },
    });
    const lookup = { lookedUpAt: new Date("2026-03-14T01:00:00.000Z"), platformUserIds: ["fan-new"] };
    const newAccount = { id: "fan-new", username: "fan_new", displayName: null, createdAt: 1_770_000_000_000 };
    fanHydrationMocks.lookupHydratedFans.mockResolvedValue({
      accounts: [newAccount],
      fallbackIds: [],
      reusedIds: ["fan-known"],
      lookup,
    });
    fanHydrationMocks.upsertHydratedFansForPage.mockResolvedValue(new Map([["fan-known", 91], ["fan-new", 92]]));

    const result = await fanslySubscribersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 14,
          label: "fansly-page",
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        requestSeq: 6,
      },
      syncRunId: 103,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(fanHydrationMocks.lookupHydratedFans).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 14,
      platformUserIds: ["fan-known", "fan-new"],
    }));
    expect(fanHydrationMocks.upsertHydratedFansForPage).toHaveBeenCalledWith(tx, {
      platformAccountId: 14,
      accounts: [newAccount],
      fallbackIds: [],
      reusedIds: ["fan-known"],
      lookup,
    });
    expect(dbMocks.upsertPageSubscriptions).toHaveBeenCalledWith(tx, [
      expect.objectContaining({ platformSubscriptionId: "sub-1", fanId: 91 }),
      expect.objectContaining({ platformSubscriptionId: "sub-2", fanId: 92 }),
    ]);
  });

  it("blocks follower reconcile finalization when fallback hydration still leaves source rows unmapped", async () => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const app = {
      db,
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getFollowersPage: vi.fn(async () => ({
          items: [{
            id: "1000",
            followerId: "fan-1",
            lastSeenAt: 1_775_782_500_000,
          }],
          accounts: [],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    sharedMocks.refreshPageMetadata.mockResolvedValue({
      parsed: {
        account: {
          followCount: 1,
        },
      },
    });
    fanHydrationMocks.lookupHydratedFans.mockResolvedValue({
      accounts: [],
      fallbackIds: ["fan-1"],
      reusedIds: [],
      lookup: null,
    });
    fanHydrationMocks.upsertHydratedFansForPage.mockResolvedValueOnce(new Map());

    await expect(executeFollowersReconcileChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 13,
          label: "fansly-page",
          platformAccountId: "acct-13",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        requestSeq: 4,
      },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never)).rejects.toThrow("refusing destructive finalization");

    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "followers_unmapped_source_rows",
      severity: "error",
      details: expect.objectContaining({
        stream: "followers_reconcile",
        unmappedFollowerCount: 1,
      }),
    }));
    expect(dbMocks.upsertPageFollows).not.toHaveBeenCalled();
    expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
    expect(dbMocks.refreshFanPageFollowerState).not.toHaveBeenCalled();
    expect(dbMocks.rebuildFollowerRollups).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  });

  it("runs follower reconcile finalization against generation-based state", async () => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const app = {
      db,
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getFollowersPage: vi.fn(async () => ({
          items: [],
          accounts: [],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    sharedMocks.refreshPageMetadata.mockResolvedValue({
      parsed: {
        account: {
          followCount: 0,
        },
      },
    });
    dbMocks.upsertFans.mockResolvedValue([]);

    const result = await executeFollowersReconcileChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 13,
          label: "fansly-page",
          platformAccountId: "acct-13",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        requestSeq: 4,
      },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(dbMocks.upsertPageFollows).toHaveBeenCalledWith(tx, []);
    expect(dbMocks.upsertFanPages).toHaveBeenCalledWith(tx, []);
    expect(dbMocks.upsertFanPageExternalPresences).toHaveBeenCalledWith(tx, []);
    expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
      platformAccountId: 13,
      generation: 1,
      lastSeenBefore: expect.any(Date),
    });
    expect(dbMocks.refreshFanPageFollowerState).toHaveBeenCalledWith(tx, 13);
    expect(dbMocks.rebuildFollowerRollups).toHaveBeenCalledWith(tx, 13, 0);
    expect(dbMocks.updatePageSyncTimestampCache).toHaveBeenCalledWith(tx, {
      pageId: 13,
      syncType: "followers",
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
      platformAccountId: 13,
      stream: "followers_reconcile",
    }));
  });

  it("starts the first follower generation at one when checkpoint and projection are empty", async () => {
    const telemetry = createTelemetry();
    const db = {};
    const app = {
      db,
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {},
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.maxPageFollowGeneration.mockResolvedValue(0);
    sharedMocks.refreshPageMetadata.mockResolvedValue({
      parsed: { account: { followCount: 0 } },
    });

    const result = await executeFollowersReconcileChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 13,
          label: "fansly-page",
          platformAccountId: "acct-13",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: { requestSeq: 4 },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(0),
    } as never);

    expect(result).toMatchObject({ satisfied: false, stats: { generation: 1 } });
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, {
      platformAccountId: 13,
      stream: "followers_reconcile",
      state: expect.objectContaining({ generation: 1 }),
    });
  });

  it("starts a fresh follower generation above the persisted row high-water", async () => {
    const telemetry = createTelemetry();
    const db = {};
    const app = {
      db,
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {},
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({ state: { revision: 3, generation: 613 } });
    dbMocks.maxPageFollowGeneration.mockResolvedValue(861);
    sharedMocks.refreshPageMetadata.mockResolvedValue({
      parsed: { account: { followCount: 9_307 } },
    });

    const result = await executeFollowersReconcileChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 13,
          label: "fansly-page",
          platformAccountId: "acct-13",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: { requestSeq: 4 },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(0),
    } as never);

    expect(result).toMatchObject({ satisfied: false, stats: { generation: 862 } });
    expect(dbMocks.maxPageFollowGeneration).toHaveBeenCalledWith(db, 13);
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, {
      platformAccountId: 13,
      stream: "followers_reconcile",
      state: expect.objectContaining({ generation: 862 }),
    });
  });

  it("keeps a newer subscriber checkpoint generation above a lower row high-water", async () => {
    const telemetry = createTelemetry();
    const db = {};
    const app = {
      db,
      config: { syncSharedRateLimitEnabled: false },
      adapter: {},
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({ state: { revision: 3, generation: 900 } });
    dbMocks.maxPageSubscriptionGeneration.mockResolvedValue(861);

    const result = await fanslySubscribersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 13,
          label: "fansly-page",
          platformAccountId: "acct-13",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: { requestSeq: 4 },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(0),
    } as never);

    expect(result).toMatchObject({ satisfied: false, stats: { generation: 901 } });
    expect(dbMocks.maxPageSubscriptionGeneration).toHaveBeenCalledWith(db, 13);
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, {
      platformAccountId: 13,
      stream: "subscribers",
      state: expect.objectContaining({ generation: 901 }),
    });
  });

  it("finalizes subscribers inside one transaction on completed pages", async () => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const getSubscribersPage = vi.fn(async () => ({
      total: 1,
      items: [{
        id: "sub-1",
        subscriberId: "fan-1",
        historyId: null,
        subscriptionTierId: null,
        subscriptionTierName: null,
        subscriptionTierColor: null,
        planId: null,
        status: 3,
        price: 5000,
        renewPrice: 5000,
        autoRenew: 1,
        billingCycle: 30,
        duration: 30,
        renewDate: null,
        createdAt: new Date("2026-03-10T00:00:00.000Z").toISOString(),
        updatedAt: null,
        endsAt: new Date("2026-04-09T00:00:00.000Z").toISOString(),
      }],
      done: true,
      raw: {},
    }));
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getSubscribersPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        revision: 5,
        generation: 0,
        historyBackfilledAt: "2026-07-01T00:00:00.000Z",
      },
    });
    fanHydrationMocks.lookupHydratedFans.mockResolvedValue({
      accounts: [{
        id: "fan-1",
        username: "fan_1",
        displayName: "Fan 1",
        createdAt: 1_770_000_000_000,
      }],
      fallbackIds: [],
    });
    dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);

    const result = await fanslySubscribersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 14,
          label: "fansly-page",
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        requestSeq: 6,
      },
      syncRunId: 103,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(getSubscribersPage).toHaveBeenCalledWith(
      expect.any(Object),
      { limit: 100, offset: 0, status: "3,4" },
    );
    expect(dbMocks.upsertPageSubscriptions).toHaveBeenCalledWith(tx, expect.any(Array));
    expect(dbMocks.upsertArchivedPageSubscriptions).not.toHaveBeenCalled();
    expect(dbMocks.upsertFanPages).toHaveBeenCalledWith(tx, expect.any(Array));
    expect(dbMocks.deactivatePageSubscriptionsByGeneration).toHaveBeenCalledWith(tx, {
      platformAccountId: 14,
      generation: 1,
      lastSeenBefore: expect.any(Date),
    });
    expect(dbMocks.refreshFanPageSubscriberState).toHaveBeenCalledWith(tx, 14);
    expect(dbMocks.rebuildSubscriberRollups).toHaveBeenCalledWith(tx, 14);
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
      platformAccountId: 14,
      stream: "subscribers",
    }));
    // One response is one snapshot; only a multi-page walk must prove membership.
    expect(dbMocks.countCurrentPageSubscriptionsByGeneration).not.toHaveBeenCalled();
  });

  it("finalizes active subscribers before a one-time archive-only expired backfill", async () => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const activeSubscription = {
      id: "sub-active",
      subscriberId: "fan-active",
      historyId: null,
      subscriptionTierId: null,
      subscriptionTierName: null,
      subscriptionTierColor: null,
      planId: null,
      status: 3,
      price: 5000,
      renewPrice: 5000,
      autoRenew: 1,
      billingCycle: 30,
      duration: 30,
      renewDate: null,
      createdAt: "2026-03-10T00:00:00.000Z",
      updatedAt: null,
      endsAt: "2026-04-09T00:00:00.000Z",
    };
    const expiredSubscription = {
      ...activeSubscription,
      id: "sub-expired",
      subscriberId: "fan-expired",
      status: 5,
      autoRenew: 0,
      endsAt: "2026-02-01T00:00:00.000Z",
    };
    const getSubscribersPage = vi.fn(async (
      _context: unknown,
      params: { status: string },
    ) => ({
      total: 1,
      items: [params.status === "3,4" ? activeSubscription : expiredSubscription],
      done: true,
      raw: {},
    }));
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getSubscribersPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.upsertFans
      .mockResolvedValueOnce([{ id: 91, platformUserId: "fan-active" }])
      .mockResolvedValueOnce([{ id: 92, platformUserId: "fan-expired" }]);

    const result = await fanslySubscribersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 14,
          label: "fansly-page",
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        requestSeq: 6,
      },
      syncRunId: 103,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        generation: 1,
        mode: "expired",
        processedThisChunk: 2,
      },
    });
    expect(getSubscribersPage.mock.calls.map(([, params]) => params.status)).toEqual([
      "3,4",
      "5",
    ]);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(dbMocks.upsertPageSubscriptions).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsertArchivedPageSubscriptions).toHaveBeenCalledTimes(1);
    expect(
      dbMocks.deactivatePageSubscriptionsByGeneration.mock.invocationCallOrder[0],
    ).toBeLessThan(
      dbMocks.upsertArchivedPageSubscriptions.mock.invocationCallOrder[0]!,
    );
    const fanPageInputs = dbMocks.upsertFanPages.mock.calls.flatMap((call) => call[1]);
    expect(fanPageInputs).toContainEqual(expect.objectContaining({
      fanId: 91,
      isSubscriber: true,
    }));
    expect(fanPageInputs).not.toContainEqual(expect.objectContaining({
      fanId: 92,
      isSubscriber: true,
    }));
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
      platformAccountId: 14,
      stream: "subscribers",
      state: expect.objectContaining({
        mode: "expired",
        observedCount: 1,
        historyBackfilledAt: expect.any(String),
      }),
    }));
  });

  describe("multi-page subscriber walks", () => {
    const subscriberItems = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-sub-${index}`,
      subscriberId: `${prefix}-fan-${index}`,
      historyId: null,
      subscriptionTierId: null,
      subscriptionTierName: null,
      subscriptionTierColor: null,
      planId: null,
      status: prefix === "expired" ? 5 : 3,
      price: 5000,
      renewPrice: 5000,
      autoRenew: 1,
      billingCycle: 30,
      duration: 30,
      renewDate: null,
      createdAt: "2026-03-10T00:00:00.000Z",
      updatedAt: null,
      endsAt: "2026-04-09T00:00:00.000Z",
    }));
    const WALK_STARTED_AT = "2026-07-02T00:00:00.000Z";
    const resumeWalk = (overrides: Record<string, unknown> = {}) => {
      dbMocks.getCheckpoint.mockResolvedValue({
        state: {
          revision: 6,
          generation: 7,
          mode: "active",
          historyBackfilledAt: "2026-07-01T00:00:00.000Z",
          offset: 100,
          observedCount: 100,
          distinctObservedCount: 100,
          pageCount: 1,
          providerReportedTotal: 150,
          restartCount: 0,
          walkStartedAt: WALK_STARTED_AT,
          ...overrides,
        },
      });
    };
    type WalkPage = { total: number; items: unknown[]; done: boolean };
    const runWalk = async (page: WalkPage | WalkPage[]) => {
      const telemetry = createTelemetry();
      const tx = {};
      const db = {
        transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
      };
      // Only the pages given are served: a walk that neither restarts nor
      // closes after them asks again.
      const getSubscribersPage = vi.fn(async (): Promise<unknown> => {
        throw new Error("unexpected extra subscribers page");
      });
      for (const served of Array.isArray(page) ? page : [page]) {
        getSubscribersPage.mockResolvedValueOnce({ ...served, raw: {} });
      }
      dbMocks.upsertFans.mockImplementation(async (_db: unknown, rows: Array<{ platformUserId: string }>) => (
        rows.map((row, index) => ({ id: 100 + index, platformUserId: row.platformUserId }))
      ));
      const result = await fanslySubscribersChunk({
        db,
        config: { syncSharedRateLimitEnabled: false },
        adapter: { getSubscribersPage },
      } as never, {
        pageContext: {
          platform: "fansly",
          page: { id: 14, label: "fansly-page" },
          session: { authorization: "token" },
          proxy: null,
        },
        streamState: { requestSeq: 6 },
        syncRunId: 103,
        telemetry: telemetry as never,
        budget: new SyncChunkBudget(),
      } as never);
      return { result, telemetry, db, tx, getSubscribersPage };
    };

    it("restarts an active walk from offset zero when the provider total shifts", async () => {
      resumeWalk();
      dbMocks.maxPageSubscriptionGeneration.mockResolvedValue(7);

      const { result, telemetry, db, getSubscribersPage } = await runWalk({
        total: 151,
        items: subscriberItems("active", 100),
        done: false,
      });

      expect(getSubscribersPage).toHaveBeenCalledWith(
        expect.any(Object),
        { limit: 100, offset: 100, status: "3,4" },
      );
      expect(sharedMocks.persistRawPayload).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        satisfied: false,
        yieldReason: null,
        continuationRetryAt: expect.any(Date),
        continuationRequestSource: "scheduled",
        stats: { generation: 8, restartCount: 1, restartReason: "total_changed" },
      });
      expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
        code: "subscribers_total_changed",
        details: {
          mode: "active",
          previousTotal: 150,
          currentTotal: 151,
          offset: 100,
          pageCount: 1,
          restartCount: 0,
        },
      }));
      expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, {
        platformAccountId: 14,
        stream: "subscribers",
        state: {
          revision: 6,
          generation: 8,
          mode: "active",
          historyBackfilledAt: "2026-07-01T00:00:00.000Z",
          offset: 0,
          observedCount: 0,
          distinctObservedCount: 0,
          pageCount: 0,
          providerReportedTotal: null,
          restartCount: 1,
          walkStartedAt: expect.any(String),
        },
      });
      // The rewalk fences from its own start, not the abandoned walk's.
      const restartState = dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1].state;
      expect(Date.parse(restartState.walkStartedAt)).toBeGreaterThan(Date.parse(WALK_STARTED_AT));
      expect(fanHydrationMocks.lookupHydratedFans).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
    });

    it("rewalks a pre-fence cursor from offset zero under a fresh generation and start", async () => {
      resumeWalk({ walkStartedAt: undefined });
      dbMocks.maxPageSubscriptionGeneration.mockResolvedValue(7);
      const startedAfter = Date.now();

      const { result, telemetry, tx, getSubscribersPage } = await runWalk({
        total: 50,
        items: subscriberItems("active", 50),
        done: true,
      });

      expect(getSubscribersPage).toHaveBeenCalledWith(
        expect.any(Object),
        { limit: 100, offset: 0, status: "3,4" },
      );
      expect(result).toMatchObject({ satisfied: true, stats: { generation: 8, pageCount: 1 } });
      expect(telemetry.addAnomaly).not.toHaveBeenCalled();
      const fence = dbMocks.deactivatePageSubscriptionsByGeneration.mock.calls[0]?.[1].lastSeenBefore as Date;
      expect(dbMocks.deactivatePageSubscriptionsByGeneration).toHaveBeenCalledWith(tx, {
        platformAccountId: 14,
        generation: 8,
        lastSeenBefore: fence,
      });
      expect(fence.getTime()).toBeGreaterThanOrEqual(startedAfter);
      // Not a provider anomaly: the bounded restart allowance is untouched.
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
        state: expect.objectContaining({ generation: 8, restartCount: 0, walkStartedAt: fence.toISOString() }),
      }));
    });

    it("fences a pre-fence cursor that has not read past offset zero without a rewalk", async () => {
      resumeWalk({
        walkStartedAt: undefined,
        offset: 0,
        observedCount: 0,
        distinctObservedCount: 0,
        pageCount: 0,
        providerReportedTotal: null,
      });
      const startedAfter = Date.now();

      const { result, tx } = await runWalk({ total: 50, items: subscriberItems("active", 50), done: true });

      expect(result).toMatchObject({ satisfied: true, stats: { generation: 7 } });
      expect(dbMocks.maxPageSubscriptionGeneration).not.toHaveBeenCalled();
      const fence = dbMocks.deactivatePageSubscriptionsByGeneration.mock.calls[0]?.[1].lastSeenBefore as Date;
      expect(dbMocks.deactivatePageSubscriptionsByGeneration).toHaveBeenCalledWith(tx, {
        platformAccountId: 14,
        generation: 7,
        lastSeenBefore: fence,
      });
      expect(fence.getTime()).toBeGreaterThanOrEqual(startedAfter);
    });

    it("takes a fresh start before retrying a first read that never wrote a page", async () => {
      // A failed or yielded first read leaves the walk's stored start behind,
      // and its retry keeps the same revision, so it resumes this cursor.
      resumeWalk({
        offset: 0,
        observedCount: 0,
        distinctObservedCount: 0,
        pageCount: 0,
        providerReportedTotal: null,
      });
      const startedAfter = Date.now();

      const { result, tx } = await runWalk({ total: 50, items: subscriberItems("active", 50), done: true });

      expect(result).toMatchObject({ satisfied: true, stats: { generation: 7, pageCount: 1 } });
      expect(dbMocks.maxPageSubscriptionGeneration).not.toHaveBeenCalled();
      const fence = dbMocks.deactivatePageSubscriptionsByGeneration.mock.calls[0]?.[1].lastSeenBefore as Date;
      expect(fence.getTime()).toBeGreaterThanOrEqual(startedAfter);
      expect(dbMocks.deactivatePageSubscriptionsByGeneration).toHaveBeenCalledWith(tx, {
        platformAccountId: 14,
        generation: 7,
        lastSeenBefore: fence,
      });
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
        state: expect.objectContaining({ generation: 7, restartCount: 0, walkStartedAt: fence.toISOString() }),
      }));
    });

    it("restarts only the archive-only history walk when the expired total shifts", async () => {
      resumeWalk({ mode: "expired", historyBackfilledAt: null, providerReportedTotal: 1001 });

      const { result, db } = await runWalk({
        total: 1002,
        items: subscriberItems("expired", 100),
        done: false,
      });

      expect(result).toMatchObject({ satisfied: false, stats: { generation: 7, restartReason: "total_changed" } });
      expect(dbMocks.maxPageSubscriptionGeneration).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, expect.objectContaining({
        state: expect.objectContaining({
          generation: 7,
          mode: "expired",
          historyBackfilledAt: null,
          offset: 0,
          restartCount: 1,
        }),
      }));
      expect(dbMocks.upsertArchivedPageSubscriptions).not.toHaveBeenCalled();
    });

    it("keeps what a shifted walk saw but retires nothing once restarts are exhausted", async () => {
      resumeWalk({ restartCount: 2 });

      const { result, tx } = await runWalk({
        total: 151,
        items: subscriberItems("active", 100),
        done: false,
      });

      expect(result).toMatchObject({
        satisfied: true,
        stats: {
          destructiveFinalization: false,
          finalizationWithheld: true,
          withheldReason: "total_changed",
          providerReportedTotal: 151,
        },
      });
      expect(dbMocks.upsertPageSubscriptions).toHaveBeenCalledWith(tx, expect.any(Array));
      expect(dbMocks.upsertPageSubscriptions.mock.calls[0]?.[1]).toHaveLength(100);
      expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
      expect(dbMocks.refreshFanPageSubscriberState).toHaveBeenCalledWith(tx, 14);
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
        state: expect.objectContaining({ destructiveFinalization: false, restartCount: 2 }),
      }));
    });

    it("replays a withheld active completion without re-reading its last page", async () => {
      // One subscription lapsed between pages: the empty last page reports a
      // total equal to the rows already read, so re-reading it would certify.
      resumeWalk({
        offset: 200,
        observedCount: 200,
        distinctObservedCount: 200,
        pageCount: 2,
        providerReportedTotal: 300,
        restartCount: 2,
      });
      dbMocks.countCurrentPageSubscriptionsByGeneration.mockResolvedValue(200);
      const emptyLastPage = { total: 200, items: [], done: true };

      const first = await runWalk(emptyLastPage);
      expect(first.result).toMatchObject({ satisfied: true, stats: { withheldReason: "total_changed" } });
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledTimes(1);
      const completedState = dbMocks.upsertCheckpoint.mock.calls[0]?.[1].state;
      expect(completedState).toMatchObject({ mode: "active", offset: 200, activeWithheldReason: "total_changed" });

      // The run died before the page sync closed; the same revision dispatches again.
      dbMocks.getCheckpoint.mockResolvedValue({ state: completedState });
      const replay = await runWalk(emptyLastPage);

      expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
      expect(replay.getSubscribersPage).not.toHaveBeenCalled();
      expect(replay.db.transaction).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledTimes(1);
      expect(replay.result).toMatchObject({
        satisfied: true,
        stats: {
          generation: 7,
          mode: "active",
          processedThisChunk: 0,
          providerReportedTotal: 200,
          destructiveFinalization: false,
          finalizationWithheld: true,
          withheldReason: "total_changed",
        },
      });
    });

    it("reads a shifted archive on to its end once restarts are exhausted, uncertified", async () => {
      resumeWalk({
        mode: "expired",
        historyBackfilledAt: null,
        providerReportedTotal: 201,
        restartCount: 2,
      });

      const { result, telemetry, db, tx, getSubscribersPage } = await runWalk([
        { total: 202, items: subscriberItems("expired", 100), done: false },
        { total: 202, items: subscriberItems("expired", 2), done: true },
      ]);

      // The archive is walked once; stopping at the drift page would leave
      // every row past it unread for good.
      expect(getSubscribersPage).toHaveBeenCalledTimes(2);
      expect(getSubscribersPage).toHaveBeenNthCalledWith(1, expect.any(Object), { limit: 100, offset: 100, status: "5" });
      expect(getSubscribersPage).toHaveBeenNthCalledWith(2, expect.any(Object), { limit: 100, offset: 200, status: "5" });
      expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
        code: "subscribers_total_changed",
        details: expect.objectContaining({ mode: "expired", previousTotal: 201, currentTotal: 202, restartCount: 2 }),
      }));
      expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(tx, expect.objectContaining({
        state: expect.objectContaining({
          mode: "expired",
          offset: 200,
          historyBackfilledAt: null,
          providerReportedTotal: 202,
          historyWithheldReason: "total_changed",
        }),
      }));
      expect(dbMocks.upsertArchivedPageSubscriptions).toHaveBeenCalledTimes(2);
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledTimes(1);
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
        state: expect.objectContaining({
          historyBackfilledAt: expect.any(String),
          historyCertified: false,
          historyWithheldReason: "total_changed",
        }),
      }));
      expect(result).toMatchObject({
        satisfied: true,
        stats: { mode: "expired", historyCertified: false, historyWithheldReason: "total_changed" },
      });
      expect(result.stats).not.toHaveProperty("finalizationWithheld");
      expect(db.transaction).toHaveBeenCalledTimes(2);
      expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
    });

    it("keeps a history walk uncertified across chunks", async () => {
      resumeWalk({
        mode: "expired",
        historyBackfilledAt: null,
        historyWithheldReason: "total_changed",
        restartCount: 2,
      });

      const { result } = await runWalk({ total: 150, items: subscriberItems("expired", 50), done: true });

      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        state: expect.objectContaining({ historyBackfilledAt: expect.any(String), historyCertified: false }),
      }));
      expect(result).toMatchObject({ satisfied: true, stats: { historyCertified: false } });
    });

    it("records a withheld active finalization through the page's first history walk", async () => {
      resumeWalk({ historyBackfilledAt: null, restartCount: 2 });

      const { result, tx } = await runWalk([
        { total: 151, items: subscriberItems("active", 100), done: false },
        { total: 1, items: subscriberItems("expired", 1), done: true },
      ]);

      expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(tx, expect.objectContaining({
        state: expect.objectContaining({ mode: "expired", offset: 0, activeWithheldReason: "total_changed" }),
      }));
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
        state: expect.objectContaining({
          mode: "expired",
          historyBackfilledAt: expect.any(String),
          destructiveFinalization: false,
          activeWithheldReason: "total_changed",
        }),
      }));
      expect(dbMocks.upsertCheckpoint.mock.calls[0]?.[1].state).not.toHaveProperty("historyCertified");
      expect(result).toMatchObject({
        satisfied: true,
        stats: {
          mode: "expired",
          destructiveFinalization: false,
          finalizationWithheld: true,
          withheldReason: "total_changed",
        },
      });
      expect(result.stats).not.toHaveProperty("historyCertified");
    });

    it("restarts a multi-page walk whose pages overlapped instead of retiring an unseen row", async () => {
      resumeWalk();
      dbMocks.maxPageSubscriptionGeneration.mockResolvedValue(7);
      dbMocks.countCurrentPageSubscriptionsByGeneration.mockResolvedValue(149);

      const { result, telemetry, tx } = await runWalk({
        total: 150,
        items: subscriberItems("active", 50),
        done: true,
      });

      expect(dbMocks.countCurrentPageSubscriptionsByGeneration).toHaveBeenCalledWith(tx, {
        platformAccountId: 14,
        generation: 7,
      });
      expect(result).toMatchObject({
        satisfied: false,
        continuationRetryAt: expect.any(Date),
        stats: { generation: 8, restartCount: 1, restartReason: "offset_duplicates" },
      });
      expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
        code: "subscribers_offset_duplicates",
        details: expect.objectContaining({ generationCurrentCount: 149, expectedCount: 150 }),
      }));
      expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(tx, expect.objectContaining({
        state: expect.objectContaining({ generation: 8, offset: 0, restartCount: 1 }),
      }));
      expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    });

    it("withholds retirement for overlapping pages once restarts are exhausted", async () => {
      resumeWalk({ restartCount: 2 });
      dbMocks.countCurrentPageSubscriptionsByGeneration.mockResolvedValue(149);

      const { result } = await runWalk({
        total: 150,
        items: subscriberItems("active", 50),
        done: true,
      });

      expect(result).toMatchObject({
        satisfied: true,
        stats: { finalizationWithheld: true, withheldReason: "offset_duplicates" },
      });
      expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
    });

    it("retires unseen subscriptions after a multi-page walk proves distinct membership", async () => {
      resumeWalk();
      dbMocks.countCurrentPageSubscriptionsByGeneration.mockResolvedValue(150);

      const { result, tx } = await runWalk({
        total: 150,
        items: subscriberItems("active", 50),
        done: true,
      });

      expect(result).toMatchObject({ satisfied: true });
      expect(result.stats).not.toHaveProperty("finalizationWithheld");
      expect(dbMocks.deactivatePageSubscriptionsByGeneration).toHaveBeenCalledWith(tx, {
        platformAccountId: 14,
        generation: 7,
        lastSeenBefore: new Date(WALK_STARTED_AT),
      });
    });

    it("restarts a multi-page walk that ends short of its total instead of retrying the same offset", async () => {
      resumeWalk();
      dbMocks.maxPageSubscriptionGeneration.mockResolvedValue(7);

      const { result, telemetry, db } = await runWalk({
        total: 150,
        items: subscriberItems("active", 30),
        done: true,
      });

      expect(result).toMatchObject({
        satisfied: false,
        stats: { generation: 8, restartCount: 1, restartReason: "partial_result" },
      });
      expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
        code: "subscribers_partial_page_guard",
      }));
      expect(fanHydrationMocks.lookupHydratedFans).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
    });
  });

  it("records OnlyFans transaction pulls as skips (webhook-sourced since Stage 18)", async () => {
    const telemetry = createTelemetry();
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
    } as never;

    const result = await onlyfansTransactionsChunk(app, {
      pageContext: {
        platform: "onlyfans",
        page: {
          id: 99,
          label: "onlyfans-page",
          platformAccountId: "of-99",
          metadata: {},
          commissionRate: 0.2,
        },
        auth: { token: "" },
        proxy: null,
      },
      streamState: {
        requestSeq: 7,
        requestPayload: null,
      },
      syncRunId: 200,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    // The stream completes without egress: OF transaction truth arrives via
    // the Stage 13 webhook writer gate, never a pull walker.
    expect(result.satisfied).toBe(true);
    expect(result.yieldReason).toBe(null);
    expect(result.stats).toMatchObject({ skipped: "onlyfans_transactions_webhook_sourced" });
  });

});
