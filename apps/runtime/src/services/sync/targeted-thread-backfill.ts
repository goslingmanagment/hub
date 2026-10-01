// Slice C′ — targeted thread backfill.
//
// The regular Fansly dm_messages executor picks WHICH thread to deep-backfill
// from a live candidate query and walks one vendor page per visit; there is no
// way to say "this thread, now". This module adds that: a one-shot pg-boss job
// (owner-initiated from the CLI) that walks ONE named thread backwards within a
// single bounded run, using the executor's own message-page unit
// (`fetchAndJournalFanslyDmMessagePage`) so the adapter call, the egress
// context, the verbatim capture and the normalization are literally the same
// code.
//
// Fencing: the run takes the page's REAL dm_messages sync lease
// (`acquireTargetedPageSyncLease`) and does EVERY write — the walk AND the
// closing summary recompute — inside the page-sync execution context, so every
// `assertOwnedPageSyncLease` / `withOwnedPageSyncTransaction` in the shared
// code actually fences (outside the context those calls early-return, which
// would silently reduce the fence to a no-op). No lease => the run refuses; it
// never runs lease-less next to the regular executor.
//
// Bounded by construction: one job = one run. When the thread is deeper than
// the run's request budget the outcome is reported as `partial` and the owner
// re-runs; there is no checkpoint-and-re-enqueue continuation.
//
// `completed` is a PROOF, not a stopping reason (plan §6.2, owner decision
// №3): the walk started at the thread's stored oldest message and read on,
// page after contiguous page, until Fansly answered an EMPTY page. A short
// page is not the end (16.09: two 24-of-25 heads with 117 and 21 older
// messages behind them), so the walk reads on past it; meeting stored ground
// is not the end either, so the walk stops there `partial`.
//
// A thread-attributable failure (the executor's per-thread breaker rule) is
// recorded on the thread's breaker and RETURNED as `vendor_error`; every
// other failure is thrown as a `TargetedThreadBackfillRunError` carrying what
// the run did, so whoever settles a hydration request knows the real spend.
//
// The run's result is the job's return value, so pg-boss keeps it in
// pgboss.job.output — the record the CLI's `--wait` reads. A refusal is a
// completed job with a refusal outcome there, not an error.

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { sql } from "drizzle-orm";

import {
  acquireTargetedPageSyncLease,
  assertOwnedPageSyncLease,
  clearConversationSyncHealth,
  countOtherDmMessageGroupsFailingSinceLastSuccess,
  ensurePageSyncStates,
  finalizePageDmConversationMessageSync,
  getCheckpoint,
  getConversationSyncHealth,
  getPageDmConversationById,
  getPageDmMessageRetentionLimit,
  getPageSyncState,
  getSyncStreamsForPlatform,
  heartbeatPageSyncLease,
  isConversationSyncHealthExcluded,
  listPageSyncStates,
  PageSyncLeaseLostError,
  pausePageSyncForAuth,
  PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
  recordConversationSyncFailure,
  recordProjectionDebt,
  releaseTargetedPageSyncLease,
  runWithPageSyncExecutionContext,
  startSyncRun,
  upsertPageDmMessages,
  withOwnedPageSyncTransaction,
  type MessageCoverageStatus,
  type PageSyncState,
  type SyncStream,
} from "@agency_hub_core/db";
import { FanslyApiError, FanslyProxyMissingError } from "@agency_hub_core/fansly";
import { isFanslyDmMessageSyncExcluded } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../../bootstrap.ts";
import { ProxyMissingError } from "../errors.ts";
import { notifyAuthFailedIncident } from "../notification-incidents.ts";
import { isPageDmPruneAllowed } from "../page-dm-retention.ts";
import { resolvePageContextById } from "../page-context.ts";
import { resolveFanslyPlatformAccountId } from "../fansly.ts";
import { SyncChunkBudget, composeRequestObservers } from "./chunk-budget.ts";
import { parseDmMessagesCursorState } from "./cursor-state.ts";
import { pageSyncDependencyInput } from "./dependencies.ts";
import {
  assertDmSharedRateLimitEnabled,
  DM_MESSAGES_BREAKER_OUTAGE_LOOKBACK_MS,
  DM_MESSAGES_BREAKER_OUTAGE_OTHER_FAILING_GROUPS,
  DmMessagesChunkRequestObserver,
  FANSLY_DM_MESSAGE_PAGE_LIMIT,
  fetchAndJournalFanslyDmMessagePage,
  isThreadAttributableFanslyFailure,
  resolveDmConversationCoverageStatus,
} from "./fansly-dm-messages.ts";
import { SyncRunTelemetry } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./../sync-queue.ts";
import { fanslyPageSendGuard } from "../fansly-send-guard/index.ts";

export const TARGETED_THREAD_BACKFILL_QUEUE = "sync.thread.backfill";

/** Vendor requests one run may spend on the thread (25 messages each). */
const TARGETED_BACKFILL_MAX_REQUESTS = 40;
/** Wall clock for one run; the pacer's inter-request delay is charged to it. */
const TARGETED_BACKFILL_MAX_WALL_CLOCK_MS = 10 * 60 * 1000;
const TARGETED_BACKFILL_LEASE_TTL_MS = 120_000;
const TARGETED_BACKFILL_HEARTBEAT_MS = 30_000;
// One attempt, no auto-retry: a half-walked thread is re-runnable by hand and
// a silent retry would double the vendor traffic behind the owner's back.
const TARGETED_BACKFILL_RETRY_LIMIT = 0;
export const TARGETED_BACKFILL_EXPIRE_SECONDS = 20 * 60;
/**
 * How long a run waits out the page's own chunks before refusing `page_busy` /
 * `lease_unavailable`. A regular chunk holds the page for seconds (p99 ≈ 1 min
 * in prod, 2026-09), but chunks come in bursts, and on 28.09 an owner repair
 * was refused in 20 ms behind a followers_reconcile burst that ended 40 s
 * later. The wait makes no vendor request, and wait + the walk's wall clock
 * (4 + 10 min) stays well inside the job's 20-minute expiry.
 */
const TARGETED_BACKFILL_CONTENTION_WAIT_MS = 4 * 60 * 1000;
const TARGETED_BACKFILL_CONTENTION_POLL_MS = 5_000;

export interface TargetedThreadBackfillRunOptions {
  /** Test seams for the contention wait above. */
  contentionWaitMs?: number;
  contentionPollMs?: number;
  /**
   * The pg-boss job this run executes. Written into the page lease's owner,
   * so reconciliation can tell THIS run's lease from any other targeted run's
   * (`isTargetedThreadBackfillLeaseLive`).
   */
  jobId?: string;
}

