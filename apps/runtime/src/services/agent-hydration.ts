// Agent Read Plane, slice C — the hydration executor.
//
// WHAT THIS FILE IS ALLOWED TO DO: turn an APPROVED request into a job on
// machinery that already exists — the Fansly targeted thread backfill of slice
// C', or an `ofapi_capture_jobs` row. That is the whole design: the egress
// resolver, the proxy, the pacing, the page-sync lease, the capture-before-parse
// discipline and the credit budget are all inherited BY CONSTRUCTION because
// this file writes a job row and nothing else. It never calls a vendor, and it
// imports no adapter, so it cannot start.
//
// ONE ATTEMPT PER APPROVAL (outbox discipline). `approved -> dispatching` is a
// CAS that happens exactly once, and there is no transition back. A run that
// crashes is settled `failed` by the stuck sweeper; a re-run needs a FRESH owner
// decision. A duplicated deep backfill behind the owner's back — extra vendor
// traffic on an account that can be banned for it — is worse than a missed one.
//
// THE FLAG IS THE KILL SWITCH. `agentHydrationMode`:
//   off          — this cycle does nothing at all, not even bookkeeping;
//   request_only — requests can be filed and decided, NOTHING is dispatched;
//                  expiry and the stuck sweep still run, so a flip away from
//                  `dispatch` cannot strand a row in `dispatching` forever;
//   dispatch     — approvals are drained.

import {
  claimAgentHydrationRequestForDispatch,
  createOrGetOfapiCaptureJob,
  expireAgentHydrationRequest,
  findAgentHydrationRequestByRef,
  findAgentHydrationThread,
  findPageById,
  getOfapiCaptureJob,
  listDispatchableAgentHydrationRequests,
  listDispatchingAgentHydrationRequests,
  listExpirableAgentHydrationRequests,
  listStuckAgentHydrationDispatches,
  recordAgentHydrationExecution,
  settleAgentHydrationRequest,
  type AgentHydrationRequestRecord,
} from "@agency_hub_core/db";
import type {
  AgentHydrationCostNote,
  AgentHydrationLane,
  AgentHydrationRequest,
} from "@agency_hub_core/contracts";
import type { Platform } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";
import {
  sendTargetedThreadBackfillJob,
  type TargetedThreadBackfillResult,
} from "./sync/targeted-thread-backfill.ts";

export const AGENT_HYDRATION_QUEUE = "agent.hydration.execute";

/**
 * Which lane serves which platform — DATA, not branches.
 *
 * `free_local_replay` is listed first in every evaluation because §7 requires a
 * free lane to be considered before a paid one; it is not SELECTED because no
 * replay lane is built yet (slice D), and saying so is the honest answer rather
 * than pretending the paid lane was the only option.
 *
 * It lives in the SERVICE rather than in the handler because it is a fact about
 * execution: what the work costs, and whether performing it changes something on
 * the platform. The handlers read it; they do not own it.
 */
export const AGENT_HYDRATION_LANES: Readonly<Record<Platform, {
  lane: AgentHydrationLane;
  costNote: AgentHydrationCostNote;
  /**
   * #158: the vendor read this lane performs MUTATES read state on the platform
   * (`GET .../messages` is "not classified as a pure read" — decisions.md). An
   * approval that refuses the side effect cannot be executed on such a platform,
   * and #13 says so instead of silently marking a fan's chat read.
   */
  readMarksThreadRead: boolean;
}>> = {
  fansly: {
    lane: "vendor_paid_low",
    costNote: "egress_quota_and_ban_risk",
    readMarksThreadRead: false,
  },
  onlyfans: {
    lane: "vendor_paid_low",
    costNote: "ofapi_credits",
    readMarksThreadRead: true,
  },
};

export interface HydrationAdmissibility {
  orderEvaluated: AgentHydrationLane[];
  selected: AgentHydrationLane | null;
  costNote: AgentHydrationCostNote | null;
  admissible: boolean;
  reason: AgentHydrationRequest["admissibility"]["reason"];
}

/** §7's lane order, evaluated. The free lane is checked FIRST, always. */
export function evaluateHydrationLanes(platform: Platform): HydrationAdmissibility {
  const paid = AGENT_HYDRATION_LANES[platform];
  return {
    // The free lane is evaluated and REPORTED, not silently skipped: "we did not
    // consider the free option" and "the free option does not exist yet" are
    // different statements and only the second one is true.
    orderEvaluated: ["free_local_replay", paid.lane],
    selected: paid.lane,
    costNote: paid.costNote,
    admissible: true,
    reason: null,
  };
}

const DISPATCH_BATCH_LIMIT = 5;
const SWEEP_BATCH_LIMIT = 20;

