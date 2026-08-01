import {
  assertOwnedPageSyncLease,
  createOrGetOfapiCaptureJob,
  findActiveOfapiCaptureJobBySlot,
  getCheckpoint,
  getOfapiCaptureJob,
  upsertCheckpoint,
  upsertCheckpointProgress,
  type PageSyncLease,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { resolveFanslyPlatformAccountId } from "../fansly.ts";
import { isOfapiBackgroundCaptureRunnable } from "../ofapi-capture-jobs.ts";
import type { ResolvedPageContext } from "../page-context.ts";
import { composeRequestObservers, type SyncChunkBudget } from "./chunk-budget.ts";
import type { StreamChunkResult } from "./executor-handlers.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import { persistRawPayload, retentionDate } from "./shared.ts";

const FANSLY_POSTS_MAPPER_VERSION = "fansly-posts-v1";
const OFAPI_POSTS_CAPTURE_LIMIT = 100;
const OFAPI_POSTS_CAPTURE_MAX_PAGES = 1_000;
const OFAPI_POSTS_CAPTURE_PRIORITY = 30;

type ExecutorRequestContext = {
  budget: SyncChunkBudget;
  pageContext: ResolvedPageContext;
  telemetry: SyncRunTelemetry;
  streamState: PageSyncLease;
  syncRunId: number;
};

export type PostsCursorState = {
  version: 1;
  platform: "fansly" | "onlyfans";
  revision: number;
  headPostId: string | null;
  anchorPostId: string | null;
  capturedHeadPostId: string | null;
  before: string;
  pageIndex: number;
  pendingCaptureJobId: string | null;
  completedAt: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

export function parsePostsCursorState(value: unknown): PostsCursorState | null {
  const state = asRecord(value);
  if (!state || state.version !== 1 || (state.platform !== "fansly" && state.platform !== "onlyfans")) {
    return null;
  }
  const revision = state.revision;
  const headPostId = nullableString(state.headPostId);
  const anchorPostId = nullableString(state.anchorPostId);
  const capturedHeadPostId = nullableString(state.capturedHeadPostId);
  const before = state.before;
  const pageIndex = state.pageIndex;
  const pendingCaptureJobId = nullableString(state.pendingCaptureJobId);
  const completedAt = nullableString(state.completedAt);
  if (
    typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 ||
    headPostId === undefined || anchorPostId === undefined || capturedHeadPostId === undefined ||
    typeof before !== "string" || before.length === 0 ||
    typeof pageIndex !== "number" || !Number.isSafeInteger(pageIndex) || pageIndex < 0 ||
    pendingCaptureJobId === undefined || completedAt === undefined
  ) {
    return null;
  }
  return {
    version: 1,
    platform: state.platform,
    revision,
    headPostId,
    anchorPostId,
    capturedHeadPostId,
    before,
    pageIndex,
    pendingCaptureJobId,
    completedAt,
  };
}

function fanslyPublishedAtIsValid(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const date = new Date(value >= 1_000_000_000_000 ? value : value * 1_000);
    return !Number.isNaN(date.getTime());
  }
  if (typeof value === "string" && value.length > 0) {
    return !Number.isNaN(new Date(value).getTime());
  }
  return false;
}

function assertFanslyPostsPageContract(page: {
  contractAccepted: boolean;
  items: Array<{
    id?: unknown;
    createdAt?: unknown;
    content?: unknown;
  }>;
}) {
  if (!page.contractAccepted) {
    throw new Error("Fansly posts response drifted away from {posts: [...]}");
  }
  for (const post of page.items) {
    if (
      typeof post.id !== "string" || post.id.length === 0 ||
      !fanslyPublishedAtIsValid(post.createdAt) ||
      (post.content !== undefined && post.content !== null && typeof post.content !== "string")
    ) {
      throw new Error("Fansly posts response contains an invalid post item");
    }
  }
}

function freshState(
  platform: "fansly" | "onlyfans",
  revision: number,
  priorHeadPostId: string | null,
): PostsCursorState {
  return {
    version: 1,
    platform,
    revision,
    headPostId: priorHeadPostId,
    anchorPostId: priorHeadPostId,
    capturedHeadPostId: null,
    before: "0",
    pageIndex: 0,
    pendingCaptureJobId: null,
    completedAt: null,
  };
}

export async function fanslyPostsChunk(
  app: AppContext,
  input: ExecutorRequestContext,
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("Fansly posts sync requires a Fansly page");
  }
  await input.telemetry.recordPhaseStarted("posts");
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "posts");
  await input.telemetry.recordCheckpointLoaded("posts", summarizeCheckpoint(checkpoint));
  const previous = parsePostsCursorState(checkpoint?.state);
  let state = previous?.revision === input.streamState.requestSeq
    ? previous
    : freshState("fansly", input.streamState.requestSeq, previous?.headPostId ?? checkpoint?.cursorText ?? null);

  if (state.completedAt !== null) {
    return { satisfied: true, yieldReason: null, stats: { pages: state.pageIndex, headPostId: state.headPostId } };
  }
  if (state.pageIndex === 0 && state.before === "0") {
    const initialized = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "posts",
      cursorText: state.headPostId,
      state,
    });
    await input.telemetry.recordCheckpointAdvanced("posts", summarizeCheckpoint(initialized));
  }

  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createSyncRateLimitWaiter(app, input.pageContext),
  };
  const accountId = resolveFanslyPlatformAccountId(input.pageContext.page);
  let captured = 0;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const page = await app.adapter.getPostsPage(requestContext, accountId, {
      before: state.before,
      pageIndex: state.pageIndex,
    });
    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "posts",
      requestParams: {
        accountId,
        before: state.before,
        after: "0",
        wallId: null,
        pageIndex: state.pageIndex,
      },
      responsePayload: page.raw,
      mapperVersion: FANSLY_POSTS_MAPPER_VERSION,
      payloadKind: "posts",
      retainUntil: retentionDate(),
    }, {
      action: "inserting Fansly posts raw payload",
      platform: "fansly",
    });

    // Contract rejection intentionally happens AFTER raw journal persistence.
    assertFanslyPostsPageContract(page);
    captured += page.items.length;
    const capturedHeadPostId = state.capturedHeadPostId ?? page.items[0]?.id ?? null;
    const anchorReached = state.anchorPostId !== null &&
      page.items.some((post) => post.id === state.anchorPostId);
    if (anchorReached || page.items.length === 0) {
      state = {
        ...state,
        capturedHeadPostId,
        headPostId: capturedHeadPostId ?? state.headPostId,
        before: "0",
        pageIndex: state.pageIndex + 1,
        completedAt: new Date().toISOString(),
      };
      const completed = await upsertCheckpoint(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "posts",
        cursorText: state.headPostId,
        state,
        lastSuccessfulRunId: input.syncRunId,
      });
      await input.telemetry.recordCheckpointAdvanced("posts", summarizeCheckpoint(completed));
      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          pages: state.pageIndex,
          captured,
          anchorReached,
          headPostId: state.headPostId,
        },
      };
    }

    if (!page.nextBefore || page.nextBefore === state.before) {
      throw new Error("Fansly posts pagination did not advance the before cursor");
    }
    state = {
      ...state,
      capturedHeadPostId,
      before: page.nextBefore,
      pageIndex: state.pageIndex + 1,
    };
    const advanced = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "posts",
      cursorText: state.headPostId,
      state,
    });
    await input.telemetry.recordCheckpointAdvanced("posts", summarizeCheckpoint(advanced));
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: { pages: state.pageIndex, captured, before: state.before },
  };
}

