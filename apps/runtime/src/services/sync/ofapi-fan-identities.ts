// Stage 14: tracking/trial-link users via OFAPI — the second OnlyMonster-
// exclusive feed. The fan_identities stream keeps its name; for OFAPI-mapped
// OnlyFans pages (flag on) the executor routes here instead of the OnlyMonster
// adapter. The walk lists tracking links (+ trial links), then each link's
// subscribers/spenders, feeding the same upsertFans/upsertFanPages writes.
//
// Link lists are rediscovered cheaply on every request revision, while a
// durable cursor records completed link/kind targets and the active user-page
// offset. This keeps idempotent upserts simple without re-buying the same
// prefix whenever a large account spans several budget-limited chunks.

import {
  getCheckpoint,
  upsertCheckpointProgress,
  upsertFanPages,
  upsertFans,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { idToString } from "../ofapi-payloads.ts";
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
  limit: number,
) => Promise<OfapiListPage>;

export interface OfapiFanIdentitiesStats {
  trackingLinks: number;
  trialLinks: number;
  userPages: number;
  upsertedFans: number;
  requestsUsed: number;
}

type OfapiFanIdentitiesCursorStateV1 = {
  version: 1;
  revision: number;
  completedTargetKeys: string[];
  activeTargetKey: string | null;
  activeOffset: number;
};

type OfapiFanIdentitiesCursorState = {
  version: 2;
  revision: number;
  phase: "links" | "users";
  linkType: "tracking" | "trial" | null;
  linkOffset: number;
  trackingLinkIds: string[];
  trialLinkIds: string[];
  completedTargetKeys: string[];
  activeTargetKey: string | null;
  activeOffset: number;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseCursorState(value: unknown): OfapiFanIdentitiesCursorState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const state = value as Record<string, unknown>;

  // V1 had only phase-2 progress. Upgrade it in memory and preserve every
  // completed/active user target; only the previously-uncheckpointed link
  // discovery must run once after deployment.
  if (state.version === 1) {
    if (
      typeof state.revision !== "number" ||
      !Number.isSafeInteger(state.revision) ||
      !isStringArray(state.completedTargetKeys) ||
      (state.activeTargetKey !== null && typeof state.activeTargetKey !== "string") ||
      typeof state.activeOffset !== "number" ||
      !Number.isSafeInteger(state.activeOffset) ||
      state.activeOffset < 0
    ) {
      return null;
    }
    const previous = state as OfapiFanIdentitiesCursorStateV1;
    return {
      version: 2,
      revision: previous.revision,
      phase: "links",
      linkType: "tracking",
      linkOffset: 0,
      trackingLinkIds: [],
      trialLinkIds: [],
      completedTargetKeys: [...new Set(previous.completedTargetKeys)],
      activeTargetKey: previous.activeTargetKey,
      activeOffset: previous.activeOffset,
    };
  }

  if (
    state.version !== 2 ||
    typeof state.revision !== "number" ||
    !Number.isSafeInteger(state.revision) ||
    (state.phase !== "links" && state.phase !== "users") ||
    (state.linkType !== null && state.linkType !== "tracking" && state.linkType !== "trial") ||
    (state.phase === "links" && state.linkType === null) ||
    (state.phase === "users" && state.linkType !== null) ||
    typeof state.linkOffset !== "number" ||
    !Number.isSafeInteger(state.linkOffset) ||
    state.linkOffset < 0 ||
    !isStringArray(state.trackingLinkIds) ||
    !isStringArray(state.trialLinkIds) ||
    !isStringArray(state.completedTargetKeys) ||
    (state.activeTargetKey !== null && typeof state.activeTargetKey !== "string") ||
    typeof state.activeOffset !== "number" ||
    !Number.isSafeInteger(state.activeOffset) ||
    state.activeOffset < 0
  ) {
    return null;
  }
  return {
    version: 2,
    revision: state.revision,
    phase: state.phase,
    linkType: state.linkType,
    linkOffset: state.linkOffset,
    trackingLinkIds: [...new Set(state.trackingLinkIds)],
    trialLinkIds: [...new Set(state.trialLinkIds)],
    completedTargetKeys: [...new Set(state.completedTargetKeys)],
    activeTargetKey: state.activeTargetKey,
    activeOffset: state.activeOffset,
  };
}

