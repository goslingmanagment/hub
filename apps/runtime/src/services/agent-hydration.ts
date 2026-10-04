// Agent Read Plane, slice C — the hydration executor.
//
// WHAT THIS FILE IS ALLOWED TO DO: turn an APPROVED request into a job on
// machinery that already exists — an `ofapi_capture_jobs` row. That is the
// whole design: the egress resolver, the proxy, the pacing, the
// capture-before-parse discipline and the credit budget are all inherited BY
// CONSTRUCTION because this file writes a job row and nothing else. It never
// calls a vendor, and it imports no adapter, so it cannot start.
//
// A FANSLY REQUEST IS NO JOB HERE. Every Fansly page is served by the Fansly
// Sync Engine: its hydration request is a one-fan history request the route
// files (`sync/requests/legacy-hydration.ts`), and this cycle only settles
// such a row once its history request is over. The legacy Fansly lane — the
// targeted thread backfill and its autopilot — is gone since step 4 (S4-15),
// so the executor has no lane for Fansly: an approval there is refused at the
// decision (`hasHydrationExecutorLane`) and never claimed here.
//
// ONE VENDOR ATTEMPT PER APPROVAL (outbox discipline). `approved -> dispatching`
// is a CAS with no way back: a run that crashes, or that may have reached the
// vendor, is settled `failed`, and a re-run needs a FRESH owner decision.
//
// THE FLAG IS THE KILL SWITCH. `agentHydrationMode`:
//   off          — nothing is expired or dispatched; only the bookkeeping
//                  about runs ALREADY dispatched goes on (reconcile, stuck
//                  sweep), so a flip to `off` cannot strand a row in
//                  `dispatching` forever;
//   request_only — requests can be filed and decided, NOTHING is dispatched;
//                  expiry, reconcile and the stuck sweep still run;
//   dispatch     — approvals are drained.
//
// A REQUEST CLOSES ON ANY OUTCOME. Reconciliation settles a dispatched
// request from its capture job's own record once the job is over, and the
// stuck sweep settles it `failed` once its deadline passed without a record
// that the work still runs.

import { randomUUID } from "node:crypto";