export interface TargetedThreadBackfillJob {
  threadId: number;
  ignoreRetentionLimit?: boolean;
  /**
   * Slice C: the owner-approved call cap, clamped to the run's own ceiling.
   *
   * An approval that says "at most 5 calls" must actually bind, or the cap the
   * owner typed is decoration. It can only ever LOWER the bound — a decision
   * cannot buy a longer run than one job is allowed to be.
   */
  maxRequests?: number;
  /**
   * Slice C: the owner-approved ITEM ceiling. Checked between vendor pages, so
   * the run stops as soon as it has accepted at least this many messages; the
   * unit of acceptance is a page, so the last page may cross it.
   */
  maxItems?: number;
  /**
   * Slice C: the approved BOUNDARY, as the message this walk starts before.
   *
   * The target says "deepen this thread PAST this point", so the boundary is
   * where the walk begins. Without it every approved boundary executed as a
   * generic walk from the deepest message we already held — spending on, and
   * reporting about, a different scope than the one that was approved.
   */
  startBeforeMessageRef?: string;
  /** Slice C: the hydration request this run answers, so its outcome settles
   *  the request instead of vanishing into the job log. */
  hydrationRequestRef?: string;
}

export interface TargetedThreadBackfillSendInput extends TargetedThreadBackfillJob {
  /** Page that owns the thread — the queue's singleton key (see below). */
  platformAccountId: number;
  /**
   * Slice C: a job id minted by the CALLER, so the hydration request can record
   * what it authorized in the same statement that claims its single attempt —
   * before the job exists. Omit it and pg-boss mints one as before.
   */
  jobId?: string;
}

export type TargetedThreadBackfillOutcome =
  /** PROVEN: from the thread's stored oldest message the walk read contiguous
   * pages down to an EMPTY one — the whole history is stored. */
  | "completed"
  /** Stopped without that proof — the run's bound or item cap, stored ground
   * met, or the end of history below an approved boundary that is not the
   * stored oldest message; re-run to continue. */
  | "partial"
  /** Fansly refused a page of this thread with a thread-attributable answer
   * (a terminal 500, or a 4xx that is not auth, timeout or rate limit); the
   * thread's breaker recorded it, so its next run waits out the backoff. */
  | "vendor_error"
  | "thread_not_found"
  | "unsupported_platform"
  /** Excluded/invisible/unidentified thread — the same rows the picker skips. */
  | "thread_not_eligible"
  /** page_dm_message_sync_health backoff or quarantine window still open. */
  | "breaker_open"
  /** Depth cap reached and the run was not told to ignore it. */
  | "retention_limit_reached"
  /** Another stream of the same page is mid-chunk (Stage 25 page serialization). */
  | "page_busy"
  /** A dm_conversations chunk ran DURING this run — summary left to the sweeper. */
  | "concurrent_page_chunk"
  /** A yielded regular chunk is parked on this very thread — refuse, don't race. */
  | "thread_checkpoint_in_progress"
  /** The regular executor (or another targeted run) holds the page's lease. */
  | "lease_unavailable"
  /** The lease was lost mid-run (fenced) — the run stopped immediately. */
  | "lease_lost";

export interface TargetedThreadBackfillResult {
  outcome: TargetedThreadBackfillOutcome;
  threadId: number;
  platformAccountId: number | null;
  syncRunId: number | null;
  /** Message pages the walk accepted and stored. */
  requests: number;
  /**
   * HTTP attempts the run STARTED against Fansly: retries, failed attempts and
   * a page that was fetched but never accepted all count. This is what the run
   * spent, and what a hydration request settles against the autopilot's daily
   * budget; `requests` undercounts it whenever an attempt did not end in an
   * accepted page. Zero for every refusal: they return before the first request.
   */
  requestAttempts: number;
  insertedMessages: number;
  journaledMessages: number;
  overlapFound: boolean;
  /** Fansly's own "no more" on the walk's last page: a short page counts. */
  providerHistoryExhausted: boolean;
  /** The walk's last page came back EMPTY: Fansly holds nothing older than
   * its cursor. The only evidence of the end of a history (decision №3). */
  emptyPageReached: boolean;
  storedMessageCountBefore: number;
  oldestStoredMessageIdBefore: string | null;
  messageCoverageStatus: MessageCoverageStatus | null;
  retentionLimit: number | null;
  projectionDebtRecorded: boolean;
}

export async function ensureTargetedThreadBackfillQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, TARGETED_THREAD_BACKFILL_QUEUE, {
    // `exclusive` + a PAGE singletonKey: at most one targeted job per page is
    // queued or active. Stage 25's coordination invariant is that a page runs
    // one sync chunk at a time (`sync.page.execute` carries the same fixed
    // page singleton, `executor.ts:891`), and a thread belongs to exactly one
    // page — so the page key also rejects a duplicate job for the same thread,
    // strictly. pg-boss singletons are per QUEUE, so the cross-queue half of
    // the invariant is enforced at run time by the page-busy lease check in
    // `runTargetedThreadBackfill`.
    policy: "exclusive",
    expireInSeconds: TARGETED_BACKFILL_EXPIRE_SECONDS,
    heartbeatSeconds: 30,
    retryLimit: TARGETED_BACKFILL_RETRY_LIMIT,
  }, createdQueues);
}

/** Enqueue one targeted backfill. Returns null when the page (hence the thread)
 * already has a targeted job queued or active. */
export async function sendTargetedThreadBackfillJob(
  boss: Pick<PgBoss, "send">,
  input: TargetedThreadBackfillSendInput,
): Promise<string | null> {
  return boss.send(
    TARGETED_THREAD_BACKFILL_QUEUE,
    {
      threadId: input.threadId,
      ignoreRetentionLimit: input.ignoreRetentionLimit === true,
      ...(input.maxRequests === undefined ? {} : { maxRequests: input.maxRequests }),
      ...(input.maxItems === undefined ? {} : { maxItems: input.maxItems }),
      ...(input.startBeforeMessageRef === undefined
        ? {}
        : { startBeforeMessageRef: input.startBeforeMessageRef }),
      ...(input.hydrationRequestRef === undefined
        ? {}
        : { hydrationRequestRef: input.hydrationRequestRef }),
    } satisfies TargetedThreadBackfillJob,
    {
      ...(input.jobId === undefined ? {} : { id: input.jobId }),
      singletonKey: String(input.platformAccountId),
      expireInSeconds: TARGETED_BACKFILL_EXPIRE_SECONDS,
      retryLimit: TARGETED_BACKFILL_RETRY_LIMIT,
    },
  );
}

/** Job states that hold the page's `exclusive` slot (pg-boss: state <= active). */
const TARGETED_BACKFILL_SLOT_STATES: ReadonlySet<string> = new Set(["created", "retry", "active"]);

/**
 * Whether `sendTargetedThreadBackfillJob` would be refused for this page right
 * now: a job under the same page singletonKey is queued or running. Whoever
 * sent it — a hydration dispatch or the owner's CLI — the slot is the page's.
 */
export async function isTargetedThreadBackfillSlotTaken(
  boss: Pick<PgBoss, "findJobs">,
  platformAccountId: number,
): Promise<boolean> {
  const jobs = await boss.findJobs(TARGETED_THREAD_BACKFILL_QUEUE, {
    key: String(platformAccountId),
  });
  return jobs.some((job) => TARGETED_BACKFILL_SLOT_STATES.has(job.state));
}

