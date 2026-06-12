// OFAPI-backed OnlyFans audience sync (Phase 3 of docs/ofapi-parity-plan.md,
// D6/D8): the subscribers executor stream for OnlyFans pages mapped to an OFAPI
// account, behind OFAPI_AUDIENCE_SYNC_ENABLED. A budgeted fans/active offset
// sweep (own daily ceiling so it can never starve DM sync) feeds the same
// page_subscriptions / page_fans tables Fansly fills, with the Fansly
// generational expiry at end of sweep; per-fan lastSeen lands in the shared
// presence store. Live updates between sweeps come from the
// subscriptions.new/renewed projection (ofapi-subscription-projection.ts).

import {
  assertOwnedPageSyncLease,
  deactivatePageSubscriptionsByGeneration,
  findPageById,
  getCheckpoint,
  getCurrentSubscribers,
  listPageSyncStates,
  listPagesByPlatform,
  pausePageSync,
  rebuildSubscriberRollups,
  refreshFanPageSubscriberState,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertFanPageExternalPresences,
  upsertFanPages,
  upsertFans,
  upsertPageSubscriptions,
  withOwnedPageSyncTransaction,
  type Database,
  type PageSyncLease,
  type SyncStream,
  type UpsertFanPageExternalPresenceInput,
  type UpsertFanPageInput,
  type UpsertPageSubscriptionInput,
} from "@agency_hub_core/db";
import {
  dollarsToMills,
  OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN,
} from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { asRecord, idToString } from "../ofapi-payloads.ts";
import type { OfapiClient, OfapiRequestContext } from "../ofapi.ts";
import type { ResolvedPageContext } from "../page-context.ts";
import { composeRequestObservers, type SyncChunkBudget } from "./chunk-budget.ts";
import {
  emptyOfapiAudienceCursorState,
  parseOfapiAudienceCursorState,
} from "./cursor-state.ts";
import {
  budgetBlockResult,
  createOfapiRestGuard,
  type OfapiStreamChunkResult,
} from "./ofapi-dm-sync.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";

// fans/active hard-caps limit at 20 per the OFAPI OpenAPI validation text.
const OFAPI_FANS_PAGE_LIMIT = 20;
const DEFAULT_MAX_REQUESTS_PER_RUN = 25;
const DEFAULT_DAILY_CREDIT_BUDGET = 300;
const DEFAULT_SWEEP_INTERVAL_MINUTES = 1440;

export const ONLYFANS_AUDIENCE_STREAMS = [
  "subscribers",
] as const satisfies SyncStream[];

type ExecutorRequestContext = {
  budget: SyncChunkBudget;
  pageContext: ResolvedPageContext;
  telemetry: SyncRunTelemetry;
};

export function isOfapiAudienceSyncEnabled(
  config?: Pick<AppContext["config"], "ofapiAudienceSyncEnabled">,
) {
  return config?.ofapiAudienceSyncEnabled === true;
}

/** D8 eligibility: OnlyFans platform + OFAPI account mapping + flag on. */
export function isOfapiAudienceSyncEligiblePage(
  config: Pick<AppContext["config"], "ofapiAudienceSyncEnabled"> | undefined,
  page: { platform: string; ofapiAccountId: string | null },
) {
  return isOfapiAudienceSyncEnabled(config) &&
    page.platform === "onlyfans" &&
    typeof page.ofapiAccountId === "string" &&
    page.ofapiAccountId.length > 0;
}

export function isOnlyFansAudienceStream(stream: SyncStream) {
  return (ONLYFANS_AUDIENCE_STREAMS as readonly SyncStream[]).includes(stream);
}

/**
 * Strips the subscribers stream from OnlyFans requests unless the page is
 * OFAPI-audience-eligible — the exact gate shape the DM-polling filter uses.
 */