import {
  claimAgentHydrationRequestForDispatch,
  createOrGetOfapiCaptureJob,
  expireAgentHydrationRequest,
  findAgentHydrationThread,
  findPageById,
  getOfapiCaptureJob,
  hashOfapiCaptureValue,
  hydrationCoverageFingerprint,
  resolveAgentHydrationBoundaryRef,
  listDispatchableAgentHydrationRequests,
  listDispatchingAgentHydrationRequests,
  listEndedEngineManagedAgentHydrationDispatches,
  listExpirableAgentHydrationRequests,
  listStuckAgentHydrationDispatches,
  recordAgentHydrationExecution,
  settleAgentHydrationRequest,
  type AgentHydrationCasOutcome,
  type AgentHydrationRequestRecord,
} from "@agency_hub_core/db";
import type {
  AgentHydrationCostNote,
  AgentHydrationLane,
  AgentHydrationLastError,
  AgentHydrationRequest,
} from "@agency_hub_core/contracts";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

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
  /**
   * The smallest credit ceiling this lane can actually run on.
   *
   * OnlyFans capture jobs are refused by their own executor when `max_credits`
   * is absent OR zero — the job is blocked `target_invalid` and, because one
   * approval buys one attempt, the owner's decision dies with it. So an approval
   * that cannot be executed is refused at DECISION time instead, where the owner
   * can still fix the number. Fansly spends no credits at all, so zero is a
   * truthful ceiling there.
   */
  minimumCredits: number;
}>> = {
  // A Fansly request is served by the Fansly Sync Engine as a history request
  // (the route's wrapper), which spends the page's egress quota, not credits.
  // No executor lane below serves it.
  fansly: {
    lane: "vendor_paid_low",
    costNote: "egress_quota_and_ban_risk",
    readMarksThreadRead: false,
    minimumCredits: 0,
  },
  onlyfans: {
    // Credit-backed. §7's lane ordering reserves `vendor_paid_high` for money
    // that leaves an account, and reporting it as `low` told the owner the wrong
    // risk class on the one lane that literally bills.
    lane: "vendor_paid_high",
    costNote: "ofapi_credits",
    readMarksThreadRead: true,
    minimumCredits: 1,
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

/** Claims one cycle may make, and the page size of the scan that finds them. */
const DISPATCH_BATCH_LIMIT = 5;
const SWEEP_BATCH_LIMIT = 20;

/**
 * How long a dispatched request may stay `dispatching` before the sweeper calls
 * it dead, per executor lane: an OnlyFans capture job is a durable,
 * budget-paced row that legitimately takes hours.
 */
const DISPATCH_DEADLINE_MS: Readonly<Partial<Record<Platform, number>>> = {
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
  /** Rows the Fansly Sync Engine served whose history request ended this
   *  pass, settled to the state they mirror. */
  engineSettled: number;
}

/**
 * One executor pass: expire, sweep, reconcile, dispatch — in that order.
 *
 * Expiry first so a request whose approval ran out is never dispatched by the
 * same cycle that would have expired it; the sweep before the dispatch so a
 * crashed run is closed before new work starts on the same thread.
 */
export async function runAgentHydrationCycle(app: AppContext): Promise<AgentHydrationCycleResult> {
  const config = await loadEffectiveConfig(app.db, app.config);
  const mode = config.agentHydrationMode ?? "off";
  const result: AgentHydrationCycleResult = {
    mode,
    expired: 0,
    swept: 0,
    reconciled: 0,
    dispatched: 0,
    refused: 0,
    engineSettled: 0,
  };
  // `off` freezes the decisions (nothing expires, nothing is dispatched) but
  // not the bookkeeping below: a run dispatched before the flip still ends,
  // and its request must close with it.
  if (mode !== "off") {
    result.expired = await expireAgentHydration(app);
  }
  // RECONCILE FIRST. A job that reached a terminal state after its deadline but
  // before this cycle would otherwise be buried by the timeout sweep as
  // `failed`, and its real outcome, accepted counts and spend could never be
  // recovered — reconciliation only ever looks at `dispatching` rows.
  result.reconciled = await reconcileAgentHydrationDispatches(app);
  result.swept = await sweepStuckAgentHydration(app);
  result.engineSettled = await settleEndedEngineHydration(app);

  // `off` and `request_only` stop HERE. Everything above is bookkeeping about
  // work that already happened; everything below starts new work.
  if (mode !== "dispatch") {
    return result;
  }

  // THE BATCH IS CLAIMS, NOT ROWS. The scan walks the approved queue oldest
  // first, a page of rows at a time, until DISPATCH_BATCH_LIMIT approvals were
  // claimed or the queue ran out. An approval refused before its claim starts
  // nothing, so it does not fill the batch: an approval behind five refused
  // ones is still considered in the same pass.
  const scanned: number[] = [];
  let claims = 0;
  while (claims < DISPATCH_BATCH_LIMIT) {
    const candidates = await listDispatchableAgentHydrationRequests(app.db, {
      limit: DISPATCH_BATCH_LIMIT,
      excludeIds: scanned,
    });
    if (candidates.length === 0) {
      break;
    }
    for (const request of candidates) {
      if (claims >= DISPATCH_BATCH_LIMIT) {
        break;
      }
      scanned.push(request.id);
      const outcome = await dispatchAgentHydrationRequest(app, request);
      if (outcome !== "not_claimed") {
        claims += 1;
      }
      if (outcome === "dispatched") {
        result.dispatched += 1;
      } else {
        result.refused += 1;
      }
    }
  }
  return result;
}

/**
 * Bookkeeping of the rows the Fansly Sync Engine served (the wrapper's,
 * step-3 design §3.5 item 10): once a row's history request is over, the row
 * takes the terminal state it mirrors, so no legacy view or check sees it
 * `dispatching` for good. The engine's request module (`requests/history.ts`)
 * is loaded only when such a row exists, so the worker stays light.
 */
async function settleEndedEngineHydration(app: AppContext): Promise<number> {
  const ended = await listEndedEngineManagedAgentHydrationDispatches(app.db, { limit: 1 });
  if (ended.length === 0) return 0;
  const { settleEngineManagedHydration } = await import("../sync/requests/legacy-hydration.ts");
  return (await settleEngineManagedHydration({ db: app.db, rawConfig: app.config })).settled;
}

/** Undecided or never-dispatched approvals whose expiry has passed. Like the
 * reconcile and the stuck sweep below, it never sees a row the Fansly Sync
 * Engine serves (`FANSLY_SYNC_ENGINE_HYDRATION_LANE`, filtered by the list):
 * that row mirrors a history request. */
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
 *
 * Each lane first reads its own record of the work (`LANE_IN_FLIGHT`): work
 * that is demonstrably STILL RUNNING is left alone, and work that finished is
 * settled from what it actually did. The deadline says nothing about the
 * outcome; the work's own record does.
 */
export async function sweepStuckAgentHydration(app: AppContext): Promise<number> {
  const rows = await listStuckAgentHydrationDispatches(app.db, { limit: SWEEP_BATCH_LIMIT });
  let swept = 0;
  for (const row of rows) {
    const executionRef = row.executionRef;
    const lane = (LANE_IN_FLIGHT[row.platform as Platform] as LaneInFlight | undefined) ?? null;
    const verdict: InFlightVerdict = lane === null || executionRef === null
      ? { kind: "gone" }
      : await lane.read({ app, row: { ...row, executionRef } });
    if (verdict.kind === "running") {
      app.logger.info(
        { requestRef: row.requestRef, executionRef: row.executionRef },
        "Agent hydration dispatch is past its deadline but its work is still running",
      );
      continue;
    }
    const outcome = verdict.kind === "settle"
      ? await verdict.settle("sweeper")
      : (await settleAgentHydrationRequest(app.db, {
        id: row.id,
        toState: "failed",
        lastError: "timeout",
        actor: "sweeper",
      })).outcome;
    if (outcome === "applied") {
      swept += 1;
      app.logger.warn(
        { requestRef: row.requestRef, pageLabel: row.pageLabel, executionRef: row.executionRef },
        "Agent hydration request passed its dispatch deadline without settling; settled from its record",
      );
    }
  }
  return swept;
}

/**
 * Settles in-flight requests from the record of the work they dispatched,
 * deadline or not: reconciling early is what keeps finished work from waiting
 * out its whole deadline.
 *
 * OnlyFans settles ONLY this way: a capture job is a durable row driven by the
 * OFAPI executor, which knows nothing about hydration. A row on a platform
 * with no executor lane (a legacy Fansly run, gone since step 4 S4-15) is
 * left to the stuck sweep.
 */
export async function reconcileAgentHydrationDispatches(app: AppContext): Promise<number> {
  const rows = await listDispatchingAgentHydrationRequests(app.db, { limit: SWEEP_BATCH_LIMIT });
  let reconciled = 0;
  for (const row of rows) {
    const lane = LANE_IN_FLIGHT[row.platform as Platform] as LaneInFlight | undefined;
    const executionRef = row.executionRef;
    if (row.executionLane === null || executionRef === null || !lane) {
      continue;
    }
    const verdict = await lane.read({ app, row: { ...row, executionRef } });
    if (verdict.kind !== "settle") {
      continue;
    }
    if (await verdict.settle("executor") === "applied") {
      reconciled += 1;
    }
  }
  return reconciled;
}

/**
 * What a lane's own record says about the work a dispatching request points
 * at: still `running` (leave it), over with an outcome to `settle` from, or
 * `gone` without one (only the sweeper acts on that: `failed/timeout`).
 */
type InFlightVerdict =
  | { kind: "running" }
  | { kind: "gone" }
  | {
    kind: "settle";
    settle: (actor: "executor" | "sweeper") => Promise<AgentHydrationCasOutcome>;
  };

interface LaneInFlight {
  read: (input: {
    app: AppContext;
    row: AgentHydrationRequestRecord & { executionRef: string };
  }) => Promise<InFlightVerdict>;
}

/** Capture-job states that mean the OFAPI executor still owns this work. */
const OFAPI_LIVE_STATES = new Set(["ready", "leased", "awaiting_parse", "retry_wait"]);

/**
 * The lane table for work in flight — one reader per executor lane, looked
 * up, never compared.
 */
const LANE_IN_FLIGHT: Readonly<Partial<Record<Platform, LaneInFlight>>> = {
  onlyfans: {
    read: async ({ app, row }): Promise<InFlightVerdict> => {
      const job = await getOfapiCaptureJob(app.db, row.executionRef);
      if (!job) {
        return { kind: "gone" };
      }
      // A durable capture job can outlive any deadline we picked, and calling
      // it dead while it is still spending credits would take the spend out of
      // the owner's view.
      if (OFAPI_LIVE_STATES.has(job.state)) {
        return { kind: "running" };
      }
      const settlement = ofapiJobSettlement(job);
      if (settlement === null) {
        return { kind: "gone" };
      }
      return {
        kind: "settle",
        settle: async (actor) => (await settleAgentHydrationRequest(app.db, {
          id: row.id,
          toState: settlement.state,
          lastError: settlement.lastError,
          acceptedItems: job.acceptedItems,
          acceptedPages: job.acceptedPages,
          spentCredits: job.spentCredits,
          actor,
        })).outcome,
      };
    },
  },
};

/**
 * What a terminal capture job says about the hydration it was created for.
 *
 * DERIVED FROM EXHAUSTION EVIDENCE, NOT FROM ROW COUNTS. Counting accepted items
 * gets both interesting cases backwards: a run truncated by its own `maxPages`
 * would be reported `completed` because it did return rows, and an honest run
 * that reached the end of the vendor's history and found nothing new would be
 * reported `partially_completed` because it returned none. `partially_completed`
 * exists for the FIRST case. This is the completeness lie the whole plane exists
 * to prevent, so the verdict reads the job's own evidence:
 *
 *   state `complete`               — the pagination reached `vendor_eof` (or the
 *                                    anchor chain closed); the history IS
 *                                    exhausted, whatever the row count;
 *   state `blocked` + `gap_open`   — the walk stopped at ITS OWN cap with real
 *                                    progress and history still to the left;
 *   any other `blocked`/`cancelled` — a refusal (bad target, no transport, no
 *                                    egress): nothing was hydrated.
 */
/** Reason codes that mean "a ceiling bound", not "the vendor broke". */
const CAP_REASON_CODES = new Set(["gap_open", "job_cap", "item_cap_exceeded", "manifest_cap"]);

export function ofapiJobSettlement(job: {
  state: string;
  reasonCode: string | null;
  acceptedItems?: number;
  acceptedPages?: number;
}):
  | { state: "completed" | "partially_completed" | "failed"; lastError: AgentHydrationLastError }
  | null {
  if (job.state === "complete") {
    return { state: "completed", lastError: "none" };
  }
  if (job.state === "blocked") {
    // `gap_open` = the walk stopped at its own page ceiling with history still
    // to the left. `job_cap` = the approved call/credit ceiling bound.
    // `item_cap_exceeded` = the approved item ceiling bound. All three are the
    // OWNER'S NUMBER doing its job, and reporting them as a vendor outage would
    // send somebody debugging OnlyFans over a limit they typed themselves.
    const reasonCode = job.reasonCode ?? "";
    if (CAP_REASON_CODES.has(reasonCode)) {
      // `gap_open` is only ever written AFTER a page was accepted, so it is
      // progress by construction. The budget denials can fire before the first
      // call, and "we spent nothing and got nothing" is a failure, not a partial.
      const madeProgress = reasonCode === "gap_open"
        || (job.acceptedItems ?? 0) > 0
        || (job.acceptedPages ?? 0) > 0;
      return madeProgress
        ? { state: "partially_completed", lastError: "budget_exhausted" }
        : { state: "failed", lastError: "budget_exhausted" };
    }
    return { state: "failed", lastError: "vendor_unavailable" };
  }
  if (job.state === "cancelled") {
    return { state: "failed", lastError: "quarantined" };
  }
  return null;
}

/**
 * Whether an executor lane runs an approved request of this platform. Fansly
 * has none since step 4 (S4-15): its requests are the Fansly Sync Engine's
 * history requests, which take no decision. The decision route refuses an
 * approval this executor could never start.
 */
export function hasHydrationExecutorLane(platform: Platform): boolean {
  return LANE_DISPATCHERS[platform] !== undefined;
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
 *
 * The answer says how far it got: `dispatched` (the job is out), `claimed` (the
 * attempt was claimed, then settled or left indeterminate), or `not_claimed`
 * (refused before the claim, or the CAS lost).
 */
async function dispatchAgentHydrationRequest(
  app: AppContext,
  request: AgentHydrationRequestRecord,
): Promise<"dispatched" | "claimed" | "not_claimed"> {
  const platform = request.platform as Platform;

  // ---- Revalidation, ALL of it, BEFORE the claim ----------------------------
  //
  // Everything checked here is a reason the work cannot start. A miss must not
  // consume the approval's single attempt: the request stays `approved` and
  // either the condition clears or the expiry closes it. "Read surfaces are
  // never approval surfaces" cuts both ways — an approval is not a dispatch
  // either, and the world is checked again here.
  const refuse = (reason: string) => {
    app.logger.warn(
      { requestRef: request.requestRef, pageLabel: request.pageLabel, reason },
      "Agent hydration approval is not dispatchable right now; attempt NOT consumed",
    );
    return "not_claimed" as const;
  };

  const dispatcher = LANE_DISPATCHERS[platform];
  const deadlineMs = DISPATCH_DEADLINE_MS[platform];
  const preparer = LANE_PREPARERS[platform];
  if (dispatcher === undefined || deadlineMs === undefined || preparer === undefined) {
    // A Fansly approval decided before step 4 (S4-15): no lane runs it any
    // more, and the expiry closes it unspent.
    return refuse("no executor lane serves this platform");
  }

  const { thread } = await findAgentHydrationThread(app.db, {
    pageId: request.pageId,
    conversationRef: request.conversationRef,
  });
  if (!thread) {
    return refuse("target is no longer a visible thread");
  }

  // The DEPTH the owner approved against. If somebody deepened this thread since
  // the decision, the approved spend buys history we already have. Coverage
  // never moves back, so this approval can never dispatch; it waits out the
  // owner's own expiry (P1-2), which says nothing was spent.
  const currentCoverage = hydrationCoverageFingerprint({
    pageId: request.pageId,
    conversationRef: request.conversationRef,
    storedMessageCount: thread.storedMessageCount,
    oldestStoredMessageId: thread.oldestStoredMessageId,
    messageCoverageStatus: thread.messageCoverageStatus,
  });
  if (currentCoverage !== request.coverageFingerprint) {
    return refuse("thread coverage moved since the decision");
  }

  // The approved BOUNDARY, resolved to the cursor the lane pages backwards
  // from. The target says "deepen PAST this point", so the boundary is where the
  // walk starts — an approval for "before message X" that executed as a generic
  // walk would spend on, and report about, a different scope than the one the
  // owner authorized.
  const boundaryRef = await resolveApprovedBoundary(app, request, thread);

  // Stable prerequisites of the lane. Neither can appear on its own between
  // now and the claim, so checking them here is what keeps a missing mapping
  // from eating the attempt and settling `failed` without ever creating a job.
  const preparation = await preparer({ app, request, thread, boundaryRef });
  if (!preparation.ok) {
    return refuse(preparation.reason);
  }

  // ---- The single attempt --------------------------------------------------
  const deadlineAt = new Date(Date.now() + deadlineMs);
  const executionLane = request.laneSelected ?? AGENT_HYDRATION_LANES[platform].lane;
  // The reference is minted HERE, before the job exists, and both the claim and
  // the job itself use it. A crash anywhere after the claim therefore leaves a
  // row that points at the work it authorized.
  const executionRef = randomUUID();
  const claimed = await claimAgentHydrationRequestForDispatch(app.db, {
    id: request.id,
    expectedVersion: request.rowVersion,
    deadlineAt,
    executionLane,
    executionRef,
  });
  if (claimed.outcome !== "applied") {
    return "not_claimed";
  }

  try {
    const enqueued = await dispatcher({
      app,
      request,
      boundaryRef,
      frozenHeadId: preparation.frozenHeadId,
      ofapiAccountId: preparation.ofapiAccountId,
      executionRef,
    });
    if (enqueued.kind === "refused") {
      // DETERMINATE: nothing was queued, and we know it. The attempt is spent —
      // the owner sees `failed` and decides again rather than the system quietly
      // retrying paid work on its own.
      await settleAgentHydrationRequest(app.db, {
        id: request.id,
        toState: "failed",
        lastError: enqueued.lastError,
      });
      return "claimed";
    }
    if (enqueued.kind === "already_done") {
      // The exact target was already captured. Settle from that job instead of
      // paying for it twice.
      await settleAgentHydrationRequest(app.db, {
        id: request.id,
        toState: enqueued.state,
        lastError: "none",
        acceptedItems: enqueued.acceptedItems,
        acceptedPages: enqueued.acceptedPages,
        spentCredits: enqueued.spentCredits,
      });
      return "claimed";
    }
    if (enqueued.executionRef !== executionRef) {
      // The job coalesced onto a MATCHING active job (target and caps verified
      // by the dispatcher). Point at the one that will really spend.
      await recordAgentHydrationExecution(app.db, {
        id: request.id,
        executionLane,
        executionRef: enqueued.executionRef,
      });
    }
    app.logger.info(
      {
        requestRef: request.requestRef,
        pageLabel: request.pageLabel,
        platform,
        executionRef: enqueued.executionRef,
        boundaryRef,
        maxCalls: request.decisionMaxCalls,
        allowMarkReadSideEffect: request.decisionAllowMarkRead,
      },
      "Agent hydration request dispatched",
    );
    return "dispatched";
  } catch (error) {
    // INDETERMINATE. The write may have landed and lost its response; the job
    // may be running right now. Settling `failed` here would let the owner
    // authorize the SAME paid work a second time while the first copy is still
    // going — the outbox law is explicit that an indeterminate send is never
    // auto-resolved. The row stays `dispatching`, pointing at the reference we
    // minted, and reconciliation or the deadline closes it from evidence.
    app.logger.error(
      { err: error, requestRef: request.requestRef, executionRef },
      "Agent hydration dispatch is INDETERMINATE; left dispatching for reconciliation",
    );
    return "claimed";
  }
}

/**
 * The approved boundary, as a message ref.
 *
 * `beforeMessageRef` is already one. `beforeAt` is resolved against what we hold:
 * the oldest stored message at or after that instant is the cursor to page back
 * from. When nothing resolves, the answer is `null` and the lane falls back to
 * the deepest point it holds — which is the same walk the owner asked for, just
 * without a tighter starting point.
 */
async function resolveApprovedBoundary(
  app: AppContext,
  request: AgentHydrationRequestRecord,
  thread: { id: number },
): Promise<string | null> {
  if (request.targetBeforeMessageRef !== null) {
    return request.targetBeforeMessageRef;
  }
  if (request.targetBeforeAt === null) {
    return null;
  }
  return resolveAgentHydrationBoundaryRef(app.db, {
    threadId: thread.id,
    beforeAt: request.targetBeforeAt,
  });
}

interface LaneDispatchInput {
  app: AppContext;
  request: AgentHydrationRequestRecord;
  /** The approved boundary, resolved: where this lane starts paging backwards. */
  boundaryRef: string | null;
  frozenHeadId: string | null;
  ofapiAccountId: string | null;
  /** Pre-minted; the created job MUST carry it (see `dispatchAgentHydrationRequest`). */
  executionRef: string;
}

type LaneEnqueueResult =
  | { kind: "enqueued"; executionRef: string }
  /** Determinate: nothing was queued and we know it. */
  | { kind: "refused"; lastError: "vendor_unavailable" | "budget_exhausted" }
  /** The exact target was already captured; settle from that job, do not re-pay. */
  | {
    kind: "already_done";
    state: "completed" | "partially_completed";
    acceptedItems: number;
    acceptedPages: number;
    spentCredits: number;
  };

interface LanePreparation {
  ok: boolean;
  reason: string;
  frozenHeadId: string | null;
  ofapiAccountId: string | null;
}

/**
 * The stable prerequisites of each executor lane, checked BEFORE the attempt
 * is claimed.
 *
 * A page with no OFAPI mapping, or a thread with no head to freeze, cannot
 * produce a job at all — and neither condition is going to appear between this
 * check and the claim. Discovering them after the CAS burned the owner's single
 * attempt on a job that was never created.
 */
const LANE_PREPARERS: Readonly<Partial<Record<Platform, (input: {
  app: AppContext;
  request: AgentHydrationRequestRecord;
  thread: { lastMessageId: string | null };
  boundaryRef: string | null;
}) => Promise<LanePreparation>>>> = {
  onlyfans: async ({ app, request, thread, boundaryRef }) => {
    const stored = await findPageById(app.db, request.pageId);
    const ofapiAccountId = stored?.page.ofapiAccountId ?? null;
    // The boundary IS the pagination start when one was approved; otherwise the
    // thread's head.
    const frozenHeadId = boundaryRef ?? thread.lastMessageId;
    if (ofapiAccountId === null) {
      return { ok: false, reason: "page has no OFAPI account mapping", frozenHeadId, ofapiAccountId };
    }
    if (frozenHeadId === null) {
      return { ok: false, reason: "thread has no head to freeze", frozenHeadId, ofapiAccountId };
    }
    return { ok: true, reason: "", frozenHeadId, ofapiAccountId };
  },
};

/**
 * The lane table, as DISPATCHERS — one entry per executor lane, looked up,
 * never compared. A branch on a platform literal here would both spend the
 * ratchet and hide the asymmetry this table exists to publish.
 */
const LANE_DISPATCHERS: Readonly<
  Partial<Record<Platform, (input: LaneDispatchInput) => Promise<LaneEnqueueResult>>>
> = {
  onlyfans: async ({ app, request, boundaryRef, frozenHeadId, ofapiAccountId, executionRef }) => {
    if (ofapiAccountId === null || frozenHeadId === null) {
      return { kind: "refused", lastError: "vendor_unavailable" };
    }
    // Every governed OnlyFans vendor call belongs to exactly one durable capture
    // job (#158). The approval's caps become the job's caps verbatim, and the
    // approved boundary becomes the frozen head it pages back from.
    const target = {
      chatId: request.conversationRef,
      frozenHeadId,
      anchorMessageId: null,
      limit: 100,
      reason: "agent_hydration_request",
    };
    const desiredTargetHash = hashOfapiCaptureValue(target);
    const created = await createOrGetOfapiCaptureJob(app.db, {
      id: executionRef,
      pageId: request.pageId,
      ofapiAccountId,
      kind: "chat_paginate",
      goal: "history_to_exhaustion",
      activeSlotKey: `page:${request.pageId}:chat:${request.conversationRef}`,
      target,
      manifest: {
        version: "agent-hydration-v1",
        hydrationRequestRef: request.requestRef,
        boundaryRef,
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
    if (created.created) {
      return { kind: "enqueued", executionRef: created.job.id };
    }

    // COALESCENCE IS NOT FREE. `createOrGetOfapiCaptureJob` returns whatever
    // occupies the chat's active slot, whatever its target, goal or ceilings. A
    // tightly capped hydration attaching to somebody's exhaustion job would
    // track and report work it never authorized, and the owner's ceiling would
    // become decorative. Attach ONLY to the same target with the same limits.
    const sameTarget = created.job.targetHash === desiredTargetHash
      && created.job.goal === "history_to_exhaustion";
    const sameCaps = created.job.maxCalls === request.decisionMaxCalls
      && created.job.maxCredits === request.decisionMaxCredits
      && created.job.maxPages === request.decisionMaxPages
      && created.job.maxItems === request.decisionMaxItems;
    if (!sameTarget || !sameCaps) {
      return { kind: "refused", lastError: "vendor_unavailable" };
    }
    if (created.job.state === "complete") {
      // The very same target already ran to exhaustion. Reporting that is the
      // honest answer; paying for it again is not.
      return {
        kind: "already_done",
        state: "completed",
        acceptedItems: created.job.acceptedItems,
        acceptedPages: created.job.acceptedPages,
        spentCredits: created.job.spentCredits,
      };
    }
    return { kind: "enqueued", executionRef: created.job.id };
  },
};