/**
 * How long a dispatched request may stay `dispatching` before the sweeper calls
 * it dead. Per lane, because the two lanes have nothing in common: a targeted
 * Fansly job is bounded to one run (the pg-boss job itself expires in 20
 * minutes), while an OnlyFans capture job is a durable, budget-paced row that
 * legitimately takes hours.
 */
const DISPATCH_DEADLINE_MS: Readonly<Record<Platform, number>> = {
  fansly: 30 * 60 * 1000,
  onlyfans: 6 * 60 * 60 * 1000,
};

export async function ensureAgentHydrationQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, AGENT_HYDRATION_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureAgentHydrationSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(AGENT_HYDRATION_QUEUE, "*/2 * * * *", null, { tz: "UTC" });
}

export interface AgentHydrationCycleResult {
  mode: "off" | "request_only" | "dispatch";
  expired: number;
  swept: number;
  reconciled: number;
  dispatched: number;
  refused: number;
}

/**
 * One executor pass: expire, sweep, reconcile, dispatch — in that order.
 *
 * Expiry first so a request whose approval ran out is never dispatched by the
 * same cycle that would have expired it; the sweep before the dispatch so a
 * crashed run is closed before new work starts on the same page.
 */
export async function runAgentHydrationCycle(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
): Promise<AgentHydrationCycleResult> {
  const config = await loadEffectiveConfig(app.db, app.config);
  const mode = config.agentHydrationMode ?? "off";
  const result: AgentHydrationCycleResult = {
    mode,
    expired: 0,
    swept: 0,
    reconciled: 0,
    dispatched: 0,
    refused: 0,
  };
  if (mode === "off") {
    return result;
  }

  result.expired = await expireAgentHydration(app);
  result.swept = await sweepStuckAgentHydration(app);
  result.reconciled = await reconcileAgentHydrationDispatches(app);

  // `request_only` stops HERE. Everything above is bookkeeping about work that
  // already happened; everything below starts new work.
  if (mode !== "dispatch") {
    return result;
  }

  const candidates = await listDispatchableAgentHydrationRequests(app.db, {
    limit: DISPATCH_BATCH_LIMIT,
  });
  for (const request of candidates) {
    const dispatched = await dispatchAgentHydrationRequest(app, boss, request);
    if (dispatched) {
      result.dispatched += 1;
    } else {
      result.refused += 1;
    }
  }
  return result;
}

/** Undecided or never-dispatched approvals whose expiry has passed. */
async function expireAgentHydration(app: AppContext): Promise<number> {
  const rows = await listExpirableAgentHydrationRequests(app.db, { limit: SWEEP_BATCH_LIMIT });
  let expired = 0;
  for (const row of rows) {
    if (row.state !== "requested" && row.state !== "approved") {
      continue;
    }
    const outcome = await expireAgentHydrationRequest(app.db, {
      id: row.id,
      fromState: row.state,
    });
    if (outcome === "applied") {
      expired += 1;
    }
  }
  return expired;
}

/**
 * The stuck-`dispatching` sweeper.
 *
 * A crashed worker leaves exactly one shape: dispatched, past its deadline,
 * never settled. It ends `failed` with `timeout` — NOT back in `approved`. The
 * work may or may not have partly happened, and only a human can decide whether
 * to spend again on a thread that might already be half-walked.
 */
export async function sweepStuckAgentHydration(app: AppContext): Promise<number> {
  const rows = await listStuckAgentHydrationDispatches(app.db, { limit: SWEEP_BATCH_LIMIT });
  let swept = 0;
  for (const row of rows) {
    const { outcome } = await settleAgentHydrationRequest(app.db, {
      id: row.id,
      toState: "failed",
      lastError: "timeout",
      actor: "sweeper",
    });
    if (outcome === "applied") {
      swept += 1;
      app.logger.warn(
        { requestRef: row.requestRef, pageLabel: row.pageLabel, executionRef: row.executionRef },
        "Agent hydration request passed its dispatch deadline without settling; marked failed",
      );
    }
  }
  return swept;
}

/**
 * OnlyFans settles by RECONCILIATION, not by callback: a capture job is a
 * durable row driven by the OFAPI executor, which knows nothing about hydration.
 * So the cycle reads the job's terminal state and settles the request from it.
 * (The Fansly lane settles directly from its own job result — see
 * `settleAgentHydrationFromBackfill`.)
 */
