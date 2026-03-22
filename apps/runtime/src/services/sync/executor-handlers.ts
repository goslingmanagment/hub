import {
  countActivePageFollows,
  deactivatePageFollowsByGeneration,
  deactivatePageSubscriptionsByGeneration,
  finalizePageDmConversationMessageSync,
  getExistingPageDmMessageIds,
  getPageDmConversationById,
  getCheckpoint,
  getCurrentSubscribers,
  markPageDmConversationsInvisibleByGeneration,
  PAGE_DM_MESSAGE_HISTORY_LIMIT,
  pageDmConversations,
  rebuildFollowerRollups,
  rebuildSubscriberRollups,
  requestSyncStreamRevisions,
  selectNextPageDmMessageSyncCandidate,
  updateLegacySyncTimestamp,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertPageDmConversation,
  upsertPageDmMessages,
  upsertFanPages,
  upsertFans,
  upsertPageFollows,
  upsertPageSubscriptions,
  refreshFanPageFollowerState,
  refreshFanPageSubscriberState,
  type UpsertFanPageInput,
  type UpsertPageFollowInput,
  type UpsertPageSubscriptionInput,
  type SyncStreamStateRow,
} from "@agency_hub_core/db";
import {
  FANSLY_MAPPER_VERSION,
  mapFanslySubscriptionStatus,
} from "@agency_hub_core/fansly";
import {
  buildFanslyDmConversationMetadata,
  buildProxyEgressKey,
  fanslyFollowIdToDate,
  getFanslyDmMessageSyncExcludedReason,
  isFanslyDmMessageSyncExcluded,
  toMills,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  type HttpRequestEvent,
  type HttpRequestObserver,
} from "@agency_hub_core/shared";
import { and, eq } from "drizzle-orm";

import type { AppContext } from "../../bootstrap.ts";
import {
  resolvePageContextById,
  type ResolvedPageContext,
} from "../page-context.ts";
import { syncOnlyFansTransactions } from "./onlyfans-transactions.ts";
import {
  summarizeCheckpoint,
  type DmMessagesChunkSummary,
  type SyncRunTelemetry,
} from "./observability.ts";
import { composeRequestObservers, type SyncChunkYieldReason, type SyncChunkBudget } from "./chunk-budget.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import {
  dmRetentionDate,
  normalizeFanslyTimestamp,
  persistRawPayload,
  refreshPageMetadata,
  retentionDate,
  trimFanslyFollowerPayload,
  trimFanslyMessagingGroupsPayload,
} from "./shared.ts";
import { hydrateFans } from "./fan-hydration.ts";
import { syncTransactions } from "./transactions.ts";

type ExecutorRequestContext = {
  budget: SyncChunkBudget;
  pageContext: ResolvedPageContext;
  telemetry: SyncRunTelemetry;
};

function createPageRateLimitWaiter(
  app: AppContext,
  pageContext: ResolvedPageContext,
) {
  return createSyncRateLimitWaiter(app, {
    egressKey: buildProxyEgressKey(pageContext.proxy),
  });
}

export type StreamChunkResult = {
  satisfied: boolean;
  yieldReason: SyncChunkYieldReason | null;
  clearRequestPayload?: boolean;
  stats?: Record<string, unknown>;
};

class DmMessagesChunkRequestObserver implements HttpRequestObserver {
  private readonly touchedConversationIds = new Set<number>();
  private readonly requestGapsMs: number[] = [];
  private requestCount = 0;
  private rateLimit429s = 0;
  private lastStartedAtMs: number | null = null;

  recordConversationTouched(conversationId: number) {
    this.touchedConversationIds.add(conversationId);
  }

  async onRequestEvent(event: HttpRequestEvent) {
    if (event.operation !== "messages") {
      return;
    }

    if (event.state === "started") {
      this.requestCount += 1;

      const startedAtMs = event.timestamp instanceof Date ? event.timestamp.getTime() : Number.NaN;
      if (Number.isFinite(startedAtMs)) {
        if (this.lastStartedAtMs !== null) {
          this.requestGapsMs.push(startedAtMs - this.lastStartedAtMs);
        }
        this.lastStartedAtMs = startedAtMs;
      }
      return;
    }

    if ("httpStatus" in event && event.httpStatus === 429) {
      this.rateLimit429s += 1;
    }
  }

  buildSummary(chunkDurationMs: number): DmMessagesChunkSummary {
    const totalGapMs = this.requestGapsMs.reduce((sum, value) => sum + value, 0);
    return {
      conversationsProcessed: this.touchedConversationIds.size,
      messageFetchRequests: this.requestCount,
      rateLimit429s: this.rateLimit429s,
      chunkDurationMs,
      averageGapMs: this.requestGapsMs.length > 0
        ? Math.round(totalGapMs / this.requestGapsMs.length)
        : 0,
    };
  }
}

type SubscribersCheckpointState = {
  revision: number;
  generation: number;
  offset: number;
  pageCount: number;
  providerReportedTotal: number | null;
};

type FollowersCheckpointState = {
  revision: number;
  knownFollowId: string | null;
  newestFollowId: string | null;
  offset: number;
  pageCount: number;
  sourceFollowerCount: number;
};

type FollowersReconcileCheckpointState = {
  revision: number;
  generation: number;
  offset: number;
  pageCount: number;
  sourceFollowerCount: number;
};

type DmConversationCheckpointState = {
  version: 1;
  mode: "full_scan";
  generation: number;
  offset: number;
  pageCount: number;
  providerReportedTotal: number | null;
  unchangedPageStreak: number;
  fullSweepStartedAt: string;
  lastFullSweepCompletedAt: string | null;
};

type DmMessagesCheckpointState = {
  version: 1;
  currentConversationId: number | null;
  currentPlatformConversationId: string | null;
  currentBeforeMessageId: string | null;
  currentMode: "backfill" | "incremental" | null;
};

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableNumber(value: unknown) {
  return value === null ? null : asNumber(value);
}

function asNullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : null;
}

