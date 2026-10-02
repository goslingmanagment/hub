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
// ONE VENDOR ATTEMPT PER APPROVAL (outbox discipline). `approved -> dispatching`
// is a CAS, and the only way back is a re-arm for a run that DETERMINATELY made
// no vendor request — refused at the page's door, capped (see
// `rearmOrFailRefusedRun`). A run that crashes, or that may have reached the
// vendor, is settled `failed`; a re-run needs a FRESH owner decision. A
// duplicated deep backfill behind the owner's back — extra vendor traffic on an
// account that can be banned for it — is worse than a missed one.
//
// ONE RUN PER PAGE. The Fansly lane's queue admits one targeted job per page, so
// a second same-page approval waits `approved` until the slot frees; it is
// never claimed into a send the queue must refuse.
//
// THE FLAG IS THE KILL SWITCH. `agentHydrationMode`:
//   off          — nothing is expired, approved or dispatched; only the
//                  bookkeeping about runs ALREADY dispatched goes on
//                  (reconcile, stuck sweep), so a flip to `off` cannot strand
//                  a row — and its page — in `dispatching` forever;
//   request_only — requests can be filed and decided, NOTHING is dispatched;
//                  expiry, reconcile and the stuck sweep still run;
//   dispatch     — approvals are drained.
//
// A REQUEST CLOSES ON ANY OUTCOME. The worker settles the request its run
// answered — from the result, or from the run's failure with the run's own
// spend — and reconciliation settles from the pg-boss job record whatever the
// worker could not, once the run is provably gone (job terminal or missing,
// AND no live page lease of that job: pg-boss failing a job does not stop
// its handler).

import { randomUUID } from "node:crypto";

