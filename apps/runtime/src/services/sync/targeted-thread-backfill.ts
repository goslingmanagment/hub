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

import { randomUUID } from "node:crypto";

import {
  acquireTargetedPageSyncLease,
  assertOwnedPageSyncLease,
  ensurePageSyncStates,
  finalizePageDmConversationMessageSync,
  getCheckpoint,
  getConversationSyncHealth,
  getPageDmConversationById,
  getPageDmMessageRetentionLimit,
  heartbeatPageSyncLease,
  isConversationSyncHealthExcluded,
  listPageSyncStates,
  PageSyncLeaseLostError,
  PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
  recordProjectionDebt,
  releaseTargetedPageSyncLease,
  runWithPageSyncExecutionContext,
  startSyncRun,
  upsertPageDmMessages,
  withOwnedPageSyncTransaction,
  type MessageCoverageStatus,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { isFanslyDmMessageSyncExcluded } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../../bootstrap.ts";
import { isPageDmPruneAllowed } from "../page-dm-retention.ts";
import { resolvePageContextById } from "../page-context.ts";
import { resolveFanslyPlatformAccountId } from "../fansly.ts";
import { SyncChunkBudget, composeRequestObservers } from "./chunk-budget.ts";
import { parseDmMessagesCursorState } from "./cursor-state.ts";
import { pageSyncDependencyInput } from "./dependencies.ts";
import {
  assertDmSharedRateLimitEnabled,
  DmMessagesChunkRequestObserver,
  FANSLY_DM_MESSAGE_PAGE_LIMIT,
  fetchAndJournalFanslyDmMessagePage,
  resolveDmConversationCoverageStatus,
} from "./fansly-dm-messages.ts";
import { SyncRunTelemetry } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./../sync-queue.ts";

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
const TARGETED_BACKFILL_EXPIRE_SECONDS = 20 * 60;

export interface TargetedThreadBackfillJob {
  threadId: number;
  ignoreRetentionLimit?: boolean;
}

export interface TargetedThreadBackfillSendInput extends TargetedThreadBackfillJob {
  /** Page that owns the thread — the queue's singleton key (see below). */
  platformAccountId: number;
}

export type TargetedThreadBackfillOutcome =
  /** The provider ran out of history (or the walk met already-stored ground). */
  | "completed"
  /** The run's bound was reached with history still left; re-run to continue. */
  | "partial"
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
  requests: number;
  insertedMessages: number;
  journaledMessages: number;
  overlapFound: boolean;
  providerHistoryExhausted: boolean;
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
    } satisfies TargetedThreadBackfillJob,
    {
      singletonKey: String(input.platformAccountId),
      expireInSeconds: TARGETED_BACKFILL_EXPIRE_SECONDS,
      retryLimit: TARGETED_BACKFILL_RETRY_LIMIT,
    },
  );
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
  return {
    threadId,
    ignoreRetentionLimit: record.ignoreRetentionLimit === true,
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
    insertedMessages: 0,
    journaledMessages: 0,
    overlapFound: false,
    providerHistoryExhausted: false,
    storedMessageCountBefore: 0,
    oldestStoredMessageIdBefore: null,
    messageCoverageStatus: null,
    retentionLimit: null,
    projectionDebtRecorded: false,
    ...overrides,
  };
}

function isFanslyAuthError(error: unknown) {
  return error instanceof FanslyApiError && (error.status === 401 || error.status === 403);
}

/**
 * Walk ONE named Fansly DM thread backwards inside a single bounded run.
 *
 * Refusals (no vendor traffic at all): unknown/ineligible thread, a page that
 * is not Fansly, an open breaker window, the depth cap without an explicit
 * override, another stream of the page mid-chunk, a regular chunk parked on
 * this very thread, and an unavailable page-sync lease.
 */