function hasUnresolvedIdentityMetadata(metadata: Record<string, unknown> | null | undefined) {
  return metadata?.unresolvedIdentity === true;
}

function parseSubscribersCheckpointState(
  value: unknown,
  revision: number,
): SubscribersCheckpointState | null {
  const state = asRecord(value);
  if (!state || asNumber(state.revision) !== revision) {
    return null;
  }

  const generation = asNumber(state.generation);
  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const providerReportedTotal = asNullableNumber(state.providerReportedTotal);
  if (
    generation === null ||
    offset === null ||
    pageCount === null ||
    providerReportedTotal === undefined
  ) {
    return null;
  }

  return {
    revision,
    generation,
    offset,
    pageCount,
    providerReportedTotal,
  };
}

function parseFollowersCheckpointState(
  value: unknown,
  revision: number,
): FollowersCheckpointState | null {
  const state = asRecord(value);
  if (!state || asNumber(state.revision) !== revision) {
    return null;
  }

  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const sourceFollowerCount = asNumber(state.sourceFollowerCount);
  const knownFollowId = asNullableString(state.knownFollowId);
  const newestFollowId = asNullableString(state.newestFollowId);
  if (
    offset === null ||
    pageCount === null ||
    sourceFollowerCount === null ||
    knownFollowId === undefined ||
    newestFollowId === undefined
  ) {
    return null;
  }

  return {
    revision,
    knownFollowId,
    newestFollowId,
    offset,
    pageCount,
    sourceFollowerCount,
  };
}

function parseFollowersReconcileCheckpointState(
  value: unknown,
  revision: number,
): FollowersReconcileCheckpointState | null {
  const state = asRecord(value);
  if (!state || asNumber(state.revision) !== revision) {
    return null;
  }

  const generation = asNumber(state.generation);
  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const sourceFollowerCount = asNumber(state.sourceFollowerCount);
  if (
    generation === null ||
    offset === null ||
    pageCount === null ||
    sourceFollowerCount === null
  ) {
    return null;
  }

  return {
    revision,
    generation,
    offset,
    pageCount,
    sourceFollowerCount,
  };
}

function parseDmConversationCheckpointState(value: unknown) {
  const state = asRecord(value);
  if (!state || asNumber(state.version) !== 1 || state.mode !== "full_scan") {
    return null;
  }

  const generation = asNumber(state.generation);
  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const providerReportedTotal = asNullableNumber(state.providerReportedTotal);
  const unchangedPageStreak = asNumber(state.unchangedPageStreak);
  const fullSweepStartedAt = asNullableString(state.fullSweepStartedAt);
  const lastFullSweepCompletedAt = asNullableString(state.lastFullSweepCompletedAt);
  if (
    generation === null ||
    offset === null ||
    pageCount === null ||
    providerReportedTotal === undefined ||
    unchangedPageStreak === null ||
    !fullSweepStartedAt
  ) {
    return null;
  }

  return {
    version: 1 as const,
    mode: "full_scan" as const,
    generation,
    offset,
    pageCount,
    providerReportedTotal,
    unchangedPageStreak,
    fullSweepStartedAt,
    lastFullSweepCompletedAt,
  } satisfies DmConversationCheckpointState;
}

function parseDmMessagesCheckpointState(value: unknown) {
  const state = asRecord(value);
  if (!state || asNumber(state.version) !== 1) {
    return null;
  }

  const currentConversationId = state.currentConversationId === null
    ? null
    : asNumber(state.currentConversationId);
  const currentPlatformConversationId = asNullableString(state.currentPlatformConversationId);
  const currentBeforeMessageId = asNullableString(state.currentBeforeMessageId);
  const currentMode = state.currentMode === "backfill" || state.currentMode === "incremental"
    ? state.currentMode
    : state.currentMode === null || state.currentMode === undefined
      ? null
      : undefined;

  if (
    currentConversationId === undefined ||
    currentPlatformConversationId === undefined ||
    currentBeforeMessageId === undefined ||
    currentMode === undefined
  ) {
    return null;
  }

  return {
    version: 1 as const,
    currentConversationId,
    currentPlatformConversationId,
    currentBeforeMessageId,
    currentMode,
  } satisfies DmMessagesCheckpointState;
}

function emptyDmMessagesCheckpointState(): DmMessagesCheckpointState {
  return {
    version: 1,
    currentConversationId: null,
    currentPlatformConversationId: null,
    currentBeforeMessageId: null,
    currentMode: null,
  };
}

