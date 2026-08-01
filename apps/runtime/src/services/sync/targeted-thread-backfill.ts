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
// (`acquireTargetedPageSyncLease`) and runs inside the page-sync execution
// context, so every `assertOwnedPageSyncLease` / `withOwnedPageSyncTransaction`
// inside the shared code actually fences. No lease => the run refuses; it never
// runs lease-less next to the regular executor.
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
  getConversationSyncHealth,
  getPageDmConversationById,
  getPageDmMessageRetentionLimit,
  heartbeatPageSyncLease,
  isConversationSyncHealthExcluded,
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
import { isFanslyDmMessageSyncExcluded } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../../bootstrap.ts";
import { isPageDmPruneAllowed } from "../page-dm-retention.ts";
import { resolvePageContextById } from "../page-context.ts";
import { resolveFanslyPlatformAccountId } from "../fansly.ts";
import { SyncChunkBudget, composeRequestObservers } from "./chunk-budget.ts";
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
    // `exclusive` + singletonKey = at most ONE job per thread queued or
    // active; a second enqueue for the same thread is rejected (send → null)
    // instead of stacking a duplicate vendor walk.
    policy: "exclusive",
    expireInSeconds: TARGETED_BACKFILL_EXPIRE_SECONDS,
    heartbeatSeconds: 30,
    retryLimit: TARGETED_BACKFILL_RETRY_LIMIT,
  }, createdQueues);
}

/** Enqueue one targeted backfill. Returns null when the thread already has a
 * job queued or active (queue policy `exclusive` per singletonKey). */
export async function sendTargetedThreadBackfillJob(
  boss: Pick<PgBoss, "send">,
  input: TargetedThreadBackfillJob,
): Promise<string | null> {
  return boss.send(
    TARGETED_THREAD_BACKFILL_QUEUE,
    {
      threadId: input.threadId,
      ignoreRetentionLimit: input.ignoreRetentionLimit === true,
    } satisfies TargetedThreadBackfillJob,
    {
      singletonKey: String(input.threadId),
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

/**
 * Walk ONE named Fansly DM thread backwards inside a single bounded run.
 *
 * Refusals (no vendor traffic at all): unknown/ineligible thread, a page that
 * is not Fansly, an open breaker window, the depth cap without an explicit
 * override, and — last — an unavailable page-sync lease.
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

  const pageContext = await resolvePageContextById(app, platformAccountId);
  if (pageContext.platform !== "fansly") {
    return emptyResult(threadId, "unsupported_platform", { ...base, retentionLimit });
  }

  assertDmSharedRateLimitEnabled(app);

  // Same precondition the executor establishes before it leases: the page's
  // stream rows must exist (idempotent, tombstoned pages excluded).
  await ensurePageSyncStates(app.db, { pageId: platformAccountId, ...pageSyncDependencyInput(app) });

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

  const run = await startSyncRun(app.db, {
    platformAccountId,
    stream: "dm_messages",
    trigger: "manual",
    generation: lease.leasedSeq,
    leaseToken: lease.leaseToken,
  });
  if (!run) {
    await releaseTargetedPageSyncLease(app.db, {
      pageId: platformAccountId,
      stream: "dm_messages",
      leaseToken: lease.leaseToken,
    });
    throw new Error(`Failed to start a sync run for targeted backfill of thread ${threadId}`);
  }
  const telemetry = new SyncRunTelemetry(app, {
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
  const pageAccountId = resolveFanslyPlatformAccountId(pageContext.page);

  const result: TargetedThreadBackfillResult = emptyResult(threadId, "partial", {
    ...base,
    retentionLimit,
    syncRunId: run.id,
    messageCoverageStatus: conversation.messageCoverageStatus,
    oldestStoredMessageIdBefore: conversation.oldestStoredMessageId,
  });

  try {
    await runWithPageSyncExecutionContext({
      pageId: platformAccountId,
      stream: "dm_messages",
      requestSeq: lease.leasedSeq,
      leaseToken: lease.leaseToken,
    }, async () => {
      let before = conversation.oldestStoredMessageId;

      while (budget.hasRequestCapacity() && budget.hasWallClockCapacity()) {
        if (leaseFenced) {
          result.outcome = "lease_lost";
          return;
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
          return;
        }

        before = messagePage.oldestMessageId;
      }
    });
  } catch (error) {
    clearInterval(leaseHeartbeat);
    await telemetry.finish(
      "failed",
      error instanceof Error ? error.message : String(error),
      { conversationId: threadId, ...targetedStats(result) },
    );
    if (!(error instanceof PageSyncLeaseLostError)) {
      await releaseTargetedPageSyncLease(app.db, {
        pageId: platformAccountId,
        stream: "dm_messages",
        leaseToken: lease.leaseToken,
      }).catch(() => false);
    }
    throw error;
  }

  clearInterval(leaseHeartbeat);

  if (result.outcome !== "lease_lost") {
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
    try {
      const enforceRetention = await isPageDmPruneAllowed(app);
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
      } else {
        // #135 A2b: the message rows are already committed and journaled; a
        // failed summary recompute becomes repairable debt, never a lost run.
        const causeMessage = error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : error instanceof Error
            ? error.message
            : String(error);
        await recordProjectionDebt(app.db, {
          kind: PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
          platformAccountId,
          conversationId: threadId,
          errorSummary: causeMessage.slice(0, 500),
        });
        result.projectionDebtRecorded = true;
        app.logger.warn(
          { err: error, threadId, platformAccountId },
          "Targeted thread backfill finalize failed; recorded projection debt",
        );
      }
    }
  }

  await telemetry.recordDmMessagesChunkSummary(
    requestObserver.buildSummary(Date.now() - startedAtMs),
  );
  await telemetry.finish(
    result.outcome === "completed" ? "success" : result.outcome === "partial" ? "partial" : "skipped",
    result.outcome === "lease_lost" ? "Page sync lease lost" : null,
    { conversationId: threadId, ...targetedStats(result) },
  );

  if (result.outcome !== "lease_lost") {
    await releaseTargetedPageSyncLease(app.db, {
      pageId: platformAccountId,
      stream: "dm_messages",
      leaseToken: lease.leaseToken,
    });
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
  };
}
