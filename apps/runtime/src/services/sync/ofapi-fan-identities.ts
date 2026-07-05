// Stage 14: tracking/trial-link users via OFAPI — the second OnlyMonster-
// exclusive feed. The fan_identities stream keeps its name; for OFAPI-mapped
// OnlyFans pages (flag on) the executor routes here instead of the OnlyMonster
// adapter. The walk lists tracking links (+ trial links), then each link's
// subscribers/spenders, feeding the same upsertFans/upsertFanPages writes.
//
// Simplification vs. the OnlyMonster path (recorded in decisions.md): no
// cross-run cursor. Links are few at agency scale and the upserts are
// idempotent, so each run re-walks under the per-run request cap; a
// budget-blocked run covers a prefix and the stream cadence converges over
// subsequent runs.

import { upsertFanPages, upsertFans } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { asRecord, idToString } from "../ofapi-payloads.ts";
import type { OfapiClient, OfapiListPage, OfapiRequestContext } from "../ofapi.ts";
import type { ResolvedPageContext } from "../page-context.ts";
import { composeRequestObservers, type SyncChunkBudget } from "./chunk-budget.ts";
import {
  budgetBlockResult,
  createOfapiRestGuard,
  type OfapiBudgetBlock,
  type OfapiStreamChunkResult,
} from "./ofapi-dm-sync.ts";
import type { SyncRunTelemetry } from "./observability.ts";

const LINKS_PAGE_LIMIT = 100;
const USERS_PAGE_LIMIT = 100;
const DEFAULT_MAX_REQUESTS_PER_RUN = 25;
const DEFAULT_DAILY_CREDIT_BUDGET = 300;

export function isOfapiFanIdentitiesSyncEnabled(
  config?: Pick<AppContext["config"], "ofapiFanIdentitiesSyncEnabled">,
) {
  return config?.ofapiFanIdentitiesSyncEnabled === true;
}

/** Flag on + OnlyFans page + OFAPI account mapping (mirrors the DM/audience gates). */
export function isOfapiFanIdentitiesEligiblePage(
  config: Pick<AppContext["config"], "ofapiFanIdentitiesSyncEnabled"> | undefined,
  page: { platform: string; ofapiAccountId: string | null },
) {
  return isOfapiFanIdentitiesSyncEnabled(config) &&
    page.platform === "onlyfans" &&
    typeof page.ofapiAccountId === "string" &&
    page.ofapiAccountId.length > 0;
}

function normalizeIdentityText(value: unknown, options?: { stripHandlePrefix?: boolean }) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return options?.stripHandlePrefix ? trimmed.replace(/^@+/, "") : trimmed;
}