function buildOnlyFansRequestContext(app: AppContext, input: ExecutorRequestContext) {
  if (input.pageContext.platform !== "onlyfans") {
    throw new Error("Expected an OnlyFans page context");
  }

  return {
    auth: input.pageContext.auth,
    proxy: input.pageContext.proxy,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
}

async function triggerFollowersReconcileAnomaly(
  app: AppContext,
  platformAccountId: number,
) {
  await requestSyncStreamRevisions(app.db, {
    platformAccountId,
    streams: ["followers_reconcile"],
    reason: "anomaly",
  });
}

function getFanslyPlatformAccountIdValue(pageContext: ResolvedPageContext) {
  if (pageContext.platform !== "fansly") {
    throw new Error("Expected a Fansly page context");
  }

  const platformAccountId = pageContext.page.platformAccountId ??
    (typeof pageContext.page.metadata["platformAccountId"] === "string"
      ? pageContext.page.metadata["platformAccountId"]
      : null);
  if (!platformAccountId) {
    throw new Error(`Page "${pageContext.page.label}" is missing a Fansly platform account id`);
  }

  return platformAccountId;
}

function assertDmSharedRateLimitEnabled(app: AppContext) {
  if (!app.config.syncSharedRateLimitEnabled) {
    throw new Error("DM sync requires SYNC_SHARED_RATE_LIMIT_ENABLED=true");
  }
}

function truncateDmPreview(content: string | null | undefined, maxLength = 280) {
  const normalized = (content ?? "").trim();
  if (!normalized) {
    return null;
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function isClearlyImplausibleDmTimestamp(timestamp: Date, now = new Date()) {
  return timestamp.getTime() < Date.UTC(2010, 0, 1) ||
    timestamp.getTime() > now.getTime() + (24 * 60 * 60 * 1000);
}

async function recordDmTimestampAnomaly(
  telemetry: SyncRunTelemetry,
  input: {
    context: string;
    rawValue: number;
    normalizedAt: Date;
  },
) {
  await telemetry.addAnomaly({
    code: "dm_timestamp_implausible",
    severity: "warn",
    message: "DM timestamp normalized to an implausible value",
    details: {
      context: input.context,
      rawValue: input.rawValue,
      normalizedAt: input.normalizedAt.toISOString(),
    },
  });
}

async function normalizeDmTimestampWithAnomaly(
  telemetry: SyncRunTelemetry,
  input: {
    context: string;
    value: number | null | undefined;
  },
) {
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    return null;
  }

  const normalized = normalizeFanslyTimestamp(input.value);
  if (isClearlyImplausibleDmTimestamp(normalized)) {
    await recordDmTimestampAnomaly(telemetry, {
      context: input.context,
      rawValue: input.value,
      normalizedAt: normalized,
    });
  }

  return normalized;
}

function resolveDmSenderRole(
  senderId: string | null | undefined,
  pageAccountId: string,
  partnerPlatformUserId: string | null | undefined,
) {
  if (!senderId) {
    return "unknown" as const;
  }
  if (senderId === pageAccountId) {
    return "model" as const;
  }
  if (partnerPlatformUserId && senderId === partnerPlatformUserId) {
    return "fan" as const;
  }
  return "unknown" as const;
}

export async function executeLightChunk(
  app: AppContext,
  input: ExecutorRequestContext,
) {
  await input.telemetry.recordPhaseStarted("page_metadata");
  if (input.pageContext.platform === "fansly") {
    const account = await refreshPageMetadata(app, input.pageContext, undefined, input.telemetry);
    await updateLegacySyncTimestamp(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncType: "light",
    });

    return {
      satisfied: true,
      yieldReason: null,
      stats: {
        followerCount: account.parsed.account.followCount,
        subscriberCount: account.parsed.account.subscriberCount,
      },
    } satisfies StreamChunkResult;
  }

  const account = await refreshPageMetadata(app, input.pageContext, undefined, input.telemetry);
  await updateLegacySyncTimestamp(app.db, {
    platformAccountId: input.pageContext.page.id,
    syncType: "light",
  });

  return {
    satisfied: true,
    yieldReason: null,
    stats: {
      username: account.parsed.account.username,
    },
  } satisfies StreamChunkResult;
}

export async function executeTransactionsChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: SyncStreamStateRow;
    syncRunId: number;
  },
) {
  await input.telemetry.recordPhaseStarted("transactions");

  if (input.pageContext.platform === "fansly") {
    const result = await syncTransactions(app, {
      pageLabel: input.pageContext.page.label,
      platformAccountId: input.pageContext.page.id,
      commissionRate: input.pageContext.page.commissionRate,
      requestContext: {
        session: input.pageContext.session,
        proxy: input.pageContext.proxy,
        requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
        rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
      },
      syncRunId: input.syncRunId,
      telemetry: input.telemetry,
    });

    return {
      satisfied: true,
      yieldReason: null,
      stats: result as Record<string, unknown>,
    } satisfies StreamChunkResult;
  }

  const payload = input.streamState.requestPayload;
  const requestedRevision = asNumber(payload?.revision);
  const transactionsStart = requestedRevision === input.streamState.desiredRevision &&
      typeof payload?.onlyFansTransactionsStart === "string"
    ? new Date(payload.onlyFansTransactionsStart)
    : null;

  const result = await syncOnlyFansTransactions(app, {
    pageLabel: input.pageContext.page.label,
    platformAccountId: input.pageContext.page.id,
    platformAccountIdValue: String(input.pageContext.page.platformAccountId),
    pageMetadata: input.pageContext.page.metadata,
    commissionRate: input.pageContext.page.commissionRate,
    rescanStart: transactionsStart,
    requestContext: buildOnlyFansRequestContext(app, input),
    syncRunId: input.syncRunId,
    telemetry: input.telemetry,
    budget: input.budget,
  });

  return {
    satisfied: result.satisfied,
    yieldReason: result.yieldReason,
    clearRequestPayload: result.satisfied && Boolean(transactionsStart),
    stats: result as Record<string, unknown>,
  } satisfies StreamChunkResult;
}

