import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getCheckpoint: vi.fn(),
  listOnlyFansPublicProfileResolutionCandidates: vi.fn(),
  upsertCheckpoint: vi.fn(),
  upsertCheckpointProgress: vi.fn(),
  upsertFanPages: vi.fn(),
  upsertFans: vi.fn(),
  upsertOnlyFansPublicProfileResolution: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof import("@agency_hub_core/db")>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { syncOnlyFansIdentities } from "../apps/runtime/src/services/sync/onlyfans-identities.ts";

function createTelemetry() {
  return {
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
  };
}

function makeLinkUser(input: {
  id: string;
  name: string;
  username: string;
  collectedAt: string;
  linkId?: string;
}) {
  return {
    link_id: input.linkId ?? "link-1",
    fan: {
      id: input.id,
      name: input.name,
      username: input.username,
    },
    subscribed_at: input.collectedAt,
    collected_at: input.collectedAt,
  };
}

function makeCursorPage<TItem>(items: TItem[], cursor?: string) {
  return {
    parsed: cursor ? { items, cursor } : { items },
    raw: {
      items,
      cursor,
    },
  };
}

function createAdapter(input: {
  trackingPages: Array<ReturnType<typeof makeCursorPage>>;
  trialPages: Array<ReturnType<typeof makeCursorPage>>;
}) {
  const trackingPages = [...input.trackingPages];
  const trialPages = [...input.trialPages];

  return {
    getTrackingLinkUsersPage: vi.fn(async () => {
      const page = trackingPages.shift();
      if (!page) {
        throw new Error("Unexpected tracking link users page request");
      }
      return page;
    }),
    getTrialLinkUsersPage: vi.fn(async () => {
      const page = trialPages.shift();
      if (!page) {
        throw new Error("Unexpected trial link users page request");
      }
      return page;
    }),
  };
}

function createApp(adapter: ReturnType<typeof createAdapter>) {
  const config: {
    onlyFansPublicProfileResolutionEnabled: boolean;
    onlyFansPublicProfileAllowDirect: boolean;
    onlyFansPublicProfileProxy: { url: string; username?: string | null; password?: string | null } | null;
    onlyFansPublicProfileMaxPerRun: number;
    onlyFansPublicProfileDelayMs: number;
  } = {
    onlyFansPublicProfileResolutionEnabled: false,
    onlyFansPublicProfileAllowDirect: false,
    onlyFansPublicProfileProxy: null,
    onlyFansPublicProfileMaxPerRun: 5,
    onlyFansPublicProfileDelayMs: 30_000,
  };

  return {
    config,
    db: {
      transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
    },
    onlyFansAdapter: adapter,
  };
}

async function runIdentitySync(input: {
  adapter: ReturnType<typeof createAdapter>;
  budget?: SyncChunkBudget;
  checkpoint?: {
    cursorTimestamp?: Date | null;
    state?: Record<string, unknown>;
  } | null;
  publicProfileResolver?: {
    resolve: ReturnType<typeof vi.fn>;
    close?: ReturnType<typeof vi.fn>;
  };
  publicProfileConfig?: {
    enabled?: boolean;
    allowDirect?: boolean;
    proxy?: { url: string; username?: string | null; password?: string | null } | null;
    maxPerRun?: number;
    delayMs?: number;
  };
}) {
  const telemetry = createTelemetry();
  dbMocks.getCheckpoint.mockResolvedValueOnce(input.checkpoint ?? null);
  const app = createApp(input.adapter);
  app.config.onlyFansPublicProfileResolutionEnabled = input.publicProfileConfig?.enabled ?? false;
  app.config.onlyFansPublicProfileAllowDirect = input.publicProfileConfig?.allowDirect ?? false;
  app.config.onlyFansPublicProfileProxy = input.publicProfileConfig?.proxy ?? null;
  app.config.onlyFansPublicProfileMaxPerRun = input.publicProfileConfig?.maxPerRun ?? 5;
  app.config.onlyFansPublicProfileDelayMs = input.publicProfileConfig?.delayMs ?? 30_000;

  return syncOnlyFansIdentities(app as never, {
    pageLabel: "onlyfans-page",
    platformAccountId: 1,
    platformAccountIdValue: "of-1",
    requestContext: {
      auth: { token: "secret" },
      proxy: null,
      requestObserver: input.budget ?? null,
    } as never,
    syncRunId: 123,
    telemetry: telemetry as never,
    budget: input.budget ?? new SyncChunkBudget(10, 60_000),
    publicProfileResolver: input.publicProfileResolver as never,
  });
}

