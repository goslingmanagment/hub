import {
  createOrGetOfapiCaptureJob,
  findActiveOfapiCaptureJobBySlot,
  findPageById,
  getCheckpoint,
  getOfapiCaptureJob,
  listPagesByPlatform,
  listPageSyncStates,
  pausePageSync,
  upsertCheckpoint,
  upsertCheckpointProgress,
  type PageSyncLease,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import {
  emptyPostsEngagementCursor,
  parsePostsCursorState,
  type PostsCursorState,
} from "../../sync/fansly/lib/posts-rules.ts";
import { isOfapiBackgroundCaptureRunnable } from "../ofapi-capture-jobs.ts";
import type { ResolvedPageContext } from "../page-context.ts";
import type { SyncChunkBudget } from "./chunk-budget.ts";
import type { StreamChunkResult } from "./executor-handlers.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";

// The legacy executor's `posts` stream is OnlyFans only: a Fansly page's posts,
// post tips and engagement refresh are the Fansly Sync Engine's `posts`
// resources (`apps/runtime/src/sync/fansly/resources/posts.ts`).

const OFAPI_POSTS_CAPTURE_LIMIT = 100;
const OFAPI_POSTS_CAPTURE_MAX_PAGES = 1_000;
const OFAPI_POSTS_CAPTURE_PRIORITY = 30;

export type OnlyFansPostsCaptureIneligibility =
  | "ofapi_posts_capture_disabled"
  | "ofapi_account_unmapped";

export class PostsCaptureConfigurationError extends Error {
  constructor(readonly code: OnlyFansPostsCaptureIneligibility) {
    super(code === "ofapi_posts_capture_disabled"
      ? "OnlyFans posts capture is disabled; manual action required: enable OFAPI_MIRROR_BACKGROUND_CAPTURE_ENABLED before activating this page"
      : "OnlyFans posts capture requires an OFAPI account mapping; manual action required: map this page before activating posts");
    this.name = "PostsCaptureConfigurationError";
  }
}

export class PostsCaptureJobBlockedError extends Error {
  constructor(
    readonly jobId: string,
    readonly reasonCode: string,
  ) {
    super(`OFAPI posts capture job ${jobId} blocked: ${reasonCode}`);
    this.name = "PostsCaptureJobBlockedError";
  }
}

export function getOnlyFansPostsCaptureIneligibility(
  config: Pick<AppContext["config"], "ofapiMirrorBackgroundCaptureEnabled"> | undefined,
  page: { platform: string; ofapiAccountId?: string | null },
): OnlyFansPostsCaptureIneligibility | null {
  if (page.platform !== "onlyfans") {
    return null;
  }
  if (!isOfapiBackgroundCaptureRunnable(config)) {
    return "ofapi_posts_capture_disabled";
  }
  return typeof page.ofapiAccountId === "string" && page.ofapiAccountId.length > 0
    ? null
    : "ofapi_account_unmapped";
}

async function pauseOnlyFansPostsForPage(app: AppContext, pageId: number, now: Date) {
  const states = await listPageSyncStates(app.db, { pageId, streams: ["posts"] });
  if (states.length === 1 && states[0]?.status === "paused") {
    return false;
  }
  await pausePageSync(app.db, { pageId, streams: ["posts"], now });
  return true;
}

/** Keep an activated OnlyFans lane inert when its global gate or page mapping
 * disappears. Re-enabling either prerequisite does not auto-resume the page;
 * the operator must use the explicit per-page `posts` scope again. */
export async function pauseIneligibleOnlyFansPostsForPage(
  app: AppContext,
  pageId: number,
  now = new Date(),
) {
  const stored = await findPageById(app.db, pageId);
  if (
    !stored ||
    stored.page.platform !== "onlyfans" ||
    getOnlyFansPostsCaptureIneligibility(app.config, stored.page) === null
  ) {
    return false;
  }
  return pauseOnlyFansPostsForPage(app, pageId, now);
}

export async function pauseIneligibleOnlyFansPostsForAllPages(
  app: AppContext,
  now = new Date(),
) {
  let pausedPages = 0;
  const pages = await listPagesByPlatform(app.db, "onlyfans");
  for (const page of pages) {
    if (
      getOnlyFansPostsCaptureIneligibility(app.config, page) !== null &&
      await pauseOnlyFansPostsForPage(app, page.id, now)
    ) {
      pausedPages += 1;
    }
  }
  return pausedPages;
}

type ExecutorRequestContext = {
  budget: SyncChunkBudget;
  pageContext: ResolvedPageContext;
  telemetry: SyncRunTelemetry;
  streamState: PageSyncLease;
  syncRunId: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

/** A new request generation of the OnlyFans walk. The cursor shape is shared
 *  with the engine's Fansly posts walk, so its Fansly fields stay at rest. */
function freshState(revision: number, priorHeadPostId: string | null): PostsCursorState {
  return {
    version: 1,
    platform: "onlyfans",
    revision,
    headPostId: priorHeadPostId,
    anchorPostId: priorHeadPostId,
    capturedHeadPostId: null,
    before: "0",
    pageIndex: 0,
    pendingCaptureJobId: null,
    fanslyPostTipsCaptureVersion: null,
    fanslyPostTipsBackfilledAt: null,
    fanslyRecentRefreshCutoffAt: null,
    fanslyRecentRefreshAnchorReached: false,
    completedAt: null,
    fanslyPostEngagement: emptyPostsEngagementCursor(),
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
  const ineligibility = getOnlyFansPostsCaptureIneligibility(app.config, {
    ...input.pageContext.page,
    platform: input.pageContext.platform,
  });
  if (ineligibility !== null) {
    // The normal path is parked by the planner. This error is the race-safe
    // fallback: it records no false success and the executor classifies it as
    // a configuration wait until the planner restores the durable pause.
    throw new PostsCaptureConfigurationError(ineligibility);
  }
  const ofapiAccountId = input.pageContext.page.ofapiAccountId;
  if (!ofapiAccountId) {
    throw new PostsCaptureConfigurationError("ofapi_account_unmapped");
  }

  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "posts");
  await input.telemetry.recordCheckpointLoaded("posts", summarizeCheckpoint(checkpoint));
  const previous = parsePostsCursorState(checkpoint?.state);
  let state = previous?.revision === input.streamState.requestSeq
    ? previous
    : freshState(input.streamState.requestSeq, previous?.headPostId ?? checkpoint?.cursorText ?? null);

  if (state.completedAt !== null) {
    return { satisfied: true, yieldReason: null, stats: { headPostId: state.headPostId } };
  }

  let job = state.pendingCaptureJobId
    ? await getOfapiCaptureJob(app.db, state.pendingCaptureJobId)
    : null;
  if (state.pendingCaptureJobId && !job) {
    throw new Error(`OFAPI posts capture job ${state.pendingCaptureJobId} is missing`);
  }
  if (job?.state === "cancelled") {
    // Decision #246/#249: an owner-cancelled job released its slot; the
    // checkpoint still names it only because nothing ran in between. Forget it
    // and let the ordinary path find or seed the fresh job.
    job = null;
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
    throw new PostsCaptureJobBlockedError(job.id, job.reasonCode ?? "unknown");
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
