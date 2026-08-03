import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  assertOwnedPageSyncLease: vi.fn(async () => {}),
  createOrGetOfapiCaptureJob: vi.fn(),
  findActiveOfapiCaptureJobBySlot: vi.fn(),
  findPageById: vi.fn(),
  getCheckpoint: vi.fn(),
  getOfapiCaptureJob: vi.fn(),
  listPagesByPlatform: vi.fn(),
  listPageSyncStates: vi.fn(),
  pausePageSync: vi.fn(),
  upsertCheckpoint: vi.fn(),
  upsertCheckpointProgress: vi.fn(),
}));

const sharedMocks = vi.hoisted(() => ({
  persistRawPayload: vi.fn(),
  retentionDate: vi.fn(() => new Date("2026-10-31T00:00:00.000Z")),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/services/sync/shared.ts", () => sharedMocks);
vi.mock("../apps/runtime/src/services/ofapi-capture-jobs.ts", () => ({
  isOfapiBackgroundCaptureRunnable: (config: { ofapiMirrorBackgroundCaptureEnabled?: boolean } | undefined) =>
    config?.ofapiMirrorBackgroundCaptureEnabled === true,
}));

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  FANSLY_RECENT_POST_REFRESH_LOOKBACK_DAYS,
  fanslyPostsChunk,
  onlyfansPostsChunk,
  parsePostsCursorState,
  PostsCaptureConfigurationError,
} from "../apps/runtime/src/services/sync/posts.ts";

const FANSLY_NOW = new Date("2026-08-03T12:00:00.000Z");

function telemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    getRequestObserver: vi.fn(() => null),
  };
}

function fanslyInput(
  budget = new SyncChunkBudget(),
  runTelemetry = telemetry(),
  now = FANSLY_NOW,
) {
  return {
    budget,
    pageContext: {
      platform: "fansly",
      page: {
        id: 55,
        label: "fansly-posts",
        platformAccountId: "fan-account-55",
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: null,
      egressKey: "fansly:55",
    },
    telemetry: runTelemetry,
    streamState: { requestSeq: 3 },
    syncRunId: 901,
    now,
  } as never;
}

function onlyfansInput(ofapiAccountId: string | null = "ofapi-77") {
  return {
    budget: new SyncChunkBudget(),
    pageContext: {
      platform: "onlyfans",
      page: {
        id: 77,
        label: "onlyfans-posts",
        ofapiAccountId,
        metadata: {},
      },
      egressKey: "onlyfans:77",
    },
    telemetry: telemetry(),
    streamState: { requestSeq: 4 },
    syncRunId: 902,
  } as never;
}

function captureJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "cbf2c577-f1a2-4389-aa1e-9bb3d25cfe35",
    kind: "post_paginate",
    state: "ready",
    reasonCode: null,
    nextAttemptAt: null,
    leaseUntil: null,
    result: null,
    ...overrides,
  };
}