describe("syncOnlyFansIdentities", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z"));

    for (const mock of Object.values(dbMocks)) {
      mock.mockReset();
    }

    dbMocks.upsertFanPages.mockResolvedValue(undefined);
    dbMocks.upsertFans.mockImplementation(async (_db: unknown, inputs: Array<{ platformUserId: string }>) =>
      inputs.map((input, index) => ({
        id: index + 1,
        platformUserId: input.platformUserId,
      })));
    dbMocks.upsertCheckpointProgress.mockImplementation(async (
      _db: unknown,
      input: {
        cursorTimestamp?: Date | null;
        state?: Record<string, unknown>;
      },
    ) => ({
      cursorTimestamp: input.cursorTimestamp ?? null,
      state: input.state ?? {},
    }));
    dbMocks.upsertCheckpoint.mockImplementation(async (
      _db: unknown,
      input: {
        cursorTimestamp?: Date | null;
        lastSuccessfulRunId?: number | null;
        state?: Record<string, unknown>;
      },
    ) => ({
      cursorTimestamp: input.cursorTimestamp ?? null,
      lastSuccessfulRunId: input.lastSuccessfulRunId ?? null,
      state: input.state ?? {},
    }));
    dbMocks.listOnlyFansPublicProfileResolutionCandidates.mockResolvedValue([]);
    dbMocks.upsertOnlyFansPublicProfileResolution.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates OnlyFans fan names and usernames from tracking and trial link users", async () => {
    const adapter = createAdapter({
      trackingPages: [
        makeCursorPage([
          makeLinkUser({
            id: "87790113",
            name: "Arian/US/27",
            username: "@arian_15",
            collectedAt: "2026-05-20T10:00:00.000Z",
          }),
        ]),
      ],
      trialPages: [
        makeCursorPage([
          makeLinkUser({
            id: "529639300",
            name: "Michael/USA/30",
            username: "u529639300",
            collectedAt: "2026-05-27T12:00:00.000Z",
          }),
        ]),
      ],
    });

    const result = await runIdentitySync({ adapter });

    expect(adapter.getTrackingLinkUsersPage).toHaveBeenCalledWith(expect.anything(), "of-1", expect.objectContaining({
      collectedFrom: null,
      collectedTo: new Date("2026-05-28T00:00:00.000Z"),
      limit: 750,
      pageIndex: 0,
    }));
    expect(adapter.getTrialLinkUsersPage).toHaveBeenCalledWith(expect.anything(), "of-1", expect.objectContaining({
      collectedFrom: null,
      collectedTo: new Date("2026-05-28T00:00:00.000Z"),
      limit: 750,
      pageIndex: 0,
    }));
    expect(dbMocks.upsertFans.mock.calls[0]?.[1]).toEqual([{
      platform: "onlyfans",
      platformUserId: "87790113",
      username: "arian_15",
      displayName: "Arian/US/27",
    }]);
    expect(dbMocks.upsertFans.mock.calls[1]?.[1]).toEqual([{
      platform: "onlyfans",
      platformUserId: "529639300",
      username: "u529639300",
      displayName: "Michael/USA/30",
    }]);
    expect(dbMocks.upsertFanPages).toHaveBeenCalledWith(expect.anything(), [{
      fanId: 1,
      platformAccountId: 1,
    }]);
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 1,
      stream: "fan_identities",
      cursorTimestamp: new Date("2026-05-27T12:00:00.000Z"),
      lastSuccessfulRunId: 123,
    }));
    expect(result).toMatchObject({
      satisfied: true,
      processed: 2,
      processedTrackingUsers: 1,
      processedTrialUsers: 1,
      upsertedFans: 2,
    });
  });

  it("uses an overlap window for incremental identity sync", async () => {
    const adapter = createAdapter({
      trackingPages: [makeCursorPage([])],
      trialPages: [makeCursorPage([])],
    });

    await runIdentitySync({
      adapter,
      checkpoint: {
        cursorTimestamp: new Date("2026-05-27T12:00:00.000Z"),
        state: {
          pageLabel: "onlyfans-page",
        },
      },
    });

    expect(adapter.getTrackingLinkUsersPage).toHaveBeenCalledWith(expect.anything(), "of-1", expect.objectContaining({
      collectedFrom: new Date("2026-05-20T12:00:00.000Z"),
      collectedTo: new Date("2026-05-28T00:00:00.000Z"),
    }));
  });

  it("skips the public profile fallback when neither a dedicated proxy nor direct egress is configured", async () => {
    const adapter = createAdapter({
      trackingPages: [makeCursorPage([])],
      trialPages: [makeCursorPage([])],
    });
    const publicProfileResolver = {
      resolve: vi.fn(),
      close: vi.fn(),
    };

    const result = await runIdentitySync({
      adapter,
      publicProfileConfig: {
        enabled: true,
        proxy: null,
      },
      publicProfileResolver,
    });

    expect(publicProfileResolver.resolve).not.toHaveBeenCalled();
    expect(dbMocks.listOnlyFansPublicProfileResolutionCandidates).not.toHaveBeenCalled();
    expect(result.publicProfilesAttempted).toBe(0);
    expect(result.publicProfilesResolved).toBe(0);
  });

  it("allows the public profile fallback to use direct egress when explicitly configured", async () => {
    const adapter = createAdapter({
      trackingPages: [makeCursorPage([])],
      trialPages: [makeCursorPage([])],
    });
    const publicProfileResolver = {
      resolve: vi.fn(async () => ({
        status: "resolved" as const,
        platformUserId: "87790113",
        username: "jamesjamesjamesjames",
        displayName: "James",
      })),
      close: vi.fn(),
    };
    dbMocks.listOnlyFansPublicProfileResolutionCandidates.mockResolvedValueOnce([{
      fanId: 44,
      platformUserId: "87790113",
      previousAttemptCount: 0,
    }]);

    const result = await runIdentitySync({
      adapter,
      publicProfileConfig: {
        enabled: true,
        allowDirect: true,
        proxy: null,
      },
      publicProfileResolver,
    });

    expect(publicProfileResolver.resolve).toHaveBeenCalledWith("87790113");
    expect(result.publicProfilesAttempted).toBe(1);
    expect(result.publicProfilesResolved).toBe(1);
  });

  it("hydrates unresolved top OnlyFans fans through the public profile fallback", async () => {
    const adapter = createAdapter({
      trackingPages: [makeCursorPage([])],
      trialPages: [makeCursorPage([])],
    });
    const publicProfileResolver = {
      resolve: vi.fn(async () => ({
        status: "resolved" as const,
        platformUserId: "87790113",
        username: "jamesjamesjamesjames",
        displayName: "James",
      })),
      close: vi.fn(),
    };
    dbMocks.listOnlyFansPublicProfileResolutionCandidates.mockResolvedValueOnce([{
      fanId: 44,
      platformUserId: "87790113",
      previousAttemptCount: 0,
    }]);

    const result = await runIdentitySync({
      adapter,
      publicProfileConfig: {
        enabled: true,
        proxy: { url: "socks5://203.0.113.10:1080" },
      },
      publicProfileResolver,
    });

    expect(dbMocks.listOnlyFansPublicProfileResolutionCandidates).toHaveBeenCalledWith(expect.anything(), {
      platformAccountId: 1,
      limit: 5,
    });
    expect(publicProfileResolver.resolve).toHaveBeenCalledWith("87790113");
    expect(dbMocks.upsertFans).toHaveBeenLastCalledWith(expect.anything(), [{
      platform: "onlyfans",
      platformUserId: "87790113",
      username: "jamesjamesjamesjames",
      displayName: "James",
    }]);
    expect(dbMocks.upsertOnlyFansPublicProfileResolution).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      fanId: 44,
      platformUserId: "87790113",
      status: "resolved",
      username: "jamesjamesjamesjames",
      displayName: "James",
      resolvedAt: new Date("2026-05-28T00:00:00.000Z"),
    }));
    expect(result.publicProfilesAttempted).toBe(1);
    expect(result.publicProfilesResolved).toBe(1);
  });

  it("stops the public profile fallback after a rate limit response", async () => {
    const adapter = createAdapter({
      trackingPages: [makeCursorPage([])],
      trialPages: [makeCursorPage([])],
    });
    const publicProfileResolver = {
      resolve: vi.fn(async () => ({
        status: "rate_limited" as const,
        platformUserId: "87790113",
        error: "HTTP 429",
      })),
      close: vi.fn(),
    };
    dbMocks.listOnlyFansPublicProfileResolutionCandidates.mockResolvedValueOnce([
      { fanId: 44, platformUserId: "87790113", previousAttemptCount: 0 },
      { fanId: 45, platformUserId: "176910775", previousAttemptCount: 0 },
    ]);

    const result = await runIdentitySync({
      adapter,
      publicProfileConfig: {
        enabled: true,
        proxy: { url: "socks5://203.0.113.10:1080" },
      },
      publicProfileResolver,
    });

    expect(publicProfileResolver.resolve).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsertOnlyFansPublicProfileResolution).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      fanId: 44,
      status: "rate_limited",
      nextAttemptAfter: new Date("2026-05-29T00:00:00.000Z"),
    }));
    expect(result.publicProfilesAttempted).toBe(1);
    expect(result.publicProfilesResolved).toBe(0);
  });
});
