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
//
// Every list page the walk buys is journaled before anything reads it: the
// link lists and each link's subscribers/spenders, with the request that
// produced them. The page is the only record of which link a fan came from —
// the fans/page_fans writes below keep the fan and drop the link.

import {
  getCheckpoint,
  upsertCheckpointProgress,
  upsertFanPages,
  upsertFans,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { idToString } from "../ofapi-payloads.ts";
import { resolveOfapiListNextOffset } from "../ofapi-list-pagination.ts";
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
import { persistRawPayload, retentionDate } from "./shared.ts";

const LINKS_PAGE_LIMIT = 100;
const USERS_PAGE_LIMIT = 100;
const DEFAULT_MAX_REQUESTS_PER_RUN = 25;
const DEFAULT_DAILY_CREDIT_BUDGET = 300;
const OFAPI_LINK_FANS_MAPPER_VERSION = "ofapi-link-fans-v1";

// One journal kind per vendor route, registered in observation-kinds.ts. Each
// kind is a literal under an `endpoint` key because that is the seam
// tests/observation-kind-coverage.test.ts greps for the kinds this tree
// writes. `path` is the route template for requestParams; the link id is in
// the body.
const LINK_LIST_JOURNAL = {
  tracking: { endpoint: "link_lists_tracking_live", path: "/:accountId/tracking-links" },
  trial: { endpoint: "link_lists_trial_live", path: "/:accountId/trial-links" },
} as const;

const LINK_USERS_JOURNAL = {
  "tracking:subscribers": {
    endpoint: "link_fans_tracking_subscribers",
    path: "/:accountId/tracking-links/:trackingLinkId/subscribers",
  },
  "tracking:spenders": {
    endpoint: "link_fans_tracking_spenders",
    path: "/:accountId/tracking-links/:trackingLinkId/spenders",
  },
  "trial:subscribers": {
    endpoint: "link_fans_trial_subscribers",
    path: "/:accountId/trial-links/:trialLinkId/subscribers",
  },
} as const;

type LinkPageJournal = { endpoint: string; path: string };

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
  kind: "subscribers" | "spenders",
) {
  const fanInputs = items.flatMap((item) => {
    const platformUserId = idToString(kind === "spenders" ? item.onlyfans_id : item.id);
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

type LinkUsersTarget = {
  key: string;
  linkKind: "tracking" | "trial";
  linkId: string;
  list: "subscribers" | "spenders";
  journal: LinkPageJournal;
  pathname: string;
  fetchPage: GuardedFetch;
};

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
    /** The chunk's run. It keys each journaled page apart from the pages of
     *  the request's other chunks, which share `requestSeq`. */
    syncRunId: number;
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

  // Journal one fetched list page, untrimmed, before the walk reads it. The
  // OFAPI client exposes no raw response envelope, so the body is the item
  // records as they arrived plus the request that produced them: a page of
  // fans does not name its link, and without the link, list and offset it
  // could not be replayed. Loud on failure — the throw fails the chunk before
  // the cursor moves, so the retry asks for this page again.
  const journalPage = async (
    journal: LinkPageJournal,
    scope: Record<string, unknown>,
    request: { offset: number; limit: number },
    page: OfapiListPage,
  ) => {
    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: journal.endpoint,
      requestParams: { ...request, path: journal.path },
      responsePayload: {
        ...scope,
        ...request,
        requestSeq: input.requestSeq,
        ofapiAccountId,
        items: page.items,
        hasNextPage: page.hasNextPage,
        nextPageUrl: page.nextPageUrl ?? null,
      },
      mapperVersion: OFAPI_LINK_FANS_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: `inserting ${journal.endpoint} raw payload`,
      platform: "onlyfans",
    });
  };
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
      await journalPage(
        LINK_LIST_JOURNAL[linkType],
        { linkKind: linkType },
        { offset: cursor.linkOffset, limit: pageLimit },
        page,
      );

      const ids = linkType === "tracking" ? trackingLinkIds : trialLinkIds;
      for (const item of page.items) {
        const id = idToString(item.id);
        if (id) {
          ids.add(id);
        }
      }

      const nextOffset = resolveOfapiListNextOffset(page, {
        pathname: `/${encodeURIComponent(ofapiAccountId)}/${linkType === "tracking" ? "tracking-links" : "trial-links"}`,
        offset: cursor.linkOffset, limit: pageLimit, baseUrl: app.config?.ofapiBaseUrl,
      });
      if (nextOffset === null) {
        cursor = linkType === "tracking"
          ? { ...cursor, linkType: "trial", linkOffset: 0 }
          : { ...cursor, phase: "users", linkType: null, linkOffset: 0 };
      } else {
        cursor = { ...cursor, linkOffset: nextOffset };
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
  const consumeUsers = async (items: Record<string, unknown>[], kind: "subscribers" | "spenders") => {
    stats.userPages += 1;
    stats.upsertedFans += await upsertLinkUsers(app, input.pageContext.page.id, items, kind);
  };

  const targets: LinkUsersTarget[] = [];
  for (const linkId of trackingLinkIds) {
    for (const kind of ["subscribers", "spenders"] as const) {
      targets.push({
        key: `tracking:${linkId}:${kind}`,
        linkKind: "tracking",
        linkId,
        list: kind,
        journal: LINK_USERS_JOURNAL[`tracking:${kind}`],
        pathname: `/${encodeURIComponent(ofapiAccountId)}/tracking-links/${encodeURIComponent(linkId)}/${kind}`,
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
      linkKind: "trial",
      linkId,
      list: "subscribers",
      journal: LINK_USERS_JOURNAL["trial:subscribers"],
      pathname: `/${encodeURIComponent(ofapiAccountId)}/trial-links/${encodeURIComponent(linkId)}/subscribers`,
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
      await journalPage(
        target.journal,
        { link: { kind: target.linkKind, id: target.linkId }, list: target.list },
        { offset, limit: pageLimit },
        page,
      );
      await consumeUsers(page.items, target.list);
      const nextOffset = resolveOfapiListNextOffset(page, {
        pathname: target.pathname, offset, limit: pageLimit, baseUrl: app.config?.ofapiBaseUrl,
      });
      if (nextOffset === null) {
        completedTargetKeys.add(target.key);
        cursor = { ...cursor, activeTargetKey: null, activeOffset: 0 };
        await persistCursor();
        break;
      }
      offset = nextOffset;
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
