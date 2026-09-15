// Full offset sweeps own membership generations and finalization. The A1
// bounded mode shares capture/head repair writers but cannot certify a full
// list, stamp membership generations, or advance full-list success. With A1
// disabled, full cursors retain their legacy persisted shape.

import {
  fanslyDmReaderHeadKey,
  computeCurrentPageSyncSlot,
  assertOwnedPageSyncLease,
  countPageDmThreadsByGeneration,
  countPageDmVisibleThreadsBelowGeneration,
  findErasureLogTouchingPageSince,
  getCheckpoint,
  observeFanslyDmHead,
  nextFanslyDmHeadRetryAt,
  listPageDmConversationsByPlatformConversationIds,
  listPageDmThreadIdsStampedWithGeneration,
  markPageDmConversationsInvisibleByGeneration,
  maxPageDmThreadGeneration,
  requestPageSync,
  tryAcquireDmArchiveWriterFenceLock,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertPageDmConversation,
  withOwnedPageSyncTransaction,
  type Database,
  type DmSenderRole,
  type MessageCoverageStatus,
  type PageSyncLease,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION, type FanslyAccount } from "@agency_hub_core/fansly";
import {
  buildFanslyDmConversationMetadata,
  getFanslyDmMessageSyncExcludedReason,
  normalizeDmMessageText,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
  type FanslyDmMessageSyncExcludedReason,
} from "@agency_hub_core/shared";

import {
  advanceDmBoundedStop, dmFullSweepDue, parseDmBoundedSweepState,
  resolveDmBoundedPolicy, serializeDmBoundedSweepState, type DmBoundedSweepState,
} from "./dm-bounded-state.ts";

import { loadEffectiveConfig } from "../effective-config.ts";
import { isPageAllowlisted } from "./fansly-stream-gate.ts";
import type { AppContext } from "../../bootstrap.ts";
import { resolveFanslyPlatformAccountId } from "../fansly.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import {
  isDmSweepErasureShapedCountShortfall,
  DM_SWEEP_DUAL_PROOF_ERASURE_NOTE_CODE,
  DM_SWEEP_DUAL_PROOF_PAGE_NOTE_CODE,
} from "./dm-sweep-dual-proof.ts";
import {
  asNullableString,
  asNumber,
  asRecord,
  isUnresumableLegacyDmConversationCursorState,
  parseDmConversationSweepState,
  serializeDmConversationSweepState,
  type DmConversationSweepCompletedState,
  type DmConversationSweepInProgressState,
  type DmConversationSweepState,
} from "./cursor-state.ts";
import { pageSyncDependencyInput } from "./dependencies.ts";
import { createPageRateLimitWaiter } from "./rate-limiter.ts";
import {
  dmRetentionDate,
  FANSLY_GROUPS_CAPTURE_MAPPER_VERSION,
  persistRawPayload,
  trimFanslyMessagingGroupsPayload,
  normalizeFanslyTimestamp,
} from "./shared.ts";
import { advanceDmShadow, type DmShadowConversation } from "./dm-shadow.ts";
import { createDmShadowState } from "./dm-shadow-state.ts";
import { readDmShadowMaterial } from "./dm-shadow-material.ts";
import { persistDmShadowReport } from "./dm-shadow-report.ts";
import {
  assertDmSharedRateLimitEnabled,
  normalizeDmTimestampWithAnomaly,
  resolveDmSenderRole,
} from "./fansly-dm-messages.ts";
import { materializeFanslyDmTipContextsBestEffort } from "./fansly-tip-contexts.ts";
import { upsertHydratedFansForPage } from "./fan-hydration.ts";
import { probeFanslyAccountResolution } from "./fansly-account-probe.ts";
import {
  breaksLegacyUnchangedPage,
  diffConversationHead,
} from "./fansly-dm-head-diff.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-types.ts";

type DmRunningSweep = DmConversationSweepInProgressState | DmBoundedSweepState;

/** G3: the Fansly dm_conversations sweep's own membership verdict — the row-
 *  side generation set did not reproduce the count the sweep observed, and no
 *  erasure explains the gap, so the destructive finalization was withheld. */
const DM_SWEEP_GENERATION_MEMBERSHIP_ANOMALY_CODE = "dm_conversations_generation_membership_guard";
/**
 * The empty-sweep guard, mirroring the OFAPI audience sweep's
 * `subscribers_empty_sweep_guard` (cursor-state.ts, ofapi-audience-sync.ts):
 * a walk that observed ZERO conversations certifies nothing while the page
 * still has visible threads.
 *
 * Without it the membership check reads `0 === 0` and certifies — one empty or
 * truncated provider answer (`data: []`, `total: 0`) then hides EVERY visible
 * thread on the page until the next sweep re-lists it, which is exactly the
 * disappearing-inbox failure decision #208 refuses to risk. Zero observations
 * are no evidence at all, so this treats them as an uncertified membership:
 * nothing is hidden, the run is not the stream's last successful one, and
 * `lastFullSweepCompletedAt` does not move.
 *
 * ESCAPE HATCH: none, deliberately — the audience sweep has none either. The
 * hold lifts on its own the moment one sweep observes a conversation again;
 * a page whose inbox genuinely emptied to zero keeps its old threads VISIBLE
 * (and this anomaly on every sweep) until a human retires them. That is the
 * same price the subscribers guard pays, and it is the cheap side of the
 * trade: a stale visible thread is recoverable, a blanked inbox is not.
 */
const DM_SWEEP_EMPTY_SWEEP_GUARD_ANOMALY_CODE = "dm_conversations_empty_sweep_guard";
const DM_CONVERSATIONS_ERASURE_FENCE_DEFERRED_NOTE_CODE = "dm_conversations_erasure_fence_deferred";
/** An erasure's delete transaction is seconds-to-minutes work, not an hour's:
 *  park the stream long enough to let it finish, short enough that a page's
 *  DM freshness barely notices. */
const DM_CONVERSATIONS_ERASURE_FENCE_RETRY_DELAY_MS = 60_000;
/** A withheld finalization re-sweeps the whole page from offset 0, so the
 *  retry must not be immediate: an uncertified membership tends to repeat, and
 *  an unthrottled loop would spend the page's whole DM request budget proving
 *  the same thing against the provider over and over. */
const DM_CONVERSATIONS_MEMBERSHIP_RETRY_DELAY_MS = 15 * 60_000;

function hasUnresolvedIdentityMetadata(metadata: Record<string, unknown> | null | undefined) {
  return metadata?.unresolvedIdentity === true;
}

