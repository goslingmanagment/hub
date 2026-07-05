import {
  assertOwnedPageSyncLease,
  getCheckpoint,
  listOnlyFansPublicProfileResolutionCandidates,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertFanPages,
  upsertFans,
  upsertOnlyFansPublicProfileResolution,
  withOwnedPageSyncTransaction,
} from "@agency_hub_core/db";
import { ONLYMONSTER_MAPPER_VERSION, type OnlyMonsterLinkUser } from "@agency_hub_core/onlyfans";

import type { AppContext } from "../../bootstrap.ts";
import {
  createOnlyFansPublicProfileResolver,
  getOnlyFansPublicProfileEgressKey,
  type OnlyFansPublicProfileResolveResult,
  type OnlyFansPublicProfileResolver,
} from "../onlyfans-public-profiles.ts";
import type { SyncChunkBudget, SyncChunkYieldReason } from "./chunk-budget.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { persistRawPayload, retentionDate } from "./shared.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ONLYFANS_IDENTITY_PAGE_LIMIT = 750;
const ONLYFANS_IDENTITY_INCREMENTAL_LOOKBACK_MS = 7 * DAY_MS;
const ONLYFANS_PUBLIC_PROFILE_RESOLVED_COOLDOWN_MS = 90 * DAY_MS;
const ONLYFANS_PUBLIC_PROFILE_UNAVAILABLE_COOLDOWN_MS = 30 * DAY_MS;
const ONLYFANS_PUBLIC_PROFILE_RATE_LIMIT_COOLDOWN_MS = DAY_MS;
const ONLYFANS_PUBLIC_PROFILE_FAILED_BASE_COOLDOWN_MS = DAY_MS;
const ONLYFANS_PUBLIC_PROFILE_FAILED_MAX_COOLDOWN_MS = 14 * DAY_MS;

type OnlyFansIdentityPhase = "tracking_link_users" | "trial_link_users";

type OnlyFansIdentityResumeState = {
  mode: "backfill" | "incremental";
  completed: false;
  provider: "onlyfans";
  stream: "fan_identities";
  phase: OnlyFansIdentityPhase;
  collectedFrom: string | null;
  collectedTo: string;
  cursor: string | null;
  processedTrackingUsers: number;
  processedTrialUsers: number;
  trackingPages: number;
  trialPages: number;
  upsertedFans: number;
  newestCollectedAt: string | null;
};

export type OnlyFansIdentitySyncResult = {
  satisfied: boolean;
  yieldReason: SyncChunkYieldReason | null;
  processed: number;
  processedTrackingUsers: number;
  processedTrialUsers: number;
  upsertedFans: number;
  publicProfilesAttempted: number;
  publicProfilesResolved: number;
  newestCollectedAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asIsoString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asNullableIsoString(value: unknown) {
  if (value === null) {
    return null;
  }

  return asIsoString(value);
}

function asNullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : null;
}