export async function executeSubscribersChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: SyncStreamStateRow;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("Subscriber sync is only supported for Fansly pages");
  }

  await input.telemetry.recordPhaseStarted("subscribers");
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "subscribers");
  await input.telemetry.recordCheckpointLoaded("subscribers", summarizeCheckpoint(checkpoint));

  const existingState = parseSubscribersCheckpointState(checkpoint?.state, input.streamState.desiredRevision);
  const previousGeneration = asNumber(asRecord(checkpoint?.state)?.generation) ?? 0;
  let state = existingState ?? {
    revision: input.streamState.desiredRevision,
    generation: previousGeneration + 1,
    offset: 0,
    pageCount: 0,
    providerReportedTotal: null,
  } satisfies SubscribersCheckpointState;

  if (!existingState) {
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "subscribers",
      state,
    });
  }

  let processedThisChunk = 0;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    const page = await app.adapter.getSubscribersPage(
      requestContext,
      { limit: 100, offset: state.offset, status: "3,4" },
    );
    state = {
      ...state,
      pageCount: state.pageCount + 1,
      providerReportedTotal: state.providerReportedTotal ?? page.total ?? null,
    };

    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "subscribers",
      requestParams: { offset: state.offset, limit: 100, status: "3,4" },
      responsePayload: page.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting subscribers raw payload",
    });

    if (state.offset === 0 && page.items.length === 0) {
      const currentSubscribers = await getCurrentSubscribers(app.db, input.pageContext.page.id);
      if (currentSubscribers.rows.length > 0) {
        await input.telemetry.addAnomaly({
          code: "subscribers_empty_first_page_guard",
          severity: "warn",
          message: "Subscriber sync returned zero rows on the first page while current subscriptions already exist",
          details: {
            existingCurrentSubscribers: currentSubscribers.rows.length,
          },
        });
        throw new Error("Subscriber sync returned zero rows; refusing destructive finalization");
      }
    }

    const fanMap = await hydrateFans(app, {
      requestContext,
      platformUserIds: page.items.map((item) => item.subscriberId),
      telemetry: input.telemetry,
    });

    const subscriptionInputs: UpsertPageSubscriptionInput[] = [];
    const fanPageInputs: UpsertFanPageInput[] = [];
    for (const item of page.items) {
      const fanId = fanMap.get(item.subscriberId);
      if (!fanId) {
        continue;
      }

      const sourceCreatedAt = item.createdAt ? new Date(item.createdAt) : null;
      const endsAt = item.endsAt ? new Date(item.endsAt) : null;
      const autoRenew = item.autoRenew === null ? null : item.autoRenew === 1;
      const canonicalStatus = mapFanslySubscriptionStatus(item.status);
      subscriptionInputs.push({
        platformSubscriptionId: item.id,
        platformAccountId: input.pageContext.page.id,
        fanId,
        platformHistoryId: item.historyId,
        subscriptionTierId: item.subscriptionTierId,
        subscriptionTierName: item.subscriptionTierName,
        subscriptionTierColor: item.subscriptionTierColor,
        planId: item.planId,
        rawStatus: item.status,
        canonicalStatus,
        priceMills: toMills(item.price),
        renewPriceMills: toMills(item.renewPrice),
        autoRenew,
        billingCycleDays: item.billingCycle,
        durationDays: item.duration,
        renewDate: item.renewDate ? new Date(item.renewDate) : null,
        sourceCreatedAt,
        sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
        endsAt,
        lastSeenGeneration: state.generation,
      });
      fanPageInputs.push({
        fanId,
        platformAccountId: input.pageContext.page.id,
        isSubscriber: true,
        subscriberSince: sourceCreatedAt,
        subscriptionExpiresAt: endsAt,
        autoRenew,
      });
    }
    processedThisChunk += subscriptionInputs.length;

    if (page.done) {
      const completedCheckpoint = await app.db.transaction(async (tx) => {
        const dbTx = tx as typeof app.db;
        await upsertPageSubscriptions(dbTx, subscriptionInputs);
        await upsertFanPages(dbTx, fanPageInputs);
        await deactivatePageSubscriptionsByGeneration(dbTx, {
          platformAccountId: input.pageContext.page.id,
          generation: state.generation,
        });
        await refreshFanPageSubscriberState(dbTx, input.pageContext.page.id);
        await rebuildSubscriberRollups(dbTx, input.pageContext.page.id);
        return upsertCheckpoint(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "subscribers",
          state,
          lastSuccessfulRunId: input.syncRunId,
        });
      });
      await input.telemetry.recordCheckpointAdvanced("subscribers", summarizeCheckpoint(completedCheckpoint));
      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          generation: state.generation,
          pageCount: state.pageCount,
          processedThisChunk,
          providerReportedTotal: state.providerReportedTotal,
        },
      } satisfies StreamChunkResult;
    }

    await upsertPageSubscriptions(app.db, subscriptionInputs);
    await upsertFanPages(app.db, fanPageInputs);
    state = {
      ...state,
      offset: state.offset + 100,
    };
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "subscribers",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced("subscribers", summarizeCheckpoint(progressCheckpoint));

    if (input.budget.shouldYield()) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        stats: {
          generation: state.generation,
          offset: state.offset,
          pageCount: state.pageCount,
          processedThisChunk,
        },
      } satisfies StreamChunkResult;
    }
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: {
      generation: state.generation,
      offset: state.offset,
      pageCount: state.pageCount,
      processedThisChunk,
    },
  } satisfies StreamChunkResult;
}

