import {
  countActivePageFollows,
  deactivatePageFollowsByGeneration,
  deactivatePageSubscriptionsByGeneration,
  getCheckpoint,
  getCurrentSubscribers,
  rebuildFollowerRollups,
  rebuildSubscriberRollups,
  requestSyncStreamRevisions,
  updateLegacySyncTimestamp,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertFanPage,
  upsertFans,
  upsertPageFollow,
  upsertPageSubscription,
  refreshFanPageFollowerState,
  refreshFanPageSubscriberState,
  type SyncStreamStateRow,
} from "@agency_hub_core/db";
import {
  FANSLY_MAPPER_VERSION,
  mapFanslySubscriptionStatus,
} from "@agency_hub_core/fansly";
import { fanslyFollowIdToDate, toMills } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  resolvePageContextById,
  type ResolvedPageContext,
} from "../page-context.ts";
import { syncOnlyFansTransactions } from "./onlyfans-transactions.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { composeRequestObservers, type SyncChunkYieldReason, type SyncChunkBudget } from "./chunk-budget.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import {
  persistRawPayload,
  refreshPageMetadata,
  retentionDate,
  trimFanslyFollowerPayload,
} from "./shared.ts";
import { hydrateFans } from "./fan-hydration.ts";
import { syncTransactions } from "./transactions.ts";

type ExecutorRequestContext = {
  budget: SyncChunkBudget;
  pageContext: ResolvedPageContext;
  telemetry: SyncRunTelemetry;
};

export type StreamChunkResult = {
  satisfied: boolean;
  yieldReason: SyncChunkYieldReason | null;
  clearRequestPayload?: boolean;
  stats?: Record<string, unknown>;
};

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

function buildOnlyFansRequestContext(app: AppContext, input: ExecutorRequestContext) {
  if (input.pageContext.platform !== "onlyfans") {
    throw new Error("Expected an OnlyFans page context");
  }

  return {
    auth: input.pageContext.auth,
    proxy: input.pageContext.proxy,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createSyncRateLimitWaiter(app),
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
        rateLimitWaiter: createSyncRateLimitWaiter(app),
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
  });

  return {
    satisfied: true,
    yieldReason: null,
    clearRequestPayload: Boolean(transactionsStart),
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
    rateLimitWaiter: createSyncRateLimitWaiter(app),
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

    for (const item of page.items) {
      const fanId = fanMap.get(item.subscriberId);
      if (!fanId) {
        continue;
      }

      const sourceCreatedAt = item.createdAt ? new Date(item.createdAt) : null;
      const endsAt = item.endsAt ? new Date(item.endsAt) : null;
      const autoRenew = item.autoRenew === null ? null : item.autoRenew === 1;
      const canonicalStatus = mapFanslySubscriptionStatus(item.status);
      await upsertPageSubscription(app.db, {
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
      await upsertFanPage(app.db, {
        fanId,
        platformAccountId: input.pageContext.page.id,
        isSubscriber: true,
        subscriberSince: sourceCreatedAt,
        subscriptionExpiresAt: endsAt,
        autoRenew,
      });
      processedThisChunk += 1;
    }

    if (page.done) {
      await deactivatePageSubscriptionsByGeneration(app.db, {
        platformAccountId: input.pageContext.page.id,
        generation: state.generation,
      });
      await refreshFanPageSubscriberState(app.db, input.pageContext.page.id);
      await rebuildSubscriberRollups(app.db, input.pageContext.page.id);
      const completedCheckpoint = await upsertCheckpoint(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "subscribers",
        state,
        lastSuccessfulRunId: input.syncRunId,
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
    rateLimitWaiter: createSyncRateLimitWaiter(app),
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
      await upsertPageFollow(app.db, {
        platformAccountId: input.pageContext.page.id,
        fanId,
        platformFollowId: follower.id,
        followedAt,
      });
      await upsertFanPage(app.db, {
        fanId,
        platformAccountId: input.pageContext.page.id,
        isFollower: true,
        followerSince: followedAt,
      });
      processedThisChunk += 1;
    }

    if (reachedBoundary || page.done) {
      const newestFollowId = state.newestFollowId ?? state.knownFollowId;
      const completedCheckpoint = await upsertCheckpoint(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "followers",
        cursorText: newestFollowId,
        state,
        lastSuccessfulRunId: input.syncRunId,
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

      await rebuildFollowerRollups(app.db, input.pageContext.page.id, state.sourceFollowerCount);
      await updateLegacySyncTimestamp(app.db, {
        platformAccountId: input.pageContext.page.id,
        syncType: "followers",
      });

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
    rateLimitWaiter: createSyncRateLimitWaiter(app),
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

    for (const follower of page.items) {
      const fanId = fanMap.get(follower.followerId);
      if (!fanId) {
        continue;
      }

      const followedAt = fanslyFollowIdToDate(follower.id);
      await upsertPageFollow(app.db, {
        platformAccountId: input.pageContext.page.id,
        fanId,
        platformFollowId: follower.id,
        followedAt,
        lastSeenGeneration: state.generation,
      });
      await upsertFanPage(app.db, {
        fanId,
        platformAccountId: input.pageContext.page.id,
        isFollower: true,
        followerSince: followedAt,
      });
      processedThisChunk += 1;
    }

    if (page.done) {
      await deactivatePageFollowsByGeneration(app.db, {
        platformAccountId: input.pageContext.page.id,
        generation: state.generation,
      });
      await refreshFanPageFollowerState(app.db, input.pageContext.page.id);
      await rebuildFollowerRollups(app.db, input.pageContext.page.id, state.sourceFollowerCount);
      await updateLegacySyncTimestamp(app.db, {
        platformAccountId: input.pageContext.page.id,
        syncType: "followers",
      });
      const completedCheckpoint = await upsertCheckpoint(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "followers_reconcile",
        state,
        lastSuccessfulRunId: input.syncRunId,
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
    case "followers":
      return executeFollowersChunk(app, input);
    case "followers_reconcile":
      return executeFollowersReconcileChunk(app, input);
    default:
      throw new Error(`Unsupported executor stream "${input.streamState.stream}"`);
  }
}