export async function reconcileAgentHydrationDispatches(app: AppContext): Promise<number> {
  // Everything currently dispatching, deadline or not: reconciling early is what
  // keeps a finished capture job from waiting out its whole deadline.
  const rows = await listDispatchingAgentHydrationRequests(app.db, { limit: SWEEP_BATCH_LIMIT });
  let reconciled = 0;
  for (const row of rows) {
    if (row.executionLane === null || row.executionRef === null || row.platform !== "onlyfans") {
      continue;
    }
    const job = await getOfapiCaptureJob(app.db, row.executionRef);
    if (!job) {
      continue;
    }
    if (job.state === "complete") {
      await settleAgentHydrationRequest(app.db, {
        id: row.id,
        // "Complete" here means the capture job finished, not that the thread is
        // now fully held: the job's own caps may have stopped it early.
        toState: job.acceptedItems > 0 ? "completed" : "partially_completed",
        acceptedItems: job.acceptedItems,
        acceptedPages: job.acceptedPages,
        spentCredits: job.spentCredits,
      });
      reconciled += 1;
      continue;
    }
    if (job.state === "cancelled" || job.state === "blocked") {
      await settleAgentHydrationRequest(app.db, {
        id: row.id,
        toState: "failed",
        lastError: job.state === "blocked" ? "vendor_unavailable" : "quarantined",
        acceptedItems: job.acceptedItems,
        acceptedPages: job.acceptedPages,
        spentCredits: job.spentCredits,
      });
      reconciled += 1;
    }
  }
  return reconciled;
}

/**
 * One approval -> one job.
 *
 * Order is deliberate: REVALIDATE, then CAS, then enqueue. Revalidating first
 * means an approval whose target went out of reach never burns its single
 * attempt; CAS'ing before the enqueue means a crash between the two can only
 * ever LOSE an attempt (settled `failed` by the sweeper), never duplicate one.
 * "Read surfaces are never approval surfaces" cuts both ways — an approval is
 * not a dispatch either, and the target is checked again here.
 */
async function dispatchAgentHydrationRequest(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  request: AgentHydrationRequestRecord,
): Promise<boolean> {
  const platform = request.platform as Platform;
  const lane = AGENT_HYDRATION_LANES[platform] as typeof AGENT_HYDRATION_LANES[Platform] | undefined;
  if (!lane) {
    return false;
  }

  const { thread } = await findAgentHydrationThread(app.db, {
    pageId: request.pageId,
    conversationRef: request.conversationRef,
  });
  if (!thread) {
    // Revalidation failed BEFORE the attempt was claimed, so the approval keeps
    // its attempt; it will expire on its own if the thread never comes back.
    app.logger.warn(
      { requestRef: request.requestRef, pageLabel: request.pageLabel },
      "Agent hydration target is no longer a visible thread; not dispatching",
    );
    return false;
  }

  const deadlineAt = new Date(Date.now() + DISPATCH_DEADLINE_MS[platform]);
  const claimed = await claimAgentHydrationRequestForDispatch(app.db, {
    id: request.id,
    expectedVersion: request.rowVersion,
    deadlineAt,
  });
  if (claimed.outcome === "conflict") {
    return false;
  }

  try {
    const executionRef = await enqueueByLane(app, boss, request, thread.id, thread.lastMessageId);
    if (executionRef === null) {
      // Fail closed. The attempt is spent: the owner sees `failed` and decides
      // again, rather than the system quietly retrying paid work on its own.
      await settleAgentHydrationRequest(app.db, {
        id: request.id,
        toState: "failed",
        lastError: "vendor_unavailable",
      });
      return false;
    }
    await recordAgentHydrationExecution(app.db, {
      id: request.id,
      executionLane: request.laneSelected ?? lane.lane,
      executionRef,
    });
    app.logger.info(
      {
        requestRef: request.requestRef,
        pageLabel: request.pageLabel,
        platform,
        executionRef,
        maxCalls: request.decisionMaxCalls,
        allowMarkReadSideEffect: request.decisionAllowMarkRead,
      },
      "Agent hydration request dispatched",
    );
    return true;
  } catch (error) {
    await settleAgentHydrationRequest(app.db, {
      id: request.id,
      toState: "failed",
      lastError: "vendor_unavailable",
    });
    app.logger.error(
      { err: error, requestRef: request.requestRef },
      "Agent hydration dispatch failed; the approval is spent and needs a fresh decision",
    );
    return false;
  }
}

/**
 * The lane table, as DISPATCHERS — one entry per platform, looked up, never
 * compared. A branch on a platform literal here would both spend the ratchet and
 * hide the asymmetry this table exists to publish.
 */