export async function executeFollowersChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: SyncStreamStateRow;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("Follower sync is only supported for Fansly pages");
  }

  await input.telemetry.recordPhaseStarted("followers");
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "followers");
  await input.telemetry.recordCheckpointLoaded("followers", summarizeCheckpoint(checkpoint));
  const existingState = parseFollowersCheckpointState(checkpoint?.state, input.streamState.desiredRevision);

  let state = existingState;
  if (!state) {
    const accountMe = await refreshPageMetadata(app, input.pageContext, undefined, input.telemetry);
    state = {
      revision: input.streamState.desiredRevision,
      knownFollowId: checkpoint?.cursorText ?? null,
      newestFollowId: null,
      offset: 0,
      pageCount: 0,
      sourceFollowerCount: accountMe.parsed.account.followCount,
    };
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "followers",
      state,
    });
  }

  let processedThisChunk = 0;
  let sawKnownCheckpoint = false;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    const page = await app.adapter.getFollowersPage(
      requestContext,
      getFanslyPlatformAccountIdValue(input.pageContext),
      {
        offset: state.offset,
        limit: 100,
        minDelayMs: app.config.followerPageDelayMs,
      },
    );
    state = {
      ...state,
      pageCount: state.pageCount + 1,
      newestFollowId: state.newestFollowId ?? page.items[0]?.id ?? null,
    };

    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "followers",
      requestParams: { offset: state.offset, limit: 100, mode: "incremental" },
      responsePayload: trimFanslyFollowerPayload(page.raw),
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting followers raw payload",
    });

    const fanRows = await upsertFans(app.db, page.accounts.map((account) => ({
      platform: "fansly" as const,
      platformUserId: account.id,
      username: account.username,
      displayName: account.displayName,
      createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
      metadata: {},
    })));
    const fanMap = new Map(fanRows.map((fan) => [fan.platformUserId, fan.id]));

    let reachedBoundary = false;
    const followInputs: UpsertPageFollowInput[] = [];
    const fanPageInputs: UpsertFanPageInput[] = [];
    for (const follower of page.items) {
      if (state.knownFollowId && follower.id === state.knownFollowId) {
        sawKnownCheckpoint = true;
        reachedBoundary = true;
        break;
      }

      const fanId = fanMap.get(follower.followerId);
      if (!fanId) {
        continue;
      }

      const followedAt = fanslyFollowIdToDate(follower.id);
      followInputs.push({
        platformAccountId: input.pageContext.page.id,
        fanId,
        platformFollowId: follower.id,
        followedAt,
      });
      fanPageInputs.push({
        fanId,
        platformAccountId: input.pageContext.page.id,
        isFollower: true,
        followerSince: followedAt,
      });
    }
    processedThisChunk += followInputs.length;

    if (reachedBoundary || page.done) {
      const newestFollowId = state.newestFollowId ?? state.knownFollowId;
      const completedCheckpoint = await app.db.transaction(async (tx) => {
        const dbTx = tx as typeof app.db;
        await upsertPageFollows(dbTx, followInputs);
        await upsertFanPages(dbTx, fanPageInputs);
        await rebuildFollowerRollups(dbTx, input.pageContext.page.id, state.sourceFollowerCount);
        await updateLegacySyncTimestamp(dbTx, {
          platformAccountId: input.pageContext.page.id,
          syncType: "followers",
        });
        return upsertCheckpoint(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "followers",
          cursorText: newestFollowId,
          state,
          lastSuccessfulRunId: input.syncRunId,
        });
      });
      await input.telemetry.recordCheckpointAdvanced("followers", summarizeCheckpoint(completedCheckpoint));

      const activeFollowerCount = await countActivePageFollows(app.db, input.pageContext.page.id);
      if (
        activeFollowerCount !== state.sourceFollowerCount ||
        (!!state.knownFollowId && page.done && !sawKnownCheckpoint) ||
        (!!state.knownFollowId && newestFollowId === state.knownFollowId && processedThisChunk > 0)
      ) {
        await triggerFollowersReconcileAnomaly(app, input.pageContext.page.id);
      }

      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          pageCount: state.pageCount,
          processedThisChunk,
          sourceFollowerCount: state.sourceFollowerCount,
          sawKnownCheckpoint,
        },
      } satisfies StreamChunkResult;
    }

    await upsertPageFollows(app.db, followInputs);
    await upsertFanPages(app.db, fanPageInputs);
    state = {
      ...state,
      offset: state.offset + 100,
    };
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "followers",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced("followers", summarizeCheckpoint(progressCheckpoint));

    if (input.budget.shouldYield()) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        stats: {
          offset: state.offset,
          pageCount: state.pageCount,
          processedThisChunk,
          newestFollowId: state.newestFollowId,
        },
      } satisfies StreamChunkResult;
    }
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: {
      offset: state.offset,
      pageCount: state.pageCount,
      processedThisChunk,
      newestFollowId: state.newestFollowId,
    },
  } satisfies StreamChunkResult;
}

export async function executeFollowersReconcileChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: SyncStreamStateRow;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("Follower reconcile is only supported for Fansly pages");
  }

  await input.telemetry.recordPhaseStarted("followers_reconcile");
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "followers_reconcile");
  await input.telemetry.recordCheckpointLoaded("followers_reconcile", summarizeCheckpoint(checkpoint));

  const existingState = parseFollowersReconcileCheckpointState(
    checkpoint?.state,
    input.streamState.desiredRevision,
  );
  const previousGeneration = asNumber(asRecord(checkpoint?.state)?.generation) ?? 0;
  let state = existingState;
  if (!state) {
    const accountMe = await refreshPageMetadata(app, input.pageContext, undefined, input.telemetry);
    state = {
      revision: input.streamState.desiredRevision,
      generation: previousGeneration + 1,
      offset: 0,
      pageCount: 0,
      sourceFollowerCount: accountMe.parsed.account.followCount,
    };
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "followers_reconcile",
      state,
    });
  }

  let processedThisChunk = 0;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    const page = await app.adapter.getFollowersPage(
      requestContext,
      getFanslyPlatformAccountIdValue(input.pageContext),
      {
        offset: state.offset,
        limit: 100,
        minDelayMs: app.config.followerPageDelayMs,
      },
    );
    state = {
      ...state,
      pageCount: state.pageCount + 1,
    };

    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "followers",
      requestParams: { offset: state.offset, limit: 100, mode: "reconcile" },
      responsePayload: trimFanslyFollowerPayload(page.raw),
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting followers raw payload",
    });

    const fanRows = await upsertFans(app.db, page.accounts.map((account) => ({
      platform: "fansly" as const,
      platformUserId: account.id,
      username: account.username,
      displayName: account.displayName,
      createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
      metadata: {},
    })));
    const fanMap = new Map(fanRows.map((fan) => [fan.platformUserId, fan.id]));

    const followInputs: UpsertPageFollowInput[] = [];
    const fanPageInputs: UpsertFanPageInput[] = [];
    for (const follower of page.items) {
      const fanId = fanMap.get(follower.followerId);
      if (!fanId) {
        continue;
      }

      const followedAt = fanslyFollowIdToDate(follower.id);
      followInputs.push({
        platformAccountId: input.pageContext.page.id,
        fanId,
        platformFollowId: follower.id,
        followedAt,
        lastSeenGeneration: state.generation,
      });
      fanPageInputs.push({
        fanId,
        platformAccountId: input.pageContext.page.id,
        isFollower: true,
        followerSince: followedAt,
      });
    }
    processedThisChunk += followInputs.length;

    if (page.done) {
      const completedCheckpoint = await app.db.transaction(async (tx) => {
        const dbTx = tx as typeof app.db;
        await upsertPageFollows(dbTx, followInputs);
        await upsertFanPages(dbTx, fanPageInputs);
        await deactivatePageFollowsByGeneration(dbTx, {
          platformAccountId: input.pageContext.page.id,
          generation: state.generation,
        });
        await refreshFanPageFollowerState(dbTx, input.pageContext.page.id);
        await rebuildFollowerRollups(dbTx, input.pageContext.page.id, state.sourceFollowerCount);
        await updateLegacySyncTimestamp(dbTx, {
          platformAccountId: input.pageContext.page.id,
          syncType: "followers",
        });
        return upsertCheckpoint(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "followers_reconcile",
          state,
          lastSuccessfulRunId: input.syncRunId,
        });
      });
      await input.telemetry.recordCheckpointAdvanced(
        "followers_reconcile",
        summarizeCheckpoint(completedCheckpoint),
      );
      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          generation: state.generation,
          pageCount: state.pageCount,
          processedThisChunk,
          sourceFollowerCount: state.sourceFollowerCount,
        },
      } satisfies StreamChunkResult;
    }

    await upsertPageFollows(app.db, followInputs);
    await upsertFanPages(app.db, fanPageInputs);
    state = {
      ...state,
      offset: state.offset + 100,
    };
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "followers_reconcile",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "followers_reconcile",
      summarizeCheckpoint(progressCheckpoint),
    );

    if (input.budget.shouldYield()) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        stats: {
          generation: state.generation,
          offset: state.offset,
          pageCount: state.pageCount,
          processedThisChunk,
        },
      } satisfies StreamChunkResult;
    }
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: {
      generation: state.generation,
      offset: state.offset,
      pageCount: state.pageCount,
      processedThisChunk,
    },
  } satisfies StreamChunkResult;
}