function normalizeDisplayName(value: unknown) {
  const normalized = normalizeIdentityText(value);
  if (!normalized || /^deleted\s+user$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

async function upsertLinkUsers(
  app: AppContext,
  pageId: number,
  items: Record<string, unknown>[],
) {
  const fanInputs = items.flatMap((item) => {
    const platformUserId = idToString(item.id);
    if (!platformUserId) {
      return [];
    }
    const username = normalizeIdentityText(item.username, { stripHandlePrefix: true });
    // The vendored shape carries both displayName (often "") and name.
    const displayName = normalizeDisplayName(item.displayName) ?? normalizeDisplayName(item.name);
    return [{
      platform: "onlyfans" as const,
      platformUserId,
      ...(username ? { username } : {}),
      ...(displayName ? { displayName } : {}),
    }];
  });
  if (fanInputs.length === 0) {
    return 0;
  }
  const fans = await upsertFans(app.db, fanInputs);
  if (fans.length > 0) {
    await upsertFanPages(app.db, fans.map((fan) => ({
      fanId: fan.id,
      platformAccountId: pageId,
    })));
  }
  return fans.length;
}

type GuardedFetch = (
  offset: number,
) => Promise<OfapiListPage>;

export interface OfapiFanIdentitiesStats {
  trackingLinks: number;
  trialLinks: number;
  userPages: number;
  upsertedFans: number;
  requestsUsed: number;
}

export async function syncOfapiFanIdentities(
  app: AppContext,
  input: {
    pageContext: ResolvedPageContext;
    budget: SyncChunkBudget;
    telemetry: SyncRunTelemetry;
  },
): Promise<OfapiStreamChunkResult> {
  const ofapiAccountId = input.pageContext.page.ofapiAccountId;
  if (input.pageContext.platform !== "onlyfans" || !ofapiAccountId) {
    throw new Error("OFAPI fan identities require an OnlyFans page mapped to an OFAPI account");
  }
  const client: OfapiClient | null = app.ofapi ?? null;
  if (
    !client?.listTrackingLinks ||
    !client.listTrackingLinkUsers ||
    !client.listTrialLinks ||
    !client.listTrialLinkSubscribers
  ) {
    throw new Error("OFAPI client is not configured for tracking/trial link reads");
  }

  const requestContext: OfapiRequestContext = {
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    pageId: input.pageContext.page.id,
  };
  // Spec: runs under the AUDIENCE day budget (this is audience-class work).
  const guard = createOfapiRestGuard(app, {
    maxRequestsPerRun:
      app.config.ofapiAudienceMaxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN,
    dailyCreditBudget:
      app.config.ofapiAudienceDailyCreditBudget ?? DEFAULT_DAILY_CREDIT_BUDGET,
    budgetScope: "audience",
  });

  const stats: OfapiFanIdentitiesStats = {
    trackingLinks: 0,
    trialLinks: 0,
    userPages: 0,
    upsertedFans: 0,
    requestsUsed: 0,
  };

  // Guarded offset walk; returns the budget block that ended it, if any.
  const walk = async (
    fetch: GuardedFetch,
    onItems: (items: Record<string, unknown>[]) => Promise<void>,
  ): Promise<"completed" | OfapiBudgetBlock> => {
    for (let offset = 0; ;) {
      const block = await guard.resolveBlock();
      if (block !== null) {
        return block;
      }
      const page = await fetch(offset);
      await guard.recordResponse(page);
      stats.requestsUsed += 1;
      await onItems(page.items);
      if (page.items.length < USERS_PAGE_LIMIT) {
        return "completed";
      }
      offset += page.items.length;
    }
  };

  // Phase 1: collect link ids (tracking + trial).
  const trackingLinkIds: string[] = [];
  const trialLinkIds: string[] = [];
  const collectIds = (target: string[]) => async (items: Record<string, unknown>[]) => {
    for (const item of items) {
      const id = idToString(asRecord(item)?.id ?? item.id);
      if (id) {
        target.push(id);
      }
    }
  };

  let block = await walk(
    (offset) => client.listTrackingLinks!(requestContext, ofapiAccountId, {
      limit: LINKS_PAGE_LIMIT,
      offset,
    }),
    collectIds(trackingLinkIds),
  );
  if (block !== "completed") {
    return budgetBlockResult(block, { ...stats });
  }
  stats.trackingLinks = trackingLinkIds.length;

  block = await walk(
    (offset) => client.listTrialLinks!(requestContext, ofapiAccountId, {
      limit: LINKS_PAGE_LIMIT,
      offset,
    }),
    collectIds(trialLinkIds),
  );
  if (block !== "completed") {
    return budgetBlockResult(block, { ...stats });
  }
  stats.trialLinks = trialLinkIds.length;

  // Phase 2: each link's users -> fans/page_fans.
  const consumeUsers = async (items: Record<string, unknown>[]) => {
    stats.userPages += 1;
    stats.upsertedFans += await upsertLinkUsers(app, input.pageContext.page.id, items);
  };

  for (const linkId of trackingLinkIds) {
    for (const kind of ["subscribers", "spenders"] as const) {
      block = await walk(
        (offset) => client.listTrackingLinkUsers!(requestContext, ofapiAccountId, linkId, kind, {
          limit: USERS_PAGE_LIMIT,
          offset,
        }),
        consumeUsers,
      );
      if (block !== "completed") {
        return budgetBlockResult(block, { ...stats });
      }
    }
  }
  for (const linkId of trialLinkIds) {
    block = await walk(
      (offset) => client.listTrialLinkSubscribers!(requestContext, ofapiAccountId, linkId, {
        limit: USERS_PAGE_LIMIT,
        offset,
      }),
      consumeUsers,
    );
    if (block !== "completed") {
      return budgetBlockResult(block, { ...stats });
    }
  }

  return {
    satisfied: true,
    yieldReason: null,
    stats: { ...stats },
  };
}