function asNonNegativeInt(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseOnlyFansIdentityResumeState(value: unknown): OnlyFansIdentityResumeState | null {
  const state = isRecord(value) ? value : null;
  if (
    !state ||
    (state.mode !== "backfill" && state.mode !== "incremental") ||
    state.completed !== false ||
    state.provider !== "onlyfans" ||
    state.stream !== "fan_identities" ||
    (state.phase !== "tracking_link_users" && state.phase !== "trial_link_users")
  ) {
    return null;
  }

  const collectedFrom = asNullableIsoString(state.collectedFrom);
  const collectedTo = asIsoString(state.collectedTo);
  const cursor = asNullableString(state.cursor);
  const processedTrackingUsers = asNonNegativeInt(state.processedTrackingUsers);
  const processedTrialUsers = asNonNegativeInt(state.processedTrialUsers);
  const trackingPages = asNonNegativeInt(state.trackingPages);
  const trialPages = asNonNegativeInt(state.trialPages);
  const upsertedFans = asNonNegativeInt(state.upsertedFans);
  const newestCollectedAt = asNullableIsoString(state.newestCollectedAt);

  if (
    collectedFrom === undefined ||
    collectedTo === null ||
    cursor === undefined ||
    processedTrackingUsers === null ||
    processedTrialUsers === null ||
    trackingPages === null ||
    trialPages === null ||
    upsertedFans === null ||
    newestCollectedAt === undefined
  ) {
    return null;
  }

  return {
    mode: state.mode,
    completed: false,
    provider: "onlyfans",
    stream: "fan_identities",
    phase: state.phase,
    collectedFrom,
    collectedTo,
    cursor,
    processedTrackingUsers,
    processedTrialUsers,
    trackingPages,
    trialPages,
    upsertedFans,
    newestCollectedAt,
  };
}

function buildOnlyFansIdentityInitialState(
  checkpoint: Awaited<ReturnType<typeof getCheckpoint>>,
  now: Date,
): OnlyFansIdentityResumeState {
  const collectedTo = now.toISOString();
  const cursorTimestamp = checkpoint?.cursorTimestamp ?? null;
  const collectedFrom = cursorTimestamp
    ? new Date(Math.max(0, cursorTimestamp.getTime() - ONLYFANS_IDENTITY_INCREMENTAL_LOOKBACK_MS)).toISOString()
    : null;

  return {
    mode: cursorTimestamp ? "incremental" : "backfill",
    completed: false,
    provider: "onlyfans",
    stream: "fan_identities",
    phase: "tracking_link_users",
    collectedFrom,
    collectedTo,
    cursor: null,
    processedTrackingUsers: 0,
    processedTrialUsers: 0,
    trackingPages: 0,
    trialPages: 0,
    upsertedFans: 0,
    newestCollectedAt: null,
  };
}

function normalizeIdentityText(value: string | null | undefined, options?: { stripHandlePrefix?: boolean }) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return options?.stripHandlePrefix ? trimmed.replace(/^@+/, "") : trimmed;
}

function normalizeDisplayName(value: string | null | undefined) {
  const normalized = normalizeIdentityText(value);
  if (!normalized || /^deleted\s+user$/i.test(normalized)) {
    return null;
  }

  return normalized;
}

function maxIsoDate(a: string | null, b: string | null) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }

  return new Date(a) >= new Date(b) ? a : b;
}

function newestCollectedAt(items: OnlyMonsterLinkUser[]) {
  return items.reduce<string | null>((newest, item) => {
    const parsed = asIsoString(item.collected_at);
    return maxIsoDate(newest, parsed);
  }, null);
}

async function upsertOnlyFansLinkUsersPage(
  db: AppContext["db"],
  input: {
    platformAccountId: number;
  },
  items: OnlyMonsterLinkUser[],
) {
  const fanInputs = items.flatMap((item) => {
    const platformUserId = normalizeIdentityText(item.fan.id);
    if (!platformUserId) {
      return [];
    }

    const username = normalizeIdentityText(item.fan.username, { stripHandlePrefix: true });
    const displayName = normalizeDisplayName(item.fan.name);
    return [{
      platform: "onlyfans" as const,
      platformUserId,
      ...(username ? { username } : {}),
      ...(displayName ? { displayName } : {}),
    }];
  });

  const fans = await upsertFans(db, fanInputs);
  if (fans.length > 0) {
    await upsertFanPages(db, fans.map((fan) => ({
      fanId: fan.id,
      platformAccountId: input.platformAccountId,
    })));
  }

  return fans.length;
}

function pageIndexForState(state: OnlyFansIdentityResumeState) {
  return state.phase === "tracking_link_users"
    ? state.trackingPages
    : state.trialPages;
}