export async function executeDmConversationsChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: SyncStreamStateRow;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("DM conversation sync is only supported for Fansly pages");
  }

  assertDmSharedRateLimitEnabled(app);
  await input.telemetry.recordPhaseStarted("dm_conversations");

  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "dm_conversations");
  await input.telemetry.recordCheckpointLoaded("dm_conversations", summarizeCheckpoint(checkpoint));

  const pageAccountId = getFanslyPlatformAccountIdValue(input.pageContext);
  const checkpointStateRecord = asRecord(checkpoint?.state);
  const existingState = parseDmConversationCheckpointState(checkpoint?.state);
  let state = existingState ?? {
    version: 1 as const,
    mode: "full_scan" as const,
    generation: (asNumber(checkpointStateRecord?.generation) ?? 0) + 1,
    offset: 0,
    pageCount: 0,
    providerReportedTotal: null,
    unchangedPageStreak: 0,
    fullSweepStartedAt: new Date().toISOString(),
    lastFullSweepCompletedAt: asNullableString(checkpointStateRecord?.lastFullSweepCompletedAt),
  };

  if (!existingState) {
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "dm_conversations",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "dm_conversations",
      summarizeCheckpoint(progressCheckpoint),
    );
  }

  let processedConversations = 0;
  let repairedHeads = 0;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    const page = await app.adapter.getMessagingGroupsPage(requestContext, {
      limit: 100,
      offset: state.offset,
      sortOrder: 1,
      flags: 0,
    });
    state = {
      ...state,
      pageCount: state.pageCount + 1,
      providerReportedTotal: state.providerReportedTotal ?? page.total ?? null,
    };

    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "dm_conversations",
      requestParams: { offset: state.offset, limit: 100, sortOrder: 1, flags: 0 },
      responsePayload: trimFanslyMessagingGroupsPayload(page.raw),
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "dm_metadata",
      retainUntil: dmRetentionDate(),
    }, {
      action: "inserting dm conversations raw payload",
    });

    const accountsById = new Map(page.accounts.map((account) => [account.id, account]));
    const groupsById = new Map(page.groups.map((group) => [group.id, group]));
    let unchangedPage = true;

    for (const conversation of page.items) {
      const existing = await app.db.query.pageDmConversations.findFirst({
        where: and(
          eq(pageDmConversations.platformAccountId, input.pageContext.page.id),
          eq(pageDmConversations.platformConversationId, conversation.groupId),
        ),
      });
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

      let fanId: number | null = partnerMissingFromAggregationAccounts
        ? existing?.fanId ?? null
        : null;
      if (partnerPlatformUserId && !partnerMissingFromAggregationAccounts) {
        const [fan] = await upsertFans(app.db, [{
          platform: "fansly",
          platformUserId: partnerPlatformUserId,
          username: partnerUsername,
          displayName: partnerDisplayName,
          createdAtExternal: partnerSnapshot?.createdAt
            ? normalizeFanslyTimestamp(partnerSnapshot.createdAt)
            : null,
          metadata: {},
        }]);
        fanId = fan?.id ?? null;
        if (fanId) {
          await upsertFanPages(app.db, [{
            fanId,
            platformAccountId: input.pageContext.page.id,
          }]);
        }
      }

      let headMessage = group?.lastMessage ?? detail?.parsed.lastMessage ?? null;
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
        const repairedHead = headRepair.items[0] ?? null;
        if (repairedHead) {
          repairedHeads += 1;
          headMessage = repairedHead;
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
      const metadata = buildFanslyDmConversationMetadata({
        unresolvedIdentity: !partnerPlatformUserId,
        messageSyncExcludedReason: partnerMissingFromAggregationAccounts
          ? FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS
          : null,
      });

      if (
        !existing ||
        existing.lastMessageId !== (conversation.lastMessageId ?? null) ||
        existing.unreadCount !== conversation.unreadCount ||
        existing.fanId !== fanId ||
        !existing.isVisible ||
        hasUnresolvedIdentityMetadata(existing?.metadata) !== hasUnresolvedIdentityMetadata(metadata) ||
        getFanslyDmMessageSyncExcludedReason(existing?.metadata) !==
          getFanslyDmMessageSyncExcludedReason(metadata)
      ) {
        unchangedPage = false;
      }

      await upsertPageDmConversation(app.db, {
        platformAccountId: input.pageContext.page.id,
        fanId,
        platformConversationId: conversation.groupId,
        partnerPlatformUserId,
        partnerUsername,
        partnerDisplayName,
        conversationFlags: conversation.flags,
        unreadCount: conversation.unreadCount,
        subscriptionTierId: conversation.subscriptionTierId ?? null,
        lastMessageId: conversation.lastMessageId ?? null,
        lastUnreadMessageId: conversation.lastUnreadMessageId ?? null,
        lastMessageAt: lastMessageAt ?? existing?.lastMessageAt ?? null,
        lastMessageSenderId: lastMessageSenderId ?? existing?.lastMessageSenderId ?? null,
        lastMessageSenderRole: lastMessageAt && lastMessageSenderId
          ? lastMessageSenderRole
          : existing?.lastMessageSenderRole ?? "unknown",
        lastMessagePreview: lastMessagePreview ?? existing?.lastMessagePreview ?? null,
        lastFanMessageAt: preservedLastFanMessageAt,
        lastModelMessageAt: preservedLastModelMessageAt,
        storedMessageCount: existing?.storedMessageCount ?? 0,
        newestStoredMessageId: existing?.newestStoredMessageId ?? null,
        oldestStoredMessageId: existing?.oldestStoredMessageId ?? null,
        messageBackfillComplete: existing?.messageBackfillComplete ?? false,
        lastMessageSyncAt: existing?.lastMessageSyncAt ?? null,
        isVisible: true,
        lastSeenGeneration: state.generation,
        metadata,
      });
      processedConversations += 1;
    }

    state = {
      ...state,
      unchangedPageStreak: unchangedPage ? state.unchangedPageStreak + 1 : 0,
    };

    if (page.done) {
      await markPageDmConversationsInvisibleByGeneration(app.db, {
        platformAccountId: input.pageContext.page.id,
        generation: state.generation,
      });
      const completedState = {
        version: 1,
        generation: state.generation,
        lastFullSweepCompletedAt: new Date().toISOString(),
      };
      const completedCheckpoint = await upsertCheckpoint(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "dm_conversations",
        state: completedState,
        lastSuccessfulRunId: input.syncRunId,
      });
      await input.telemetry.recordCheckpointAdvanced(
        "dm_conversations",
        summarizeCheckpoint(completedCheckpoint),
      );
      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          generation: state.generation,
          offset: state.offset,
          pageCount: state.pageCount,
          processedConversations,
          repairedHeads,
          providerReportedTotal: state.providerReportedTotal,
          fullSweepCompleted: true,
        },
      } satisfies StreamChunkResult;
    }

    state = {
      ...state,
      offset: state.offset + 100,
    };
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "dm_conversations",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "dm_conversations",
      summarizeCheckpoint(progressCheckpoint),
    );
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: {
      generation: state.generation,
      offset: state.offset,
      pageCount: state.pageCount,
      processedConversations,
      repairedHeads,
      providerReportedTotal: state.providerReportedTotal,
      fullSweepCompleted: false,
    },
  } satisfies StreamChunkResult;
}