function truncateDmPreview(content: string | null | undefined, maxLength = 280) {
  const normalized = normalizeDmMessageText(content);
  if (!normalized) {
    return null;
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * THE checkpoint writer for this stream — the four inline upserts the sweep
 * used to carry (fresh init, contract-drift restart, completion, mid-sweep
 * progress) now differ only in their arguments.
 *
 * It changes nothing about progress-vs-success semantics: `progress` is still
 * `upsertCheckpointProgress` (no successful-run stamp, no freshness), `success`
 * is still `upsertCheckpoint` with the run id. `db` is the transaction handle
 * for the two writes that happen inside the page transaction and the plain
 * connection for the two that do not — same as before.
 */
async function writeSweepCheckpoint(
  db: Database,
  input:
    & { platformAccountId: number; state: DmConversationSweepState | DmBoundedSweepState }
    & (
      | {
        outcome: "progress";
        /** Telemetry rider on the mid-sweep write only; see
         *  serializeDmConversationSweepState. */
        generationSetCount?: number;
      }
      | { outcome: "success"; lastSuccessfulRunId: number }
    ),
) {
  const state = input.state.kind === "bounded" ? serializeDmBoundedSweepState(input.state)
    : input.outcome === "progress" && input.generationSetCount !== undefined
    ? serializeDmConversationSweepState(input.state, {
      generationSetCount: input.generationSetCount,
    })
    : serializeDmConversationSweepState(input.state);

  if (input.outcome === "success") {
    return upsertCheckpoint(db, {
      platformAccountId: input.platformAccountId,
      stream: "dm_conversations",
      state,
      lastSuccessfulRunId: input.lastSuccessfulRunId,
    });
  }

  return upsertCheckpointProgress(db, {
    platformAccountId: input.platformAccountId,
    stream: "dm_conversations",
    state,
  });
}

/** Does this conversation's freshly written head justify waking the sibling
 *  dm_messages stream? */
export function shouldRequestDmMessagesFollowup(conversation: {
  fanId: number | null;
  isVisible: boolean;
  lastMessageId: string | null;
  newestStoredMessageId: string | null;
  lastMessageAt: Date | null;
  lastMessageSyncAt: Date | null;
  messageCoverageStatus: MessageCoverageStatus;
  metadata: Record<string, unknown>;
}, headDebtDue?: boolean) {
  if (
    !conversation.isVisible ||
    conversation.fanId === null ||
    getFanslyDmMessageSyncExcludedReason(conversation.metadata) !== null
  ) {
    return false;
  }

  if (headDebtDue !== undefined) return headDebtDue;

  if (conversation.messageCoverageStatus === "pending_backfill") {
    return true;
  }

  if (conversation.lastMessageId === conversation.newestStoredMessageId) {
    return false;
  }

  return conversation.lastMessageSyncAt === null ||
    (conversation.lastMessageAt !== null && conversation.lastMessageSyncAt < conversation.lastMessageAt);
}

export async function fanslyDmConversationsChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("DM conversation sync is only supported for Fansly pages");
  }

  assertDmSharedRateLimitEnabled(app);
  await input.telemetry.recordPhaseStarted("dm_conversations");
  const effective = await loadEffectiveConfig(app.db, app.config);
  const headCatchupEnabled = isPageAllowlisted(
    effective.fanslyDmHeadCatchupPageAllowlist, input.pageContext.page.label,
  );
  const shadowEnabled = isPageAllowlisted(
    effective.fanslyDmShadowPageAllowlist, input.pageContext.page.label,
  );

  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "dm_conversations");
  await input.telemetry.recordCheckpointLoaded("dm_conversations", summarizeCheckpoint(checkpoint));

  const pageAccountId = resolveFanslyPlatformAccountId(input.pageContext.page);
  const checkpointStateRecord = asRecord(checkpoint?.state);
  // G3: the parser migrates a stored v1 state (with its cumulative id array) to
  // the v2 scalar shape on load — `observedCount` comes across as the array's
  // length, and the array is never written again.
  //
  // ROLLBACK (verified against main @ 61f7c1dd, the binary production would
  // roll back to): that parser rejects anything whose `version` is not exactly
  // 1, so a v2 state parses as null there and the pre-G3 handler falls into
  // this same fresh-sweep branch — it reads `generation` straight off the
  // stored record, takes max(that, the row-side high-water) + 1, and re-walks
  // from offset 0. A rolled-back sweep therefore loses its PROGRESS and never
  // its correctness: the new generation is above every stamp on the page, so
  // its finalization cannot hide a thread the interrupted sweep had seen.
  // `lastFullSweepCompletedAt` is read off the raw record too, so the UX
  // timestamp survives the round trip.
  const parsedState = parseDmConversationSweepState(checkpoint?.state);
  const previousBounded = parseDmBoundedSweepState(checkpoint?.state);
  const boundedPolicy = resolveDmBoundedPolicy(effective, input.pageContext.page.label);
  const cadenceSeconds = input.streamState.cadenceSeconds;
  const slotOffsetSeconds = input.streamState.slotOffsetSeconds;
  const schedulingKnown = cadenceSeconds === 1800 && Number.isSafeInteger(slotOffsetSeconds) &&
    slotOffsetSeconds >= 0 && slotOffsetSeconds < 1800 &&
    Number.isSafeInteger(input.streamState.lastScheduledSlot) && input.streamState.lastScheduledSlot >= 0;
  const currentSlot = schedulingKnown
    ? computeCurrentPageSyncSlot(new Date(), cadenceSeconds, slotOffsetSeconds) : -1;
  const previousSchedule = previousBounded?.polling ?? parsedState?.polling;
  const fullDue = dmFullSweepDue({
    policy: boundedPolicy, schedule: previousSchedule, currentSlot, cadenceSeconds, slotOffsetSeconds,
  });
  const canStartBounded = !fullDue && (previousBounded !== null ||
    (parsedState?.kind === "completed" && parsedState.membershipCertified));
  // A completed document parses now instead of coming back as null, but it is
  // not a resumable cursor and never was: only the in_progress arm resumes, so
  // a completed (or unparseable) record still opens a fresh sweep below.
  const existingState = parsedState?.kind === "in_progress" ? parsedState : null;
  // Only meaningful for a cursor that DID resume: a record the parser rejected
  // outright already restarts as a fresh sweep below, and restarting it twice
  // would burn a generation and re-fetch a page for nothing.
  const legacyCountEvidenceMissing = existingState !== null &&
    isUnresumableLegacyDmConversationCursorState(checkpoint?.state);
  let state: DmRunningSweep;
  if (existingState) {
    state = existingState;
  } else if (canStartBounded && previousSchedule?.lastCertifiedFull) {
    state = previousBounded?.completedAt === null ? previousBounded : {
      kind: "bounded", version: 2, mode: "bounded", completedAt: null,
      generation: previousBounded?.generation ?? parsedState!.generation,
      offset: 0, observedCount: 0, pageCount: 0, unchangedPageStreak: 0,
      providerTotalMode: "unobserved", providerReportedTotal: null,
      fullSweepStartedAt: new Date().toISOString(),
      lastFullSweepCompletedAt: previousSchedule.lastCertifiedFull.completedAt,
      polling: previousSchedule, previousTimestampMs: null, stopInvalidated: false,
    };
    if (state.pageCount === 0) {
      await writeSweepCheckpoint(app.db, {
        platformAccountId: input.pageContext.page.id, outcome: "progress", state,
      });
    }
  } else {
    const checkpointGeneration = asNumber(checkpointStateRecord?.generation) ?? 0;
    const storedGeneration = await maxPageDmThreadGeneration(app.db, input.pageContext.page.id);
    state = {
      kind: "in_progress",
      generation: Math.max(checkpointGeneration, storedGeneration) + 1,
      offset: 0,
      observedCount: 0,
      pageCount: 0,
      providerTotalMode: "unobserved",
      providerReportedTotal: null,
      unchangedPageStreak: 0,
      fullSweepStartedAt: new Date().toISOString(),
      lastFullSweepCompletedAt: asNullableString(checkpointStateRecord?.lastFullSweepCompletedAt),
      ...(boundedPolicy && schedulingKnown ? { polling: {
        anchorSlot: Math.min(currentSlot, input.streamState.lastScheduledSlot),
        slotOffsetSeconds,
        lastCertifiedFull: previousSchedule?.lastCertifiedFull ?? null,
      } } : {}),
    };
    const progressCheckpoint = await writeSweepCheckpoint(app.db, {
      platformAccountId: input.pageContext.page.id,
      outcome: "progress",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "dm_conversations",
      summarizeCheckpoint(progressCheckpoint),
    );
  }

  let shadow = shadowEnabled && state.kind !== "bounded"
    ? state.diagnostics ?? createDmShadowState({
      startedAtMs: Date.parse(state.fullSweepStartedAt),
      boundaryMs: parsedState?.kind === "completed" && parsedState.membershipCertified &&
        parsedState.lastFullSweepCompletedAt !== null
        ? Date.parse(parsedState.lastFullSweepCompletedAt)
        : null,
      completeCoverage: state.pageCount === 0,
    })
    : undefined;
  if (shadow) {
    shadow = {
      ...shadow,
      resumes: shadow.resumes + (existingState === null ? 0 : 1),
      completeCoverage: shadow.completeCoverage && shadow.pageCount === state.pageCount,
    };
    await persistDmShadowReport(app, {
      telemetry: input.telemetry,
      pageId: input.pageContext.page.id,
      generation: state.generation,
      state: shadow,
      status: "running",
    });
  }
  // Disabling diagnostics never changes the business cursor or its generation.
  if (!shadowEnabled && state.diagnostics) {
    await persistDmShadowReport(app, {
      telemetry: input.telemetry,
      pageId: input.pageContext.page.id,
      generation: state.generation,
      state: state.diagnostics,
      status: "incomplete",
      reason: "disabled_during_sweep",
    });
  }
  const { diagnostics: _diagnostics, ...businessState } = state;
  state = businessState;

  const restartSweepAfterCapturedContractDrift = async (guard: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  }): Promise<never> => {
    if (shadow) {
      await persistDmShadowReport(app, {
        telemetry: input.telemetry,
        pageId: input.pageContext.page.id,
        generation: state.generation,
        state: shadow,
        status: "incomplete",
        reason: guard.code,
      });
    }
    const storedGeneration = await maxPageDmThreadGeneration(app.db, input.pageContext.page.id);
    const restartState: DmConversationSweepInProgressState = {
      kind: "in_progress",
      generation: Math.max(state.generation, storedGeneration) + 1,
      offset: 0,
      observedCount: 0,
      pageCount: 0,
      providerTotalMode: "unobserved",
      providerReportedTotal: null,
      unchangedPageStreak: 0,
      fullSweepStartedAt: new Date().toISOString(),
      lastFullSweepCompletedAt: state.lastFullSweepCompletedAt,
      ...(state.polling ? { polling: state.kind === "bounded" ? {
        ...state.polling, anchorSlot: Math.min(currentSlot, input.streamState.lastScheduledSlot),
      } : state.polling } : {}),
    };
    const progressCheckpoint = await writeSweepCheckpoint(app.db, {
      platformAccountId: input.pageContext.page.id,
      outcome: "progress",
      state: restartState,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "dm_conversations",
      summarizeCheckpoint(progressCheckpoint),
    );
    await input.telemetry.addAnomaly({
      code: guard.code,
      severity: "error",
      message: guard.message,
      details: {
        ...guard.details,
        abandonedGeneration: state.generation,
        restartGeneration: restartState.generation,
      },
    });
    throw new Error(`${guard.message}; restarted the DM conversation sweep`);
  };

  let processedConversations = 0;
  let repairedHeads = 0;
  // The per-page count compare is cheap enough to run on every page, but its
  // note is latched to ONE per run — a sweep that diverges on page 3 diverges
  // on every page after it, and telemetry rows are the thing G1 just finished
  // bounding. Since G3 this is an early warning for the completion check that
  // now gates the destructive finalization, not a shadow reading.
  let generationSetDivergenceNoted = false;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const page = await app.adapter.getMessagingGroupsPage(requestContext, {
      limit: 100,
      offset: state.offset,
      sortOrder: 1,
      flags: 0,
    });
    const frozenProviderReportedTotal = state.providerReportedTotal;
    const frozenProviderTotalMode = state.providerTotalMode;
    const providerTotalField = page.total as unknown;
    const currentProviderTotalMode = providerTotalField == null
      ? "absent" as const
      : "present" as const;
    const currentProviderReportedTotal = currentProviderTotalMode === "present" &&
        Number.isSafeInteger(providerTotalField) && (providerTotalField as number) >= 0
      ? providerTotalField as number
      : null;
    const nextPageCount = state.pageCount + 1;

    const capturedPayload = trimFanslyMessagingGroupsPayload(page.raw);
    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "dm_conversations",
      requestParams: { offset: state.offset, limit: 100, sortOrder: 1, flags: 0 },
      responsePayload: capturedPayload,
      mapperVersion: FANSLY_GROUPS_CAPTURE_MAPPER_VERSION,
      payloadKind: "dm_metadata",
      retainUntil: dmRetentionDate(),
    }, {
      action: "inserting dm conversations raw payload",
      platform: "fansly",
    });

    if (currentProviderTotalMode === "present" && currentProviderReportedTotal === null) {
      await restartSweepAfterCapturedContractDrift({
        code: "dm_conversations_provider_total_invalid",
        message:
          "DM conversation sync provider total was present but invalid; refusing to apply the page",
        details: {
          currentProviderReportedTotal: providerTotalField ?? null,
          observedCount: state.observedCount,
          pageCount: nextPageCount,
          offset: state.offset,
        },
      });
      continue;
    }

    if (legacyCountEvidenceMissing) {
      await restartSweepAfterCapturedContractDrift({
        code: "dm_conversations_legacy_snapshot_restart",
        message:
          "DM conversation sync resumed a legacy sweep without its unique-id snapshot; refusing to apply the page",
        details: {
          providerReportedTotal: currentProviderReportedTotal,
          pageCount: nextPageCount,
          offset: state.offset,
        },
      });
    }

    if (
      (frozenProviderTotalMode !== "unobserved" &&
        currentProviderTotalMode !== frozenProviderTotalMode) ||
      (frozenProviderTotalMode === "present" &&
        currentProviderReportedTotal !== frozenProviderReportedTotal)
    ) {
      await restartSweepAfterCapturedContractDrift({
        code: "dm_conversations_provider_total_drift_guard",
        message:
          "DM conversation sync provider total presence or value changed during the sweep; refusing to apply the inconsistent page",
        details: {
          providerTotalMode: frozenProviderTotalMode,
          currentProviderTotalMode,
          providerReportedTotal: frozenProviderReportedTotal,
          currentProviderReportedTotal,
          observedCount: state.observedCount,
          pageCount: nextPageCount,
          offset: state.offset,
        },
      });
    }

    const currentConversationIds = page.items.map((conversation) => conversation.groupId);
    const uniqueCurrentConversationIds = new Set(currentConversationIds);
    // Within a single page the ids are compared in memory — no stored state can
    // tell you a page repeated an id against itself. Only the CROSS-page
    // overlap check needs the database, and it waits for the page transaction
    // below; everything decidable without I/O stays HERE, before the hydration
    // loop, so a malformed page cannot spend group-detail and head-repair
    // requests against Fansly before being rejected.
    const duplicateIdsWithinPage = currentConversationIds.length - uniqueCurrentConversationIds.size;
    if (duplicateIdsWithinPage > 0) {
      await restartSweepAfterCapturedContractDrift({
        code: "dm_conversations_snapshot_overlap_guard",
        message:
          "DM conversation sync returned duplicate or overlapping group ids; refusing to apply the page",
        details: {
          providerReportedTotal: currentProviderReportedTotal,
          overlappingConversationIds: [],
          overlapCount: 0,
          duplicateIdsWithinPage,
          observedCount: state.observedCount,
          pageCount: nextPageCount,
          offset: state.offset,
        },
      });
    }

    // No overlap is tolerated, so a page that survives the guards here and in
    // the transaction contributes exactly its unique ids — the same arithmetic
    // the cumulative array performed by concatenating them and taking its
    // length.
    const finalObservedCount = state.observedCount + uniqueCurrentConversationIds.size;
    if (currentProviderReportedTotal !== null && (
      finalObservedCount > currentProviderReportedTotal ||
      (page.done && finalObservedCount !== currentProviderReportedTotal)
    )) {
      await restartSweepAfterCapturedContractDrift({
        code: "dm_conversations_partial_page_guard",
        message:
          "DM conversation sync returned a unique-id count that differs from the provider-reported total; refusing destructive finalization",
        details: {
          providerReportedTotal: currentProviderReportedTotal,
          observedCount: finalObservedCount,
          pageCount: nextPageCount,
        },
      });
    }

    state = {
      ...state,
      pageCount: nextPageCount,
      providerTotalMode: frozenProviderTotalMode === "unobserved"
        ? currentProviderTotalMode
        : frozenProviderTotalMode,
      providerReportedTotal: frozenProviderReportedTotal ?? currentProviderReportedTotal,
    };

    const accountsById = new Map(page.accounts.map((account) => [account.id, account]));
    const groupsById = new Map(page.groups.map((group) => [group.id, group]));
    const existingConversations = await listPageDmConversationsByPlatformConversationIds(app.db, {
      platformAccountId: input.pageContext.page.id,
      platformConversationIds: page.items.map((conversation) => conversation.groupId),
    });
    const existingByGroupId = new Map(
      existingConversations.map((conversation) => [
        conversation.platformConversationId,
        conversation,
      ]),
    );
    const shadowMaterial = shadow === undefined ? null : await readDmShadowMaterial(app, {
      pageId: input.pageContext.page.id,
      maxDurationMs: input.budget.maxWallClockMs - input.budget.elapsedMs,
      heads: page.items.flatMap(item => item.lastMessageId ? [{
        conversationRef: item.groupId,
        conversationId: existingByGroupId.get(item.groupId)?.id ?? null,
        messageId: item.lastMessageId,
      }] : []),
    });
    let unchangedPage = true;
    const shadowConversations: DmShadowConversation[] = [];
    const hydratedAccountsById = new Map<string, FanslyAccount>();
    const fallbackPartnerIds = new Set<string>();
    const conversationWrites: Array<{
      observedHeadId: string | null;
      observedHeadAt: Date | null;
      existingFanId: number | null;
      partnerPlatformUserId: string | null;
      partnerUsername: string | null;
      partnerDisplayName: string | null;
      conversationFlags: number;
      unreadCount: number;
      subscriptionTierId: string | null;
      lastMessageId: string | null;
      lastUnreadMessageId: string | null;
      lastMessageAt: Date | null;
      lastMessageSenderId: string | null;
      lastMessageSenderRole: DmSenderRole;
      lastMessagePreview: string | null;
      lastFanMessageAt: Date | null;
      lastModelMessageAt: Date | null;
      storedMessageCount: number;
      newestStoredMessageId: string | null;
      oldestStoredMessageId: string | null;
      messageCoverageStatus: MessageCoverageStatus;
      messageBackfillComplete: boolean;
      lastMessageSyncAt: Date | null;
      isVisible: boolean;
      lastSeenGeneration: number | null;
      metadata: Record<string, unknown>;
      platformConversationId: string;
    }> = [];

    for (const conversation of page.items) {
      const existing = existingByGroupId.get(conversation.groupId) ?? null;
      const group = groupsById.get(conversation.groupId);
      const aggregatedPartnerIds = Array.from(new Set(
        (group?.users ?? [])
          .map((user) => user.userId)
          .filter((userId) => userId !== pageAccountId),
      ));

      let partnerPlatformUserId = conversation.partnerAccountId ?? null;
      const contradictoryPartner =
        (aggregatedPartnerIds.length === 1 &&
          partnerPlatformUserId !== null &&
          aggregatedPartnerIds[0] !== partnerPlatformUserId) ||
        aggregatedPartnerIds.length > 1;

      if (!partnerPlatformUserId && aggregatedPartnerIds.length === 1) {
        partnerPlatformUserId = aggregatedPartnerIds[0]!;
      }

      const partnerMissingFromAggregationAccounts = Boolean(
        partnerPlatformUserId &&
        page.accounts.length > 0 &&
        !accountsById.has(partnerPlatformUserId),
      );

      let detail: Awaited<ReturnType<AppContext["adapter"]["getGroupDetail"]>> | null = null;
      if ((!partnerPlatformUserId || contradictoryPartner) &&
        !partnerMissingFromAggregationAccounts &&
        input.budget.hasRequestCapacity() &&
        input.budget.hasWallClockCapacity()) {
        detail = await app.adapter.getGroupDetail(requestContext, conversation.groupId);
        await persistRawPayload(app.db, {
          platformAccountId: input.pageContext.page.id,
          syncRunId: input.syncRunId,
          endpoint: "group_detail",
          requestParams: { groupId: conversation.groupId },
          responsePayload: detail.raw,
          mapperVersion: FANSLY_MAPPER_VERSION,
          payloadKind: "dm_metadata",
          retainUntil: dmRetentionDate(),
        }, {
          action: "inserting group_detail raw payload",
          platform: "fansly",
        });
        const detailPartnerIds = Array.from(new Set(
          (detail.parsed.users ?? [])
            .map((user) => user.userId)
            .filter((userId) => userId !== pageAccountId),
        ));
        partnerPlatformUserId = detailPartnerIds.length === 1
          ? detailPartnerIds[0]!
          : null;
      }

      const partnerSnapshot = partnerPlatformUserId
        ? accountsById.get(partnerPlatformUserId) ?? null
        : null;
      const partnerUsername = partnerSnapshot?.username ??
        conversation.partnerUsername ??
        existing?.partnerUsername ??
        null;
      const partnerDisplayName = partnerSnapshot?.displayName ??
        existing?.partnerDisplayName ??
        null;

      if (partnerPlatformUserId && !partnerMissingFromAggregationAccounts) {
        if (partnerSnapshot) {
          hydratedAccountsById.set(partnerPlatformUserId, {
            id: partnerPlatformUserId,
            username: partnerUsername,
            displayName: partnerDisplayName,
            // Both fields are optional on FanslyAccount and the snapshot may
            // omit either, so they are spread rather than assigned undefined —
            // the value every consumer sees is the same (`account.createdAt ?`,
            // `Array.isArray(account.notes)`), this file just stays inside
            // exactOptionalPropertyTypes instead of adding to the ratchet.
            ...(partnerSnapshot.createdAt === undefined
              ? {}
              : { createdAt: partnerSnapshot.createdAt }),
            ...(partnerSnapshot.notes === undefined ? {} : { notes: partnerSnapshot.notes }),
          });
        } else {
          fallbackPartnerIds.add(partnerPlatformUserId);
        }
      }

      const headMessage = group?.lastMessage ?? detail?.parsed.lastMessage ?? null;
      let lastMessageAt = headMessage
        ? await normalizeDmTimestampWithAnomaly(input.telemetry, {
          context: "dm_conversations:lastMessage",
          value: headMessage.createdAt,
        })
        : null;
      let lastMessageSenderId = headMessage?.senderId ?? null;
      let lastMessageSenderRole = resolveDmSenderRole(
        lastMessageSenderId,
        pageAccountId,
        partnerPlatformUserId,
      );
      let lastMessagePreview = truncateDmPreview(headMessage?.content);

      const needsHeadRepair = !partnerMissingFromAggregationAccounts &&
        (!lastMessageAt || !lastMessageSenderId) &&
        (!existing || existing.lastMessageId !== (conversation.lastMessageId ?? null)) &&
        input.budget.hasRequestCapacity() &&
        input.budget.hasWallClockCapacity();

      if (needsHeadRepair) {
        const headRepair = await app.adapter.getMessagesPage(requestContext, {
          groupId: conversation.groupId,
          limit: 1,
        });
        const headRepairRequestParams = {
          groupId: conversation.groupId,
          limit: 1,
          headRepair: true,
        };
        const rawPayload = await persistRawPayload(app.db, {
          platformAccountId: input.pageContext.page.id,
          syncRunId: input.syncRunId,
          endpoint: "dm_messages",
          requestParams: headRepairRequestParams,
          responsePayload: headRepair.raw,
          mapperVersion: FANSLY_MAPPER_VERSION,
          payloadKind: "dm_messages",
          retainUntil: dmRetentionDate(),
        }, {
          action: "inserting dm_messages head-repair raw payload",
          platform: "fansly",
        });
        await materializeFanslyDmTipContextsBestEffort(app, {
          accountId: input.pageContext.page.id,
          requestParams: headRepairRequestParams,
          responsePayload: headRepair.raw,
          sourceRawPayloadId: rawPayload.id,
          capturedAt: rawPayload.capturedAt,
        });
        const repairedHead = headRepair.items[0] ?? null;
        if (repairedHead) {
          repairedHeads += 1;
          lastMessageAt = await normalizeDmTimestampWithAnomaly(input.telemetry, {
            context: "dm_conversations:headRepair",
            value: repairedHead.createdAt,
          });
          lastMessageSenderId = repairedHead.senderId ?? null;
          lastMessageSenderRole = resolveDmSenderRole(
            lastMessageSenderId,
            pageAccountId,
            partnerPlatformUserId,
          );
          lastMessagePreview = truncateDmPreview(repairedHead.content);
        }
      }

      const preservedLastFanMessageAt = lastMessageAt && lastMessageSenderRole === "fan"
        ? lastMessageAt
        : existing?.lastFanMessageAt ?? null;
      const preservedLastModelMessageAt = lastMessageAt && lastMessageSenderRole === "model"
        ? lastMessageAt
        : existing?.lastModelMessageAt ?? null;
      const existingExcludedReason = getFanslyDmMessageSyncExcludedReason(existing?.metadata);
      let messageSyncExcludedReason: FanslyDmMessageSyncExcludedReason | null =
        partnerMissingFromAggregationAccounts
        ? FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS
        : null;

      if (
        existingExcludedReason ===
          FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP
      ) {
        let shouldClearUnresolvableExclusion = false;

        if (
          partnerPlatformUserId &&
          input.budget.hasRequestCapacity() &&
          input.budget.hasWallClockCapacity()
        ) {
          const resolution = await probeFanslyAccountResolution(
            app,
            requestContext,
            partnerPlatformUserId,
            { platformAccountId: input.pageContext.page.id, syncRunId: input.syncRunId },
          );
          shouldClearUnresolvableExclusion = resolution === "resolved";
        }

        messageSyncExcludedReason = shouldClearUnresolvableExclusion
          ? null
          : FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP;
      }

      const metadata = buildFanslyDmConversationMetadata({
        unresolvedIdentity: !partnerPlatformUserId,
        messageSyncExcludedReason,
      });
      const incomingLastMessageId = conversation.lastMessageId ?? null;
      const preserveHeadForRetry = incomingLastMessageId !== null &&
        (!lastMessageAt || !lastMessageSenderId) &&
        (!existing || existing.lastMessageId !== incomingLastMessageId);

      // What the row actually ends up with, so the diff below reports a head
      // that MOVED rather than one the sweep merely had no fresh evidence for.
      const writtenLastMessageAt = lastMessageAt ?? existing?.lastMessageAt ?? null;
      const writtenLastMessageSenderId = lastMessageSenderId ??
        existing?.lastMessageSenderId ?? null;
      const headDiff = diffConversationHead(
        existing
          ? {
            lastMessageId: existing.lastMessageId,
            unreadCount: existing.unreadCount,
            isVisible: existing.isVisible,
            conversationFlags: existing.conversationFlags,
            lastUnreadMessageId: existing.lastUnreadMessageId,
            subscriptionTierId: existing.subscriptionTierId,
            lastMessageAt: existing.lastMessageAt,
            lastMessageSenderId: existing.lastMessageSenderId,
            unresolvedIdentity: hasUnresolvedIdentityMetadata(existing.metadata),
            messageSyncExcludedReason: getFanslyDmMessageSyncExcludedReason(existing.metadata),
          }
          : null,
        {
          lastMessageId: incomingLastMessageId,
          unreadCount: conversation.unreadCount,
          // The sweep only ever writes visible rows; a hidden stored row
          // therefore always reads as a visibility change, which is what the
          // retired inline `!existing.isVisible` said.
          isVisible: true,
          conversationFlags: conversation.flags,
          lastUnreadMessageId: conversation.lastUnreadMessageId ?? null,
          subscriptionTierId: conversation.subscriptionTierId ?? null,
          lastMessageAt: writtenLastMessageAt,
          lastMessageSenderId: writtenLastMessageSenderId,
          unresolvedIdentity: hasUnresolvedIdentityMetadata(metadata),
          messageSyncExcludedReason: getFanslyDmMessageSyncExcludedReason(metadata),
        },
      );
      // BEHAVIOUR PIN, not a preference: the streak is computed over the LEGACY
      // subset of the diff, so a page on which only flags / lastUnreadMessageId
      // / subscriptionTierId moved still counts as unchanged — exactly what the
      // inline predicate did, and what
      // tests/fansly-dm-conversations-sweep.integration.test.ts pins
      // ("current behavior, not desired", unchangedPageStreak: 1). A0 uses
      // the full reasons only in diagnostic state; this predicate stays intact.
      if (breaksLegacyUnchangedPage(headDiff.reasons)) {
        unchangedPage = false;
      }
      if (shadow || state.kind === "bounded") {
        const rawHeadCreatedAt = group?.lastMessage?.createdAt;
        shadowConversations.push({
          reasons: headDiff.reasons,
          listMessageId: state.kind === "bounded" ? conversation.lastMessageId ?? null : incomingLastMessageId,
          embeddedMessageId: group?.lastMessage?.id ?? null,
          timestampMs: typeof rawHeadCreatedAt === "number" && Number.isFinite(rawHeadCreatedAt)
            ? normalizeFanslyTimestamp(rawHeadCreatedAt).getTime()
            : null,
          previousTimestampMs: existing?.lastMessageAt?.getTime() ?? null,
          previousMessageId: existing?.lastMessageId ?? null,
          readerHead: conversation.lastMessageId ? shadowMaterial?.reader.get(fanslyDmReaderHeadKey({
            conversationRef: conversation.groupId, messageId: conversation.lastMessageId,
          })) ?? null : null,
          materialConfirmed: shadowMaterial === null ? null
            : existing !== null && shadowMaterial.hot.get(existing.id)?.present === true,
          discoveryToCaptureMs: existing === null ? null
            : shadowMaterial?.hot.get(existing.id)?.discoveryToCaptureMs ?? null,
          historyPending: existing?.messageBackfillComplete !== true,
          lastHistorySyncAtMs: existing?.lastMessageSyncAt?.getTime() ?? null,
        });
      }

      conversationWrites.push({
        observedHeadId: incomingLastMessageId,
        observedHeadAt: lastMessageAt,
        existingFanId: partnerMissingFromAggregationAccounts
          ? (existing?.fanId ?? null)
          : null,
        platformConversationId: conversation.groupId,
        partnerPlatformUserId,
        partnerUsername,
        partnerDisplayName,
        conversationFlags: conversation.flags,
        unreadCount: conversation.unreadCount,
        subscriptionTierId: conversation.subscriptionTierId ?? null,
        lastMessageId: preserveHeadForRetry ? existing?.lastMessageId ?? null : incomingLastMessageId,
        lastUnreadMessageId: conversation.lastUnreadMessageId ?? null,
        lastMessageAt: writtenLastMessageAt,
        lastMessageSenderId: writtenLastMessageSenderId,
        lastMessageSenderRole: lastMessageAt && lastMessageSenderId
          ? lastMessageSenderRole
          : existing?.lastMessageSenderRole ?? "unknown",
        lastMessagePreview: lastMessagePreview ?? existing?.lastMessagePreview ?? null,
        lastFanMessageAt: preservedLastFanMessageAt,
        lastModelMessageAt: preservedLastModelMessageAt,
        storedMessageCount: existing?.storedMessageCount ?? 0,
        newestStoredMessageId: existing?.newestStoredMessageId ?? null,
        oldestStoredMessageId: existing?.oldestStoredMessageId ?? null,
        messageCoverageStatus: existing?.messageCoverageStatus ?? "pending_backfill",
        messageBackfillComplete: existing?.messageBackfillComplete ?? false,
        lastMessageSyncAt: existing?.lastMessageSyncAt ?? null,
        isVisible: true,
        lastSeenGeneration: state.kind === "bounded" ? null : state.generation,
        metadata,
      });
    }
    processedConversations += conversationWrites.length;

    const nextShadow = shadow === undefined ? undefined : advanceDmShadow(shadow, {
      observedAtMs: Date.now(),
      responseBytes: Buffer.byteLength(JSON.stringify(capturedPayload), "utf8"),
      conversations: shadowConversations,
    });

    const boundedStop = state.kind === "bounded" ? advanceDmBoundedStop(state,
      shadowConversations.map((item) => ({ ...item, unchanged: item.reasons.length === 0 }))) : null;
    const nextState: DmRunningSweep = {
      ...state,
      observedCount: finalObservedCount,
      unchangedPageStreak: unchangedPage ? state.unchangedPageStreak + 1 : 0,
      offset: page.done ? state.offset : state.offset + 100,
      ...(nextShadow === undefined ? {} : { diagnostics: nextShadow }),
      ...(boundedStop ?? {}),
    } as DmRunningSweep;
    const pageWrite = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
      // G3 erasure fence (Stage 28 / PR4): with the cumulative array gone, the
      // rows carrying this generation ARE the sweep's membership record, and a
      // running erasure legitimately deletes some of them. Take the shared
      // page fence so the check-stamp-count-finalize sequence below cannot
      // interleave with an erasure's delete transaction; when the erasure
      // holds the exclusive lock, DEFER the whole chunk — no writes, no
      // checkpoint, nothing consumed. The page re-fetches from the same offset
      // on the next dispatch (its response is already journaled, DP-7 intact).
      if (!(await tryAcquireDmArchiveWriterFenceLock(dbTx, input.pageContext.page.id))) {
        return { kind: "deferred" as const };
      }

      // The cross-page overlap check, row-side and pre-upsert: an id whose row
      // already carries THIS generation was applied by an earlier offset page
      // of this same sweep. Only this sweep ever writes this generation (the
      // page/stream lease is exclusive, the generation starts above every
      // stored stamp, and the monotonic conflict-update lets no other writer
      // introduce it), so the stamp is as authoritative as the array was —
      // and, unlike the array, it is read at the same isolation as the write
      // that follows it. It has to be read BEFORE the upserts: afterwards
      // every id on the page would carry the generation.
      const overlappingConversationIds = state.kind === "bounded" ? [] : await listPageDmThreadIdsStampedWithGeneration(dbTx, {
        platformAccountId: input.pageContext.page.id,
        generation: state.generation,
        platformConversationIds: [...uniqueCurrentConversationIds],
      });
      if (overlappingConversationIds.length > 0) {
        return { kind: "overlap" as const, overlappingConversationIds };
      }

      let dmMessagesFollowupNeeded = false;
      const fanMap = await upsertHydratedFansForPage(dbTx, {
        platformAccountId: input.pageContext.page.id,
        accounts: [...hydratedAccountsById.values()],
        fallbackIds: [...fallbackPartnerIds],
      });

      for (const conversationWrite of conversationWrites) {
        const fanId = conversationWrite.partnerPlatformUserId && conversationWrite.existingFanId === null
          ? (fanMap.get(conversationWrite.partnerPlatformUserId) ?? null)
          : conversationWrite.existingFanId;
        const upsertedConversation = await upsertPageDmConversation(dbTx, {
          platformAccountId: input.pageContext.page.id,
          fanId,
          platformConversationId: conversationWrite.platformConversationId,
          partnerPlatformUserId: conversationWrite.partnerPlatformUserId,
          partnerUsername: conversationWrite.partnerUsername,
          partnerDisplayName: conversationWrite.partnerDisplayName,
          conversationFlags: conversationWrite.conversationFlags,
          unreadCount: conversationWrite.unreadCount,
          subscriptionTierId: conversationWrite.subscriptionTierId,
          lastMessageId: conversationWrite.lastMessageId,
          lastUnreadMessageId: conversationWrite.lastUnreadMessageId,
          lastMessageAt: conversationWrite.lastMessageAt,
          lastMessageSenderId: conversationWrite.lastMessageSenderId,
          lastMessageSenderRole: conversationWrite.lastMessageSenderRole,
          lastMessagePreview: conversationWrite.lastMessagePreview,
          lastFanMessageAt: conversationWrite.lastFanMessageAt,
          lastModelMessageAt: conversationWrite.lastModelMessageAt,
          storedMessageCount: conversationWrite.storedMessageCount,
          newestStoredMessageId: conversationWrite.newestStoredMessageId,
          oldestStoredMessageId: conversationWrite.oldestStoredMessageId,
          messageCoverageStatus: conversationWrite.messageCoverageStatus,
          messageBackfillComplete: conversationWrite.messageBackfillComplete,
          lastMessageSyncAt: conversationWrite.lastMessageSyncAt,
          isVisible: conversationWrite.isVisible,
          lastSeenGeneration: conversationWrite.lastSeenGeneration,
          metadata: conversationWrite.metadata,
        });
        if (!upsertedConversation) continue;
        await observeFanslyDmHead(dbTx, {
          conversationId: upsertedConversation.id,
          messageId: conversationWrite.observedHeadId,
          messageAt: conversationWrite.observedHeadAt,
        });
        const retryAt = headCatchupEnabled ? await nextFanslyDmHeadRetryAt(dbTx, {
          platformAccountId: input.pageContext.page.id,
          conversationId: upsertedConversation.id,
        }) : null;
        const pendingHistory = headCatchupEnabled &&
          upsertedConversation.messageCoverageStatus === "pending_backfill" &&
          retryAt === null;
        if (shouldRequestDmMessagesFollowup(upsertedConversation,
          headCatchupEnabled ? pendingHistory || (retryAt !== null && retryAt <= new Date()) : undefined)) {
          dmMessagesFollowupNeeded = true;
        }
      }

      if (nextState.kind === "bounded") {
        const boundedComplete = page.done || nextState.unchangedPageStreak >= 3;
        const checkpoint = await writeSweepCheckpoint(dbTx, {
          platformAccountId: input.pageContext.page.id, outcome: "progress",
          state: { ...nextState, completedAt: boundedComplete ? new Date().toISOString() : null },
        });
        return { kind: "bounded" as const, boundedComplete, dmMessagesFollowupNeeded, checkpoint };
      }

      // One indexed count of the rows this sweep has stamped, read INSIDE the
      // write transaction so it is exactly the membership the checkpoint about
      // to be written describes. Since G3 this IS the sweep's second opinion on
      // its own `observedCount` — and the last page's copy of it gates the
      // destructive finalization below.
      const generationSetCount = await countPageDmThreadsByGeneration(dbTx, {
        platformAccountId: input.pageContext.page.id,
        generation: state.generation,
      });

      if (page.done) {
        // Erasure PLAUSIBILITY — not permission. The Stage-28 module deletes
        // stamped rows, so a shortfall (and only a shortfall) can have a benign
        // cause when an erasure touched this page inside the sweep window. But
        // findErasureLogTouchingPageSince proves only that SOME erasure ran; it
        // does not prove it deleted THESE missing rows. An abandoned erasure
        // plus one genuinely lost stamp looks identical, and acting on that
        // would hide a live thread — so this only chooses the calm note over
        // the anomaly. It never certifies membership.
        let erasureDelta: number | null = null;
        if (
          isDmSweepErasureShapedCountShortfall({
            observedCount: finalObservedCount,
            generationSetCount,
          })
        ) {
          const sweepStartedAt = new Date(state.fullSweepStartedAt);
          const erasure = Number.isNaN(sweepStartedAt.getTime())
            ? null
            : await findErasureLogTouchingPageSince(dbTx, {
              pageId: input.pageContext.page.id,
              since: sweepStartedAt,
            });
          if (erasure) {
            erasureDelta = finalObservedCount - generationSetCount;
          }
        }

        // The empty-sweep guard (see the anomaly code's JSDoc): a sweep that
        // observed nothing reproduces its own zero trivially, so the check
        // below would certify it and the destructive pass would blank every
        // visible thread on the page. Counted with the destructive pass's own
        // predicate, inside the same transaction, so it measures exactly the
        // rows that pass would hide — and only on an empty sweep, which is the
        // one shape where a single provider answer can cost a whole inbox.
        const emptySweepVisibleThreadCount = finalObservedCount === 0
          ? await countPageDmVisibleThreadsBelowGeneration(dbTx, {
            platformAccountId: input.pageContext.page.id,
            generation: state.generation,
          })
          : 0;
        const emptySweepGuardHeld = emptySweepVisibleThreadCount > 0;

        // The whole point of G3: invisibility only after the row-side set
        // reproduces the count the sweep claims to have observed — EXACTLY,
        // with no excuse accepted. Any gap, in either direction and however
        // plausible, means the membership record cannot be trusted, and hiding
        // threads on an untrustworthy record is the failure mode (a live thread
        // disappearing from every chatter's list) this refuses to risk.
        // Decision #208 prefers stale visibility to that, and the re-sweep
        // under a fresh generation converges on its own.
        const membershipCertified = !emptySweepGuardHeld &&
          generationSetCount === finalObservedCount;
        const destructiveFinalization = state.providerTotalMode === "present" &&
          membershipCertified;
        // Independent of the total mode: a total-less sweep runs no destructive
        // pass, but it must not stamp itself successful — or advance the
        // coverage timestamp — on a membership it could not certify either.
        const finalizationWithheld = !membershipCertified;
        if (destructiveFinalization) {
          await markPageDmConversationsInvisibleByGeneration(dbTx, {
            platformAccountId: input.pageContext.page.id,
            generation: state.generation,
          });
        }
        const completedAt = new Date().toISOString();
        const completedState: DmConversationSweepCompletedState = {
          kind: "completed",
          generation: state.generation,
          observedCount: finalObservedCount,
          generationSetCount,
          providerTotalMode: state.providerTotalMode,
          providerReportedTotal: state.providerReportedTotal,
          destructiveFinalization,
          membershipCertified,
          // Serialized only when non-null, exactly as the inline literal's
          // conditional spread did.
          erasureDelta,
          // A withheld finalization did walk every page, but it is not a full
          // sweep the coverage UX may advertise — the previous timestamp
          // stands until a sweep certifies itself.
          lastFullSweepCompletedAt: finalizationWithheld
            ? state.lastFullSweepCompletedAt
            : completedAt,
          ...(nextShadow === undefined ? {} : { diagnostics: nextShadow }),
          ...(state.polling ? { polling: {
            ...state.polling,
            lastCertifiedFull: finalizationWithheld ? state.polling.lastCertifiedFull : {
              startedAt: state.fullSweepStartedAt,
              completedAt,
              anchorSlot: state.polling.anchorSlot,
            },
          } } : {}),
        };
        // Note the completed state carries no `mode`, so the parser refuses it
        // as a resumable cursor and the next chunk opens a fresh sweep under a
        // higher generation. That is also what makes a withheld finalization
        // self-healing rather than a wedge: the retry re-walks from offset 0.
        return {
          kind: "complete" as const,
          destructiveFinalization,
          finalizationWithheld,
          membershipCertified,
          emptySweepGuardHeld,
          emptySweepVisibleThreadCount,
          dmMessagesFollowupNeeded,
          generationSetCount,
          erasureDelta,
          checkpoint: finalizationWithheld
            // Progress write: a run that refused to finalize must not stamp
            // itself as the stream's last successful run.
            ? await writeSweepCheckpoint(dbTx, {
              platformAccountId: input.pageContext.page.id,
              outcome: "progress",
              state: completedState,
            })
            : await writeSweepCheckpoint(dbTx, {
              platformAccountId: input.pageContext.page.id,
              outcome: "success",
              state: completedState,
              lastSuccessfulRunId: input.syncRunId,
            }),
        };
      }

      return {
        kind: "progress" as const,
        dmMessagesFollowupNeeded,
        generationSetCount,
        // `generationSetCount` is telemetry, not cursor state: the parser
        // drops it on resume and every page recomputes it. It rides the
        // checkpoint purely so summarizeCheckpoint carries it into the
        // bounded projection — the per-page membership signal that replaced
        // the array's digest.
        checkpoint: await writeSweepCheckpoint(dbTx, {
          platformAccountId: input.pageContext.page.id,
          outcome: "progress",
          state: nextState,
          generationSetCount,
        }),
      };
    });

    if (pageWrite.kind === "deferred") {
      await input.telemetry.addNote(
        "DM conversation sweep deferred a page while an erasure held the page fence",
        {
          code: DM_CONVERSATIONS_ERASURE_FENCE_DEFERRED_NOTE_CODE,
          generation: state.generation,
          pageCount: nextPageCount,
          offset: state.offset,
        },
      );
      return {
        satisfied: false,
        yieldReason: null,
        continuationRetryAt: new Date(Date.now() + DM_CONVERSATIONS_ERASURE_FENCE_RETRY_DELAY_MS),
        continuationRequestSource: "scheduled",
        stats: {
          generation: state.generation,
          offset: state.offset,
          pageCount: state.pageCount,
          observedCount: state.observedCount,
          processedConversations,
          repairedHeads,
          providerTotalMode: state.providerTotalMode,
          providerReportedTotal: state.providerReportedTotal,
          fullSweepCompleted: false,
          erasureFenceDeferred: true,
        },
      } satisfies StreamChunkResult;
    }

    if (pageWrite.kind === "overlap") {
      await restartSweepAfterCapturedContractDrift({
        code: "dm_conversations_snapshot_overlap_guard",
        message:
          "DM conversation sync returned duplicate or overlapping group ids; refusing to apply the page",
        details: {
          providerReportedTotal: currentProviderReportedTotal,
          overlappingConversationIds: pageWrite.overlappingConversationIds.slice(0, 10),
          overlapCount: pageWrite.overlappingConversationIds.length,
          duplicateIdsWithinPage,
          observedCount: state.observedCount,
          pageCount: nextPageCount,
          offset: state.offset,
        },
      });
      continue;
    }

    await input.telemetry.recordCheckpointAdvanced(
      "dm_conversations",
      summarizeCheckpoint(pageWrite.checkpoint),
    );

    if (nextShadow) {
      shadow = nextShadow;
      const complete = pageWrite.kind === "complete";
      const certified = complete && pageWrite.membershipCertified && shadow.completeCoverage &&
        shadow.boundaryMs !== null && shadow.unknownMaterialChecks === 0 &&
        shadow.readerHeadsChecked !== null && shadow.unknownReaderHeadChecks === 0;
      await persistDmShadowReport(app, {
        telemetry: input.telemetry,
        pageId: input.pageContext.page.id,
        generation: state.generation,
        state: shadow,
        status: complete ? (certified ? "complete" : "incomplete") : "running",
        ...(complete && !certified ? { reason: "uncertified_or_partial_diagnostics" } : {}),
      });
    }

    if (pageWrite.dmMessagesFollowupNeeded) {
      await requestPageSync(app.db, {
        pageId: input.pageContext.page.id,
        streams: ["dm_messages"],
        source: "scheduled",
        ...pageSyncDependencyInput(app),
      });
    }

    if (pageWrite.kind === "bounded") {
      if (pageWrite.boundedComplete) {
        return {
          satisfied: true, yieldReason: null, qualityHold: "fansly_dm_bounded_only",
          stats: { processedConversations, repairedHeads, pageCount: nextState.pageCount,
            boundedCompleted: true, fullSweepCompleted: false },
        } satisfies StreamChunkResult;
      }
      state = nextState;
      continue;
    }

    // Early warning: a mid-sweep divergence is what the completion check will
    // fail on, several pages before it does. It changes nothing on its own —
    // the last page decides — but it dates the divergence to a page.
    if (
      pageWrite.kind === "progress" &&
      !generationSetDivergenceNoted &&
      pageWrite.generationSetCount !== finalObservedCount
    ) {
      generationSetDivergenceNoted = true;
      await input.telemetry.addNote(
        "DM conversation sweep generation set diverged from its observed count",
        {
          code: DM_SWEEP_DUAL_PROOF_PAGE_NOTE_CODE,
          generation: state.generation,
          pageCount: nextPageCount,
          observedCount: finalObservedCount,
          generationSetCount: pageWrite.generationSetCount,
        },
      );
    }

    if (pageWrite.kind === "complete") {
      if (pageWrite.emptySweepGuardHeld) {
        // Ahead of the membership verdict below on purpose: "the provider
        // listed nothing" is the cause, and reporting it as a generation-set
        // mismatch would send the reader hunting for a lost stamp that never
        // existed.
        await input.telemetry.addAnomaly({
          code: DM_SWEEP_EMPTY_SWEEP_GUARD_ANOMALY_CODE,
          // warn, like the audience sweep's twin: an empty answer is a
          // provider-side fact this stream absorbs and recovers from, not the
          // internal inconsistency the membership guard reports as an error.
          severity: "warn",
          message:
            "DM conversation sweep observed no conversations while the page still has visible threads; refusing destructive finalization",
          details: {
            generation: state.generation,
            pageCount: nextPageCount,
            observedCount: finalObservedCount,
            generationSetCount: pageWrite.generationSetCount,
            visibleThreadCount: pageWrite.emptySweepVisibleThreadCount,
            providerTotalMode: state.providerTotalMode,
            providerReportedTotal: state.providerReportedTotal,
            finalizationWithheld: pageWrite.finalizationWithheld,
          },
        });
      } else if (pageWrite.erasureDelta !== null) {
        // Same withheld outcome as any other uncertified sweep — only the
        // volume differs. A shortfall an erasure could plausibly have caused
        // is not an incident, so it reports as a note; the sweep still refuses
        // to finalize on it.
        await input.telemetry.addNote(
          "DM conversation sweep generation set trails its observed count by rows an erasure could have removed inside the sweep window; finalization withheld",
          {
            code: DM_SWEEP_DUAL_PROOF_ERASURE_NOTE_CODE,
            generation: state.generation,
            observedCount: finalObservedCount,
            generationSetCount: pageWrite.generationSetCount,
            erasureDelta: pageWrite.erasureDelta,
            finalizationWithheld: pageWrite.finalizationWithheld,
          },
        );
      } else if (!pageWrite.membershipCertified) {
        await input.telemetry.addAnomaly({
          code: DM_SWEEP_GENERATION_MEMBERSHIP_ANOMALY_CODE,
          // error, not warn: unlike the G2 shadow this verdict WITHHELD the
          // sweep's completion, and no deletion on this page can even explain
          // the gap.
          severity: "error",
          message:
            "DM conversation sweep generation set did not reproduce its observed count; refusing destructive finalization",
          details: {
            generation: state.generation,
            pageCount: nextPageCount,
            observedCount: finalObservedCount,
            generationSetCount: pageWrite.generationSetCount,
            providerTotalMode: state.providerTotalMode,
            providerReportedTotal: state.providerReportedTotal,
            finalizationWithheld: pageWrite.finalizationWithheld,
          },
        });
      }

      if (state.providerTotalMode !== "present" && !pageWrite.finalizationWithheld) {
        await input.telemetry.addNote(
          "DM conversation sweep completed without a provider total; unseen conversations remain visible",
          {
            code: "dm_conversations_provider_total_absent_nondestructive",
            observedCount: finalObservedCount,
            pageCount: state.pageCount,
            providerTotalMode: state.providerTotalMode,
          },
        );
      }
      return {
        // A withheld finalization is not a success: the walk finished, the
        // certification did not. Yielding re-queues the stream, and the
        // completed checkpoint it wrote makes the retry a fresh sweep.
        satisfied: !pageWrite.finalizationWithheld,
        yieldReason: null,
        ...(pageWrite.finalizationWithheld
          ? {
            continuationRetryAt: new Date(Date.now() + DM_CONVERSATIONS_MEMBERSHIP_RETRY_DELAY_MS),
            continuationRequestSource: "scheduled" as const,
          }
          : {}),
        stats: {
          generation: state.generation,
          offset: state.offset,
          pageCount: state.pageCount,
          observedCount: finalObservedCount,
          generationSetCount: pageWrite.generationSetCount,
          processedConversations,
          repairedHeads,
          providerTotalMode: state.providerTotalMode,
          providerReportedTotal: state.providerReportedTotal,
          destructiveFinalization: pageWrite.destructiveFinalization,
          membershipCertified: pageWrite.membershipCertified,
          finalizationWithheld: pageWrite.finalizationWithheld,
          emptySweepGuard: pageWrite.emptySweepGuardHeld,
          fullSweepCompleted: !pageWrite.finalizationWithheld,
        },
      } satisfies StreamChunkResult;
    }

    state = nextState;
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: {
      generation: state.generation,
      offset: state.offset,
      pageCount: state.pageCount,
      observedCount: state.observedCount,
      processedConversations,
      repairedHeads,
      providerTotalMode: state.providerTotalMode,
      providerReportedTotal: state.providerReportedTotal,
      fullSweepCompleted: false,
    },
  } satisfies StreamChunkResult;
}