function truncatePublicProfileError(value: string | null) {
  if (!value) {
    return null;
  }

  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function onlyFansPublicProfileNextAttemptAfter(
  result: OnlyFansPublicProfileResolveResult,
  previousAttemptCount: number,
  now: Date,
) {
  switch (result.status) {
    case "resolved":
      return new Date(now.getTime() + ONLYFANS_PUBLIC_PROFILE_RESOLVED_COOLDOWN_MS);
    case "not_found":
    case "unavailable":
      return new Date(now.getTime() + ONLYFANS_PUBLIC_PROFILE_UNAVAILABLE_COOLDOWN_MS);
    case "rate_limited":
      return new Date(now.getTime() + ONLYFANS_PUBLIC_PROFILE_RATE_LIMIT_COOLDOWN_MS);
    case "failed": {
      const multiplier = 2 ** Math.min(previousAttemptCount, 4);
      return new Date(now.getTime() + Math.min(
        ONLYFANS_PUBLIC_PROFILE_FAILED_MAX_COOLDOWN_MS,
        ONLYFANS_PUBLIC_PROFILE_FAILED_BASE_COOLDOWN_MS * multiplier,
      ));
    }
  }
}

async function persistOnlyFansPublicProfileResolution(
  db: AppContext["db"],
  input: {
    platformAccountId: number;
    fanId: number;
    platformUserId: string;
    previousAttemptCount: number;
    result: OnlyFansPublicProfileResolveResult;
    attemptedAt: Date;
  },
) {
  const nextAttemptAfter = onlyFansPublicProfileNextAttemptAfter(
    input.result,
    input.previousAttemptCount,
    input.attemptedAt,
  );

  if (input.result.status === "resolved") {
    const hasIdentity = Boolean(input.result.username || input.result.displayName);
    if (hasIdentity) {
      const upsertedFans = await upsertFans(db, [{
        platform: "onlyfans",
        platformUserId: input.platformUserId,
        ...(input.result.username ? { username: input.result.username } : {}),
        ...(input.result.displayName ? { displayName: input.result.displayName } : {}),
      }]);

      if (upsertedFans.length > 0) {
        await upsertFanPages(db, upsertedFans.map((fan) => ({
          fanId: fan.id,
          platformAccountId: input.platformAccountId,
        })));
      }
    }

    await upsertOnlyFansPublicProfileResolution(db, {
      fanId: input.fanId,
      platformUserId: input.platformUserId,
      status: hasIdentity ? "resolved" : "unavailable",
      username: hasIdentity ? input.result.username : null,
      displayName: hasIdentity ? input.result.displayName : null,
      attemptedAt: input.attemptedAt,
      resolvedAt: hasIdentity ? input.attemptedAt : null,
      nextAttemptAfter: hasIdentity
        ? nextAttemptAfter
        : new Date(input.attemptedAt.getTime() + ONLYFANS_PUBLIC_PROFILE_UNAVAILABLE_COOLDOWN_MS),
      lastError: hasIdentity ? null : "Public profile response did not contain username or display name",
    });
    return hasIdentity;
  }

  await upsertOnlyFansPublicProfileResolution(db, {
    fanId: input.fanId,
    platformUserId: input.platformUserId,
    status: input.result.status,
    attemptedAt: input.attemptedAt,
    resolvedAt: null,
    nextAttemptAfter,
    lastError: truncatePublicProfileError(input.result.error),
  });
  return false;
}

async function syncOnlyFansPublicProfileFallback(
  app: AppContext,
  input: {
    platformAccountId: number;
    telemetry: SyncRunTelemetry;
    budget: SyncChunkBudget;
    publicProfileResolver?: OnlyFansPublicProfileResolver;
  },
) {
  const emptyStats = {
    attempted: 0,
    resolved: 0,
  };

  if (!app.config.onlyFansPublicProfileResolutionEnabled) {
    return emptyStats;
  }

  const proxy = app.config.onlyFansPublicProfileProxy ?? null;
  const allowDirect = app.config.onlyFansPublicProfileAllowDirect ?? false;
  if (!proxy && !allowDirect) {
    await input.telemetry.addNote(
      "OnlyFans public profile fallback skipped because neither a dedicated proxy nor direct egress is enabled",
      { publicProfileFallback: "missing_proxy_or_direct_disabled" },
    );
    return emptyStats;
  }

  if (!input.budget.hasWallClockCapacity()) {
    await input.telemetry.addNote(
      "OnlyFans public profile fallback skipped because the sync chunk is out of wall-clock budget",
      { publicProfileFallback: "wall_clock_budget" },
    );
    return emptyStats;
  }

  const limit = app.config.onlyFansPublicProfileMaxPerRun ?? 5;
  const candidates = await listOnlyFansPublicProfileResolutionCandidates(app.db, {
    platformAccountId: input.platformAccountId,
    limit,
  });
  if (candidates.length === 0) {
    return emptyStats;
  }

  const resolver = input.publicProfileResolver ??
    createOnlyFansPublicProfileResolver({
      proxy,
      delayMs: app.config.onlyFansPublicProfileDelayMs ?? 30_000,
    });
  const shouldCloseResolver = !input.publicProfileResolver;
  let attempted = 0;
  let resolved = 0;
  let rateLimited = false;

  await input.telemetry.addNote("Starting OnlyFans public profile fallback", {
    candidateCount: candidates.length,
    maxPerRun: limit,
    egressKey: getOnlyFansPublicProfileEgressKey(proxy),
    directEgress: !proxy,
  });

  try {
    for (const candidate of candidates) {
      if (!input.budget.hasWallClockCapacity()) {
        break;
      }

      await assertOwnedPageSyncLease(app.db);
      const result = await resolver.resolve(candidate.platformUserId);
      const attemptedAt = new Date();
      attempted += 1;

      let didResolve = false;
      await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
        didResolve = await persistOnlyFansPublicProfileResolution(dbTx, {
          platformAccountId: input.platformAccountId,
          fanId: candidate.fanId,
          platformUserId: candidate.platformUserId,
          previousAttemptCount: candidate.previousAttemptCount,
          result,
          attemptedAt,
        });
      });

      if (didResolve) {
        resolved += 1;
      }
      if (result.status === "rate_limited") {
        rateLimited = true;
        break;
      }
    }
  } finally {
    if (shouldCloseResolver) {
      await resolver.close?.();
    }
  }

  await input.telemetry.addNote("Finished OnlyFans public profile fallback", {
    attempted,
    resolved,
    rateLimited,
  });

  return { attempted, resolved };
}