export function filterOnlyFansAudienceStreams(
  platform: "fansly" | "onlyfans",
  streams: readonly SyncStream[],
  config?: Pick<AppContext["config"], "ofapiAudienceSyncEnabled">,
  page?: { ofapiAccountId: string | null },
) {
  if (platform !== "onlyfans") {
    return [...streams];
  }
  if (page && isOfapiAudienceSyncEligiblePage(config, { platform, ofapiAccountId: page.ofapiAccountId })) {
    return [...streams];
  }

  return streams.filter((stream) => !isOnlyFansAudienceStream(stream));
}

async function pauseOnlyFansAudienceForPage(app: AppContext, pageId: number, now: Date) {
  const states = await listPageSyncStates(app.db, {
    pageId,
    streams: [...ONLYFANS_AUDIENCE_STREAMS],
  });
  if (
    states.length === ONLYFANS_AUDIENCE_STREAMS.length &&
    states.every((state) => state.status === "paused")
  ) {
    return false;
  }

  await pausePageSync(app.db, {
    pageId,
    streams: [...ONLYFANS_AUDIENCE_STREAMS],
    now,
  });
  return true;
}

export async function pauseDisabledOnlyFansAudienceForPage(
  app: AppContext,
  pageId: number,
  now = new Date(),
) {
  if (!app.config) {
    return false;
  }

  const storedPage = await findPageById(app.db, pageId);
  if (!storedPage || storedPage.page.platform !== "onlyfans") {
    return false;
  }
  if (isOfapiAudienceSyncEligiblePage(app.config, storedPage.page)) {
    return false;
  }

  return pauseOnlyFansAudienceForPage(app, pageId, now);
}