import {
  claimAgentHydrationRequestForDispatch,
  createOrGetOfapiCaptureJob,
  expireAgentHydrationRequest,
  findAgentHydrationRequestByRef,
  findAgentHydrationThread,
  findPageById,
  getOfapiCaptureJob,
  hashOfapiCaptureValue,
  hasDispatchingAgentHydrationRequestOnPage,
  hydrationCoverageFingerprint,
  resolveAgentHydrationBoundaryRef,
  listDispatchableAgentHydrationRequests,
  listDispatchingAgentHydrationRequests,
  listExpirableAgentHydrationRequests,
  listStuckAgentHydrationDispatches,
  rearmAgentHydrationRequest,
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
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import {
  runAgentHydrationAutoApprove,
  type AgentHydrationAutoApproveResult,
} from "./agent-hydration-autopilot.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";
import {
  asTargetedThreadBackfillResult,
  describeFailedTargetedThreadBackfillJob,
  findTargetedThreadBackfillJob,
  isTargetedThreadBackfillJobInFlight,
  isTargetedThreadBackfillLeaseLive,
  isTargetedThreadBackfillSlotTaken,
  sendTargetedThreadBackfillJob,
  TargetedThreadBackfillRunError,
  type TargetedThreadBackfillResult,
} from "./sync/targeted-thread-backfill.ts";

export const AGENT_HYDRATION_QUEUE = "agent.hydration.execute";

/** What the executor needs from pg-boss: send a job, and see a page's slot. */
type HydrationBoss = Pick<PgBoss, "send" | "findJobs">;

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
 * How many times one approval may be claimed when every run before the last
 * was refused without a vendor request: the first claim plus three re-arms.
 * A page that stays busy past that is reported, not waited on forever.
 */
const MAX_DISPATCHES_PER_APPROVAL = 4;

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

/**
 * How long a Fansly run's job must have been terminal — or, for a job the
 * queue never showed, the request dispatched — before its request is settled
 * from that record. pg-boss marks a job terminal BEFORE its handler is gone (a
 * worker's shutdown fails the active job while the process is still
 * stopping), and a send that threw may still be landing; the grace lets the
 * record become true. Settling also requires that no live page lease names
 * the job (`isTargetedThreadBackfillLeaseLive`).
 */
const FANSLY_RUN_SETTLE_GRACE_MS = 2 * 60 * 1000;

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
  /** Approvals left `approved`, attempt unspent, because their page's one run
   *  slot was taken (a run in flight, or one already started this cycle). */
  pageBusy: number;
  /** Decision #202: what the auto-approve policy did this pass (null while off). */
  autoApprove: AgentHydrationAutoApproveResult | null;
  /** Auto-approved rows HELD back from dispatch because the policy mode left
   *  `enforce` after they were approved — the kill-switch's middle rung. */
  autoHeld: number;
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
  boss: HydrationBoss,
): Promise<AgentHydrationCycleResult> {
  const config = await loadEffectiveConfig(app.db, app.config);
  const mode = config.agentHydrationMode ?? "off";
  const autoMode = config.agentHydrationAutoApproveMode ?? "off";
  const result: AgentHydrationCycleResult = {
    mode,
    expired: 0,
    swept: 0,
    reconciled: 0,
    dispatched: 0,
    refused: 0,
    pageBusy: 0,
    autoApprove: null,
    autoHeld: 0,
  };
  // `off` freezes the decisions (nothing expires, nothing is approved or
  // dispatched) but not the bookkeeping below: a run dispatched before the
  // flip still ends, and its request must close with it.
  if (mode !== "off") {
    result.expired = await expireAgentHydration(app);
  }
  // RECONCILE FIRST. A job that reached a terminal state after its deadline but
  // before this cycle would otherwise be buried by the timeout sweep as
  // `failed`, and its real outcome, accepted counts and spend could never be
  // recovered — reconciliation only ever looks at `dispatching` rows.
  result.reconciled = await reconcileAgentHydrationDispatches(app, boss);
  result.swept = await sweepStuckAgentHydration(app, boss);

  // `off` and `request_only` stop HERE. Everything above is bookkeeping about
  // work that already happened; everything below starts new work.
  if (mode !== "dispatch") {
    return result;
  }

  // Decision #202: the policy decides (or shadow-logs) BEFORE the dispatch scan
  // of the same pass, so an enforced approval executes within one cycle. It
  // runs only under `dispatch` — approving into a mode that cannot execute
  // would arm authorizations for nobody.
  if (autoMode !== "off") {
    result.autoApprove = await runAgentHydrationAutoApprove(app, config);
  }

  // THE BATCH IS CLAIMS, NOT ROWS. The scan walks the approved queue oldest
  // first, a page of rows at a time, until DISPATCH_BATCH_LIMIT approvals were
  // claimed or the queue ran out. An approval that waits — its page busy or
  // already served this cycle, parked by the policy, refused before its claim —
  // starts nothing, so it does not fill the batch: five older approvals behind
  // one busy page used to be the whole batch on every cycle, and an approval on
  // a free page behind them expired without being considered.
  const pagesThisCycle = new Set<number>();
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
      // Kill-switch middle rung: leaving `enforce` also PARKS not-yet-started
      // auto-approvals. They stay `approved` until their short TTL expires them,
      // so re-entering `enforce` within the window resumes exactly where it stopped.
      if (request.decisionSource === "auto_policy" && autoMode !== "enforce") {
        result.autoHeld += 1;
        continue;
      }
      // One run per page, checked BEFORE the claim: an approval whose page slot
      // is taken stays `approved` with its attempt unspent, and its TTL bounds
      // the wait. At most one claim per page per cycle, too. The page's turn is
      // spent by a claim, or by finding its slot taken (probed once per cycle).
      // An approval refused before its claim leaves the page as free as it
      // found it, so it cannot take the page's turn from the approvals behind
      // it on every cycle.
      const slotTaken = LANE_PAGE_SLOTS[request.platform as Platform] as
        | LanePageSlotProbe
        | null
        | undefined;
      if (slotTaken) {
        if (pagesThisCycle.has(request.pageId)) {
          result.pageBusy += 1;
          continue;
        }
        if (await slotTaken({ app, boss, pageId: request.pageId })) {
          pagesThisCycle.add(request.pageId);
          result.pageBusy += 1;
          continue;
        }
      }
      const outcome = await dispatchAgentHydrationRequest(app, boss, request);
      if (outcome !== "not_claimed") {
        claims += 1;
        if (slotTaken) {
          pagesThisCycle.add(request.pageId);
        }
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

/** Undecided or never-dispatched approvals whose expiry has passed. Like the
 * reconcile and the stuck sweep below, it never sees a row the Fansly Sync
 * Engine serves (`FANSLY_SYNC_ENGINE_HYDRATION_LANE`, filtered by the list):
 * that row mirrors a history request, and a page the engine owns gets its
 * legacy-state rows converted by the switch, not dispatched (step-3 design
 * §3.1 item 8). */
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
export async function sweepStuckAgentHydration(
  app: AppContext,
  boss: HydrationBoss,
): Promise<number> {
  const rows = await listStuckAgentHydrationDispatches(app.db, { limit: SWEEP_BATCH_LIMIT });
  let swept = 0;
  for (const row of rows) {
    const executionRef = row.executionRef;
    const lane = (LANE_IN_FLIGHT[row.platform as Platform] as LaneInFlight | undefined) ?? null;
    const verdict: InFlightVerdict = lane === null || executionRef === null
      ? { kind: "gone" }
      : await lane.read({ app, boss, row: { ...row, executionRef } });
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
 * OFAPI executor, which knows nothing about hydration. The Fansly lane settles
 * from its own run first (`settleAgentHydrationFromBackfill`,
 * `settleAgentHydrationFromFailedRun`); this is how a request still closes when
 * that run could not — crashed, stopped mid-run by a deploy, its settle lost
 * to the database, or its job never created.
 */
export async function reconcileAgentHydrationDispatches(
  app: AppContext,
  boss: HydrationBoss,
): Promise<number> {
  const rows = await listDispatchingAgentHydrationRequests(app.db, { limit: SWEEP_BATCH_LIMIT });
  let reconciled = 0;
  for (const row of rows) {
    const lane = LANE_IN_FLIGHT[row.platform as Platform] as LaneInFlight | undefined;
    const executionRef = row.executionRef;
    if (row.executionLane === null || executionRef === null || !lane) {
      continue;
    }
    const verdict = await lane.read({ app, boss, row: { ...row, executionRef } });
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
    boss: HydrationBoss;
    row: AgentHydrationRequestRecord & { executionRef: string };
  }) => Promise<InFlightVerdict>;
}

/** Capture-job states that mean the OFAPI executor still owns this work. */
const OFAPI_LIVE_STATES = new Set(["ready", "leased", "awaiting_parse", "retry_wait"]);

/**
 * The lane table for work in flight — one reader per platform, looked up,
 * never compared.
 */
const LANE_IN_FLIGHT: Readonly<Record<Platform, LaneInFlight>> = {
  fansly: { read: readFanslyRun },
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
 * A Fansly run, read back from the queue and the page lease.
 *
 * `running` while pg-boss still owns the job (queued or active), while a live
 * page lease names the job — pg-boss fails an expired job, and a stopping
 * worker's active job, while its handler may still be walking, and only the
 * lease proves otherwise — and for the settle grace after the job turned
 * terminal (or after a dispatch whose job never showed up). Then: a completed
 * job's result settles the request exactly as the worker would have; a failed
 * or cancelled job, or a missing one, settles it `failed` with what the record
 * knows about the spend.
 */
async function readFanslyRun(input: {
  app: AppContext;
  boss: HydrationBoss;
  row: AgentHydrationRequestRecord & { executionRef: string };
}): Promise<InFlightVerdict> {
  const { app, boss, row } = input;
  const jobId = row.executionRef;
  const job = await findTargetedThreadBackfillJob(boss, jobId);
  if (job !== null && isTargetedThreadBackfillJobInFlight(job.state)) {
    return { kind: "running" };
  }
  if (await isTargetedThreadBackfillLeaseLive(app.db, { pageId: row.pageId, jobId })) {
    return { kind: "running" };
  }
  const now = Date.now();
  if (job === null) {
    // The send threw (INDETERMINATE) and nothing ever landed: no job, no run,
    // no vendor request — the spend is a known zero.
    if (row.dispatchedAt === null || now - row.dispatchedAt.getTime() < FANSLY_RUN_SETTLE_GRACE_MS) {
      return { kind: "running" };
    }
    return {
      kind: "settle",
      settle: (actor) => settleFailedRun(app, row, { cause: "job_missing", vendorCalls: 0, actor }),
    };
  }
  if (job.state === "completed") {
    const result = asTargetedThreadBackfillResult(job.output);
    if (result !== null) {
      return {
        kind: "settle",
        settle: async () => (await settleAgentHydrationFromBackfill(app, row.requestRef, result)) ?? "conflict",
      };
    }
    // The worker returns no result only for a payload it could not use: the
    // walk never started.
    return {
      kind: "settle",
      settle: (actor) => settleFailedRun(app, row, { cause: "job_without_result", vendorCalls: 0, actor }),
    };
  }
  if (job.completedOn !== null && now - job.completedOn.getTime() < FANSLY_RUN_SETTLE_GRACE_MS) {
    return { kind: "running" };
  }
  const failed = describeFailedTargetedThreadBackfillJob(job.output);
  return {
    kind: "settle",
    settle: (actor) => settleFailedRun(app, row, {
      cause: failed.failureClass ?? `job_${job.state}`,
      failureClass: failed.failureClass,
      run: failed.result,
      actor,
    }),
  };
}

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
 * attempt was claimed, then settled, re-armed or left indeterminate), or
 * `not_claimed` (refused or retired before the claim, or the CAS lost).
 */
async function dispatchAgentHydrationRequest(
  app: AppContext,
  boss: HydrationBoss,
  request: AgentHydrationRequestRecord,
): Promise<"dispatched" | "claimed" | "not_claimed"> {
  const platform = request.platform as Platform;
  const lane = AGENT_HYDRATION_LANES[platform] as typeof AGENT_HYDRATION_LANES[Platform] | undefined;
  if (!lane) {
    return "not_claimed";
  }

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

  const { thread } = await findAgentHydrationThread(app.db, {
    pageId: request.pageId,
    conversationRef: request.conversationRef,
  });
  if (!thread) {
    return refuse("target is no longer a visible thread");
  }

  // The DEPTH the owner approved against. If somebody deepened this thread since
  // the decision, the approved spend buys history we already have.
  const currentCoverage = hydrationCoverageFingerprint({
    pageId: request.pageId,
    conversationRef: request.conversationRef,
    storedMessageCount: thread.storedMessageCount,
    oldestStoredMessageId: thread.oldestStoredMessageId,
    messageCoverageStatus: thread.messageCoverageStatus,
  });
  if (currentCoverage !== request.coverageFingerprint) {
    // Coverage never moves back, so this approval can never dispatch. An owner
    // approval never claimed waits out the owner's own expiry, as before (P1-2).
    // The policy's approvals, and any approval a refused run handed back, are
    // retired now instead: they are the ones that wait, and waiting is when a
    // thread moves (a regular chunk parked on it resumes). Left `approved`, they
    // would hold the page's one live approval and their reserved calls until
    // the TTL. `expired` says nothing was spent.
    if (request.decisionSource === "auto_policy" || request.dispatchCount > 0) {
      await retireUndispatchableApproval(app, request, "coverage_moved");
      return "not_claimed";
    }
    return refuse("thread coverage moved since the decision");
  }

  // The approved BOUNDARY, resolved to the cursor each lane pages backwards
  // from. The target says "deepen PAST this point", so the boundary is where the
  // walk starts — an approval for "before message X" that executed as a generic
  // walk would spend on, and report about, a different scope than the one the
  // owner authorized.
  const boundaryRef = await resolveApprovedBoundary(app, request, thread);

  // Stable prerequisites of the OnlyFans lane. Neither can appear on its own
  // between now and the claim, so checking them here is what keeps a missing
  // mapping from eating the attempt and settling `failed` without ever creating
  // a job.
  const preparation = await LANE_PREPARERS[platform]({ app, request, thread, boundaryRef });
  if (!preparation.ok) {
    return refuse(preparation.reason);
  }

  // ---- The single attempt --------------------------------------------------
  const deadlineAt = new Date(Date.now() + DISPATCH_DEADLINE_MS[platform]);
  const executionLane = request.laneSelected ?? lane.lane;
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
    const enqueued = await LANE_DISPATCHERS[platform]({
      app,
      boss,
      request,
      threadId: thread.id,
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
    if (enqueued.kind === "slot_taken") {
      // DETERMINATE and FREE: the page's slot was taken between the probe and
      // the send, so no job exists and no vendor was asked. The approval goes
      // back to wait for the slot instead of losing its attempt to the race.
      await rearmOrFailRefusedRun(app, claimed.request ?? request, "page_slot_taken", 0);
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
    // INDETERMINATE. The send may have landed and lost its response; the job may
    // be running right now. Settling `failed` here would let the owner authorize
    // the SAME paid work a second time while the first copy is still going —
    // the outbox law is explicit that an indeterminate send is never
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
 * from. When nothing resolves, the answer is `null` and each lane falls back to
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
  boss: HydrationBoss;
  request: AgentHydrationRequestRecord;
  threadId: number;
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
  /** Determinate and free: the page's one-run slot refused the job. Waits for
   *  the slot (re-arm) rather than spending the attempt. */
  | { kind: "slot_taken" }
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
 * The stable prerequisites of each lane, checked BEFORE the attempt is claimed.
 *
 * A page with no OFAPI mapping, or a thread with no head to freeze, cannot
 * produce a job at all — and neither condition is going to appear between this
 * check and the claim. Discovering them after the CAS burned the owner's single
 * attempt on a job that was never created.
 */
const LANE_PREPARERS: Readonly<Record<Platform, (input: {
  app: AppContext;
  request: AgentHydrationRequestRecord;
  thread: { lastMessageId: string | null };
  boundaryRef: string | null;
}) => Promise<LanePreparation>>> = {
  fansly: async () => ({
    ok: true,
    reason: "",
    frozenHeadId: null,
    ofapiAccountId: null,
  }),
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

type LanePageSlotProbe = (input: {
  app: AppContext;
  boss: HydrationBoss;
  pageId: number;
}) => Promise<boolean>;

/**
 * Lanes that run ONE job per page, and how to see that page's slot taken.
 *
 * Probed BEFORE the claim. The Fansly targeted queue is `exclusive` on a page
 * singletonKey, so a second same-page send returns null; claiming first spent
 * the approval's attempt on a send the queue had to refuse (2026-09-27..29: 121
 * approvals failed that way, 10-20 ms after dispatch, without a Fansly call).
 * The slot is taken by a hydration run still in flight OR by any queued or
 * running targeted job for the page — the owner's CLI sends to the same key.
 *
 * `null`: the lane has no page-wide slot. OnlyFans capture jobs coalesce per
 * chat (`activeSlotKey`) inside `createOrGetOfapiCaptureJob`.
 */
const LANE_PAGE_SLOTS: Readonly<Record<Platform, LanePageSlotProbe | null>> = {
  fansly: async ({ app, boss, pageId }) =>
    await hasDispatchingAgentHydrationRequestOnPage(app.db, pageId)
      || await isTargetedThreadBackfillSlotTaken(boss, pageId),
  onlyfans: null,
};

/**
 * The lane table, as DISPATCHERS — one entry per platform, looked up, never
 * compared. A branch on a platform literal here would both spend the ratchet and
 * hide the asymmetry this table exists to publish.
 */
const LANE_DISPATCHERS: Readonly<
  Record<Platform, (input: LaneDispatchInput) => Promise<LaneEnqueueResult>>
> = {
  fansly: async ({ boss, request, threadId, boundaryRef, executionRef }) => {
    // Slice C's whole job: hand the thread to C'. The owner's ceilings become
    // the run's budgets, the approved boundary becomes its starting cursor, and
    // the depth cap is lifted for THIS run only — going past the cap is
    // precisely what the owner approved.
    const jobId = await sendTargetedThreadBackfillJob(boss, {
      threadId,
      platformAccountId: request.pageId,
      ignoreRetentionLimit: true,
      maxRequests: fanslyRequestCeiling(request),
      ...(request.decisionMaxItems === null ? {} : { maxItems: request.decisionMaxItems }),
      ...(boundaryRef === null ? {} : { startBeforeMessageRef: boundaryRef }),
      hydrationRequestRef: request.requestRef,
      jobId: executionRef,
    });
    // `null` is the `exclusive` page singleton refusing a second job — not a
    // vendor answer. The dispatcher probes the slot before claiming, so this
    // is only the race between that probe and this send.
    return jobId === null
      ? { kind: "slot_taken" }
      : { kind: "enqueued", executionRef: jobId };
  },
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

/**
 * The ceiling the Fansly run must not exceed.
 *
 * Both approved numbers bound the same thing on this lane — one vendor request
 * per message page — so the run gets the SMALLER of them. The fallback is
 * deliberately the tightest number rather than the run's own full budget: the
 * failure to avoid is an approval whose ceiling silently does not arrive.
 */
function fanslyRequestCeiling(request: AgentHydrationRequestRecord): number {
  const caps = [request.decisionMaxCalls, request.decisionMaxPages]
    .filter((cap): cap is number => cap !== null && cap > 0);
  return caps.length === 0 ? 1 : Math.min(...caps);
}

/**
 * How a targeted-backfill outcome settles the request that asked for it.
 *
 * `completed` only where the walk PROVED the end of the history: an empty
 * page reached from the stored oldest message (the run's own outcome rule; a
 * short page or known ground is `partial`). Everything the run REFUSED
 * (breaker open, lease unavailable, page busy, ineligible thread) is a
 * `failed`, not a `partially_completed`: nothing was hydrated, and calling
 * that a partial success would tell the owner the spend bought something.
 *
 * The three TRANSIENT refusals (`REARMABLE_OUTCOMES`) reach this table only
 * once their re-arms are used up. The page stayed busy for every run the
 * approval got, so they settle `timeout`; `vendor_unavailable` would blame a
 * vendor nobody called.
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
  page_busy: { state: "failed", lastError: "timeout" },
  thread_checkpoint_in_progress: { state: "failed", lastError: "timeout" },
  lease_unavailable: { state: "failed", lastError: "timeout" },
  lease_lost: { state: "failed", lastError: "timeout" },
  // The thread's own breaker now holds it (500 breaker of the point path).
  vendor_error: { state: "failed", lastError: "quarantined" },
};

/**
 * Refusals at the page's door: the run took no vendor request because the page
 * was busy right then (another stream mid-chunk, the page lease held, a regular
 * chunk parked on this thread). The same approval can succeed a few minutes
 * later, so it is re-armed rather than failed. The stable refusals (thread
 * gone or ineligible, breaker open) are not here: waiting does not fix them.
 */
const REARMABLE_OUTCOMES: ReadonlySet<TargetedThreadBackfillResult["outcome"]> = new Set([
  "page_busy",
  "lease_unavailable",
  "thread_checkpoint_in_progress",
]);

/**
 * A claimed run that DETERMINATELY made no vendor request: give the approval
 * back (`dispatching -> approved`) so the next cycle can start it again, or —
 * once `MAX_DISPATCHES_PER_APPROVAL` claims are used — settle it `failed` with
 * `timeout`. If the row already moved on (the sweeper settled it), both CASes
 * refuse and nothing changes.
 */
async function rearmOrFailRefusedRun(
  app: AppContext,
  request: AgentHydrationRequestRecord,
  cause: string,
  /** What the refused run sent; the callers only get here when it sent none. */
  vendorCalls: number | undefined,
): Promise<AgentHydrationCasOutcome> {
  const rearmed = await rearmAgentHydrationRequest(app.db, {
    id: request.id,
    expectedVersion: request.rowVersion,
    maxDispatches: MAX_DISPATCHES_PER_APPROVAL,
    cause,
  });
  if (rearmed.outcome === "applied") {
    app.logger.info(
      {
        requestRef: request.requestRef,
        pageLabel: request.pageLabel,
        cause,
        dispatchCount: rearmed.request?.dispatchCount ?? null,
      },
      "Agent hydration run was refused before any vendor request; approval re-armed",
    );
    return "applied";
  }
  const { outcome } = await settleAgentHydrationRequest(app.db, {
    id: request.id,
    toState: "failed",
    lastError: "timeout",
    cause,
    ...(vendorCalls === undefined ? {} : { vendorCalls }),
  });
  if (outcome === "applied") {
    app.logger.warn(
      { requestRef: request.requestRef, pageLabel: request.pageLabel, cause },
      "Agent hydration page stayed busy through every allowed run; approval settled failed",
    );
  }
  return outcome;
}

/**
 * An approval that can never dispatch, ended before its window closes:
 * `approved -> expired`, journaled with the cause. `expired`, not `failed`: no
 * vendor was asked, so its reservation is returned (`sumAutoApprovedCallsSince`)
 * and its page is free for the next approval at once.
 */
async function retireUndispatchableApproval(
  app: AppContext,
  request: AgentHydrationRequestRecord,
  cause: string,
): Promise<void> {
  const outcome = await expireAgentHydrationRequest(app.db, {
    id: request.id,
    fromState: "approved",
    actor: "executor",
    cause,
  });
  if (outcome === "applied") {
    app.logger.warn(
      {
        requestRef: request.requestRef,
        pageLabel: request.pageLabel,
        cause,
        decisionSource: request.decisionSource,
        dispatchCount: request.dispatchCount,
      },
      "Agent hydration approval can no longer dispatch; retired as expired, no vendor request made",
    );
  }
}

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
): Promise<AgentHydrationCasOutcome | null> {
  const { request } = await findAgentHydrationRequestByRef(app.db, requestRef);
  if (!request || request.state !== "dispatching") {
    return null;
  }
  // The run's own count of the requests it sent, which is what the autopilot's
  // daily budget is charged once the request settles. Not `requests`: that
  // counts accepted pages, and misses retries and a page fetched but not kept.
  const vendorCalls = Number.isSafeInteger(result.requestAttempts) && result.requestAttempts >= 0
    ? result.requestAttempts
    : undefined;
  // `requests === 0` is the evidence, not the outcome name: only a run that
  // provably never reached the vendor may hand its approval back.
  if (REARMABLE_OUTCOMES.has(result.outcome) && result.requests === 0) {
    return rearmOrFailRefusedRun(app, request, result.outcome, vendorCalls);
  }
  // `completed` is believed only with its proof on the result: the empty page
  // reached from the stored oldest message (decision №3). A result that says
  // `completed` without it — written before the proof rule, read back from an
  // old job — is a partial. An outcome this build does not know is no
  // evidence of success at all: `failed`, its spend still counted.
  const outcome = result.outcome === "completed" && result.emptyPageReached !== true
    ? "partial"
    : result.outcome;
  const mapped = (BACKFILL_OUTCOME_STATES[outcome] as
    | (typeof BACKFILL_OUTCOME_STATES)[TargetedThreadBackfillResult["outcome"]]
    | undefined) ?? { state: "failed" as const, lastError: "vendor_unavailable" as const };
  const settled = await settleAgentHydrationRequest(app.db, {
    id: request.id,
    toState: mapped.state,
    lastError: mapped.lastError,
    acceptedItems: result.insertedMessages,
    acceptedPages: result.requests,
    ...(vendorCalls === undefined ? {} : { vendorCalls }),
  });
  return settled.outcome;
}

/**
 * Settles the hydration request a targeted run answered when the run returned
 * NO result: it threw, or its job could not be run at all.
 *
 * `failed`, never a re-arm — a run that threw may have reached Fansly. The
 * journal gets a bounded `cause` and, whenever it is known, the run's real
 * spend: a `TargetedThreadBackfillRunError` carries the attempts it started
 * (zero for a failure before the walk). An unknown spend is settled
 * `timeout`, which keeps the approval's whole reservation on the autopilot's
 * budget (fail closed); a known one picks the closest code for the failure.
 */
export async function settleAgentHydrationFromFailedRun(
  app: AppContext,
  requestRef: string,
  failure: {
    /** What the run threw, when it ran. */
    error?: unknown;
    /** Bounded code for the journal when the run did not throw. */
    cause?: string;
    /** Known spend when there is no run error to read it from. */
    vendorCalls?: number;
  },
): Promise<AgentHydrationCasOutcome | null> {
  const { request } = await findAgentHydrationRequestByRef(app.db, requestRef);
  if (!request || request.state !== "dispatching") {
    return null;
  }
  const runError = failure.error instanceof TargetedThreadBackfillRunError ? failure.error : null;
  return settleFailedRun(app, request, {
    cause: runError?.failureClass ?? failure.cause ?? "run_error",
    failureClass: runError?.failureClass ?? null,
    run: runError?.result ?? null,
    ...(failure.vendorCalls === undefined ? {} : { vendorCalls: failure.vendorCalls }),
    actor: "executor",
  });
}

/** `last_error` for a run that failed with a KNOWN spend, by failure class. */
function failedRunLastError(failureClass: string | null): AgentHydrationLastError {
  if (failureClass === "proxy_missing") {
    return "proxy_missing";
  }
  if (failureClass === "lease_lost") {
    return "timeout";
  }
  return "vendor_unavailable";
}

async function settleFailedRun(
  app: AppContext,
  request: AgentHydrationRequestRecord,
  failure: {
    cause: string;
    failureClass?: string | null;
    /** What the run did before it failed; `requestAttempts` is its spend. */
    run?: TargetedThreadBackfillResult | null;
    vendorCalls?: number;
    actor: "executor" | "sweeper";
  },
): Promise<AgentHydrationCasOutcome> {
  const run = failure.run ?? null;
  const vendorCalls = run !== null ? run.requestAttempts : failure.vendorCalls;
  const { outcome } = await settleAgentHydrationRequest(app.db, {
    id: request.id,
    toState: "failed",
    lastError: vendorCalls === undefined ? "timeout" : failedRunLastError(failure.failureClass ?? null),
    acceptedItems: run?.insertedMessages ?? 0,
    acceptedPages: run?.requests ?? 0,
    ...(vendorCalls === undefined ? {} : { vendorCalls }),
    cause: failure.cause,
    actor: failure.actor,
  });
  if (outcome === "applied") {
    app.logger.warn(
      {
        requestRef: request.requestRef,
        pageLabel: request.pageLabel,
        executionRef: request.executionRef,
        cause: failure.cause,
        vendorCalls: vendorCalls ?? null,
      },
      "Agent hydration run ended without a result; request settled failed",
    );
  }
  return outcome;
}
