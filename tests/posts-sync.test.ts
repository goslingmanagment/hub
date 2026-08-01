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
  fanslyPostsChunk,
  onlyfansPostsChunk,
  parsePostsCursorState,
  PostsCaptureConfigurationError,
} from "../apps/runtime/src/services/sync/posts.ts";

function telemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    getRequestObserver: vi.fn(() => null),
  };
}

function fanslyInput(budget = new SyncChunkBudget()) {
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
    telemetry: telemetry(),
    streamState: { requestSeq: 3 },
    syncRunId: 901,
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
      completedAt: null,
    };
    expect(parsePostsCursorState(state)).toEqual(state);
    expect(parsePostsCursorState({ ...state, before: "" })).toBeNull();
    expect(parsePostsCursorState({ ...state, revision: -1 })).toBeNull();
  });

  it("persists the Fansly response before refusing contract drift", async () => {
    const getPostsPage = vi.fn(async () => ({
      items: [],
      nextBefore: null,
      done: true,
      contractAccepted: false,
      raw: { unexpected: [] },
    }));

    await expect(fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage },
    } as never, fanslyInput())).rejects.toThrow(/drifted away/);

    expect(sharedMocks.persistRawPayload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      endpoint: "posts",
      payloadKind: "posts",
      responsePayload: { unexpected: [] },
    }), expect.anything());
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  });

  it("stops a Fansly incremental scan at its prior head and advances to the newly captured head", async () => {
    dbMocks.getCheckpoint.mockResolvedValue({
      cursorText: "post-10",
      state: {
        version: 1,
        platform: "fansly",
        revision: 3,
        headPostId: "post-10",
        anchorPostId: "post-10",
        capturedHeadPostId: null,
        before: "0",
        pageIndex: 0,
        pendingCaptureJobId: null,
        completedAt: null,
      },
    });
    const getPostsPage = vi.fn(async () => ({
      items: [
        { id: "post-12", createdAt: 1_775_000_000, content: "new" },
        { id: "post-10", createdAt: 1_774_000_000, content: "anchor" },
      ],
      nextBefore: "post-10",
      done: false,
      contractAccepted: true,
      raw: { posts: [{ id: "post-12" }, { id: "post-10" }] },
    }));

    const result = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage },
    } as never, fanslyInput());

    expect(result).toMatchObject({
      satisfied: true,
      stats: { anchorReached: true, headPostId: "post-12", captured: 2 },
    });
    expect(getPostsPage).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stream: "posts",
      cursorText: "post-12",
      lastSuccessfulRunId: 901,
      state: expect.objectContaining({ completedAt: expect.any(String), pageIndex: 1 }),
    }));
  });

  it("completes an empty Fansly backfill and preserves a resumable cursor when the chunk yields", async () => {
    const emptyPage = vi.fn(async () => ({
      items: [],
      nextBefore: null,
      done: true,
      contractAccepted: true,
      raw: { posts: [] },
    }));
    const emptyResult = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage: emptyPage },
    } as never, fanslyInput());
    expect(emptyResult).toMatchObject({ satisfied: true, stats: { headPostId: null, captured: 0 } });

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.upsertCheckpoint.mockClear();
    dbMocks.upsertCheckpointProgress.mockClear();
    const oneRequestBudget = new SyncChunkBudget(1);
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
    const yielded = await fanslyPostsChunk({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: { getPostsPage: paged },
    } as never, fanslyInput(oneRequestBudget));

    expect(yielded).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { before: "post-20", captured: 1, pages: 1 },
    });
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