async function fetchOnlyFansIdentityPage(
  app: AppContext,
  input: {
    platformAccountIdValue: string;
    requestContext: Parameters<AppContext["onlyFansAdapter"]["getTrackingLinkUsersPage"]>[0];
  },
  state: OnlyFansIdentityResumeState,
) {
  const params = {
    collectedFrom: state.collectedFrom ? new Date(state.collectedFrom) : null,
    collectedTo: new Date(state.collectedTo),
    cursor: state.cursor,
    limit: ONLYFANS_IDENTITY_PAGE_LIMIT,
    pageIndex: pageIndexForState(state),
  };

  return state.phase === "tracking_link_users"
    ? app.onlyFansAdapter.getTrackingLinkUsersPage(
      input.requestContext,
      input.platformAccountIdValue,
      params,
    )
    : app.onlyFansAdapter.getTrialLinkUsersPage(
      input.requestContext,
      input.platformAccountIdValue,
      params,
    );
}

function advanceIdentityState(
  state: OnlyFansIdentityResumeState,
  input: {
    cursor: string | null;
    itemCount: number;
    upsertedFans: number;
    newestCollectedAt: string | null;
  },
) {
  const processedTrackingUsers = state.processedTrackingUsers +
    (state.phase === "tracking_link_users" ? input.itemCount : 0);
  const processedTrialUsers = state.processedTrialUsers +
    (state.phase === "trial_link_users" ? input.itemCount : 0);
  const trackingPages = state.trackingPages +
    (state.phase === "tracking_link_users" ? 1 : 0);
  const trialPages = state.trialPages +
    (state.phase === "trial_link_users" ? 1 : 0);
  const nextBase = {
    ...state,
    cursor: input.cursor,
    processedTrackingUsers,
    processedTrialUsers,
    trackingPages,
    trialPages,
    upsertedFans: state.upsertedFans + input.upsertedFans,
    newestCollectedAt: maxIsoDate(state.newestCollectedAt, input.newestCollectedAt),
  };

  if (input.cursor || state.phase === "trial_link_users") {
    return nextBase;
  }

  return {
    ...nextBase,
    phase: "trial_link_users" as const,
    cursor: null,
  };
}