describe("posts sync handlers", () => {
  beforeEach(() => {
    for (const mock of [...Object.values(dbMocks), ...Object.values(sharedMocks)]) {
      mock.mockReset();
    }
    dbMocks.assertOwnedPageSyncLease.mockResolvedValue(undefined);
    dbMocks.findActiveOfapiCaptureJobBySlot.mockResolvedValue(null);
    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.getOfapiCaptureJob.mockResolvedValue(null);
    dbMocks.upsertCheckpoint.mockResolvedValue({});
    dbMocks.upsertCheckpointProgress.mockResolvedValue({});
    sharedMocks.persistRawPayload.mockResolvedValue(undefined);
    sharedMocks.retentionDate.mockReturnValue(new Date("2026-10-31T00:00:00.000Z"));
  });

  it("parses only the versioned durable posts cursor shape", () => {
    const state = {
      version: 1,
      platform: "fansly",
      revision: 2,
      headPostId: "post-10",
      anchorPostId: "post-10",
      capturedHeadPostId: null,
      before: "0",
      pageIndex: 0,
      pendingCaptureJobId: null,
      fanslyPostTipsCaptureVersion: 1,
      fanslyPostTipsBackfilledAt: null,
      completedAt: null,
    };
    expect(parsePostsCursorState(state)).toEqual({
      ...state,
      fanslyRecentRefreshCutoffAt: null,
      fanslyRecentRefreshAnchorReached: false,
    });
    expect(parsePostsCursorState({ ...state, before: "" })).toBeNull();
    expect(parsePostsCursorState({ ...state, revision: -1 })).toBeNull();
    expect(parsePostsCursorState({ ...state, fanslyPostTipsCaptureVersion: 2 })).toBeNull();
    expect(parsePostsCursorState({ ...state, fanslyRecentRefreshCutoffAt: "not-a-date" })).toBeNull();
    expect(parsePostsCursorState({ ...state, fanslyRecentRefreshAnchorReached: "yes" })).toBeNull();
  });

  it("persists the Fansly response before refusing contract drift", async () => {
    const getPostsPage = vi.fn(async () => ({
      items: [],
      nextBefore: null,
      done: true,
      contractAccepted: false,
      raw: { unexpected: [] },
    }));
    const getTipsByTargetIds = vi.fn();

    await expect(fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage, getTipsByTargetIds },
    } as never, fanslyInput())).rejects.toThrow(/drifted away/);

    expect(sharedMocks.persistRawPayload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      endpoint: "posts",
      payloadKind: "posts",
      responsePayload: { unexpected: [] },
    }), expect.anything());
    expect(getTipsByTargetIds).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  });

  it("retains drifted tip raw, records parse debt, and does not wedge the posts lane", async () => {
    const getPostsPage = vi.fn()
      .mockResolvedValueOnce({
        items: [{ id: "post-12", createdAt: 1_775_000_000, content: "new" }],
        nextBefore: "post-12",
        done: false,
        contractAccepted: true,
        raw: { posts: [{ id: "post-12" }] },
      })
      .mockResolvedValueOnce({
        items: [],
        nextBefore: null,
        done: true,
        contractAccepted: true,
        raw: { posts: [] },
      });
    const getTipsByTargetIds = vi.fn(async () => ({
      items: [],
      targetIds: ["post-12"],
      contractAccepted: false,
      raw: { tips: [] },
    }));

    const runTelemetry = telemetry();
    const input = fanslyInput(new SyncChunkBudget(), runTelemetry);
    const result = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage, getTipsByTargetIds },
    } as never, input);

    expect(getTipsByTargetIds).toHaveBeenCalledWith(expect.anything(), ["post-12"]);
    expect(sharedMocks.persistRawPayload).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      endpoint: "posts",
      payloadKind: "posts",
      responsePayload: { posts: [{ id: "post-12" }] },
    }), expect.anything());
    expect(sharedMocks.persistRawPayload).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      endpoint: "post_tips",
      payloadKind: "post_tips",
      requestParams: { targetIds: ["post-12"] },
      responsePayload: { tips: [] },
    }), expect.anything());
    expect(runTelemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "fansly_post_tips_contract_drift",
      severity: "warn",
    }));
    expect(result).toMatchObject({
      satisfied: true,
      stats: { captured: 1, postTipsContractDrifts: 1 },
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalled();
  });

  it("quarantines a tip response that escapes the requested post scope", async () => {
    const getPostsPage = vi.fn()
      .mockResolvedValueOnce({
        items: [{ id: "post-12", createdAt: 1_775_000_000, content: "new" }],
        nextBefore: "post-12",
        done: false,
        contractAccepted: true,
        raw: { posts: [{ id: "post-12" }] },
      })
      .mockResolvedValueOnce({
        items: [],
        nextBefore: null,
        done: true,
        contractAccepted: true,
        raw: { posts: [] },
      });
    const escaped = [{
      id: "tip-out-of-scope",
      receiverId: "fan-account-55",
      targetId: "another-post",
    }];
    const getTipsByTargetIds = vi.fn(async () => ({
      items: escaped,
      targetIds: ["post-12"],
      contractAccepted: true,
      raw: escaped,
    }));
    const runTelemetry = telemetry();

    const result = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage, getTipsByTargetIds },
    } as never, fanslyInput(new SyncChunkBudget(), runTelemetry));

    expect(sharedMocks.persistRawPayload).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        endpoint: "post_tips",
        mapperVersion: "fansly-post-tips-v2",
        requestParams: { targetIds: ["post-12"] },
        responsePayload: escaped,
      }),
      expect.objectContaining({
        observationPayload: {
          quarantine: "fansly_post_tips_scope_v1",
          requestedTargetIds: ["post-12"],
          response: escaped,
        },
      }),
    );
    expect(runTelemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "fansly_post_tips_scope_drift",
      severity: "warn",
      details: expect.objectContaining({
        rejectedItemIndexes: [0],
        reasons: ["post_target_out_of_scope"],
      }),
    }));
    expect(result).toMatchObject({
      satisfied: true,
      stats: { captured: 1, postTipsScopeDrifts: 1 },
    });
  });

  it("walks past the prior head through the frozen recent-publication horizon", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorText: "post-10",
      state: {
        version: 1,
        platform: "fansly",
        revision: 2,
        headPostId: "post-10",
        anchorPostId: "post-10",
        capturedHeadPostId: null,
        before: "0",
        pageIndex: 0,
        pendingCaptureJobId: null,
        fanslyPostTipsCaptureVersion: 1,
        fanslyPostTipsBackfilledAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-03T00:00:00.000Z",
      },
    });
    const getPostsPage = vi.fn()
      .mockResolvedValueOnce({
        items: [
          { id: "post-12", createdAt: "2026-08-02T12:00:00.000Z", content: "new" },
          { id: "post-10", createdAt: "2026-08-01T12:00:00.000Z", content: "anchor" },
        ],
        nextBefore: "page-1-tail",
        done: false,
        contractAccepted: true,
        raw: { posts: [{ id: "post-12" }, { id: "post-10" }] },
      })
      .mockResolvedValueOnce({
        items: [
          { id: "campaign-post", createdAt: "2026-07-25T12:00:00.000Z", content: "late tips live here" },
          { id: "post-older", createdAt: "2026-07-19T12:00:00.000Z", content: "older than cutoff" },
        ],
        nextBefore: "page-2-tail",
        done: false,
        contractAccepted: true,
        raw: { posts: [{ id: "campaign-post" }, { id: "post-older" }] },
      })
      .mockResolvedValueOnce({
        items: [
          { id: "post-old-2", createdAt: "2026-07-18T12:00:00.000Z", content: "fully old page" },
        ],
        nextBefore: "page-3-tail",
        done: false,
        contractAccepted: true,
        raw: { posts: [{ id: "post-old-2" }] },
      });
    const getTipsByTargetIds = vi.fn(async (_context, targetIds: string[]) => ({
      items: [],
      targetIds,
      contractAccepted: true,
      raw: [],
    }));

    const result = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage, getTipsByTargetIds },
    } as never, fanslyInput());

    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        anchorReached: true,
        headPostId: "post-12",
        captured: 5,
        recentRefreshCutoffAt: "2026-07-20T12:00:00.000Z",
        recentRefreshCutoffReached: true,
        timelineExhausted: false,
      },
    });
    expect(FANSLY_RECENT_POST_REFRESH_LOOKBACK_DAYS).toBe(14);
    expect(getPostsPage).toHaveBeenCalledTimes(3);
    expect(getTipsByTargetIds).toHaveBeenCalledWith(expect.anything(), ["post-12", "post-10"]);
    expect(getTipsByTargetIds).toHaveBeenCalledWith(expect.anything(), ["campaign-post", "post-older"]);
    expect(sharedMocks.persistRawPayload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      endpoint: "posts",
      requestParams: expect.objectContaining({
        scanMode: "recent_refresh",
        recentRefreshCutoffAt: "2026-07-20T12:00:00.000Z",
      }),
    }), expect.anything());
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stream: "posts",
      cursorText: "post-12",
      lastSuccessfulRunId: 901,
      state: expect.objectContaining({
        completedAt: FANSLY_NOW.toISOString(),
        pageIndex: 3,
        fanslyRecentRefreshCutoffAt: "2026-07-20T12:00:00.000Z",
        fanslyRecentRefreshAnchorReached: true,
      }),
    }));
  });

  it("keeps an in-progress cutoff frozen and includes posts published exactly at it", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorText: "post-20",
      state: {
        version: 1,
        platform: "fansly",
        revision: 3,
        headPostId: "post-10",
        anchorPostId: "post-10",
        capturedHeadPostId: "post-20",
        before: "page-1-tail",
        pageIndex: 1,
        pendingCaptureJobId: null,
        fanslyPostTipsCaptureVersion: 1,
        fanslyPostTipsBackfilledAt: "2026-08-01T00:00:00.000Z",
        fanslyRecentRefreshCutoffAt: "2026-07-20T12:00:00.000Z",
        fanslyRecentRefreshAnchorReached: true,
        completedAt: null,
      },
    });
    const getPostsPage = vi.fn()
      .mockResolvedValueOnce({
        items: [
          { id: "post-at-cutoff", createdAt: "2026-07-20T12:00:00.000Z" },
          { id: "post-old", createdAt: "2026-07-19T12:00:00.000Z" },
        ],
        nextBefore: "page-2-tail",
        done: false,
        contractAccepted: true,
        raw: { posts: [] },
      })
      .mockResolvedValueOnce({
        items: [{ id: "post-older", createdAt: "2026-07-18T12:00:00.000Z" }],
        nextBefore: "page-3-tail",
        done: false,
        contractAccepted: true,
        raw: { posts: [] },
      });
    const getTipsByTargetIds = vi.fn(async (_context, targetIds: string[]) => ({
      items: [],
      targetIds,
      contractAccepted: true,
      raw: [],
    }));

    const result = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage, getTipsByTargetIds },
    } as never, fanslyInput(
      new SyncChunkBudget(),
      telemetry(),
      new Date("2026-08-10T12:00:00.000Z"),
    ));

    expect(getPostsPage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        pages: 3,
        recentRefreshCutoffAt: "2026-07-20T12:00:00.000Z",
        recentRefreshCutoffReached: true,
      },
    });
  });

  it("restarts an unfinished legacy incremental checkpoint without a refresh cutoff", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorText: "post-10",
      state: {
        version: 1,
        platform: "fansly",
        revision: 3,
        headPostId: "post-10",
        anchorPostId: "post-10",
        capturedHeadPostId: "post-12",
        before: "legacy-tail",
        pageIndex: 4,
        pendingCaptureJobId: null,
        fanslyPostTipsCaptureVersion: 1,
        fanslyPostTipsBackfilledAt: "2026-08-01T00:00:00.000Z",
        completedAt: null,
      },
    });
    const getPostsPage = vi.fn(async () => ({
      items: [{ id: "post-old", createdAt: "2026-07-18T12:00:00.000Z" }],
      nextBefore: "old-tail",
      done: false,
      contractAccepted: true,
      raw: { posts: [] },
    }));
    const getTipsByTargetIds = vi.fn(async (_context, targetIds: string[]) => ({
      items: [],
      targetIds,
      contractAccepted: true,
      raw: [],
    }));

    await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage, getTipsByTargetIds },
    } as never, fanslyInput());

    expect(getPostsPage).toHaveBeenCalledWith(expect.anything(), "fan-account-55", {
      before: "0",
      pageIndex: 0,
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      state: expect.objectContaining({
        fanslyRecentRefreshCutoffAt: "2026-07-20T12:00:00.000Z",
        pageIndex: 1,
      }),
    }));
  });

  it("full-crawls once when a legacy Fansly checkpoint predates post-tip capture", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorText: "post-10",
      state: {
        version: 1,
        platform: "fansly",
        revision: 2,
        headPostId: "post-10",
        anchorPostId: "post-10",
        capturedHeadPostId: null,
        before: "0",
        pageIndex: 0,
        pendingCaptureJobId: null,
        completedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    const getPostsPage = vi.fn()
      .mockResolvedValueOnce({
        items: [{ id: "post-10", createdAt: 1_774_000_000, content: "legacy head" }],
        nextBefore: "post-10",
        done: false,
        contractAccepted: true,
        raw: { posts: [{ id: "post-10" }] },
      })
      .mockResolvedValueOnce({
        items: [],
        nextBefore: null,
        done: true,
        contractAccepted: true,
        raw: { posts: [] },
      });
    const getTipsByTargetIds = vi.fn(async (_context, targetIds: string[]) => ({
      items: [],
      targetIds,
      contractAccepted: true,
      raw: [],
    }));

    const result = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage, getTipsByTargetIds },
    } as never, fanslyInput());

    expect(result).toMatchObject({ satisfied: true, stats: { anchorReached: false } });
    expect(getPostsPage).toHaveBeenCalledTimes(2);
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      state: expect.objectContaining({
        fanslyPostTipsBackfilledAt: expect.any(String),
        fanslyRecentRefreshCutoffAt: null,
        completedAt: expect.any(String),
      }),
    }));
  });

  it("resumes an unfinished Fansly post-tip backfill across request generations", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorText: null,
      state: {
        version: 1,
        platform: "fansly",
        revision: 2,
        headPostId: null,
        anchorPostId: null,
        capturedHeadPostId: "post-20",
        before: "post-10",
        pageIndex: 4,
        pendingCaptureJobId: null,
        fanslyPostTipsCaptureVersion: 1,
        fanslyPostTipsBackfilledAt: null,
        completedAt: null,
      },
    });
    const getPostsPage = vi.fn(async () => ({
      items: [],
      nextBefore: null,
      done: true,
      contractAccepted: true,
      raw: { posts: [] },
    }));
    const getTipsByTargetIds = vi.fn();

    const result = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage, getTipsByTargetIds },
    } as never, fanslyInput());

    expect(getPostsPage).toHaveBeenCalledWith(expect.anything(), "fan-account-55", {
      before: "post-10",
      pageIndex: 4,
    });
    expect(result).toMatchObject({
      satisfied: true,
      stats: { pages: 5, headPostId: "post-20" },
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      state: expect.objectContaining({
        revision: 3,
        fanslyPostTipsBackfilledAt: expect.any(String),
      }),
    }));
  });

  it("resumes an unfinished bounded refresh across request generations", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorText: "post-20",
      state: {
        version: 1,
        platform: "fansly",
        revision: 2,
        headPostId: "post-10",
        anchorPostId: "post-10",
        capturedHeadPostId: "post-20",
        before: "page-2-tail",
        pageIndex: 2,
        pendingCaptureJobId: null,
        fanslyPostTipsCaptureVersion: 1,
        fanslyPostTipsBackfilledAt: "2026-08-01T00:00:00.000Z",
        fanslyRecentRefreshCutoffAt: "2026-07-20T12:00:00.000Z",
        fanslyRecentRefreshAnchorReached: true,
        completedAt: null,
      },
    });
    const getPostsPage = vi.fn(async () => ({
      items: [{
        id: "post-old",
        createdAt: "2026-07-18T12:00:00.000Z",
        content: "first wholly old page",
      }],
      nextBefore: "page-3-tail",
      done: false,
      contractAccepted: true,
      raw: { posts: [{ id: "post-old" }] },
    }));
    const getTipsByTargetIds = vi.fn(async (_context, targetIds: string[]) => ({
      items: [],
      targetIds,
      contractAccepted: true,
      raw: [],
    }));

    const result = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage, getTipsByTargetIds },
    } as never, fanslyInput());

    expect(getPostsPage).toHaveBeenCalledWith(expect.anything(), "fan-account-55", {
      before: "page-2-tail",
      pageIndex: 2,
    });
    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        pages: 3,
        headPostId: "post-20",
        anchorReached: true,
        recentRefreshCutoffReached: true,
      },
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      cursorText: "post-20",
      state: expect.objectContaining({
        revision: 3,
        fanslyRecentRefreshCutoffAt: "2026-07-20T12:00:00.000Z",
        fanslyRecentRefreshAnchorReached: true,
      }),
    }));
  });

  it("completes an empty Fansly backfill without requesting tips", async () => {
    const emptyPage = vi.fn(async () => ({
      items: [],
      nextBefore: null,
      done: true,
      contractAccepted: true,
      raw: { posts: [] },
    }));
    const getTipsByTargetIds = vi.fn();
    const emptyResult = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage: emptyPage, getTipsByTargetIds },
    } as never, fanslyInput());
    expect(emptyResult).toMatchObject({ satisfied: true, stats: { headPostId: null, captured: 0 } });
    expect(getTipsByTargetIds).not.toHaveBeenCalled();
  });

  it("reserves both Fansly page requests and checkpoints only the complete pair", async () => {
    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.upsertCheckpoint.mockClear();
    dbMocks.upsertCheckpointProgress.mockClear();
    const oneRequestBudget = new SyncChunkBudget(1);
    const getPostsPage = vi.fn();
    const getTipsByTargetIds = vi.fn();
    const refused = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage, getTipsByTargetIds },
    } as never, fanslyInput(oneRequestBudget));
    expect(refused).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { before: "0", captured: 0, pages: 0 },
    });
    expect(getPostsPage).not.toHaveBeenCalled();
    expect(getTipsByTargetIds).not.toHaveBeenCalled();

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.upsertCheckpoint.mockClear();
    dbMocks.upsertCheckpointProgress.mockClear();
    const twoRequestBudget = new SyncChunkBudget(2);
    const paged = vi.fn(async (context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } }) => {
      await context.requestObserver?.onRequestEvent({ state: "started" });
      return {
        items: [{ id: "post-20", createdAt: 1_775_000_000, content: "page one" }],
        nextBefore: "post-20",
        done: false,
        contractAccepted: true,
        raw: { posts: [{ id: "post-20" }] },
      };
    });
    const tips = vi.fn(async (
      context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } },
      targetIds: string[],
    ) => {
      await context.requestObserver?.onRequestEvent({ state: "started" });
      return {
        items: [],
        targetIds,
        contractAccepted: true,
        raw: [],
      };
    });
    const yielded = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage: paged, getTipsByTargetIds: tips },
    } as never, fanslyInput(twoRequestBudget));

    expect(yielded).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { before: "post-20", captured: 1, pages: 1 },
    });
    expect(tips).toHaveBeenCalledWith(expect.anything(), ["post-20"]);
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      stream: "posts",
      state: expect.objectContaining({ before: "post-20", pageIndex: 1, capturedHeadPostId: "post-20" }),
    }));
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  });

  it("fails honestly instead of claiming a gated success when OFAPI capture is off", async () => {
    await expect(onlyfansPostsChunk({
      db: {},
      config: { ofapiMirrorBackgroundCaptureEnabled: false },
    } as never, onlyfansInput())).rejects.toMatchObject({
      name: "PostsCaptureConfigurationError",
      code: "ofapi_posts_capture_disabled",
    });

    expect(dbMocks.getCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.createOrGetOfapiCaptureJob).not.toHaveBeenCalled();
  });

  it("treats a missing OFAPI mapping as configuration error, never gated success", async () => {
    await expect(onlyfansPostsChunk({
      db: {},
      config: { ofapiMirrorBackgroundCaptureEnabled: true },
    } as never, onlyfansInput(null))).rejects.toEqual(
      new PostsCaptureConfigurationError("ofapi_account_unmapped"),
    );

    expect(dbMocks.getCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.createOrGetOfapiCaptureJob).not.toHaveBeenCalled();
  });

  it("seeds one governed OFAPI post job, yields, then checkpoints only after completion", async () => {
    const ready = captureJob();
    dbMocks.createOrGetOfapiCaptureJob.mockResolvedValue({ created: true, job: ready });

    const app = {
      db: {},
      config: { ofapiMirrorBackgroundCaptureEnabled: true },
    } as never;
    const first = await onlyfansPostsChunk(app, onlyfansInput());

    expect(first).toMatchObject({
      satisfied: false,
      yieldReason: null,
      stats: { captureJobId: ready.id, captureState: "ready" },
    });
    expect(dbMocks.createOrGetOfapiCaptureJob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pageId: 77,
      ofapiAccountId: "ofapi-77",
      kind: "post_paginate",
      activeSlotKey: "page:77:posts",
      budgetScope: "bulk",
      target: expect.objectContaining({ anchorPostId: null, limit: 100, requestRevision: 4 }),
    }));
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();

    dbMocks.getCheckpoint.mockResolvedValue({
      cursorText: null,
      state: {
        version: 1,
        platform: "onlyfans",
        revision: 4,
        headPostId: null,
        anchorPostId: null,
        capturedHeadPostId: null,
        before: "0",
        pageIndex: 0,
        pendingCaptureJobId: ready.id,
        completedAt: null,
      },
    });
    dbMocks.getOfapiCaptureJob.mockResolvedValue(captureJob({
      state: "complete",
      result: { headPostId: "of-post-90", pages: 3 },
    }));
    const completed = await onlyfansPostsChunk(app, onlyfansInput());

    expect(completed).toMatchObject({
      satisfied: true,
      stats: { captureJobId: ready.id, headPostId: "of-post-90" },
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stream: "posts",
      cursorText: "of-post-90",
      lastSuccessfulRunId: 902,
      state: expect.objectContaining({
        headPostId: "of-post-90",
        pendingCaptureJobId: null,
        completedAt: expect.any(String),
      }),
    }));
  });

  it("surfaces a blocked OFAPI posts capture job without advancing the checkpoint", async () => {
    const blocked = captureJob({ state: "blocked", reasonCode: "contract_drift" });
    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        platform: "onlyfans",
        revision: 4,
        headPostId: "old-head",
        anchorPostId: "old-head",
        capturedHeadPostId: null,
        before: "0",
        pageIndex: 0,
        pendingCaptureJobId: blocked.id,
        completedAt: null,
      },
    });
    dbMocks.getOfapiCaptureJob.mockResolvedValue(blocked);

    await expect(onlyfansPostsChunk({
      db: {},
      config: { ofapiMirrorBackgroundCaptureEnabled: true },
    } as never, onlyfansInput())).rejects.toThrow(/blocked: contract_drift/);
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  });
});