/** One targeted job as pg-boss holds it; null when the queue has no such job. */
export interface TargetedThreadBackfillJobRecord {
  state: string;
  /** The run's result once `completed`; the serialized error once `failed`. */
  output: unknown;
  completedOn: Date | null;
}

export async function findTargetedThreadBackfillJob(
  boss: Pick<PgBoss, "findJobs">,
  jobId: string,
): Promise<TargetedThreadBackfillJobRecord | null> {
  const [job] = await boss.findJobs(TARGETED_THREAD_BACKFILL_QUEUE, { id: jobId });
  return job
    ? { state: job.state, output: job.output ?? null, completedOn: job.completedOn ?? null }
    : null;
}

/** pg-boss still owns the job: it is queued, or a worker is running it. */
export function isTargetedThreadBackfillJobInFlight(state: string): boolean {
  return TARGETED_BACKFILL_SLOT_STATES.has(state);
}

export function parseTargetedThreadBackfillJob(data: unknown): TargetedThreadBackfillJob | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const threadId = typeof record.threadId === "number" ? record.threadId : Number.NaN;
  if (!Number.isInteger(threadId) || threadId <= 0) {
    return null;
  }
  const maxRequests = typeof record.maxRequests === "number" && Number.isInteger(record.maxRequests)
    && record.maxRequests > 0
    ? record.maxRequests
    : undefined;
  const maxItems = typeof record.maxItems === "number" && Number.isInteger(record.maxItems)
    && record.maxItems > 0
    ? record.maxItems
    : undefined;
  return {
    threadId,
    ignoreRetentionLimit: record.ignoreRetentionLimit === true,
    ...(maxRequests === undefined ? {} : { maxRequests }),
    ...(maxItems === undefined ? {} : { maxItems }),
    ...(typeof record.startBeforeMessageRef === "string" && record.startBeforeMessageRef.length > 0
      ? { startBeforeMessageRef: record.startBeforeMessageRef }
      : {}),
    ...(typeof record.hydrationRequestRef === "string"
      ? { hydrationRequestRef: record.hydrationRequestRef }
      : {}),
  };
}

function emptyResult(
  threadId: number,
  outcome: TargetedThreadBackfillOutcome,
  overrides?: Partial<TargetedThreadBackfillResult>,
): TargetedThreadBackfillResult {
  return {
    outcome,
    threadId,
    platformAccountId: null,
    syncRunId: null,
    requests: 0,
    requestAttempts: 0,
    insertedMessages: 0,
    journaledMessages: 0,
    overlapFound: false,
    providerHistoryExhausted: false,
    emptyPageReached: false,
    storedMessageCountBefore: 0,
    oldestStoredMessageIdBefore: null,
    messageCoverageStatus: null,
    retentionLimit: null,
    projectionDebtRecorded: false,
    ...overrides,
  };
}

/**
 * A run that FAILED, thrown with what it did before the failure.
 *
 * The message is the original error's (the CLI's `--wait` and the job log
 * read it), the original is the `cause`, and `result.requestAttempts` is the
 * run's real spend — zero for a failure before the walk. pg-boss serializes
 * the thrown error into the failed job's output, `result` and
 * `failureClass` included, so a request the worker could not settle is
 * still settled from the job record later (agent-hydration reconciliation).
 */
export class TargetedThreadBackfillRunError extends Error {
  readonly result: TargetedThreadBackfillResult;
  /** Bounded code for journals: `proxy_missing`, `fansly_<status>`,
   * `fansly_transport`, `lease_lost` or `internal`. */
  readonly failureClass: string;

  constructor(cause: unknown, result: TargetedThreadBackfillResult) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TargetedThreadBackfillRunError";
    this.result = result;
    this.failureClass = classifyTargetedRunFailure(cause);
  }
}

function classifyTargetedRunFailure(error: unknown): string {
  if (error instanceof ProxyMissingError || error instanceof FanslyProxyMissingError) {
    return "proxy_missing";
  }
  if (error instanceof PageSyncLeaseLostError) {
    return "lease_lost";
  }
  if (error instanceof FanslyApiError) {
    return typeof error.status === "number" ? `fansly_${error.status}` : "fansly_transport";
  }
  return "internal";
}

/**
 * Reads a targeted run's result back from wherever it was kept: the value a
 * completed job returned, or the `result` a failed job's serialized
 * `TargetedThreadBackfillRunError` carries. Anything else is not a result.
 */
export function asTargetedThreadBackfillResult(value: unknown): TargetedThreadBackfillResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const counts = [record.requests, record.requestAttempts, record.insertedMessages];
  if (
    typeof record.outcome !== "string" ||
    typeof record.threadId !== "number" ||
    !counts.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
  ) {
    return null;
  }
  return record as unknown as TargetedThreadBackfillResult;
}

/** What a failed targeted job's output says about its run, when anything. */
export function describeFailedTargetedThreadBackfillJob(output: unknown): {
  result: TargetedThreadBackfillResult | null;
  failureClass: string | null;
} {
  const record = typeof output === "object" && output !== null ? output as Record<string, unknown> : {};
  return {
    result: asTargetedThreadBackfillResult(record.result),
    failureClass: typeof record.failureClass === "string" ? record.failureClass : null,
  };
}

/** The hydration request a job's raw data names, even when the rest of the
 * payload is unusable (the worker still owes that request an answer). */
export function targetedThreadBackfillRequestRefOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const ref = (data as Record<string, unknown>).hydrationRequestRef;
  return typeof ref === "string" && ref.length > 0 ? ref : null;
}

const TARGETED_BACKFILL_LEASE_OWNER_PREFIX = "targeted-thread-backfill";

/** `targeted-thread-backfill:<pid>[:<pg-boss job id>]`. The job id makes the
 * lease attributable to one run; a run started outside a job has none. */
function targetedBackfillLeaseOwner(jobId: string | undefined) {
  return jobId === undefined
    ? `${TARGETED_BACKFILL_LEASE_OWNER_PREFIX}:${process.pid}`
    : `${TARGETED_BACKFILL_LEASE_OWNER_PREFIX}:${process.pid}:${jobId}`;
}

/**
 * Whether a targeted run of THIS job may still be holding the page.
 *
 * pg-boss failing a job does not stop its handler: an expired job is failed
 * while its code runs on, and a worker's shutdown fails its active job before
 * the process is gone. The page's dm_messages lease is what proves a run is
 * still alive — it is heartbeated every 30 s and lapses within its 120 s TTL
 * once nobody does. Read on the database clock. An unexpired targeted lease
 * owned by ANOTHER job is not this run; one whose owner names no job (written
 * before owners carried it) might be, and counts as live.
 */
