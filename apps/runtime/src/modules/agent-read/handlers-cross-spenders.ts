import {
  AGENT_CROSS_SPENDERS_DEFAULTS,
  type AgentCrossSpendersAudience,
  type AgentCrossSpendersResponse,
} from "@agency_hub_core/contracts";
import { millsFromInteger, type Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal } from "../../services/auth.ts";
import {
  CrossPageSourceRefusal,
  compareCrossPageSpenders,
  readCrossPageSpenders,
  resolveCrossPageSources,
  type CrossPageSourceSelection,
} from "../../services/cross-page-spenders.ts";
import { BadRequestError } from "../../services/errors.ts";
import { decodeAgentCursor, encodeAgentCursor } from "./cursors.ts";
import { buildAgentEvidence } from "./epistemics.ts";
import { staticNotFound, toSafeNumberOr } from "./errors.ts";
import { planesNotRead } from "./planes.ts";
import {
  AGENT_TIMEOUT_MS,
  beginAgentRequest,
  buildDelivery,
  computeScopeFieldStates,
  isoOrNull,
  withAgentTimeout,
} from "./runtime.ts";

/**
 * `agentCrossSpenders` (`hub cross-spenders`): the fans of a target page's
 * audience who paid other pages of its platform, the set a mass message of
 * the target leaves out. The rules live in `services/cross-page-spenders.ts`;
 * this handler adds the plane's envelope.
 *
 * Money-bearing like the `fan_memberships` dataset: `read:datasets` and
 * `read:money`. The target page out of the grant is the plane's static 404,
 * and so is a listed source out of it (indistinguishable from a page that does
 * not exist); a listed source on another platform, or the target itself, is a
 * 400. Database only, nothing is sent anywhere.
 *
 * Each call reads the whole set (it is bounded by the target's audience), so
 * the summary always counts all of it; `items` is one keyset page of it. A
 * single call that serves the whole set froze its snapshot; a traversal across
 * calls did not (the spend moves under it) and says so.
 */

const OPERATION = "agentCrossSpenders";

/** What a cursor carries besides the keyset: the normalized request. */
interface CrossSpendersParams {
  audience: AgentCrossSpendersAudience;
  sources: "model" | "all" | string[];
  minSourceSpendMills: number;
  maxTargetSpendMills: number | null;
  limit: number;
}

function sourceSelection(raw: readonly string[] | undefined): "model" | "all" | string[] {
  if (raw === undefined) return "model";
  const labels = [...new Set(raw.flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => value !== ""))];
  if (labels.length === 1 && (labels[0] === "model" || labels[0] === "all")) return labels[0];
  if (labels.length === 0 || labels.includes("model") || labels.includes("all")) {
    throw new BadRequestError("sources is `model`, `all`, or page labels, never a mix");
  }
  return labels;
}