export async function syncOnlyFansIdentities(
  app: AppContext,
  input: {
    pageLabel: string;
    platformAccountId: number;
    platformAccountIdValue: string;
    requestContext: Parameters<AppContext["onlyFansAdapter"]["getTrackingLinkUsersPage"]>[0];
    syncRunId: number;
    telemetry: SyncRunTelemetry;
    budget: SyncChunkBudget;
    publicProfileResolver?: OnlyFansPublicProfileResolver;
  },
): Promise<OnlyFansIdentitySyncResult> {
  const checkpoint = await getCheckpoint(app.db, input.platformAccountId, "fan_identities");
  await input.telemetry.recordCheckpointLoaded("fan_identities", summarizeCheckpoint(checkpoint));

  const resumeState = parseOnlyFansIdentityResumeState(checkpoint?.state);
  let state = resumeState ??
    buildOnlyFansIdentityInitialState(checkpoint, new Date());
  let currentRunProcessedTrackingUsers = 0;
  let currentRunProcessedTrialUsers = 0;
  let currentRunUpsertedFans = 0;

  await input.telemetry.addNote(
    resumeState
      ? "Resuming incomplete OnlyFans fan identity sync"
      : "Starting OnlyFans fan identity sync",
    {
      mode: state.mode,
      phase: state.phase,
      collectedFrom: state.collectedFrom,
      collectedTo: state.collectedTo,
      cursor: state.cursor,
    },
  );

  while (true) {
    await assertOwnedPageSyncLease(app.db);
    const currentPhase = state.phase;
    const page = await fetchOnlyFansIdentityPage(app, input, state);
    await persistRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: currentPhase,
      requestParams: {
        collectedFrom: state.collectedFrom,
        collectedTo: state.collectedTo,
        cursor: state.cursor,
        limit: ONLYFANS_IDENTITY_PAGE_LIMIT,
      },
      responsePayload: page.raw,
      mapperVersion: ONLYMONSTER_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: `inserting ${currentPhase} raw payload`,
      platform: "onlyfans",
    });
    const completed = currentPhase === "trial_link_users" && !page.parsed.cursor;
    const pageNewestCollectedAt = newestCollectedAt(page.parsed.items);
    let upsertedFansCount = 0;
    let nextState: OnlyFansIdentityResumeState | null = null;

    await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
      upsertedFansCount = await upsertOnlyFansLinkUsersPage(dbTx, {
        platformAccountId: input.platformAccountId,
      }, page.parsed.items);
      nextState = advanceIdentityState(state, {
        cursor: page.parsed.cursor ?? null,
        itemCount: page.parsed.items.length,
        upsertedFans: upsertedFansCount,
        newestCollectedAt: pageNewestCollectedAt,
      });
      await upsertCheckpointProgress(dbTx, {
        platformAccountId: input.platformAccountId,
        stream: "fan_identities",
        state: nextState,
      });
    });

    if (!nextState) {
      throw new Error("OnlyFans fan identity sync failed to advance state");
    }
    state = nextState;
    currentRunUpsertedFans += upsertedFansCount;
    if (currentPhase === "tracking_link_users") {
      currentRunProcessedTrackingUsers += page.parsed.items.length;
    } else {
      currentRunProcessedTrialUsers += page.parsed.items.length;
    }

    if (completed) {
      break;
    }

    if (input.budget.shouldYield()) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        processed: currentRunProcessedTrackingUsers + currentRunProcessedTrialUsers,
        processedTrackingUsers: currentRunProcessedTrackingUsers,
        processedTrialUsers: currentRunProcessedTrialUsers,
        upsertedFans: currentRunUpsertedFans,
        publicProfilesAttempted: 0,
        publicProfilesResolved: 0,
        newestCollectedAt: new Date(state.newestCollectedAt ?? state.collectedTo),
      };
    }
  }

  const publicProfileStats = await syncOnlyFansPublicProfileFallback(app, {
    platformAccountId: input.platformAccountId,
    telemetry: input.telemetry,
    budget: input.budget,
    publicProfileResolver: input.publicProfileResolver,
  });

  const checkpointTimestamp = new Date(state.newestCollectedAt ?? state.collectedTo);
  const checkpointAfter = await upsertCheckpoint(app.db, {
    platformAccountId: input.platformAccountId,
    stream: "fan_identities",
    cursorTimestamp: checkpointTimestamp,
    state: {
      pageLabel: input.pageLabel,
      mode: state.mode,
      collectedFrom: state.collectedFrom,
      collectedTo: state.collectedTo,
      processedTrackingUsers: state.processedTrackingUsers,
      processedTrialUsers: state.processedTrialUsers,
      upsertedFans: state.upsertedFans,
      newestCollectedAt: state.newestCollectedAt,
    },
    lastSuccessfulRunId: input.syncRunId,
  });
  await input.telemetry.recordCheckpointAdvanced("fan_identities", summarizeCheckpoint(checkpointAfter));

  return {
    satisfied: true,
    yieldReason: null,
    processed: currentRunProcessedTrackingUsers + currentRunProcessedTrialUsers,
    processedTrackingUsers: currentRunProcessedTrackingUsers,
    processedTrialUsers: currentRunProcessedTrialUsers,
    upsertedFans: currentRunUpsertedFans,
    publicProfilesAttempted: publicProfileStats.attempted,
    publicProfilesResolved: publicProfileStats.resolved,
    newestCollectedAt: checkpointTimestamp,
  };
}