const LANE_DISPATCHERS: Readonly<Record<Platform, (input: {
  app: AppContext;
  boss: Pick<PgBoss, "send">;
  request: AgentHydrationRequestRecord;
  threadId: number;
  frozenHeadId: string | null;
}) => Promise<string | null>>> = {
  fansly: async ({ boss, request, threadId }) => {
    // Slice C's whole job: hand the thread to C'. The owner's `maxCalls` becomes
    // the run's request budget, and the depth cap is lifted for THIS run only —
    // going past the cap is precisely what the owner approved.
    return sendTargetedThreadBackfillJob(boss, {
      threadId,
      platformAccountId: request.pageId,
      ignoreRetentionLimit: true,
      ...(request.decisionMaxCalls === null ? {} : { maxRequests: request.decisionMaxCalls }),
      hydrationRequestRef: request.requestRef,
    });
  },
  onlyfans: async ({ app, request, frozenHeadId }) => {
    const stored = await findPageById(app.db, request.pageId);
    const ofapiAccountId = stored?.page.ofapiAccountId ?? null;
    if (ofapiAccountId === null || frozenHeadId === null) {
      return null;
    }
    // Every governed OnlyFans vendor call belongs to exactly one durable capture
    // job (#158). The approval's caps become the job's caps verbatim — that is
    // what makes the owner's numbers binding rather than decorative.
    const created = await createOrGetOfapiCaptureJob(app.db, {
      pageId: request.pageId,
      ofapiAccountId,
      kind: "chat_paginate",
      goal: "history_to_exhaustion",
      activeSlotKey: `page:${request.pageId}:chat:${request.conversationRef}`,
      target: {
        chatId: request.conversationRef,
        frozenHeadId,
        anchorMessageId: null,
        limit: 100,
        reason: "agent_hydration_request",
      },
      manifest: {
        version: "agent-hydration-v1",
        hydrationRequestRef: request.requestRef,
        // #158 consent, carried INTO the execution record: the job row is where
        // an auditor looks, and the answer must be there and not only in the
        // request that authorized it.
        allowMarkReadSideEffect: request.decisionAllowMarkRead === true,
      },
      budgetScope: "bulk",
      ...(request.decidedByUserId === null ? {} : { originPrincipalId: request.decidedByUserId }),
      createdBy: "owner",
      maxCalls: request.decisionMaxCalls,
      maxCredits: request.decisionMaxCredits,
      maxPages: request.decisionMaxPages,
      maxItems: request.decisionMaxItems,
    });
    return created.job.id;
  },
};

async function enqueueByLane(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  request: AgentHydrationRequestRecord,
  threadId: number,
  frozenHeadId: string | null,
): Promise<string | null> {
  const dispatcher = LANE_DISPATCHERS[request.platform as Platform];
  if (!dispatcher) {
    return null;
  }
  return dispatcher({ app, boss, request, threadId, frozenHeadId });
}

/**
 * How a targeted-backfill outcome settles the request that asked for it.
 *
 * `completed` only where the walk genuinely ran out of history or met known
 * ground. Everything the run REFUSED (breaker open, lease unavailable, page
 * busy, ineligible thread) is a `failed`, not a `partially_completed`: nothing
 * was hydrated, and calling that a partial success would tell the owner the
 * spend bought something.
 */
const BACKFILL_OUTCOME_STATES: Readonly<Record<
  TargetedThreadBackfillResult["outcome"],
  { state: "completed" | "partially_completed" | "failed"; lastError: "none" | "vendor_unavailable" | "retention_limit" | "quarantined" | "timeout" }
>> = {
  completed: { state: "completed", lastError: "none" },
  partial: { state: "partially_completed", lastError: "none" },
  retention_limit_reached: { state: "partially_completed", lastError: "retention_limit" },
  concurrent_page_chunk: { state: "partially_completed", lastError: "none" },
  thread_not_found: { state: "failed", lastError: "vendor_unavailable" },
  unsupported_platform: { state: "failed", lastError: "vendor_unavailable" },
  thread_not_eligible: { state: "failed", lastError: "vendor_unavailable" },
  breaker_open: { state: "failed", lastError: "quarantined" },
  page_busy: { state: "failed", lastError: "vendor_unavailable" },
  thread_checkpoint_in_progress: { state: "failed", lastError: "vendor_unavailable" },
  lease_unavailable: { state: "failed", lastError: "vendor_unavailable" },
  lease_lost: { state: "failed", lastError: "timeout" },
};

/**
 * Settles the hydration request a targeted backfill run answered.
 *
 * Called by the worker that ran the job, with the result in hand. A crash
 * between the run and this call leaves the request `dispatching` until the stuck
 * sweeper closes it — which is the correct order of failure: an unsettled
 * request is visible, a wrongly-settled one is not.
 */
export async function settleAgentHydrationFromBackfill(
  app: AppContext,
  requestRef: string,
  result: TargetedThreadBackfillResult,
): Promise<void> {
  const { request } = await findAgentHydrationRequestByRef(app.db, requestRef);
  if (!request || request.state !== "dispatching") {
    return;
  }
  const mapped = BACKFILL_OUTCOME_STATES[result.outcome];
  await settleAgentHydrationRequest(app.db, {
    id: request.id,
    toState: mapped.state,
    lastError: mapped.lastError,
    acceptedItems: result.insertedMessages,
    acceptedPages: result.requests,
  });
}