export async function runTargetedThreadBackfill(
  app: AppContext,
  input: TargetedThreadBackfillJob,
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

  // Stage 25: a page runs ONE sync chunk at a time. The regular path gets that
  // from the fixed page singleton on `sync.page.execute`; this run lives on its
  // own queue, so it re-establishes the invariant here — any OTHER stream of
  // the page holding a live lease means a chunk is in flight (dm_conversations
  // full-upserts the thread summary), and racing it would regress this thread's
  // cursor after the closing recompute.
  const now = Date.now();
  const pageStates = await listPageSyncStates(app.db, { pageId: platformAccountId });
  const busyStream = pageStates.find((state) =>
    state.stream !== "dm_messages" &&
    state.leasedSeq !== null &&
    state.leaseExpiresAt !== null &&
    state.leaseExpiresAt.getTime() > now
  );
  if (busyStream) {
    return emptyResult(threadId, "page_busy", { ...base, retentionLimit });
  }

  const lease = await acquireTargetedPageSyncLease(app.db, {
    pageId: platformAccountId,
    stream: "dm_messages",
    workerId: `targeted-thread-backfill:${process.pid}`,
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
  try {
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
    TARGETED_BACKFILL_MAX_REQUESTS,
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
  };

  const result: TargetedThreadBackfillResult = emptyResult(threadId, "partial", {
    ...base,
    retentionLimit,
    syncRunId: run.id,
    messageCoverageStatus: conversation.messageCoverageStatus,
    oldestStoredMessageIdBefore: conversation.oldestStoredMessageId,
  });
  let walkFailure: unknown = null;

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

  try {
    await runWithPageSyncExecutionContext({
      pageId: platformAccountId,
      stream: "dm_messages",
      requestSeq: lease.leasedSeq,
      leaseToken: lease.leaseToken,
    }, async () => {
      try {
        let before = conversation.oldestStoredMessageId;

        while (budget.hasRequestCapacity() && budget.hasWallClockCapacity()) {
          if (leaseFenced) {
            result.outcome = "lease_lost";
            break;
          }

          await assertOwnedPageSyncLease(app.db);
          requestObserver.recordConversationTouched(threadId);

          const messagePage = await fetchAndJournalFanslyDmMessagePage(app, {
            requestContext,
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
          });

          result.requests += 1;
          result.insertedMessages += messagePage.insertedMessageCount;
          result.journaledMessages += messagePage.normalizedMessages.length;
          result.overlapFound = result.overlapFound || messagePage.overlapFound;
          result.providerHistoryExhausted = messagePage.providerHistoryExhausted;

          if (messagePage.providerHistoryExhausted || messagePage.overlapFound) {
            result.outcome = "completed";
            break;
          }

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

          before = messagePage.oldestMessageId;
        }
      } catch (error) {
        walkFailure = error;
        result.outcome = error instanceof PageSyncLeaseLostError ? "lease_lost" : "partial";
        if (isFanslyAuthError(error)) {
          // Fail closed (BL-C1): unlike the executor this run does not park the
          // page's streams or open the auth incident — it just stops, loudly.
          app.logger.error(
            { err: error, threadId, platformAccountId, pageLabel: pageContext.page.label },
            "Targeted thread backfill aborted on a Fansly auth failure; page streams NOT paused (BL-C1)",
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
      if (walkFailure || result.outcome === "lease_lost") {
        await recordSummaryDebt(walkFailure ?? new PageSyncLeaseLostError());
        return;
      }

      // The coverage verdict uses the deep-backfill rule: a walk that ended on
      // exhaustion or known ground is `complete`, an interrupted one stays
      // `partial_window` so the regular crawl keeps offering the thread.
      const messageCoverageStatus = resolveDmConversationCoverageStatus({
        currentMode: "deep_backfill",
        existingStatus: conversation.messageCoverageStatus,
        overlapFound: result.overlapFound,
        providerHistoryExhausted: result.providerHistoryExhausted,
        hitWindowCap: false,
      });
      // A run told to ignore the depth cap must not have its freshly captured
      // window pruned back by the global cache policy in the same breath.
      const enforceRetention = ignoreRetentionLimit ? false : await isPageDmPruneAllowed(app);
      try {
        const finalized = await withOwnedPageSyncTransaction(app.db, async (dbTx) =>
          finalizePageDmConversationMessageSync(dbTx, {
            conversationId: threadId,
            messageCoverageStatus,
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
      : result.outcome === "partial" || result.outcome === "retention_limit_reached"
        ? "partial"
        : "skipped",
    result.outcome === "lease_lost" ? "Page sync lease lost" : null,
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
    insertedMessages: result.insertedMessages,
    journaledMessages: result.journaledMessages,
    overlapFound: result.overlapFound,
    providerHistoryExhausted: result.providerHistoryExhausted,
    messageCoverageStatus: result.messageCoverageStatus,
    projectionDebtRecorded: result.projectionDebtRecorded,
  };
}