export async function syncOfapiFanIdentities(
  app: AppContext,
  input: {
    pageContext: ResolvedPageContext;
    budget: SyncChunkBudget;
    telemetry: SyncRunTelemetry;
    requestSeq: number;
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
    creditBudgetScope: "audience",
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

  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "fan_identities");
  const storedCursor = parseCursorState(checkpoint?.state);
  let cursor: OfapiFanIdentitiesCursorState = storedCursor?.revision === input.requestSeq
    ? storedCursor
    : {
      version: 2,
      revision: input.requestSeq,
      phase: "links",
      linkType: "tracking",
      linkOffset: 0,
      trackingLinkIds: [],
      trialLinkIds: [],
      completedTargetKeys: [],
      activeTargetKey: null,
      activeOffset: 0,
    };
  const completedTargetKeys = new Set(cursor.completedTargetKeys);
  const trackingLinkIds = new Set(cursor.trackingLinkIds);
  const trialLinkIds = new Set(cursor.trialLinkIds);
  const persistCursor = async () => {
    cursor = {
      ...cursor,
      trackingLinkIds: [...trackingLinkIds].sort(),
      trialLinkIds: [...trialLinkIds].sort(),
      completedTargetKeys: [...completedTargetKeys].sort(),
    };
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "fan_identities",
      state: cursor,
    });
  };

  // Phase 1: link discovery is itself a durable offset walk. Both the request
  // limit and the next offset use the same local pageLimit, so pagination
  // cannot silently drift if tracking/trial limits change later.
  const walkLinkPages = async (): Promise<OfapiBudgetBlock | null> => {
    while (cursor.phase === "links") {
      const block = await guard.resolveBlock();
      if (block !== null) {
        await persistCursor();
        return block;
      }

      const linkType = cursor.linkType!;
      const pageLimit = LINKS_PAGE_LIMIT;
      const page = linkType === "tracking"
        ? await client.listTrackingLinks!(requestContext, ofapiAccountId, {
          limit: pageLimit,
          offset: cursor.linkOffset,
        })
        : await client.listTrialLinks!(requestContext, ofapiAccountId, {
          limit: pageLimit,
          offset: cursor.linkOffset,
        });
      await guard.recordResponse(page);
      stats.requestsUsed += 1;

      const ids = linkType === "tracking" ? trackingLinkIds : trialLinkIds;
      for (const item of page.items) {
        const id = idToString(item.id);
        if (id) {
          ids.add(id);
        }
      }

      if (page.items.length < pageLimit) {
        cursor = linkType === "tracking"
          ? { ...cursor, linkType: "trial", linkOffset: 0 }
          : { ...cursor, phase: "users", linkType: null, linkOffset: 0 };
      } else {
        cursor = { ...cursor, linkOffset: cursor.linkOffset + pageLimit };
      }
      stats.trackingLinks = trackingLinkIds.size;
      stats.trialLinks = trialLinkIds.size;
      await persistCursor();
    }
    return null;
  };

  stats.trackingLinks = trackingLinkIds.size;
  stats.trialLinks = trialLinkIds.size;
  const phaseOneBlock = await walkLinkPages();
  if (phaseOneBlock !== null) {
    return budgetBlockResult(phaseOneBlock, {
      ...stats,
      phase: cursor.phase,
      linkType: cursor.linkType,
      linkOffset: cursor.linkOffset,
    });
  }

  // Phase 2: each link's users -> fans/page_fans.
  const consumeUsers = async (items: Record<string, unknown>[]) => {
    stats.userPages += 1;
    stats.upsertedFans += await upsertLinkUsers(app, input.pageContext.page.id, items);
  };

  const targets: Array<{ key: string; fetchPage: GuardedFetch }> = [];
  for (const linkId of trackingLinkIds) {
    for (const kind of ["subscribers", "spenders"] as const) {
      targets.push({
        key: `tracking:${linkId}:${kind}`,
        fetchPage: (offset, limit) =>
          client.listTrackingLinkUsers!(requestContext, ofapiAccountId, linkId, kind, {
            limit,
            offset,
          }),
      });
    }
  }
  for (const linkId of trialLinkIds) {
    targets.push({
      key: `trial:${linkId}:subscribers`,
      fetchPage: (offset, limit) =>
        client.listTrialLinkSubscribers!(requestContext, ofapiAccountId, linkId, {
          limit,
          offset,
        }),
    });
  }

  // Resume the in-flight target before any newly discovered/incomplete one.
  // Persisted ID arrays are sorted for deterministic checkpoints, so relying
  // on Set iteration order here could let an earlier target clear the saved
  // active offset and repurchase its prefix.
  if (cursor.activeTargetKey !== null) {
    const activeIndex = targets.findIndex((target) => target.key === cursor.activeTargetKey);
    if (activeIndex > 0) {
      const [activeTarget] = targets.splice(activeIndex, 1);
      if (activeTarget) targets.unshift(activeTarget);
    }
  }

  // A request can span several executor chunks. Persist both completed link
  // targets and the active target's offset so a per-run budget yield resumes
  // after the prefix instead of buying the same prefix forever.
  for (const target of targets) {
    if (completedTargetKeys.has(target.key)) {
      continue;
    }
    let offset = cursor.activeTargetKey === target.key ? cursor.activeOffset : 0;
    for (;;) {
      const targetBlock = await guard.resolveBlock();
      if (targetBlock !== null) {
        cursor = { ...cursor, activeTargetKey: target.key, activeOffset: offset };
        await persistCursor();
        return budgetBlockResult(targetBlock, {
          ...stats,
          completedTargets: completedTargetKeys.size,
          activeTargetKey: target.key,
          activeOffset: offset,
        });
      }
      const pageLimit = USERS_PAGE_LIMIT;
      const page = await target.fetchPage(offset, pageLimit);
      await guard.recordResponse(page);
      stats.requestsUsed += 1;
      await consumeUsers(page.items);
      if (page.items.length < pageLimit) {
        completedTargetKeys.add(target.key);
        cursor = { ...cursor, activeTargetKey: null, activeOffset: 0 };
        await persistCursor();
        break;
      }
      offset += pageLimit;
      cursor = { ...cursor, activeTargetKey: target.key, activeOffset: offset };
      await persistCursor();
    }
  }

  cursor = { ...cursor, activeTargetKey: null, activeOffset: 0 };
  await persistCursor();

  return {
    satisfied: true,
    yieldReason: null,
    stats: { ...stats, completedTargets: completedTargetKeys.size },
  };
}