export async function pauseDisabledOnlyFansAudienceForAllPages(
  app: AppContext,
  now = new Date(),
) {
  if (!app.config) {
    return 0;
  }

  let pausedPages = 0;
  const pages = await listPagesByPlatform(app.db, "onlyfans");
  for (const page of pages) {
    if (isOfapiAudienceSyncEligiblePage(app.config, page)) {
      continue;
    }
    if (await pauseOnlyFansAudienceForPage(app, page.id, now)) {
      pausedPages += 1;
    }
  }

  return pausedPages;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseOfapiTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The only subscription status string the OFAPI spec documents; anything else
// is treated as auto-renewing (plan recommendation 4 — verify-live mapping).
const SET_TO_EXPIRE_STATUS = "Set to Expire";

export interface OfapiActiveFan {
  fanId: string;
  username: string | null;
  displayName: string | null;
  priceDollars: number;
  regularPriceDollars: number | null;
  subscribeAt: Date | null;
  renewedAt: Date | null;
  expiredAt: Date | null;
  status: string | null;
  autoRenew: boolean | null;
  lastSeenAt: Date | null;
}

/**
 * Maps one fans/active item; returns null when the fan id is missing. Field
 * semantics follow the OFAPI OpenAPI example (subscribedOnData carries the
 * current relationship; prices are float dollars; "Set to Expire" means
 * auto-renew is off) — plan §7.4 flags these as verify-live, so every read is
 * null-tolerant and money stays transactions-based (no *Summ fields, D8).
 */
export function parseOfapiActiveFan(item: Record<string, unknown>): OfapiActiveFan | null {
  const fanId = idToString(item.id);
  if (!fanId) {
    return null;
  }

  const subscribedOn = asRecord(item.subscribedOnData);
  const priceDollars = asFiniteNumber(subscribedOn?.price) ??
    asFiniteNumber(subscribedOn?.subscribePrice) ??
    asFiniteNumber(item.subscribePrice) ??
    0;
  const status = nonEmpty(subscribedOn?.status);

  return {
    fanId,
    username: nonEmpty(item.username),
    displayName: nonEmpty(item.name) ?? nonEmpty(item.displayName),
    priceDollars,
    regularPriceDollars: asFiniteNumber(subscribedOn?.regularPrice),
    subscribeAt: parseOfapiTimestamp(subscribedOn?.subscribeAt),
    renewedAt: parseOfapiTimestamp(subscribedOn?.renewedAt),
    expiredAt: parseOfapiTimestamp(subscribedOn?.expiredAt),
    status,
    autoRenew: status !== null ? status !== SET_TO_EXPIRE_STATUS : null,
    lastSeenAt: parseOfapiTimestamp(item.lastSeen),
  };
}

function resolveAudienceClient(app: AppContext): OfapiClient {
  if (!app.ofapi) {
    throw new Error("OFAPI audience sync requires OFAPI_API_KEY to be configured");
  }
  return app.ofapi;
}

function requireOfapiAccountId(pageContext: ResolvedPageContext) {
  const ofapiAccountId = pageContext.page.ofapiAccountId;
  if (pageContext.platform !== "onlyfans" || !ofapiAccountId) {
    throw new Error("OFAPI audience sync requires an OnlyFans page mapped to an OFAPI account");
  }
  return ofapiAccountId;
}

/**
 * The subscribers stream for OFAPI-fed OnlyFans pages: one full fans/active
 * offset sweep per OFAPI_AUDIENCE_SWEEP_INTERVAL_MINUTES, checkpointed so
 * budget yields resume mid-walk. End of sweep mirrors the Fansly generational
 * semantics — subscriptions absent from the sweep are deactivated and the
 * page_fans subscriber state + rollups refreshed in the same transaction.
 */
export async function executeOfapiAudienceChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
): Promise<OfapiStreamChunkResult> {
  const ofapiAccountId = requireOfapiAccountId(input.pageContext);
  const client = resolveAudienceClient(app);
  await input.telemetry.recordPhaseStarted("subscribers");

  const requestContext: OfapiRequestContext = {
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    pageId: input.pageContext.page.id,
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "subscribers");
  await input.telemetry.recordCheckpointLoaded("subscribers", summarizeCheckpoint(checkpoint));

  // A Fansly-shaped checkpoint (page converted platforms? defensive) parses to
  // null and restarts as a fresh OFAPI audience sweep.
  let state = parseOfapiAudienceCursorState(checkpoint?.state) ?? emptyOfapiAudienceCursorState();

  // D6: the audience sweep gets its own daily ceiling. With the credit ledger
  // on, the guard reserves against the sweep's dedicated day counter (audit
  // F9 — the ledger-attributed SUM it replaced could not see in-flight
  // spend); otherwise it falls back to the global day counter (conservative —
  // shared with DM spend).
  const guard = createOfapiRestGuard(app, {
    maxRequestsPerRun: app.config.ofapiAudienceMaxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN,
    dailyCreditBudget: app.config.ofapiAudienceDailyCreditBudget ?? DEFAULT_DAILY_CREDIT_BUDGET,
    budgetScope: "audience",
  });

  const sweepIntervalMs = Math.max(
    1,
    app.config.ofapiAudienceSweepIntervalMinutes ?? DEFAULT_SWEEP_INTERVAL_MINUTES,
  ) * 60 * 1000;

  if (state.sweepStartedAt === null) {
    const lastCompletedMs = state.lastSweepCompletedAt
      ? Date.parse(state.lastSweepCompletedAt)
      : Number.NaN;
    const sweepDue = Number.isNaN(lastCompletedMs) ||
      Date.now() - lastCompletedMs >= sweepIntervalMs;
    if (!sweepDue) {
      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          skipped: "sweep_not_due",
          lastSweepCompletedAt: state.lastSweepCompletedAt,
        },
      };
    }

    state = {
      ...state,
      generation: state.generation + 1,
      offset: 0,
      pageCount: 0,
      sweepStartedAt: new Date().toISOString(),
    };
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "subscribers",
      state,
    });
  }

  let processedFans = 0;
  let pagesFetched = 0;
  let result: OfapiStreamChunkResult | null = null;

  const applyActiveFans = async (dbTx: Database, fans: OfapiActiveFan[]) => {
    if (fans.length === 0) {
      return;
    }

    const now = new Date();
    const fanRows = await upsertFans(dbTx, fans.map((fan) => ({
      platform: "onlyfans" as const,
      platformUserId: fan.fanId,
      ...(fan.username !== null ? { username: fan.username } : {}),
      ...(fan.displayName !== null ? { displayName: fan.displayName } : {}),
    })));
    const fanIdByPlatformUserId = new Map(
      fanRows.map((fan) => [fan.platformUserId, fan.id] as const),
    );

    const subscriptionInputs: UpsertPageSubscriptionInput[] = [];
    const fanPageInputs: UpsertFanPageInput[] = [];
    const presenceInputs: UpsertFanPageExternalPresenceInput[] = [];
    for (const fan of fans) {
      const fanId = fanIdByPlatformUserId.get(fan.fanId);
      if (!fanId) {
        continue;
      }

      const priceMills = dollarsToMills(fan.priceDollars);
      subscriptionInputs.push({
        // OnlyFans has one subscription relationship per fan-page pair and no
        // exposed subscription id — the fan id is the stable identity.
        platformSubscriptionId: fan.fanId,
        platformAccountId: input.pageContext.page.id,
        fanId,
        // OnlyFans exposes no numeric raw status; canonical status carries it.
        rawStatus: 0,
        canonicalStatus: "active",
        priceMills,
        renewPriceMills: fan.regularPriceDollars !== null
          ? dollarsToMills(fan.regularPriceDollars)
          : priceMills,
        autoRenew: fan.autoRenew,
        // expiredAt is when the current period ends: the renewal date while
        // auto-renew is on, the end date once "Set to Expire" (verify-live).
        renewDate: fan.expiredAt,
        sourceCreatedAt: fan.subscribeAt,
        sourceUpdatedAt: fan.renewedAt ?? fan.subscribeAt,
        endsAt: fan.expiredAt,
        // tier is deliberately null — OnlyFans has no tiers (D8).
        lastSeenGeneration: state.generation,
      });
      fanPageInputs.push({
        fanId,
        platformAccountId: input.pageContext.page.id,
        isSubscriber: true,
        subscriberSince: fan.subscribeAt,
        subscriptionExpiresAt: fan.expiredAt,
        autoRenew: fan.autoRenew,
      });
      if (fan.lastSeenAt) {
        presenceInputs.push({
          fanId,
          platformAccountId: input.pageContext.page.id,
          externalPresenceAt: fan.lastSeenAt,
          externalPresenceObservedAt: now,
          externalPresenceSource: OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN,
        });
      }
    }

    await upsertPageSubscriptions(dbTx, subscriptionInputs);
    await upsertFanPages(dbTx, fanPageInputs);
    await upsertFanPageExternalPresences(dbTx, presenceInputs);
    processedFans += subscriptionInputs.length;
  };

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    const block = await guard.resolveBlock();
    if (block) {
      result = budgetBlockResult(block, {
        mode: "audience_sweep",
        generation: state.generation,
        offset: state.offset,
        pageCount: state.pageCount,
        processedFans,
      });
      break;
    }

    await assertOwnedPageSyncLease(app.db);
    const page = await client.listActiveFans(requestContext, ofapiAccountId, {
      limit: OFAPI_FANS_PAGE_LIMIT,
      offset: state.offset,
      pageIndex: state.pageCount,
    });
    await guard.recordResponse(page);
    pagesFetched += 1;

    if (state.offset === 0 && page.items.length === 0) {
      const currentSubscribers = await getCurrentSubscribers(app.db, input.pageContext.page.id);
      if (currentSubscribers.rows.length > 0) {
        // Mirrors the Fansly empty-first-page guard: never run the destructive
        // generation expiry off a response that claims zero subscribers.
        await input.telemetry.addAnomaly({
          code: "subscribers_empty_first_page_guard",
          severity: "warn",
          message: "OFAPI audience sweep returned zero fans while current subscriptions exist",
          details: { existingCurrentSubscribers: currentSubscribers.rows.length },
        });
        throw new Error("OFAPI audience sweep returned zero fans; refusing destructive finalization");
      }
    }

    const fans: OfapiActiveFan[] = [];
    for (const item of page.items) {
      const fan = parseOfapiActiveFan(item);
      if (fan) {
        fans.push(fan);
      } else {
        await input.telemetry.addAnomaly({
          code: "ofapi_fan_unparseable",
          severity: "warn",
          message: "Skipped an OFAPI fans/active item without a fan id",
          details: { context: "ofapi_audience_sweep", offset: state.offset },
        });
      }
    }

    const sweepComplete = !page.hasNextPage || page.items.length === 0;
    // An empty page that still claims hasNextPage is contradictory pagination —
    // complete the sweep (offset += 0 would loop forever) but refuse the
    // destructive generational expiry on a signal we cannot trust.
    const contradictoryPagination = page.items.length === 0 && page.hasNextPage;
    const nextState = sweepComplete
      ? {
        ...state,
        offset: 0,
        pageCount: state.pageCount + 1,
        sweepStartedAt: null,
        lastSweepCompletedAt: new Date().toISOString(),
      }
      : {
        ...state,
        offset: state.offset + page.items.length,
        pageCount: state.pageCount + 1,
      };

    if (contradictoryPagination) {
      await input.telemetry.addAnomaly({
        code: "ofapi_fans_contradictory_pagination",
        severity: "warn",
        message: "fans/active returned an empty page with hasMore=true; completing the sweep without the generational expiry",
        details: { offset: state.offset, generation: state.generation },
      });
    }

    const written = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
      await applyActiveFans(dbTx, fans);
      if (sweepComplete && !contradictoryPagination) {
        // P-25: a multi-chunk sweep can take hours; a subscription the live
        // webhook projection created mid-sweep (lastSeenGeneration null) may
        // sit at an offset the walk already passed — retiring it here would
        // hide a fresh, real subscriber until the next sweep. Rows touched
        // since the sweep started are spared; the next sweep adopts or
        // retires them on real data.
        const sweepStartedAt = state.sweepStartedAt ? new Date(state.sweepStartedAt) : null;
        await deactivatePageSubscriptionsByGeneration(dbTx, {
          platformAccountId: input.pageContext.page.id,
          generation: state.generation,
          ...(sweepStartedAt !== null && !Number.isNaN(sweepStartedAt.getTime())
            ? { lastSeenBefore: sweepStartedAt }
            : {}),
        });
        await refreshFanPageSubscriberState(dbTx, input.pageContext.page.id);
        await rebuildSubscriberRollups(dbTx, input.pageContext.page.id);
        return upsertCheckpoint(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "subscribers",
          state: nextState,
          lastSuccessfulRunId: input.syncRunId,
        });
      }
      if (sweepComplete) {
        return upsertCheckpoint(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "subscribers",
          state: nextState,
          lastSuccessfulRunId: input.syncRunId,
        });
      }
      return upsertCheckpointProgress(dbTx, {
        platformAccountId: input.pageContext.page.id,
        stream: "subscribers",
        state: nextState,
      });
    });
    state = nextState;
    await input.telemetry.recordCheckpointAdvanced("subscribers", summarizeCheckpoint(written));

    if (sweepComplete) {
      result = {
        satisfied: true,
        yieldReason: null,
        stats: {
          mode: "audience_sweep",
          generation: state.generation,
          pageCount: state.pageCount,
          processedFans,
          pagesFetched,
          fullSweepCompleted: true,
        },
      };
      break;
    }

    if (input.budget.shouldYield()) {
      break;
    }
  }

  result ??= {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: {
      mode: "audience_sweep",
      generation: state.generation,
      offset: state.offset,
      pageCount: state.pageCount,
      processedFans,
      pagesFetched,
      fullSweepCompleted: false,
    },
  };

  return result;
}