export async function onlyfansPostsChunk(
  app: AppContext,
  input: ExecutorRequestContext,
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "onlyfans") {
    throw new Error("OnlyFans posts sync requires an OnlyFans page");
  }
  await input.telemetry.recordPhaseStarted("posts");
  if (!isOfapiBackgroundCaptureRunnable(app.config)) {
    return {
      satisfied: true,
      yieldReason: null,
      gatedSkip: "ofapi_posts_capture_disabled",
      stats: { skipped: "ofapi_posts_capture_disabled" },
    };
  }
  const ofapiAccountId = input.pageContext.page.ofapiAccountId;
  if (!ofapiAccountId) {
    return {
      satisfied: true,
      yieldReason: null,
      gatedSkip: "ofapi_account_unmapped",
      stats: { skipped: "ofapi_account_unmapped" },
    };
  }

  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "posts");
  await input.telemetry.recordCheckpointLoaded("posts", summarizeCheckpoint(checkpoint));
  const previous = parsePostsCursorState(checkpoint?.state);
  let state = previous?.revision === input.streamState.requestSeq
    ? previous
    : freshState("onlyfans", input.streamState.requestSeq, previous?.headPostId ?? checkpoint?.cursorText ?? null);

  if (state.completedAt !== null) {
    return { satisfied: true, yieldReason: null, stats: { headPostId: state.headPostId } };
  }

  let job = state.pendingCaptureJobId
    ? await getOfapiCaptureJob(app.db, state.pendingCaptureJobId)
    : null;
  if (state.pendingCaptureJobId && !job) {
    throw new Error(`OFAPI posts capture job ${state.pendingCaptureJobId} is missing`);
  }
  if (!job) {
    const activeSlotKey = `page:${input.pageContext.page.id}:posts`;
    job = await findActiveOfapiCaptureJobBySlot(app.db, activeSlotKey);
    if (job && job.kind !== "post_paginate") {
      throw new Error(`OFAPI posts slot is occupied by ${job.kind}`);
    }
    if (!job) {
      const seeded = await createOrGetOfapiCaptureJob(app.db, {
        pageId: input.pageContext.page.id,
        ofapiAccountId,
        kind: "post_paginate",
        activeSlotKey,
        target: {
          anchorPostId: state.headPostId,
          limit: OFAPI_POSTS_CAPTURE_LIMIT,
          requestRevision: input.streamState.requestSeq,
        },
        manifest: {
          version: "posts-sync-v1",
          stream: "posts",
          requestRevision: input.streamState.requestSeq,
        },
        budgetScope: state.headPostId === null ? "bulk" : "live",
        createdBy: "product_signal",
        priority: OFAPI_POSTS_CAPTURE_PRIORITY,
        maxCalls: OFAPI_POSTS_CAPTURE_MAX_PAGES,
        maxCredits: OFAPI_POSTS_CAPTURE_MAX_PAGES,
        maxPages: OFAPI_POSTS_CAPTURE_MAX_PAGES,
        maxItems: null,
      });
      job = seeded.job;
    }
    state = { ...state, pendingCaptureJobId: job.id };
    const initialized = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "posts",
      cursorText: state.headPostId,
      state,
    });
    await input.telemetry.recordCheckpointAdvanced("posts", summarizeCheckpoint(initialized));
  }

  if (job.state === "complete") {
    const result = asRecord(job.result);
    const nextHeadPostId = nullableString(result?.headPostId);
    if (nextHeadPostId === undefined) {
      throw new Error(`OFAPI posts capture job ${job.id} completed without a valid headPostId`);
    }
    state = {
      ...state,
      headPostId: nextHeadPostId ?? state.headPostId,
      capturedHeadPostId: nextHeadPostId,
      pendingCaptureJobId: null,
      completedAt: new Date().toISOString(),
    };
    const completed = await upsertCheckpoint(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "posts",
      cursorText: state.headPostId,
      state,
      lastSuccessfulRunId: input.syncRunId,
    });
    await input.telemetry.recordCheckpointAdvanced("posts", summarizeCheckpoint(completed));
    return {
      satisfied: true,
      yieldReason: null,
      stats: { captureJobId: job.id, headPostId: state.headPostId, capture: result },
    };
  }
  if (job.state === "blocked") {
    throw new Error(
      `OFAPI posts capture job ${job.id} blocked: ${job.reasonCode ?? "unknown"}`,
    );
  }

  return {
    satisfied: false,
    yieldReason: null,
    ...(job.state === "retry_wait"
      ? { continuationRetryAt: job.nextAttemptAt }
      : job.state === "leased" && job.leaseUntil
        ? { continuationRetryAt: job.leaseUntil }
        : {}),
    stats: {
      captureJobId: job.id,
      captureState: job.state,
      captureReasonCode: job.reasonCode,
      headPostId: state.headPostId,
    },
  };
}