export async function isTargetedThreadBackfillLeaseLive(
  db: AppContext["db"],
  input: { pageId: number; jobId: string },
): Promise<boolean> {
  const result = await db.execute<{ owner: string | null }>(sql`
    select lease_owner as "owner"
    from page_sync_states
    where page_id = ${input.pageId}
      and stream = 'dm_messages'
      and leased_seq is not null
      and lease_expires_at > clock_timestamp()
      and lease_owner like ${`${TARGETED_BACKFILL_LEASE_OWNER_PREFIX}:%`}
  `);
  const owner = result.rows[0]?.owner;
  if (typeof owner !== "string") {
    return false;
  }
  const [, , ...jobParts] = owner.split(":");
  return jobParts.length === 0 || jobParts.join(":") === input.jobId;
}

/** pgboss.job, as the CLI reads it back for one targeted backfill job. */
export interface TargetedThreadBackfillJobStatus {
  state: string;
  /** The run's TargetedThreadBackfillResult once `completed`; the error once `failed`. */
  output: unknown;
  startedOn: Date | null;
  completedOn: Date | null;
}

const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

export async function readTargetedThreadBackfillJobStatus(
  db: AppContext["db"],
  jobId: string,
): Promise<TargetedThreadBackfillJobStatus | null> {
  const result = await db.execute<{
    state: string;
    output: unknown;
    startedOn: Date | null;
    completedOn: Date | null;
  }>(sql`
    select state::text as "state",
           output,
           started_on as "startedOn",
           completed_on as "completedOn"
    from pgboss.job
    where name = ${TARGETED_THREAD_BACKFILL_QUEUE}
      and id = ${jobId}::uuid
  `);
  const row = result.rows[0];
  return row
    ? { state: row.state, output: row.output ?? null, startedOn: row.startedOn, completedOn: row.completedOn }
    : null;
}

/**
 * Slack past the job's expiry for pg-boss to record it: the worker fails an
 * overrunning handler at the expiry itself, and a dead worker's job is failed
 * by the next supervise pass (every 60 s by default).
 */
const TARGETED_BACKFILL_WAIT_GRACE_SECONDS = 90;

/**
 * The CLI's `--wait` budget. A bare `--wait` follows the job to its end: up to
 * the expiry while it sits queued (the worker runs this queue one job at a
 * time across all pages), then the expiry again, plus the grace, from the
 * moment it is seen running — pg-boss counts expire_seconds from started_on,
 * not from enqueue. An explicit number of seconds is a hard cap from enqueue.
 */
export function targetedThreadBackfillWaitBudget(
  seconds: number | true,
): { timeoutMs: number; activeBudgetMs?: number } {
  if (seconds !== true) {
    return { timeoutMs: seconds * 1000 };
  }
  return {
    timeoutMs: TARGETED_BACKFILL_EXPIRE_SECONDS * 1000,
    activeBudgetMs: (TARGETED_BACKFILL_EXPIRE_SECONDS + TARGETED_BACKFILL_WAIT_GRACE_SECONDS) * 1000,
  };
}

/**
 * Poll one job until it is completed, failed or cancelled, reporting each state
 * change once. A missing row returns at once (`status: null`); running out of
 * time returns the last row seen with `timedOut`. `activeBudgetMs` pushes the
 * deadline to at least that long after the job is first seen `active`, so a
 * job that waited in the queue still gets its whole run. Read-only.
 */
export async function waitForTargetedThreadBackfillJob(input: {
  read: () => Promise<TargetedThreadBackfillJobStatus | null>;
  timeoutMs: number;
  activeBudgetMs?: number;
  pollMs: number;
  onState?: (status: TargetedThreadBackfillJobStatus) => void;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}): Promise<{ status: TargetedThreadBackfillJobStatus | null; timedOut: boolean }> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => delay(ms));
  let deadline = now() + input.timeoutMs;
  let lastState: string | null = null;
  for (;;) {
    const status = await input.read();
    if (status === null) {
      return { status: null, timedOut: false };
    }
    if (status.state !== lastState) {
      lastState = status.state;
      input.onState?.(status);
      if (status.state === "active" && input.activeBudgetMs !== undefined) {
        // Local clock, not started_on: no skew against the database's clock,
        // and the job started no later than this read.
        deadline = Math.max(deadline, now() + input.activeBudgetMs);
      }
    }
    if (TERMINAL_JOB_STATES.has(status.state)) {
      return { status, timedOut: false };
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return { status, timedOut: true };
    }
    await sleep(Math.min(input.pollMs, remainingMs));
  }
}

function isFanslyAuthError(error: unknown) {
  return error instanceof FanslyApiError && (error.status === 401 || error.status === 403);
}

/** The only other stream whose chunk writes thread summaries back (see
 * findConcurrentPageChunk). */
const THREAD_SUMMARY_WRITER_STREAMS: ReadonlySet<SyncStream> = new Set(["dm_conversations"]);

/**
 * Identity of the thread-summary writers' chunk activity on the page. Only
 * fields a RUNNING chunk moves are included — a planner cadence bump or a
 * manual request (request_seq/status/requested_at) must not read as a
 * concurrent chunk.
 */
function fingerprintThreadSummaryWriters(states: readonly PageSyncState[]) {
  const fingerprints = new Map<SyncStream, string>();
  for (const state of states) {
    if (!THREAD_SUMMARY_WRITER_STREAMS.has(state.stream)) {
      continue;
    }
    fingerprints.set(state.stream, [
      state.leasedSeq ?? "-",
      state.leaseToken ?? "-",
      state.appliedSeq,
      state.startedAt?.getTime() ?? "-",
      state.progressedAt?.getTime() ?? "-",
      state.finishedAt?.getTime() ?? "-",
      state.succeededAt?.getTime() ?? "-",
    ].join("|"));
  }
  return fingerprints;
}

/**
 * Did a dm_conversations chunk of this page run while the targeted walk was in
 * flight? That chunk snapshots `storedMessageCount` / `oldestStoredMessageId` /
 * `messageCoverageStatus` at read time (`fansly-dm-conversations.ts`) and
 * writes them back through the non head-guarded half of the thread upsert
 * (`page-dm.ts` upsertPageDmConversation), so a chunk that overlaps this run
 * would REGRESS the cursor right after this run recomputed it — and the next
 * regular deep backfill would then meet a false overlap and mark a
 * half-backfilled thread `complete`. Before this slice the fixed page
 * singleton made those two chunks mutually exclusive; a job on a separate
 * queue removes that guarantee, so detection is fail-closed here. No other
 * page stream writes thread rows (the dm_messages lane is excluded by this
 * run's own lease), so their chunks never withhold the verdict.
 */
async function findConcurrentPageChunk(
  app: Pick<AppContext, "db">,
  platformAccountId: number,
  baseline: ReadonlyMap<SyncStream, string>,
) {
  const current = fingerprintThreadSummaryWriters(
    await listPageSyncStates(app.db, { pageId: platformAccountId }),
  );
  for (const [stream, fingerprint] of current) {
    const before = baseline.get(stream);
    if (before === undefined || before !== fingerprint) {
      return stream;
    }
  }
  return null;
}