export async function executeDmMessagesChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: SyncStreamStateRow;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("DM message sync is only supported for Fansly pages");
  }

  assertDmSharedRateLimitEnabled(app);
  await input.telemetry.recordPhaseStarted("dm_messages");

  const chunkStartedAt = Date.now();
  const dmMessagesRequestObserver = new DmMessagesChunkRequestObserver();
  let emittedDmMessagesChunkSummary: DmMessagesChunkSummary | null = null;

  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    requestObserver: composeRequestObservers(
      input.telemetry.getRequestObserver(),
      input.budget,
      dmMessagesRequestObserver,
    ),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "dm_messages");
  await input.telemetry.recordCheckpointLoaded("dm_messages", summarizeCheckpoint(checkpoint));

  let state = parseDmMessagesCheckpointState(checkpoint?.state) ?? emptyDmMessagesCheckpointState();

  if (!parseDmMessagesCheckpointState(checkpoint?.state)) {
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "dm_messages",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "dm_messages",
      summarizeCheckpoint(progressCheckpoint),
    );
  }

  const pageAccountId = getFanslyPlatformAccountIdValue(input.pageContext);
  let processedMessages = 0;
  let completedConversations = 0;
  let overlapHits = 0;
  let exhaustedEligibleConversations = false;

  const emitDmMessagesChunkSummary = async () => {
    if (emittedDmMessagesChunkSummary) {
      return emittedDmMessagesChunkSummary;
    }

    emittedDmMessagesChunkSummary = dmMessagesRequestObserver.buildSummary(Date.now() - chunkStartedAt);
    await input.telemetry.recordDmMessagesChunkSummary(emittedDmMessagesChunkSummary);
    return emittedDmMessagesChunkSummary;
  };

  try {
    while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
      let conversation = state.currentConversationId
        ? await getPageDmConversationById(app.db, state.currentConversationId)
        : null;

      if (conversation && isFanslyDmMessageSyncExcluded(conversation.metadata)) {
        state = emptyDmMessagesCheckpointState();
        const progressCheckpoint = await upsertCheckpointProgress(app.db, {
          platformAccountId: input.pageContext.page.id,
          stream: "dm_messages",
          state,
        });
        await input.telemetry.recordCheckpointAdvanced(
          "dm_messages",
          summarizeCheckpoint(progressCheckpoint),
        );
        conversation = null;
      }

      if (!conversation || !conversation.isVisible || conversation.fanId === null) {
        const candidate = await selectNextPageDmMessageSyncCandidate(app.db, {
          platformAccountId: input.pageContext.page.id,
        });
        if (!candidate) {
          exhaustedEligibleConversations = true;
          break;
        }

        conversation = await getPageDmConversationById(app.db, candidate.id);
        if (!conversation) {
          exhaustedEligibleConversations = true;
          break;
        }

        const currentMode = conversation.storedMessageCount === 0
          ? "backfill"
          : conversation.lastMessageId !== conversation.newestStoredMessageId
            ? "incremental"
            : conversation.messageBackfillComplete
              ? "incremental"
              : "backfill";

        state = {
          ...emptyDmMessagesCheckpointState(),
          currentConversationId: conversation.id,
          currentPlatformConversationId: conversation.platformConversationId,
          currentBeforeMessageId: currentMode === "backfill"
            ? conversation.oldestStoredMessageId
            : null,
          currentMode,
        };
        const progressCheckpoint = await upsertCheckpointProgress(app.db, {
          platformAccountId: input.pageContext.page.id,
          stream: "dm_messages",
          state,
        });
        await input.telemetry.recordCheckpointAdvanced(
          "dm_messages",
          summarizeCheckpoint(progressCheckpoint),
        );
      }

      if (!conversation || !state.currentMode) {
        exhaustedEligibleConversations = true;
        break;
      }

      let collectedThisConversation = 0;
      while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
        dmMessagesRequestObserver.recordConversationTouched(conversation.id);

        const page = await app.adapter.getMessagesPage(requestContext, {
          groupId: conversation.platformConversationId,
          limit: 25,
          before: state.currentBeforeMessageId,
        });
        const existingIds = await getExistingPageDmMessageIds(app.db, {
          conversationId: conversation.id,
          platformMessageIds: page.items.map((message) => message.id),
        });
        const overlapFound = page.items.some((message) => existingIds.has(message.id));

        const normalizedMessages = [];
        for (const message of page.items) {
          const createdAt = await normalizeDmTimestampWithAnomaly(input.telemetry, {
            context: "dm_messages:message",
            value: message.createdAt,
          });
          if (!createdAt) {
            continue;
          }

          normalizedMessages.push({
            conversationId: conversation.id,
            platformAccountId: input.pageContext.page.id,
            platformMessageId: message.id,
            senderPlatformUserId: message.senderId ?? null,
            senderRole: resolveDmSenderRole(
              message.senderId ?? null,
              pageAccountId,
              conversation.partnerPlatformUserId,
            ),
            createdAt,
            content: message.content ?? "",
            totalTipAmountCents: message.totalTipAmount ?? 0,
            inReplyToMessageId: message.inReplyTo ?? null,
            inReplyToRootMessageId: message.inReplyToRoot ?? null,
          });
        }
        await upsertPageDmMessages(app.db, normalizedMessages);
        collectedThisConversation += normalizedMessages
          .filter((message) => !existingIds.has(message.platformMessageId))
          .length;
        processedMessages += normalizedMessages.length;

        const oldestMessageId = page.items.at(-1)?.id ?? null;
        const providerHistoryExhausted = page.done || !oldestMessageId;
        const hitWindowCap =
          state.currentMode === "backfill" &&
          (conversation.storedMessageCount + collectedThisConversation) >= PAGE_DM_MESSAGE_HISTORY_LIMIT;
        const shouldComplete = state.currentMode === "incremental"
          ? overlapFound || providerHistoryExhausted
          : overlapFound || providerHistoryExhausted || hitWindowCap;

        if (shouldComplete) {
          if (overlapFound) {
            overlapHits += 1;
          }
          const finalized = await finalizePageDmConversationMessageSync(app.db, {
            conversationId: conversation.id,
            messageBackfillComplete: state.currentMode === "backfill"
              ? providerHistoryExhausted || hitWindowCap
              : conversation.messageBackfillComplete,
          });
          conversation = finalized.conversation;
          completedConversations += 1;
          state = emptyDmMessagesCheckpointState();
          const progressCheckpoint = await upsertCheckpointProgress(app.db, {
            platformAccountId: input.pageContext.page.id,
            stream: "dm_messages",
            state,
          });
          await input.telemetry.recordCheckpointAdvanced(
            "dm_messages",
            summarizeCheckpoint(progressCheckpoint),
          );
          break;
        }

        state = {
          ...state,
          currentBeforeMessageId: oldestMessageId,
        };
        const progressCheckpoint = await upsertCheckpointProgress(app.db, {
          platformAccountId: input.pageContext.page.id,
          stream: "dm_messages",
          state,
        });
        await input.telemetry.recordCheckpointAdvanced(
          "dm_messages",
          summarizeCheckpoint(progressCheckpoint),
        );

        if (input.budget.shouldYield()) {
          break;
        }
      }
    }

    const dmMessagesChunk = await emitDmMessagesChunkSummary();

    if (!exhaustedEligibleConversations) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        stats: {
          currentConversationId: state.currentConversationId,
          currentBeforeMessageId: state.currentBeforeMessageId,
          currentMode: state.currentMode,
          processedMessages,
          completedConversations,
          overlapHits,
          dmMessagesChunk,
        },
      } satisfies StreamChunkResult;
    }

    const completedCheckpoint = await upsertCheckpoint(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "dm_messages",
      state,
      lastSuccessfulRunId: input.syncRunId,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "dm_messages",
      summarizeCheckpoint(completedCheckpoint),
    );

    return {
      satisfied: true,
      yieldReason: null,
      stats: {
        currentConversationId: state.currentConversationId,
        currentBeforeMessageId: state.currentBeforeMessageId,
        currentMode: state.currentMode,
        processedMessages,
        completedConversations,
        overlapHits,
        dmMessagesChunk,
      },
    } satisfies StreamChunkResult;
  } catch (error) {
    await emitDmMessagesChunkSummary().catch(() => undefined);
    throw error;
  }
}

export async function resolveExecutorPageContext(
  app: AppContext,
  platformAccountId: number,
) {
  return resolvePageContextById(app, platformAccountId);
}

export async function executeStreamChunk(
  app: AppContext,
  input: {
    pageContext: ResolvedPageContext;
    streamState: SyncStreamStateRow;
    syncRunId: number;
    telemetry: SyncRunTelemetry;
    budget: SyncChunkBudget;
  },
) {
  switch (input.streamState.stream) {
    case "light":
      return executeLightChunk(app, input);
    case "transactions":
      return executeTransactionsChunk(app, input);
    case "subscribers":
      return executeSubscribersChunk(app, input);
    case "dm_conversations":
      return executeDmConversationsChunk(app, input);
    case "dm_messages":
      return executeDmMessagesChunk(app, input);
    case "followers":
      return executeFollowersChunk(app, input);
    case "followers_reconcile":
      return executeFollowersReconcileChunk(app, input);
    default:
      throw new Error(`Unsupported executor stream "${input.streamState.stream}"`);
  }
}
