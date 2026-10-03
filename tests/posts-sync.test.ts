import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
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

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/services/ofapi-capture-jobs.ts", () => ({
  isOfapiBackgroundCaptureRunnable: (config: { ofapiMirrorBackgroundCaptureEnabled?: boolean } | undefined) =>
    config?.ofapiMirrorBackgroundCaptureEnabled === true,
}));

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  onlyfansPostsChunk,
  PostsCaptureJobBlockedError,
  PostsCaptureConfigurationError,
} from "../apps/runtime/src/services/sync/posts.ts";
import { parsePostsCursorState } from "../apps/runtime/src/sync/fansly/lib/posts-rules.ts";

// The legacy executor's `posts` stream is OnlyFans only; a Fansly page's posts
// are the Fansly Sync Engine's (tests/sync-resources-content*.test.ts).

function telemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    getRequestObserver: vi.fn(() => null),
  };
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

function resetPostsSyncMocks() {
  for (const mock of Object.values(dbMocks)) {
    mock.mockReset();
  }
  dbMocks.findActiveOfapiCaptureJobBySlot.mockResolvedValue(null);
  dbMocks.getCheckpoint.mockResolvedValue(null);
  dbMocks.getOfapiCaptureJob.mockResolvedValue(null);
  dbMocks.upsertCheckpoint.mockResolvedValue({});
  dbMocks.upsertCheckpointProgress.mockResolvedValue({});
}

describe("posts sync handlers", () => {
  beforeEach(resetPostsSyncMocks);

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
      // WP-F6: a checkpoint written before the engagement phase existed parses
      // as "never run" rather than failing — refusing the whole cursor here
      // would restart the timeline walk from the head on the deploy that ships
      // the phase.
      fanslyPostEngagement: {
        utcDay: null,
        callsToday: 0,
        seedCursor: null,
        seedComplete: false,
      },
    });
    expect(parsePostsCursorState({ ...state, before: "" })).toBeNull();
    expect(parsePostsCursorState({ ...state, revision: -1 })).toBeNull();
    expect(parsePostsCursorState({ ...state, fanslyPostTipsCaptureVersion: 2 })).toBeNull();
    expect(parsePostsCursorState({ ...state, fanslyRecentRefreshCutoffAt: "not-a-date" })).toBeNull();
    expect(parsePostsCursorState({ ...state, fanslyRecentRefreshAnchorReached: "yes" })).toBeNull();
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

  it("forgets an owner-cancelled pending job and seeds a fresh one through the slot path (decision #249)", async () => {
    const cancelled = captureJob({ state: "cancelled", reasonCode: "owner_cancelled" });
    const fresh = captureJob({ id: "job-fresh" });
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
        pendingCaptureJobId: cancelled.id,
        completedAt: null,
      },
    });
    dbMocks.getOfapiCaptureJob.mockResolvedValue(cancelled);
    dbMocks.findActiveOfapiCaptureJobBySlot.mockResolvedValue(null);
    dbMocks.createOrGetOfapiCaptureJob.mockResolvedValue({ created: true, job: fresh });

    const result = await onlyfansPostsChunk({
      db: {},
      config: { ofapiMirrorBackgroundCaptureEnabled: true },
    } as never, onlyfansInput());

    expect(result).toMatchObject({
      satisfied: false,
      stats: { captureJobId: "job-fresh" },
    });
    expect(dbMocks.findActiveOfapiCaptureJobBySlot).toHaveBeenCalledWith(expect.anything(), "page:77:posts");
    expect(dbMocks.createOrGetOfapiCaptureJob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      activeSlotKey: "page:77:posts",
      target: expect.objectContaining({ anchorPostId: "old-head" }),
    }));
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      state: expect.objectContaining({ pendingCaptureJobId: "job-fresh" }),
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
    } as never, onlyfansInput())).rejects.toEqual(
      new PostsCaptureJobBlockedError(blocked.id, "contract_drift"),
    );
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  });
});