/**
 * Walk ONE named Fansly DM thread backwards inside a single bounded run.
 *
 * Refusals (no vendor traffic at all): unknown/ineligible thread, a page that
 * is not Fansly, an open breaker window, the depth cap without an explicit
 * override, a regular chunk parked on this very thread, and — only after the
 * bounded contention wait — another stream of the page mid-chunk or an
 * unavailable page-sync lease.
 *
 * Contention with the page's own chunks is transient, so on `page_busy` or
 * `lease_unavailable` the whole attempt is re-run every few seconds until
 * TARGETED_BACKFILL_CONTENTION_WAIT_MS runs out. Both refusals happen before
 * the run starts (no sync run, no vendor request, the lease handed back), and
 * each attempt re-reads the thread, so one the regular crawl walked meanwhile
 * is judged on its current summary rather than the one read before the wait.
 * A dm_messages lease that cannot free up inside the wait refuses at once,
 * like every other refusal: a paused or blocked stream, or a retry backoff
 * (`retry_at`, up to 30 min after a failure streak) that ends after the wait
 * would. A page that is not active never gets here: resolving its context
 * throws before the lease is tried.
 */
export async function runTargetedThreadBackfill(
  app: AppContext,
  input: TargetedThreadBackfillJob,
  options?: TargetedThreadBackfillRunOptions,
): Promise<TargetedThreadBackfillResult> {
  const deadline = Date.now() + (options?.contentionWaitMs ?? TARGETED_BACKFILL_CONTENTION_WAIT_MS);
  const pollMs = options?.contentionPollMs ?? TARGETED_BACKFILL_CONTENTION_POLL_MS;
  for (;;) {
    const result = await runTargetedThreadBackfillOnce(app, input, options?.jobId);
    if (result.outcome !== "page_busy" && result.outcome !== "lease_unavailable") {
      return result;
    }
    if (result.outcome === "lease_unavailable" && result.platformAccountId !== null) {
      const own = await getPageSyncState(app.db, result.platformAccountId, "dm_messages");
      if (
        !own ||
        own.status === "paused" ||
        own.blockerKind !== null ||
        (own.retryAt !== null && own.retryAt.getTime() >= deadline)
      ) {
        return result;
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return result;
    }
    await delay(Math.min(pollMs, remainingMs));
  }
}

/** What one attempt has done so far; read back when it throws. */
interface TargetedRunProgress {
  result: TargetedThreadBackfillResult | null;
  budget: SyncChunkBudget | null;
}

/**
 * One attempt, and the only place a run's failure leaves it: every throw —
 * before the lease, around the walk, after it — becomes a
 * `TargetedThreadBackfillRunError` that carries the run's spend so far.
 */
async function runTargetedThreadBackfillOnce(
  app: AppContext,
  input: TargetedThreadBackfillJob,
  jobId: string | undefined,
): Promise<TargetedThreadBackfillResult> {
  const progress: TargetedRunProgress = { result: null, budget: null };
  try {
    return await walkTargetedThread(app, input, jobId, progress);
  } catch (error) {
    if (error instanceof TargetedThreadBackfillRunError) {
      throw error;
    }
    const result = progress.result ?? emptyResult(input.threadId, "partial");
    result.requestAttempts = progress.budget?.totalRequests ?? result.requestAttempts;
    throw new TargetedThreadBackfillRunError(error, result);
  }
}

async function walkTargetedThread(
  app: AppContext,
  input: TargetedThreadBackfillJob,
  jobId: string | undefined,
  progress: TargetedRunProgress,
): Promise<TargetedThreadBackfillResult> {
  const { threadId } = input;
  const ignoreRetentionLimit = input.ignoreRetentionLimit === true;

  const conversation = await getPageDmConversationById(app.db, threadId);
  if (!conversation) {
    return emptyResult(threadId, "thread_not_found");
  }

  const platformAccountId = conversation.platformAccountId;
  const base = { platformAccountId, storedMessageCountBefore: conversation.storedMessageCount };

  if (
    !conversation.isVisible ||
    conversation.fanId === null ||
    isFanslyDmMessageSyncExcluded(conversation.metadata)
  ) {
    return emptyResult(threadId, "thread_not_eligible", base);
  }

  // Circuit breaker (0086): the regular candidate picker refuses conversations
  // inside a backoff or quarantine window. A targeted run is an owner action,
  // not an override of a poison chat — it refuses on the same signal.
  const health = await getConversationSyncHealth(app.db, threadId);
  if (isConversationSyncHealthExcluded(health)) {
    return emptyResult(threadId, "breaker_open", base);
  }
  // A lapsed window with failures still on record is a retry of a thread
  // Fansly has been refusing: its first page goes out on ONE physical
  // attempt, as the executor's failing-thread retry does, so a poison thread
  // costs one request instead of four.
  const failingThread = (health?.failureCount ?? 0) > 0;

  // Stage 17 depth cap, per run instead of per global config: the deep-backfill
  // picker offers a thread only while stored_message_count < retention_limit.
  const retentionLimit = await getPageDmMessageRetentionLimit(app.db, threadId);
  if (!ignoreRetentionLimit && conversation.storedMessageCount >= retentionLimit) {
    return emptyResult(threadId, "retention_limit_reached", { ...base, retentionLimit });
  }

  // Everything fallible resolves BEFORE the lease is taken: a throw after the
  // acquire would leave the row `running` with a heartbeat nobody stops.
  const pageContext = await resolvePageContextById(app, platformAccountId);
  if (pageContext.platform !== "fansly") {
    return emptyResult(threadId, "unsupported_platform", { ...base, retentionLimit });
  }
  const pageAccountId = resolveFanslyPlatformAccountId(pageContext.page);
  assertDmSharedRateLimitEnabled(app);

  // Same precondition the executor establishes before it leases: the page's
  // stream rows must exist (idempotent, tombstoned pages excluded).
  await ensurePageSyncStates(app.db, { pageId: platformAccountId, ...pageSyncDependencyInput(app) });

  const lease = await acquireTargetedPageSyncLease(app.db, {
    pageId: platformAccountId,
    stream: "dm_messages",
    workerId: targetedBackfillLeaseOwner(jobId),
    leaseToken: randomUUID(),
    leaseTtlMs: TARGETED_BACKFILL_LEASE_TTL_MS,
  });
  if (!lease) {
    return emptyResult(threadId, "lease_unavailable", { ...base, retentionLimit });
  }

  const releaseLease = () =>
    releaseTargetedPageSyncLease(app.db, {
      pageId: platformAccountId,
      stream: "dm_messages",
      leaseToken: lease.leaseToken,
    });

  // Everything between the acquire and the heartbeat runs under a release-on-
  // throw guard: a failure here would otherwise leave the row `running` with
  // nobody to hand the lease back.
  let run: NonNullable<Awaited<ReturnType<typeof startSyncRun>>>;
  let telemetry: SyncRunTelemetry;
  let summaryWriterBaseline: ReadonlyMap<SyncStream, string>;
  try {
    // Stage 25: a page runs ONE sync chunk at a time. The regular path gets
    // that from the fixed page singleton on `sync.page.execute`; this run lives
    // on its own queue, so it re-establishes the invariant here. Read UNDER the
    // lease and used twice: refuse when another stream is already mid-chunk
    // (the caller waits that out), and keep the thread-summary writers' part
    // of the snapshot as the baseline that finalize time compares against (a
    // dm_conversations chunk that starts AFTER this check is caught there).
    const now = Date.now();
    const pageStates = await listPageSyncStates(app.db, { pageId: platformAccountId });
    const busyStream = pageStates.find((state) =>
      state.stream !== "dm_messages" &&
      state.leasedSeq !== null &&
      state.leaseExpiresAt !== null &&
      state.leaseExpiresAt.getTime() > now
    );
    if (busyStream) {
      await releaseLease();
      return emptyResult(threadId, "page_busy", { ...base, retentionLimit });
    }
    summaryWriterBaseline = fingerprintThreadSummaryWriters(pageStates);

    // A yielded regular chunk can be parked ON THIS THREAD with its own
    // `before` cursor in the checkpoint. Restarting the walk from the thread
    // summary would re-fetch the window that chunk already holds and land on
    // the false-overlap path, so the owner-invoked one-shot refuses instead of
    // guessing. Read under the lease: the executor cannot be mid-write.
    const checkpointState = parseDmMessagesCursorState(
      (await getCheckpoint(app.db, platformAccountId, "dm_messages"))?.state,
    );
    if (checkpointState?.currentConversationId === threadId) {
      await releaseLease();
      return emptyResult(threadId, "thread_checkpoint_in_progress", { ...base, retentionLimit });
    }

    const startedRun = await startSyncRun(app.db, {
      platformAccountId,
      stream: "dm_messages",
      trigger: "manual",
      generation: lease.leasedSeq,
      leaseToken: lease.leaseToken,
    });
    if (!startedRun) {
      throw new Error(`Failed to start a sync run for targeted backfill of thread ${threadId}`);
    }
    run = startedRun;
    telemetry = new SyncRunTelemetry(app, {
      runId: run.id,
      platformAccountId,
      pageLabel: pageContext.page.label,
      provider: "fansly",
      stream: "dm_messages",
      trigger: "manual",
      egressKey: pageContext.egressKey,
    });
    await telemetry.recordRunStarted();
    await telemetry.recordPhaseStarted("dm_messages_targeted_backfill", {
      conversationId: threadId,
      ignoreRetentionLimit,
      retentionLimit,
    });
  } catch (error) {
    await releaseLease().catch(() => false);
    throw error;
  }

  let leaseFenced = false;
  const leaseHeartbeat = setInterval(() => {
    void heartbeatPageSyncLease(app.db, {
      pageId: platformAccountId,
      stream: "dm_messages",
      leaseToken: lease.leaseToken,
      leaseTtlMs: TARGETED_BACKFILL_LEASE_TTL_MS,
    }).then((owned) => {
      if (!owned) {
        leaseFenced = true;
      }
    }).catch((error) => {
      leaseFenced = true;
      app.logger.warn(
        { err: error, platformAccountId, threadId },
        "Failed to heartbeat targeted thread backfill lease",
      );
    });
  }, TARGETED_BACKFILL_HEARTBEAT_MS);

  const startedAtMs = Date.now();
  const budget = new SyncChunkBudget(
    // An owner-approved cap (slice C) may only LOWER the ceiling: a decision
    // cannot buy a longer run than one job is allowed to be.
    Math.min(TARGETED_BACKFILL_MAX_REQUESTS, input.maxRequests ?? TARGETED_BACKFILL_MAX_REQUESTS),
    TARGETED_BACKFILL_MAX_WALL_CLOCK_MS,
  );
  const requestObserver = new DmMessagesChunkRequestObserver();
  const requestContext = {
    session: pageContext.session,
    proxy: pageContext.proxy,
    egressKey: pageContext.egressKey,
    requestObserver: composeRequestObservers(
      telemetry.getRequestObserver(),
      budget,
      requestObserver,
    ),
    rateLimitWaiter: createSyncRateLimitWaiter(app, { egressKey: pageContext.egressKey }),
    sendGuard: fanslyPageSendGuard(app, pageContext.page.id, "targeted_backfill"),
  };
  // The adapter clamps its in-process retries to this allowance.
  const singleAttemptRequestContext = { ...requestContext, remainingAttempts: () => 1 };

  const result: TargetedThreadBackfillResult = emptyResult(threadId, "partial", {
    ...base,
    retentionLimit,
    syncRunId: run.id,
    messageCoverageStatus: conversation.messageCoverageStatus,
    oldestStoredMessageIdBefore: conversation.oldestStoredMessageId,
  });
  progress.result = result;
  progress.budget = budget;
  let walkFailure: unknown = null;
  /** The thread-attributable failure the breaker recorded (`vendor_error`).
   * Assigned inside the execution-context callback; the cast keeps the
   * declared type instead of a narrowing to `null` across it. */
  let vendorFailure = null as (FanslyApiError & { status: number }) | null;
  /** A page of this walk left a message unstored (no parseable createdAt). */
  let normalizationDebt = false;
  /** When this walk read the thread head; finalize never stamps it otherwise. */
  let headReadAt: Date | null = null;
  /** The walk begins at the stored oldest message (or at the head of an empty
   * thread), not at an approved boundary elsewhere in or below the window. */
  const walkStartsAtStoredOldest =
    (input.startBeforeMessageRef ?? conversation.oldestStoredMessageId) === conversation.oldestStoredMessageId;

  /** The thread summary is the ONLY writer of stored_message_count / oldest id;
   * `upsertPageDmMessages` does not touch it. So a run that wrote messages and
   * could not recompute MUST leave repairable debt: a stale oldest id makes the
   * next deep backfill ask `before=<stale>`, meet known ids, and mark a
   * half-backfilled thread `complete` (#135 A2b machinery, same shape). */
  const recordSummaryDebt = async (error: unknown) => {
    if (result.requests === 0 || result.projectionDebtRecorded) {
      return;
    }
    const causeMessage = error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : String(error);
    try {
      await recordProjectionDebt(app.db, {
        kind: PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
        platformAccountId,
        conversationId: threadId,
        errorSummary: causeMessage.slice(0, 500),
      });
      result.projectionDebtRecorded = true;
    } catch (debtError) {
      app.logger.error(
        { err: debtError, threadId, platformAccountId },
        "Targeted thread backfill could not record projection debt; thread summary is stale",
      );
    }
  };

  /**
   * The executor's per-thread breaker (0086), written by the point path too:
   * a thread Fansly keeps refusing backs off (5 min doubling, 6 h quarantine
   * from the 4th failure) instead of being walked into the same answer by
   * every approval. Not recorded while several OTHER groups of the page have
   * failed since its last successful read — that is an outage, not this
   * thread. Runs inside the execution context, so the write is fenced.
   */
  const recordThreadBreakerFailure = async (
    error: FanslyApiError & { status: number },
  ): Promise<{ recorded: boolean; leaseLost: PageSyncLeaseLostError | null }> => {
    try {
      const otherFailingGroups = await countOtherDmMessageGroupsFailingSinceLastSuccess(app.db, {
        platformAccountId,
        platformConversationId: conversation.platformConversationId,
        since: new Date(Date.now() - DM_MESSAGES_BREAKER_OUTAGE_LOOKBACK_MS),
      });
      if (otherFailingGroups >= DM_MESSAGES_BREAKER_OUTAGE_OTHER_FAILING_GROUPS) {
        await telemetry.addNote(
          "DM message failures span several conversations; treated as a page-wide outage, no breaker",
          { conversationId: threadId, httpStatus: error.status, otherFailingGroups },
        );
        return { recorded: false, leaseLost: null };
      }
      const health = await withOwnedPageSyncTransaction(app.db, async (dbTx) =>
        recordConversationSyncFailure(dbTx, {
          conversationId: threadId,
          platformAccountId,
          errorClass: `fansly_${error.status}`,
          errorMessage: error.message,
        }));
      await telemetry.addNote(
        health.quarantineUntil !== null
          ? "DM conversation quarantined after repeated targeted-backfill failures"
          : "DM conversation targeted-backfill failure recorded, backing off",
        {
          conversationId: threadId,
          httpStatus: error.status,
          failureCount: health.failureCount,
          nextRetryAt: health.nextRetryAt?.toISOString() ?? null,
          quarantineUntil: health.quarantineUntil?.toISOString() ?? null,
          otherFailingGroups,
        },
      );
      return { recorded: true, leaseLost: null };
    } catch (breakerError) {
      if (breakerError instanceof PageSyncLeaseLostError) {
        return { recorded: false, leaseLost: breakerError };
      }
      app.logger.warn(
        { err: breakerError, threadId, platformAccountId },
        "Targeted thread backfill could not record the thread's breaker failure",
      );
      return { recorded: false, leaseLost: null };
    }
  };

  try {
    await runWithPageSyncExecutionContext({
      pageId: platformAccountId,
      stream: "dm_messages",
      requestSeq: lease.leasedSeq,
      leaseToken: lease.leaseToken,
    }, async () => {
      try {
        // The approved boundary when there is one (slice C), otherwise the
        // deepest message we already hold — the walk goes backwards from here.
        let before = input.startBeforeMessageRef ?? conversation.oldestStoredMessageId;
        // Only a walk of an empty thread starts at (and reads) the head.
        headReadAt = before === null ? new Date() : null;
        let pageRequestContext = failingThread ? singleAttemptRequestContext : requestContext;

        while (budget.hasRequestCapacity() && budget.hasWallClockCapacity()) {
          if (leaseFenced) {
            result.outcome = "lease_lost";
            break;
          }

          await assertOwnedPageSyncLease(app.db);
          requestObserver.recordConversationTouched(threadId);

          const messagePage = await fetchAndJournalFanslyDmMessagePage(app, {
            requestContext: pageRequestContext,
            telemetry,
            syncRunId: run.id,
            platformAccountId,
            platform: "fansly",
            pageAccountId,
            conversation,
            before,
            limit: FANSLY_DM_MESSAGE_PAGE_LIMIT,
          });

          await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
            await upsertPageDmMessages(dbTx, messagePage.normalizedMessages);
            // The group answered: end its per-thread breaker streak (the run
            // refuses an open window, so only a lapsed one gets here). A
            // thread whose history this run completes may never be walked by
            // the regular crawl again to clear the row.
            await clearConversationSyncHealth(dbTx, threadId);
          });

          // The thread answered, and its breaker row is gone: the rest of
          // the walk is ordinary work.
          pageRequestContext = requestContext;

          result.requests += 1;
          result.insertedMessages += messagePage.insertedMessageCount;
          result.journaledMessages += messagePage.normalizedMessages.length;
          result.overlapFound = result.overlapFound || messagePage.overlapFound;
          result.providerHistoryExhausted = messagePage.providerHistoryExhausted;
          result.emptyPageReached = messagePage.page.items.length === 0;
          normalizationDebt = normalizationDebt || messagePage.normalizationDebt;

          // The end of the history, PROVEN only by an empty page reached from
          // the stored oldest message (decision №3). Below an approved
          // boundary that is not the stored oldest, the same empty page leaves
          // the window above the boundary unread: `partial`.
          if (result.emptyPageReached) {
            result.outcome = walkStartsAtStoredOldest ? "completed" : "partial";
            break;
          }
          // Stored ground met: no proof of anything (plan §6.2) — a stale
          // summary or an interior boundary. Stop; the finalize below
          // recomputes the summary, so a re-run starts from the real oldest.
          if (messagePage.overlapFound) {
            result.outcome = "partial";
            break;
          }
          // A SHORT page is not the end: Fansly cuts 25 rows and can filter
          // some out (16.09). The walk reads on from its oldest message; an
          // empty answer to that read is the proof.

          // Stage 17: only the explicit per-run override may lift the depth
          // predicate. Checking it ONCE before the walk would let a default run
          // that started one message under the cap retain a full extra window.
          if (
            !ignoreRetentionLimit &&
            result.storedMessageCountBefore + result.insertedMessages >= retentionLimit
          ) {
            result.outcome = "retention_limit_reached";
            break;
          }

          // Slice C: the owner-approved item ceiling. Checked here rather than
          // trusted to the request budget, because one request accepts up to 25
          // messages and an explicit item cap could otherwise be blown past
          // several times over inside the approved call count.
          if (input.maxItems !== undefined && result.insertedMessages >= input.maxItems) {
            result.outcome = "partial";
            break;
          }

          before = messagePage.oldestMessageId;
        }
      } catch (error) {
        walkFailure = error;
        result.outcome = error instanceof PageSyncLeaseLostError ? "lease_lost" : "partial";
        if (isThreadAttributableFanslyFailure(error)) {
          // The 500 breaker of the point path: the executor's per-thread rule.
          // Recorded, the failure is this thread's verdict and the run ENDS
          // with it (`vendor_error`) instead of throwing; not recorded (a
          // page-wide outage, or the write failed), it stays a run failure.
          const breaker = await recordThreadBreakerFailure(error);
          if (breaker.recorded) {
            walkFailure = null;
            vendorFailure = error;
            result.outcome = "vendor_error";
          } else if (breaker.leaseLost) {
            walkFailure = breaker.leaseLost;
            result.outcome = "lease_lost";
          }
        }
        if (isFanslyAuthError(error)) {
          // A dead session is dead for the WHOLE page, exactly as in the
          // executor: park every stream so nothing else burns quota against
          // it, and open the incident so the owner learns tonight, not at the
          // next manual check. (Closed the former log-only gap; the hydration
          // autopilot additionally refuses pages whose dm stream is auth-parked.)
          const failedAt = new Date();
          try {
            await pausePageSyncForAuth(app.db, {
              pageId: platformAccountId,
              streams: getSyncStreamsForPlatform("fansly"),
              blockerCode: "credentials_invalid",
              blockerMessage: String((error as Error).message ?? "fansly auth failure").slice(0, 500),
              now: failedAt,
            });
          } catch (pauseError) {
            app.logger.warn(
              { platformAccountId, err: pauseError },
              "Targeted backfill could not pause the auth-dead page; streams stay unparked",
            );
          }
          try {
            await notifyAuthFailedIncident(app, {
              platformAccountId,
              pageLabel: pageContext.page.label,
              platform: "fansly",
              errorCode: error instanceof FanslyApiError ? String(error.status) : "auth",
              errorSummary: String((error as Error).message ?? "fansly auth failure").slice(0, 200),
              occurredAt: failedAt,
            });
          } catch (notifyError) {
            app.logger.warn(
              { platformAccountId, err: notifyError },
              "Targeted backfill auth incident notification failed",
            );
          }
          app.logger.error(
            { err: error, threadId, platformAccountId, pageLabel: pageContext.page.label },
            "Targeted thread backfill aborted on a Fansly auth failure; page streams paused",
          );
        }
      }

      // Finalization runs INSIDE the execution context — outside it every
      // assertOwnedPageSyncLease early-returns and the coverage verdict, the
      // summary recompute and the prune would all run unfenced.
      //
      // An aborted walk does NOT finalize (a failed chunk never writes a
      // coverage verdict, and a lost lease may not write at all) — it leaves
      // repairable debt so the 5-minute sweep recomputes the summary.
      if (walkFailure || vendorFailure || result.outcome === "lease_lost") {
        await recordSummaryDebt(walkFailure ?? vendorFailure ?? new PageSyncLeaseLostError());
        return;
      }

      // Fail closed on a dm_conversations chunk that ran during this walk:
      // writing the verdict now would be overwritten by that chunk's stale
      // thread snapshot, and the regression re-arms the false-complete path.
      // The sweeper recomputes the summary once the page is quiet again.
      const concurrentStream = await findConcurrentPageChunk(
        app,
        platformAccountId,
        summaryWriterBaseline,
      );
      if (concurrentStream) {
        result.outcome = "concurrent_page_chunk";
        await recordSummaryDebt(
          new Error(
            `A ${concurrentStream} chunk ran on page ${platformAccountId} during the targeted backfill; thread summary left to the projection-debt sweep`,
          ),
        );
        app.logger.warn(
          { threadId, platformAccountId, concurrentStream },
          "Targeted thread backfill skipped finalization: a thread-summary writer chunked this page mid-run",
        );
        return;
      }

      // The coverage verdict. Only an EMPTY page reached by a walk that
      // started at the stored oldest message (or at the head of an empty
      // thread) proves the whole history stored: `complete`, unless the walk
      // left a message unstored. A short page proves nothing (decision №3).
      // Overlap proves nothing here — from the stored oldest id a correct
      // summary never overlaps, so it means an interior boundary or a stale
      // summary — and exhaustion below any other boundary would certify the
      // unread gap above it. Both keep the current status (the incremental
      // rule, which still honours normalization debt) instead of claiming or
      // downgrading coverage. An interrupted walk stays `partial_window` so
      // the regular crawl keeps offering the thread.
      const provesHistoryStored = result.emptyPageReached && walkStartsAtStoredOldest;
      const endedWithoutVerdict = !provesHistoryStored &&
        (result.overlapFound || result.providerHistoryExhausted);
      const messageCoverageStatus = resolveDmConversationCoverageStatus({
        currentMode: endedWithoutVerdict ? "incremental" : "deep_backfill",
        existingStatus: conversation.messageCoverageStatus,
        overlapFound: false,
        providerHistoryExhausted: provesHistoryStored,
        hitWindowCap: false,
        normalizationDebt,
      });
      // A run told to ignore the depth cap must not have its freshly captured
      // window pruned back by the global cache policy in the same breath.
      const enforceRetention = ignoreRetentionLimit ? false : await isPageDmPruneAllowed(app);
      try {
        const finalized = await withOwnedPageSyncTransaction(app.db, async (dbTx) =>
          finalizePageDmConversationMessageSync(dbTx, {
            conversationId: threadId,
            messageCoverageStatus,
            headReadAt,
            enforceRetention,
          }));
        result.messageCoverageStatus = finalized.conversation?.messageCoverageStatus
          ?? messageCoverageStatus;
      } catch (error) {
        if (error instanceof PageSyncLeaseLostError) {
          result.outcome = "lease_lost";
        }
        await recordSummaryDebt(error);
        if (!(error instanceof PageSyncLeaseLostError)) {
          app.logger.warn(
            { err: error, threadId, platformAccountId },
            "Targeted thread backfill finalize failed; recorded projection debt",
          );
        }
      }
    });
  } finally {
    // Stopped only after finalization, mirroring the executor's heartbeat
    // lifetime (executor.ts:491-502): a lease that expires mid-finalize would
    // hand the row to the reclaimer while this run is still writing.
    clearInterval(leaseHeartbeat);
  }
  // The budget sees every attempt's `started` event, retries included: the
  // same count the run's request ceiling was enforced against.
  result.requestAttempts = budget.totalRequests;

  await telemetry.recordDmMessagesChunkSummary(
    requestObserver.buildSummary(Date.now() - startedAtMs),
  );

  if (walkFailure && !(walkFailure instanceof PageSyncLeaseLostError)) {
    await telemetry.finish(
      "failed",
      walkFailure instanceof Error ? walkFailure.message : String(walkFailure),
      { conversationId: threadId, ...targetedStats(result) },
    );
    await releaseLease();
    throw walkFailure;
  }

  await telemetry.finish(
    result.outcome === "completed"
      ? "success"
      : result.outcome === "vendor_error"
        ? "failed"
        : result.outcome === "partial" ||
            result.outcome === "retention_limit_reached" ||
            result.outcome === "concurrent_page_chunk"
          ? "partial"
          : "skipped",
    result.outcome === "lease_lost"
      ? "Page sync lease lost"
      : vendorFailure?.message ?? null,
    { conversationId: threadId, ...targetedStats(result) },
  );

  if (result.outcome !== "lease_lost") {
    await releaseLease();
  }

  app.logger.info({ ...targetedStats(result), threadId, platformAccountId },
    "Targeted thread backfill finished");
  return result;
}

function targetedStats(result: TargetedThreadBackfillResult) {
  return {
    outcome: result.outcome,
    requests: result.requests,
    requestAttempts: result.requestAttempts,
    insertedMessages: result.insertedMessages,
    journaledMessages: result.journaledMessages,
    overlapFound: result.overlapFound,
    providerHistoryExhausted: result.providerHistoryExhausted,
    emptyPageReached: result.emptyPageReached,
    messageCoverageStatus: result.messageCoverageStatus,
    projectionDebtRecorded: result.projectionDebtRecorded,
  };
}