export async function handleAgentCrossSpenders(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { pageLabel: string },
  query: {
    audience?: AgentCrossSpendersAudience | undefined;
    sources?: string[] | undefined;
    minSourceSpendMills?: number | undefined;
    maxTargetSpendMills?: number | "any" | undefined;
    limit: number;
    cursor?: string | undefined;
  },
): Promise<AgentCrossSpendersResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: OPERATION,
    requiredCapabilities: ["read:datasets", "read:money"],
  });
  let delivered = 0;
  try {
    // In-handler grant guard behind the declarative page scope: a miss is the
    // same static 404 the middleware answers.
    const target = scope.pages.find((candidate) => candidate.pageLabel === params.pageLabel);
    if (!target) {
      throw staticNotFound();
    }
    const resource = `cross_spenders:${target.id}`;
    const cursorConsumed = query.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(query.cursor as string, {
        operation: OPERATION,
        resource,
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;
    // A cursor carries the request; the schema refuses scope beside one.
    const effective: CrossSpendersParams = cursor !== null
      ? cursor.params as unknown as CrossSpendersParams
      : {
        audience: query.audience ?? AGENT_CROSS_SPENDERS_DEFAULTS.audience,
        sources: sourceSelection(query.sources),
        minSourceSpendMills: query.minSourceSpendMills ?? AGENT_CROSS_SPENDERS_DEFAULTS.minSourceSpendMills,
        maxTargetSpendMills: query.maxTargetSpendMills === "any"
          ? null
          : query.maxTargetSpendMills ?? AGENT_CROSS_SPENDERS_DEFAULTS.maxTargetSpendMills,
        limit: query.limit,
      };

    let sources;
    try {
      sources = resolveCrossPageSources({
        target,
        candidates: scope.pages,
        sources: effective.sources as CrossPageSourceSelection,
      });
    } catch (error) {
      if (error instanceof CrossPageSourceRefusal) {
        if (error.reason === "unknown_page") throw staticNotFound();
        throw new BadRequestError(error.message);
      }
      throw error;
    }

    const set = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) => readCrossPageSpenders(tx, {
      target,
      sources,
      audience: effective.audience,
      minSourceSpendMills: millsFromInteger(effective.minSourceSpendMills),
      maxTargetSpendMills: effective.maxTargetSpendMills === null ? null : millsFromInteger(effective.maxTargetSpendMills),
    }), "agent_cross_spenders");

    const after = cursor === null
      ? null
      : {
        sourceSpendMills: millsFromInteger(String(cursor.keyset.sourceSpendMills)),
        platformUserId: String(cursor.keyset.platformUserId),
      };
    const remaining = after === null ? set.fans : set.fans.filter((fan) => compareCrossPageSpenders(fan, after) > 0);
    const page = remaining.slice(0, effective.limit);
    const last = page.at(-1);
    const nextCursor = remaining.length > effective.limit && last !== undefined
      ? encodeAgentCursor({
        operation: OPERATION,
        resource,
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        params: { ...effective },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: {},
        seqHighWater: {},
        keyset: { sourceSpendMills: last.sourceSpendMills.toString(), platformUserId: last.platformUserId },
      }, scope.signing)
      : null;
    // One call that served the whole set read it in one statement; a walk
    // across calls has no bound to freeze.
    const frozenSnapshot = !cursorConsumed && nextCursor === null;
    const snapshotExhausted = frozenSnapshot;

    const operationPlanes = ["page_fans", "fans", "fan_spend_lifetime", "transactions"];
    const floorAt = isoOrNull(set.transactionsFloorAt);
    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields: null,
      operationPlanes,
      planeReads: set.witnesses,
      planesNotRead: planesNotRead({ operationPlanes, witnesses: set.witnesses }),
      delivery: { snapshotExhausted, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      frozenSnapshot,
      requestWindow: null,
      gaps: [],
      scopeFieldStates: computeScopeFieldStates({ fields: [], platforms: [target.platform as Platform] }),
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: floorAt === null ? { at: null, kind: "unknown" } : { at: floorAt, kind: "oldest_stored_row" },
      inventoryUnprovenPages: 0,
    });

    const mills = (value: bigint) => toSafeNumberOr(value, 0);
    const response: AgentCrossSpendersResponse = {
      scope: {
        pageLabel: target.pageLabel,
        platform: target.platform as Platform,
        audience: effective.audience,
        sourceSelection: typeof effective.sources === "string" ? effective.sources : "listed",
        sourcePages: sources.map((source) => source.pageLabel),
        minSourceSpendMills: effective.minSourceSpendMills,
        maxTargetSpendMills: effective.maxTargetSpendMills,
      },
      summary: {
        qualifying: set.fans.length,
        sources: set.perSource.map((source) => ({
          pageLabel: source.page.pageLabel,
          fans: source.fans,
          grossMills: mills(source.grossMills),
          transactionsFloorAt: isoOrNull(source.transactionsFloorAt),
        })),
        audience: {
          newFollowersReadAt: isoOrNull(set.audience.newFollowersReadAt),
          followersWalkedAt: isoOrNull(set.audience.followersWalkedAt),
          subscribersWalkedAt: isoOrNull(set.audience.subscribersWalkedAt),
        },
      },
      items: page.map((fan) => ({
        platformUserId: fan.platformUserId,
        username: fan.username,
        displayName: fan.displayName,
        isFollower: fan.isFollower,
        followerSince: isoOrNull(fan.followerSince),
        isSubscriber: fan.isSubscriber,
        subscriptionExpiresAt: isoOrNull(fan.subscriptionExpiresAt),
        targetSpendMills: mills(fan.targetSpendMills),
        sourceSpendMills: mills(fan.sourceSpendMills),
        lastSourceTransactionAt: isoOrNull(fan.lastSourceTransactionAt),
        sources: fan.sources.map((source) => ({
          pageLabel: source.page.pageLabel,
          grossMills: mills(source.grossMills),
          lastTransactionAt: isoOrNull(source.lastTransactionAt),
        })),
        accountLookupMissAt: isoOrNull(fan.accountLookupMissAt),
      })),
      delivery: buildDelivery({
        returned: page.length,
        matched: { value: set.fans.length, exact: true },
        cappedBy: nextCursor === null ? null : "limit",
        nextCursor,
        snapshotExhausted,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    delivered = page.length;
    return response;
  } finally {
    await scope.finish(delivered);
  }
}
