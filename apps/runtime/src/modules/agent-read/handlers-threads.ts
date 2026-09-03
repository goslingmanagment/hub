import { createHash } from "node:crypto";

import {
  AGENT_CLAIM_FIELDS,
  agentClaimFieldClass,
  type AgentCoverageResponse,
  type AgentPersonTimelineResponse,
  type AgentPlaneReason,
  type AgentSearchCaveat,
  type AgentSearchMessagesBody,
  type AgentSearchMessagesResponse,
  type AgentThreadMessagesResponse,
  type AgentThreadsResponse,
} from "@agency_hub_core/contracts";
import {
  countAgentThreads,
  countAgentTranscript,
  findAgentFanId,
  findAgentPersonIdentity,
  listAgentCoverageScopes,
  listAgentThreads,
  listAgentTimeline,
  listAgentTranscript,
  readAgentPostTipParseDebt,
  readAgentJournalFloor,
  readAgentThreadArchiveFloor,
  readAgentThreadsHighWater,
  searchAgentArchive,
  type AgentTranscriptFilters,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal } from "../../services/auth.ts";
import { POSTS_CANONICALIZER_VERSION } from "../../services/canonicalize/posts.ts";
import {
  buildAgentEvidence,
  gapBeforeCaptureFloor,
} from "./epistemics.ts";
import { decodeAgentCursor, encodeAgentCursor } from "./cursors.ts";
import { AgentPlaneDisabledError, staticNotFound, toSafeNumber } from "./errors.ts";
import { MESSAGE_PLANES, MONEY_PLANES, planesNotRead } from "./planes.ts";
import {
  AGENT_POST_TIP_VIEW_CLAIM_FIELDS,
  postTipParseDebtGaps,
  postTipViewFieldStates,
} from "./post-tip-view.ts";
import {
  AGENT_COUNT_PROBE_MAX,
  AGENT_PLATFORM_CAPABILITIES,
  AGENT_SEARCH_BACKEND_IN_USE,
  AGENT_TIMEOUT_MS,
  beginAgentRequest,
  buildDelivery,
  buildPredicates,
  computeScopeFieldStates,
  hydrationRemedy,
  iso,
  isoOrNull,
  observedRowFloorOf,
  operationPlanesFor,
  retentionLimitFor,
  tryAgentTimeout,
  withAgentTimeout,
  writeAgentAudit,
} from "./runtime.ts";

/**
 * Operations #4 (timeline), #5 (threads), #6 (transcript), #7 (search) and #8
 * (coverage).
 *
 * What they share: a keyset traversal over a MUTABLE sort key. Every paged
 * response therefore carries the `mutable_sort_key` caveat, and a response that
 * CONSUMED a cursor carries the `mutable_sort_key_traversal` blocker instead —
 * within one request the read is snapshot-consistent, across pages it is not.
 *
 * #7 pages not at all, on purpose ("bound it, do not paginate"): it returns at
 * most 100 locators with an inexact `matchedInScope` and no cursor.
 */

/** Money lanes on #4, and the capability that opens them. */
const MONEY_LANES: ReadonlySet<string> = new Set(["money", "post_tips", "subscriptions"]);
const MESSAGE_LANES: ReadonlySet<string> = new Set(["messages"]);
const ALL_LANES = [
  "messages",
  "money",
  "post_tips",
  "subscriptions",
  "follows",
  "presence",
] as const;

/** Vendor media metadata is captured verbatim and old rows can contain zero,
 * negative, fractional or otherwise out-of-contract dimensions. Preserve the
 * media item while withholding only the invalid scalar: one malformed vendor
 * hint must never make the entire transcript unserializable. */
function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function nonNegativeNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** Derived from the registry (plus the subscription-price field, which rides
 *  the same capability) so a money field added there cannot skip this gate. */
const MONEY_CLAIM_FIELDS: readonly string[] = [
  ...AGENT_CLAIM_FIELDS.filter((field) => agentClaimFieldClass(field) === "money"),
  "subscriptionPriceMills",
];

/**
 * Which lanes this key may actually be served.
 *
 * `lanes` defaults to ALL of them, so the money lane used to reach any valid key:
 * amounts, type, state and currency, with no `read:money` anywhere in sight. Lanes
 * a key may not have are dropped, and `lanesServed` reports the difference rather
 * than pretending the request was honoured whole.
 */
function permittedLanes(
  requested: readonly string[],
  capabilities: { money: boolean; messages: boolean },
): string[] {
  return requested.filter((lane) => {
    if (MONEY_LANES.has(lane)) {
      return capabilities.money;
    }
    if (MESSAGE_LANES.has(lane)) {
      return capabilities.messages;
    }
    return true;
  });
}

/** The OF-only archive is a REQUIRED plane for message claims; on a Fansly scope
 *  it is `not_read` with its real reason. Decided from the capability table, never
 *  from a platform literal. */
function messagePlaneOverrides(
  platforms: readonly Platform[],
): Record<string, { state: "not_read" | "not_indexed"; reason: AgentPlaneReason }> {
  const overrides: Record<string, { state: "not_read" | "not_indexed"; reason: AgentPlaneReason }> = {
    observations: { state: "not_read", reason: "not_queried_by_this_operation" },
    sync_raw_payloads: { state: "not_read", reason: "not_queried_by_this_operation" },
  };
  const anyOnlyFansLane = platforms.some((platform) =>
    AGENT_PLATFORM_CAPABILITIES[platform].conversationIdSemantics === "equals_fan_id");
  if (platforms.length > 0 && !anyOnlyFansLane) {
    overrides.dm_message_archive = { state: "not_read", reason: "onlyfans_only" };
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// #4 agentPersonTimeline
// ---------------------------------------------------------------------------

export async function handleAgentPersonTimeline(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { platform: Platform; platformUserId: string },
  query: {
    from?: string | undefined;
    to?: string | undefined;
    lanes?: string[] | undefined;
    pageLabel?: string | undefined;
    sortDir: "asc" | "desc";
    limit: number;
    cursor?: string | undefined;
    claimFields?: string[] | undefined;
  },
): Promise<AgentPersonTimelineResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentPersonTimeline",
  });
  try {
    const cursorConsumed = query.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(query.cursor as string, {
        operation: "agentPersonTimeline",
        resource: `person:${params.platform}:${params.platformUserId}`,
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;

    const stored = cursor?.params as Record<string, unknown> | undefined;
    const from = String(stored?.from ?? query.from ?? "");
    const to = String(stored?.to ?? query.to ?? "");
    const lanesRequested = ((stored?.lanes as string[] | undefined) ?? query.lanes
      ?? [...ALL_LANES]) as Array<(typeof ALL_LANES)[number]>;
    const pageLabel = (stored?.pageLabel as string | undefined) ?? query.pageLabel;
    const sortDir = (stored?.sortDir as "asc" | "desc" | undefined) ?? query.sortDir;
    const claimFields = (stored?.claimFields as string[] | undefined) ?? query.claimFields ?? null;
    // The page size comes from the CURSOR on a resumed traversal. A cursor request
    // may not re-send `limit`, so reading the schema default instead silently
    // changed the page size after page 1 and re-minted every later cursor with it.
    const requestedLimit = (stored?.limit as number | undefined) ?? query.limit;

    const mayReadMoney = scope.has("read:money");
    const mayReadMessages = scope.has("read:messages");
    const lanesServed = permittedLanes(lanesRequested, {
      money: mayReadMoney,
      messages: mayReadMessages,
    }) as Array<(typeof ALL_LANES)[number]>;

    const narrowed = pageLabel === undefined
      ? scope.pages
      : scope.pages.filter((page) => page.pageLabel === pageLabel);
    const pageIds = narrowed.map((page) => page.id);
    const platforms = [...new Set(narrowed.map((page) => page.platform))] as Platform[];

    const identity = pageIds.length === 0
      ? { row: null, witnesses: [] }
      : await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
        findAgentPersonIdentity(tx, {
          pageIds,
          platform: params.platform,
          platformUserId: params.platformUserId,
        }), "agent_timeline_identity");

    const { limit, cappedByBudget } = await scope.limitWithinRowBudget(requestedLimit);
    const timeline = identity.row === null || lanesServed.length === 0
      ? { rows: [], witnesses: [] }
      : await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
        listAgentTimeline(tx, {
          pageIds,
          fanId: identity.row!.fanId,
          from: new Date(from),
          to: new Date(to),
          lanes: lanesServed,
          sortDir,
          limit,
          after: cursor === null
            ? undefined
            : {
              sortValue: cursor.keyset.sortValue === null ? null : String(cursor.keyset.sortValue),
              key: String(cursor.keyset.key ?? ""),
            },
        }), "agent_timeline");
    const postTipParseDebt = lanesServed.includes("post_tips")
      ? await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
        readAgentPostTipParseDebt(tx, {
          pageIds,
          parserVersion: POSTS_CANONICALIZER_VERSION,
        }), "agent_timeline_post_tip_parse_debt")
      : { topLevel: false, rejectedItems: false };

    const witnesses = [...identity.witnesses, ...timeline.witnesses];
    const operationPlanes = operationPlanesFor(
      [
        ...MESSAGE_PLANES,
        ...MONEY_PLANES,
        "creator_post_tips",
        "page_subscriptions",
        "page_follows",
        "page_fans",
        "fans",
      ],
      claimFields,
    );

    const overrides = messagePlaneOverrides(platforms);
    if (!mayReadMoney) {
      for (const plane of [...MONEY_PLANES, "creator_post_tips", "page_subscriptions"]) {
        overrides[plane] = { state: "not_read", reason: "capability_not_granted" };
      }
    }
    if (!mayReadMessages) {
      for (const plane of ["message_archive", "dm_message_archive", "page_dm_messages"]) {
        overrides[plane] = { state: "not_read", reason: "capability_not_granted" };
      }
    }

    const hasMore = timeline.rows.length === limit;
    const last = timeline.rows.at(-1);
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentPersonTimeline",
        resource: `person:${params.platform}:${params.platformUserId}`,
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        params: { from, to, lanes: lanesRequested, pageLabel, sortDir, claimFields, limit: requestedLimit },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: {},
        seqHighWater: {},
        keyset: { sortValue: last.sortValue, key: last.stableRef },
      }, scope.signing)
      : null;
    // `snapshotExhausted` may be true ONLY where a snapshot was genuinely frozen.
    // This traversal has no monotonic bound to freeze, so the last page still says
    // false and carries `no_frozen_snapshot`: "there is nothing more" would be a
    // claim about a population that can grow underneath the walk.
    const frozenSnapshot = false;
    const snapshotExhausted = frozenSnapshot && nextCursor === null;


    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: witnesses,
      planesNotRead: planesNotRead({ operationPlanes, witnesses, overrides }),
      delivery: { snapshotExhausted, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      // A five-lane union over live tables has no single monotonic bound to freeze.
      frozenSnapshot,
      requestWindow: { from, to },
      gaps: postTipParseDebtGaps(postTipParseDebt),
      scopeFieldStates: computeScopeFieldStates({
        fields: claimFields ?? [],
        platforms,
        ungrantedFields: mayReadMoney
          ? []
          : [...MONEY_CLAIM_FIELDS, ...AGENT_POST_TIP_VIEW_CLAIM_FIELDS],
      }),
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: observedRowFloorOf(timeline.rows.map((row) => row.occurredAt)),
      captureFloor: { at: null, kind: "unknown" },
      inventoryUnprovenPages: 0,
    });

    const response: AgentPersonTimelineResponse = {
      window: { from, to },
      lanesRequested,
      // The difference from `lanesRequested` is the honest report of a capability
      // gate: a dropped lane is visible, not silently empty.
      lanesServed,
      items: timeline.rows.map((row) => ({
        lane: row.lane as (typeof ALL_LANES)[number],
        kind: row.kind as AgentPersonTimelineResponse["items"][number]["kind"],
        occurredAt: iso(row.occurredAt),
        stableRef: row.stableRef,
        pageLabel: row.pageLabel,
        platform: row.platform as Platform,
        conversationRef: row.conversationRef,
        messageRef: row.messageRef,
        transactionRef: row.transactionRef,
        subscriptionRef: row.subscriptionRef,
        grossMills: toSafeNumber(row.grossMills),
        netMills: toSafeNumber(row.netMills),
        transactionType: row.transactionType as "tip" | null,
        transactionState: row.transactionState as "posted" | null,
        currency: row.currency,
        direction: row.direction as "inbound" | null,
        senderRole: row.senderRole as "fan" | null,
        textLength: row.textLength,
        hasMedia: row.hasMedia,
        isTip: row.isTip,
        postTipPostRef: row.postTipPostRef,
        postTipRef: row.postTipRef,
        postTipOccurredAt: isoOrNull(row.postTipOccurredAt),
        postTipAmountMills: toSafeNumber(row.postTipAmountMills),
        postTipGoalRef: row.postTipGoalRef,
        fieldStates: row.lane === "post_tips"
          ? postTipViewFieldStates({
            claimFields,
            scopeFieldStates: evidence.capture.scopeFieldStates,
            values: {
              postTipPostRef: row.postTipPostRef,
              postTipRef: row.postTipRef,
              postTipOccurredAt: row.postTipOccurredAt,
              postTipAmountMills: row.postTipAmountMills,
              postTipGoalRef: row.postTipGoalRef,
            },
          })
          : {},
        provenance: {
          ingestPaths: ["unknown" as const],
          convergence: "no_material_lane" as const,
          observationRef: null,
        },
      })),
      predicates: buildPredicates([
        { name: "window", requested: true, applied: true },
        {
          name: "lanes",
          requested: query.lanes !== undefined,
          // Applied whenever the served set is narrower than everything, whether
          // the narrowing came from the caller or from the capability gate.
          applied: lanesServed.length < ALL_LANES.length,
          reason: lanesServed.length < lanesRequested.length
            ? "capability_not_granted"
            : query.lanes === undefined
              ? "not_requested"
              : "applied",
        },
        {
          name: "pageLabel",
          requested: pageLabel !== undefined,
          applied: pageLabel !== undefined,
        },
      ]),
      delivery: buildDelivery({
        returned: timeline.rows.length,
        // A lower bound unless this is a complete, un-resumed read: on any later
        // page the count of THIS page is simply not the count in scope.
        matched: {
          value: timeline.rows.length,
          exact: !cursorConsumed && nextCursor === null,
        },
        cappedBy: nextCursor === null ? null : cappedByBudget ? "budget" : "limit",
        nextCursor,
        snapshotExhausted,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(timeline.rows.length);
    return response;
  } catch (error) {
    await scope.finish(0);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// #5 agentThreads
// ---------------------------------------------------------------------------

export async function handleAgentThreads(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  query: {
    platform?: Platform | undefined;
    pageLabel?: string | undefined;
    personPlatform?: Platform | undefined;
    personPlatformUserId?: string | undefined;
    coverageStatus?: string | undefined;
    quarantined?: boolean | undefined;
    hasMessagesSince?: string | undefined;
    minStoredMessages?: number | undefined;
    orderBy: "lastMessageAt" | "storedMessageCount" | "pageLabel";
    sortDir: "asc" | "desc";
    limit: number;
    cursor?: string | undefined;
    claimFields?: string[] | undefined;
  },
): Promise<AgentThreadsResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentThreads",
    requiredCapabilities: ["read:messages"],
  });
  try {
    const cursorConsumed = query.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(query.cursor as string, {
        operation: "agentThreads",
        resource: "global",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;
    const stored = cursor?.params as Record<string, unknown> | undefined;
    const effective = {
      platform: (stored?.platform as Platform | undefined) ?? query.platform,
      pageLabel: (stored?.pageLabel as string | undefined) ?? query.pageLabel,
      personPlatform: (stored?.personPlatform as Platform | undefined) ?? query.personPlatform,
      personPlatformUserId: (stored?.personPlatformUserId as string | undefined)
        ?? query.personPlatformUserId,
      coverageStatus: (stored?.coverageStatus as string | undefined) ?? query.coverageStatus,
      quarantined: (stored?.quarantined as boolean | undefined) ?? query.quarantined,
      hasMessagesSince: (stored?.hasMessagesSince as string | undefined) ?? query.hasMessagesSince,
      minStoredMessages: (stored?.minStoredMessages as number | undefined) ?? query.minStoredMessages,
      orderBy: (stored?.orderBy as typeof query.orderBy | undefined) ?? query.orderBy,
      sortDir: (stored?.sortDir as "asc" | "desc" | undefined) ?? query.sortDir,
      claimFields: (stored?.claimFields as string[] | undefined) ?? query.claimFields ?? null,
    };
    // From the CURSOR on a resumed traversal: page 2 may not re-send `limit`, and
    // the schema default silently changed the page size mid-walk.
    const requestedLimit = (stored?.limit as number | undefined) ?? query.limit;

    const narrowed = effective.pageLabel === undefined
      ? scope.pages
      : scope.pages.filter((page) => page.pageLabel === effective.pageLabel);
    const pageIds = narrowed.map((page) => page.id);
    const platforms = [...new Set(narrowed.map((page) => page.platform))] as Platform[];

    // The person filter is RESOLVED and APPLIED. It used to reach this function
    // and stop here: the response reported the predicate as applied and returned
    // every fan's threads.
    const personRequested = effective.personPlatformUserId !== undefined
      && effective.personPlatform !== undefined;
    const fanId = personRequested
      ? await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
        findAgentFanId(tx, {
          platform: effective.personPlatform as Platform,
          platformUserId: effective.personPlatformUserId as string,
        }), "agent_threads_person")
      : null;
    // A named person nobody knows narrows the result to NOTHING; it must never
    // widen it back to everybody.
    const personFilter = personRequested ? { fanId: fanId ?? -1 } : {};

    const { limit, cappedByBudget } = await scope.limitWithinRowBudget(requestedLimit);
    const storedHighWater = Number(stored?.highWater ?? 0);
    const highWater = storedHighWater > 0
      ? storedHighWater
      : await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
        readAgentThreadsHighWater(tx, pageIds), "agent_threads_high_water");

    // The retention TIER (200 vs 1000 on Fansly) applies if and only if the fan
    // has spent, so reading it without `read:money` publishes the existence of a
    // payment through a field that looks like a platform constant.
    const mayReadMoney = scope.has("read:money");
    const dbQuery = {
      pageIds,
      platform: effective.platform,
      includeLifetimeSpend: mayReadMoney,
      ...personFilter,
      coverageStatus: effective.coverageStatus,
      quarantined: effective.quarantined,
      hasMessagesSince: effective.hasMessagesSince === undefined
        ? undefined
        : new Date(effective.hasMessagesSince),
      minStoredMessages: effective.minStoredMessages,
      orderBy: effective.orderBy,
      sortDir: effective.sortDir,
      limit,
      maxThreadId: highWater,
      after: cursor === null
        ? undefined
        : {
          sortValue: cursor.keyset.sortValue === null ? null : String(cursor.keyset.sortValue),
          key: String(cursor.keyset.key ?? ""),
        },
    };

    const [result, matched] = await withAgentTimeout(
      scope.db,
      AGENT_TIMEOUT_MS.short,
      async (tx) => Promise.all([
        listAgentThreads(tx, dbQuery),
        countAgentThreads(tx, dbQuery, AGENT_COUNT_PROBE_MAX),
      ]),
      "agent_threads",
    );

    const operationPlanes = operationPlanesFor(
      // `fan_spend_lifetime` stays IN the set either way: the operation could have
      // consulted it, and "we chose not to" is a different statement from "this
      // store has nothing to do with your question".
      [...result.witnesses.map((witness) => witness.plane), "fan_spend_lifetime"],
      effective.claimFields,
    );

    const hasMore = result.rows.length === limit;
    const last = result.rows.at(-1);
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentThreads",
        resource: "global",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        params: { ...effective, limit: requestedLimit, highWater },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { page_dm_threads: String(highWater) },
        seqHighWater: {},
        keyset: { sortValue: last.sortValue, key: last.keysetKey },
      }, scope.signing)
      : null;
    // A real monotonic bound was applied in SQL, so an exhausted snapshot is a
    // claim this traversal has actually earned.
    const frozenSnapshot = true;
    const snapshotExhausted = frozenSnapshot && nextCursor === null;


    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields: effective.claimFields,
      operationPlanes,
      planeReads: result.witnesses,
      planesNotRead: planesNotRead({
        operationPlanes,
        witnesses: result.witnesses,
        overrides: {
          ...messagePlaneOverrides(platforms),
          ...(mayReadMoney
            ? {}
            : {
              fan_spend_lifetime: {
                state: "not_read" as const,
                reason: "capability_not_granted" as const,
              },
            }),
        },
      }),
      delivery: { snapshotExhausted, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      frozenSnapshot,
      requestWindow: null,
      gaps: [],
      scopeFieldStates: computeScopeFieldStates({
        fields: effective.claimFields ?? [],
        platforms,
      }),
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
      inventoryUnprovenPages: 0,
    });

    const response: AgentThreadsResponse = {
      items: result.rows.map((row) => ({
        pageLabel: row.pageLabel,
        platform: row.platform as Platform,
        conversationRef: row.conversationRef,
        fanPlatformUserId: row.fanPlatformUserId,
        fanUsername: row.fanUsername,
        fanDisplayName: row.fanDisplayName,
        isVisible: row.isVisible,
        unreadCount: row.unreadCount,
        lastMessageAt: isoOrNull(row.lastMessageAt),
        lastFanMessageAt: isoOrNull(row.lastFanMessageAt),
        lastModelMessageAt: isoOrNull(row.lastModelMessageAt),
        storedMessageCount: row.storedMessageCount,
        oldestStoredMessageRef: row.oldestStoredMessageRef,
        newestStoredMessageRef: row.newestStoredMessageRef,
        messageCoverageStatusRaw: row.coverageStatusRaw as "complete",
        lastMessageSyncAt: isoOrNull(row.lastMessageSyncAt),
        breakerOpen: row.quarantineUntil !== null && row.quarantineUntil.getTime() > Date.now(),
        quarantineUntil: isoOrNull(row.quarantineUntil),
        // Per-thread floors would be one extra scan per row; the inventory says
        // `unknown` and #6/#8 establish the real floor for a named thread.
        captureFloor: { at: null, kind: "unknown" as const },
        // The overview lesson: predict what the detail call will return, using the
        // SAME predicate, so a caller never chases a thread that answers nothing.
        transcriptWillReturnRows: row.storedMessageCount > 0,
        hydrationRemedy: hydrationRemedy(scope),
        // null WITHOUT `read:money`, because the tier cannot be known without the
        // spend and guessing the default would state a number that may be wrong.
        // The field state below says which of the two nulls this is.
        retentionLimit: mayReadMoney
          ? retentionLimitFor(row.platform as Platform, row.lifetimeSpendMills)
          : null,
        fieldStates: mayReadMoney
          ? {}
          : {
            lifetimeSpendMills: {
              state: "unknown" as const,
              remedy: { kind: "none" as const, reason: "capability_not_granted" as const },
            },
          },
        provenance: {
          ingestPaths: ["unknown" as const],
          convergence: "no_material_lane" as const,
          observationRef: null,
        },
      })),
      predicates: buildPredicates([
        {
          name: "platform",
          requested: effective.platform !== undefined,
          applied: effective.platform !== undefined,
        },
        {
          name: "pageLabel",
          requested: effective.pageLabel !== undefined,
          applied: effective.pageLabel !== undefined,
        },
        { name: "person", requested: personRequested, applied: personRequested },
        {
          name: "coverageStatus",
          requested: effective.coverageStatus !== undefined,
          applied: effective.coverageStatus !== undefined,
        },
        {
          name: "quarantined",
          requested: effective.quarantined !== undefined,
          applied: effective.quarantined !== undefined,
        },
        {
          name: "hasMessagesSince",
          requested: effective.hasMessagesSince !== undefined,
          applied: effective.hasMessagesSince !== undefined,
        },
        {
          name: "minStoredMessages",
          requested: effective.minStoredMessages !== undefined,
          applied: effective.minStoredMessages !== undefined,
        },
      ]),
      delivery: buildDelivery({
        returned: result.rows.length,
        matched,
        cappedBy: nextCursor === null ? null : cappedByBudget ? "budget" : "limit",
        nextCursor,
        snapshotExhausted,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(result.rows.length);
    return response;
  } catch (error) {
    await scope.finish(0);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// #6 agentThreadMessages
// ---------------------------------------------------------------------------

export async function handleAgentThreadMessages(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { pageLabel: string; conversationRef: string },
  query: {
    from?: string | undefined;
    to?: string | undefined;
    direction?: "inbound" | "outbound" | "unknown" | undefined;
    senderRole?: "fan" | "model" | "system" | "unknown" | undefined;
    hasMedia?: boolean | undefined;
    hasPrice?: boolean | undefined;
    isTip?: boolean | undefined;
    includeDeleted: boolean;
    sortDir: "asc" | "desc";
    limit: number;
    cursor?: string | undefined;
    claimFields?: string[] | undefined;
  },
): Promise<AgentThreadMessagesResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentThreadMessages",
    requiredCapabilities: ["read:messages"],
  });
  try {
    // In-handler guard (dual-layer law #143): the declarative middleware may run
    // in `log` mode, so the page grant is re-checked here, and a miss answers the
    // SAME static 404 the middleware would have produced.
    const page = scope.pages.find((candidate) => candidate.pageLabel === params.pageLabel);
    if (!page) {
      throw staticNotFound();
    }

    const cursorConsumed = query.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(query.cursor as string, {
        operation: "agentThreadMessages",
        // Bound to the CONVERSATION: a cursor minted for one thread must not
        // resume against another and present it as a continuation.
        resource: `conversation:${page.id}:${params.conversationRef}`,
        keyId: principal.agentKeyId,
        pageIds: [page.id],
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;
    const stored = cursor?.params as Record<string, unknown> | undefined;
    const from = String(stored?.from ?? query.from ?? "");
    const to = String(stored?.to ?? query.to ?? "");
    // What the caller ASKED for, which is what the cursor carries and what the
    // predicate report calls `requested`.
    const requestedFilters: AgentTranscriptFilters = {
      direction: (stored?.direction as typeof query.direction) ?? query.direction,
      senderRole: (stored?.senderRole as typeof query.senderRole) ?? query.senderRole,
      hasMedia: (stored?.hasMedia as boolean | undefined) ?? query.hasMedia,
      hasPrice: (stored?.hasPrice as boolean | undefined) ?? query.hasPrice,
      isTip: (stored?.isTip as boolean | undefined) ?? query.isTip,
      includeDeleted: (stored?.includeDeleted as boolean | undefined) ?? query.includeDeleted,
    };
    const sortDir = (stored?.sortDir as "asc" | "desc" | undefined) ?? query.sortDir;
    const claimFields = (stored?.claimFields as string[] | undefined) ?? query.claimFields ?? null;
    const requestedLimit = (stored?.limit as number | undefined) ?? query.limit;

    const pageCapabilities = AGENT_PLATFORM_CAPABILITIES[page.platform as Platform];
    /**
     * A predicate over a field this platform never parsed is DROPPED FROM THE
     * QUERY, not merely reported as unapplied.
     *
     * Reporting `applied: false` while still binding the column into the WHERE
     * clause was the exact lie the report exists to prevent: on Fansly, where the
     * price is not captured and the media list is journaled unparsed,
     * `hasMedia=true` returned zero rows next to an envelope saying the filter had
     * not been used, and an empty result with no applied filter reads as "there is
     * no media here". The query now genuinely ignores it, so the rows come back
     * and the envelope explains that the narrowing the caller wanted did not
     * happen.
     */
    const filters: AgentTranscriptFilters = {
      ...requestedFilters,
      hasMedia: pageCapabilities.capturesMediaMetadata === "present"
        ? requestedFilters.hasMedia
        : undefined,
      hasPrice: pageCapabilities.capturesMessagePrice === "present"
        ? requestedFilters.hasPrice
        : undefined,
    };

    // The floor is established by its OWN unbounded query, not from the rows this
    // window returned: "the oldest thing I found" is not "the oldest thing we hold".
    const archiveFloor = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
      readAgentThreadArchiveFloor(tx, {
        pageId: page.id,
        conversationRef: params.conversationRef,
      }), "agent_transcript_floor");

    const { limit, cappedByBudget } = await scope.limitWithinRowBudget(requestedLimit);
    const transcriptInput = {
      pageId: page.id,
      platform: page.platform,
      conversationRef: params.conversationRef,
      from: new Date(from),
      to: new Date(to),
      sortDir,
      limit,
      filters,
      archiveFloor,
      after: cursor === null
        ? undefined
        : {
          sortValue: cursor.keyset.sortValue === null ? null : String(cursor.keyset.sortValue),
          key: String(cursor.keyset.key ?? ""),
        },
    };

    const [result, matched] = await withAgentTimeout(
      scope.db,
      AGENT_TIMEOUT_MS.long,
      async (tx) => Promise.all([
        listAgentTranscript(tx, transcriptInput),
        countAgentTranscript(tx, transcriptInput, AGENT_COUNT_PROBE_MAX),
      ]),
      "agent_transcript",
    );

    const operationPlanes = operationPlanesFor(MESSAGE_PLANES, claimFields);

    const hasMore = result.rows.length === limit;
    const last = result.rows.at(-1);
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentThreadMessages",
        resource: `conversation:${page.id}:${params.conversationRef}`,
        keyId: principal.agentKeyId,
        pageIds: [page.id],
        // The REQUESTED filters, so page 2 reports the same predicates page 1 did
        // and drops the unsupported ones for the same reason.
        params: { from, to, ...requestedFilters, sortDir, claimFields, limit: requestedLimit },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { message_archive: last.messageRef },
        seqHighWater: { [String(page.id)]: last.sourceAccountSeq ?? 0 },
        keyset: { sortValue: last.sortValue, key: last.keysetKey },
      }, scope.signing)
      : null;
    // `snapshotExhausted` may be true ONLY where a snapshot was genuinely frozen.
    // This traversal has no monotonic bound to freeze, so the last page still says
    // false and carries `no_frozen_snapshot`: "there is nothing more" would be a
    // claim about a population that can grow underneath the walk.
    const frozenSnapshot = false;
    const snapshotExhausted = frozenSnapshot && nextCursor === null;


    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: result.witnesses,
      planesNotRead: planesNotRead({
        operationPlanes,
        witnesses: result.witnesses,
        overrides: messagePlaneOverrides([page.platform as Platform]),
      }),
      delivery: { snapshotExhausted, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      frozenSnapshot,
      requestWindow: { from, to },
      gaps: gapBeforeCaptureFloor({
        plane: "message_archive",
        floorAt: isoOrNull(archiveFloor),
        windowFrom: from,
        hydration: hydrationRemedy(scope),
      }),
      scopeFieldStates: computeScopeFieldStates({
        fields: claimFields ?? [],
        platforms: [page.platform as Platform],
      }),
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: observedRowFloorOf(result.rows.map((row) => row.occurredAt)),
      captureFloor: {
        at: isoOrNull(archiveFloor),
        kind: archiveFloor === null ? "unknown" : "oldest_stored_row",
      },
      inventoryUnprovenPages: 0,
    });

    // Every transcript read leaves an audit row. This is not decorative: the
    // owner's acceptance of a machine principal reading verbatim material rests
    // on it.
    await writeAgentAudit(scope.db, {
      agentKeyId: principal.agentKeyId,
      operation: "agentThreadMessages",
      pageIds: [page.id],
      verbatimText: true,
      requestSummary: {
        limit: requestedLimit,
        returned: result.rows.length,
        cursorConsumed,
        windowFrom: new Date(from).toISOString(),
        windowTo: new Date(to).toISOString(),
        platform: page.platform,
        planeMode: scope.planeMode,
      },
    });

    const response: AgentThreadMessagesResponse = {
      scope: {
        pageLabel: page.pageLabel,
        platform: page.platform as Platform,
        conversationRef: params.conversationRef,
        fanPlatformUserId: result.rows.at(0)?.fanPlatformUserId ?? null,
      },
      window: { from, to },
      items: result.rows.map((row) => ({
        pageLabel: page.pageLabel,
        platform: page.platform as Platform,
        conversationRef: params.conversationRef,
        messageRef: row.messageRef,
        nativeMessageRef: row.nativeMessageRef,
        fanPlatformUserId: row.fanPlatformUserId,
        senderPlatformUserId: row.senderPlatformUserId,
        senderRole: row.senderRole as "fan",
        direction: (row.isSentByMe
          ? "outbound"
          : row.senderRole === "unknown" ? "unknown" : "inbound") as "inbound",
        isSentByMe: row.isSentByMe,
        occurredAt: isoOrNull(row.occurredAt),
        state: (row.deletedAt !== null
          ? "deleted"
          : row.contentPending ? "content_pending" : "materialized") as "materialized",
        // Captured text is NEVER rewritten: no platform wording swap, no dash
        // normalization. Those rules bind text WE compose; this is a person's own.
        textPlain: row.textPlain,
        textHtml: row.textHtml,
        priceMills: toSafeNumber(row.priceMills),
        isOpened: row.isOpened,
        isNew: row.isNew,
        isTip: row.isTip,
        tipAmountMills: toSafeNumber(row.tipAmountMills),
        tipTextPlain: row.tipTextPlain,
        inReplyToRef: row.inReplyToRef,
        replyMetadata: row.replyMetadata === null
          ? null
          : Object.fromEntries(Object.entries(row.replyMetadata).map(([key, value]) => [
            key,
            typeof value === "string" || typeof value === "number" || typeof value === "boolean"
              ? value
              : null,
          ])),
        mediaMetadata: row.mediaMetadata.map((media) => ({
          mediaRef: typeof media.id === "string" ? media.id : null,
          mediaType: typeof media.type === "string" ? media.type : null,
          mimeType: typeof media.mimetype === "string" ? media.mimetype : null,
          width: positiveIntegerOrNull(media.width),
          height: positiveIntegerOrNull(media.height),
          durationSeconds: nonNegativeNumberOrNull(media.duration),
          sizeBytes: nonNegativeIntegerOrNull(media.size),
          isLocked: typeof media.locked === "boolean" ? media.locked : null,
        })),
        mediaCount: row.mediaMetadata.length,
        originClass: row.originClass,
        materialObservedAt: isoOrNull(row.materialObservedAt),
        vendorChangedAt: isoOrNull(row.vendorChangedAt),
        sourceAccountSeq: row.sourceAccountSeq,
        servingContractVersion: row.servingContractVersion,
        backfillSource: row.backfillSource,
        contentPending: row.contentPending,
        deletedAt: isoOrNull(row.deletedAt),
        sourcePlane: row.sourcePlane as "message_archive",
        fieldStates: {},
        provenance: {
          ingestPaths: ["unknown" as const],
          convergence: "no_material_lane" as const,
          observationRef: null,
        },
      })),
      predicates: buildPredicates([
        { name: "window", requested: true, applied: true },
        {
          name: "direction",
          requested: filters.direction !== undefined,
          applied: filters.direction !== undefined,
        },
        {
          name: "senderRole",
          requested: filters.senderRole !== undefined,
          applied: filters.senderRole !== undefined,
        },
        // A predicate over a field the platform never parsed was DROPPED FROM THE
        // QUERY above, and `applied: false` therefore describes the SQL that ran.
        // Reporting it unapplied while binding it anyway is what let `hasMedia=true`
        // return nothing and read as "there was no media".
        {
          name: "hasMedia",
          requested: requestedFilters.hasMedia !== undefined,
          applied: filters.hasMedia !== undefined,
          reason: requestedFilters.hasMedia === undefined
            ? "not_requested"
            : filters.hasMedia !== undefined
              ? "applied"
              : "unsupported_for_plane",
        },
        {
          name: "hasPrice",
          requested: requestedFilters.hasPrice !== undefined,
          applied: filters.hasPrice !== undefined,
          reason: requestedFilters.hasPrice === undefined
            ? "not_requested"
            : filters.hasPrice !== undefined
              ? "applied"
              : "unsupported_for_plane",
        },
        { name: "isTip", requested: filters.isTip !== undefined, applied: filters.isTip !== undefined },
        { name: "includeDeleted", requested: true, applied: true },
      ]),
      delivery: buildDelivery({
        returned: result.rows.length,
        matched,
        cappedBy: nextCursor === null ? null : cappedByBudget ? "budget" : "limit",
        nextCursor,
        snapshotExhausted,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(result.rows.length);
    return response;
  } catch (error) {
    await scope.finish(0);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// #7 agentSearchMessages
// ---------------------------------------------------------------------------

export async function handleAgentSearchMessages(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  body: AgentSearchMessagesBody,
): Promise<AgentSearchMessagesResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentSearchMessages",
    requiredCapabilities: ["read:messages"],
  });
  try {
    // The EFFECTIVE config, not the boot one: the backend flag is `runtimeApply:
    // live`, and reading `appContext.config` meant a dashboard flip did nothing
    // until the process restarted.
    const configured = scope.config.agentSearchBackend ?? "fts";
    if (configured === "off") {
      throw new AgentPlaneDisabledError("agent message search is disabled");
    }

    const narrowed = body.pageLabels === undefined
      ? scope.pages
      : scope.pages.filter((page) => body.pageLabels?.includes(page.pageLabel));
    const pageIds = narrowed.map((page) => page.id);
    const platforms = [...new Set(narrowed.map((page) => page.platform))] as Platform[];

    const { detectPgTrgmExtension } = await import("@agency_hub_core/db");
    const trgmPresent = configured === "fts_trgm"
      ? await detectPgTrgmExtension(scope.db)
      : false;
    // REPORT WHAT RAN, which is the plain FTS statement of decision #198 in every
    // case: there is no trigram branch in the SQL, so `fts_trgm` was a label for a
    // query that did not exist. Announcing it told a caller its query had been
    // fuzzy-matched when it had not, and on a miss that reads as "we even tried
    // approximate matching".
    const backend = AGENT_SEARCH_BACKEND_IN_USE;

    const from = body.from ?? "";
    const to = body.to ?? "";
    const { limit, cappedByBudget } = await scope.limitWithinRowBudget(body.limit);
    const result = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
      searchAgentArchive(tx, {
        pageIds,
        query: body.q,
        from: new Date(from),
        to: new Date(to),
        platform: body.platform,
        conversationRefs: body.conversationRefs,
        // The PAIR, not just the id: native ids are platform-scoped.
        person: body.person,
        direction: body.direction,
        senderRole: body.senderRole,
        includeSnippet: body.includeSnippet,
        limit,
      }), "agent_search");

    // The first two are ALWAYS true and the array can never be empty: a search
    // that silently misses media-only messages and inflected forms would let an
    // empty result read as an absence.
    const caveats: AgentSearchCaveat[] = [
      "text_search_misses_media_only_messages",
      "text_search_is_exact_form_only",
      "text_search_covers_message_archive_only",
    ];
    if (configured === "fts_trgm" && !trgmPresent) {
      caveats.push("trgm_extension_absent");
    }
    if (scope.scopeNarrowing.keyGrantExcludedPages > 0) {
      caveats.push("scope_narrowed_by_key_grant");
    }
    if (result.rows.length >= limit) {
      caveats.push("result_capped_at_limit");
    }

    const claimFields = body.claim?.fields ?? null;
    const operationPlanes = operationPlanesFor(MESSAGE_PLANES, claimFields);

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: result.witnesses,
      planesNotRead: planesNotRead({
        operationPlanes,
        witnesses: result.witnesses,
        overrides: {
          // The other two message stores have NO text-search index and none is
          // being built. Declaring that makes a miss visible as non-coverage
          // rather than as absence.
          dm_message_archive: { state: "not_indexed", reason: "not_indexed_for_text_search" },
          page_dm_messages: { state: "not_indexed", reason: "not_indexed_for_text_search" },
          observations: { state: "not_read", reason: "not_queried_by_this_operation" },
          sync_raw_payloads: { state: "not_read", reason: "not_queried_by_this_operation" },
          page_dm_threads: { state: "not_read", reason: "not_queried_by_this_operation" },
        },
      }),
      // Bound, not paginated: there is no snapshot to exhaust and no cursor to
      // carry one, so both stay false rather than implying completeness.
      delivery: { snapshotExhausted: false, nextCursor: null },
      cursorConsumed: false,
      cursorCapable: false,
      frozenSnapshot: false,
      requestWindow: { from, to },
      gaps: [],
      scopeFieldStates: computeScopeFieldStates({ fields: claimFields ?? [], platforms }),
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      // The hits ARE dated, and a hardcoded null threw that away.
      observedRowFloor: observedRowFloorOf(result.rows.map((row) => row.occurredAt)),
      captureFloor: { at: null, kind: "unknown" },
      inventoryUnprovenPages: 0,
    });

    if (body.includeSnippet) {
      // Snippets are the SECOND place verbatim material reaches an agent, so the
      // call is audited exactly like a transcript read. The query text itself
      // never enters the audit row: only its digest and length.
      await writeAgentAudit(scope.db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentSearchMessages",
        pageIds,
        verbatimText: true,
        requestSummary: {
          qSha256: createHash("sha256").update(body.q, "utf8").digest("hex"),
          qLength: body.q.length,
          limit: body.limit,
          returned: result.rows.length,
          windowFrom: new Date(from).toISOString(),
          windowTo: new Date(to).toISOString(),
          planeMode: scope.planeMode,
        },
      });
    }

    const response: AgentSearchMessagesResponse = {
      backend,
      caveats,
      items: result.rows.map((row) => ({
        pageLabel: row.pageLabel,
        platform: row.platform as Platform,
        conversationRef: row.conversationRef,
        messageRef: row.messageRef,
        occurredAt: isoOrNull(row.occurredAt),
        senderRole: row.senderRole as "fan",
        direction: (row.isSentByMe ? "outbound" : "inbound") as "inbound",
        isSentByMe: row.isSentByMe,
        rank: row.rank,
        snippet: body.includeSnippet ? row.snippet : null,
        fieldStates: {},
        provenance: {
          ingestPaths: ["unknown" as const],
          convergence: "no_material_lane" as const,
          observationRef: null,
        },
      })),
      predicates: buildPredicates([
        { name: "textSearch", requested: true, applied: true },
        { name: "window", requested: true, applied: true },
        {
          name: "platform",
          requested: body.platform !== undefined,
          applied: body.platform !== undefined,
        },
        {
          name: "pageLabel",
          requested: body.pageLabels !== undefined,
          applied: body.pageLabels !== undefined,
        },
        { name: "person", requested: body.person !== undefined, applied: body.person !== undefined },
        {
          name: "conversationRef",
          requested: body.conversationRefs !== undefined,
          applied: body.conversationRefs !== undefined && body.conversationRefs.length > 0,
        },
        {
          name: "direction",
          requested: body.direction !== undefined,
          applied: body.direction !== undefined,
        },
        {
          name: "senderRole",
          requested: body.senderRole !== undefined,
          applied: body.senderRole !== undefined,
        },
      ]),
      delivery: buildDelivery({
        returned: result.rows.length,
        // "Bound it, do not paginate": at the cap the count is a LOWER BOUND, and
        // there is deliberately no cursor to walk past it.
        matched: { value: result.rows.length, exact: result.rows.length < limit },
        cappedBy: result.rows.length >= limit ? (cappedByBudget ? "budget" : "limit") : null,
        nextCursor: null,
        snapshotExhausted: false,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(result.rows.length);
    return response;
  } catch (error) {
    await scope.finish(0);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// #8 agentCoverage
// ---------------------------------------------------------------------------

export async function handleAgentCoverage(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  query: {
    from?: string | undefined;
    to?: string | undefined;
    platform?: Platform | undefined;
    pageLabel?: string | undefined;
    personPlatform?: Platform | undefined;
    personPlatformUserId?: string | undefined;
    conversationRef?: string | undefined;
    limit: number;
    cursor?: string | undefined;
    claimFields?: string[] | undefined;
  },
): Promise<AgentCoverageResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentCoverage",
    // The response carries conversation refs, fan ids and a message-archive floor:
    // the same thread inventory #2 and #5 gate. An ungated probe was a way to
    // enumerate who talks to whom without holding the capability for it.
    requiredCapabilities: ["read:messages"],
  });
  try {
    const cursorConsumed = query.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(query.cursor as string, {
        operation: "agentCoverage",
        resource: "global",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;
    const stored = cursor?.params as Record<string, unknown> | undefined;
    const from = String(stored?.from ?? query.from ?? "");
    const to = String(stored?.to ?? query.to ?? "");
    // EVERY scope field is read back from the cursor. Since a cursor request may
    // not re-send them, anything the cursor fails to store silently widens the
    // traversal on page 2 — which is exactly how `platform` was lost here.
    const platform = (stored?.platform as Platform | undefined) ?? query.platform;
    const pageLabel = (stored?.pageLabel as string | undefined) ?? query.pageLabel;
    const conversationRef = (stored?.conversationRef as string | undefined) ?? query.conversationRef;
    const personPlatform = (stored?.personPlatform as Platform | undefined) ?? query.personPlatform;
    const personPlatformUserId = (stored?.personPlatformUserId as string | undefined)
      ?? query.personPlatformUserId;
    const claimFields = (stored?.claimFields as string[] | undefined) ?? query.claimFields ?? null;
    const requestedLimit = (stored?.limit as number | undefined) ?? query.limit;

    const narrowed = pageLabel === undefined
      ? scope.pages
      : scope.pages.filter((page) => page.pageLabel === pageLabel);
    const pageIds = narrowed.map((page) => page.id);
    const platforms = [...new Set(narrowed.map((page) => page.platform))] as Platform[];

    // Accepted AND applied — this pair used to be dropped between the schema and
    // the query while the response reported the predicate as applied.
    const personRequested = personPlatformUserId !== undefined && personPlatform !== undefined;
    const fanId = personRequested
      ? await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
        findAgentFanId(tx, {
          platform: personPlatform as Platform,
          platformUserId: personPlatformUserId as string,
        }), "agent_coverage_person")
      : null;
    const personFilter = personRequested ? { fanId: fanId ?? -1 } : {};

    const { limit, cappedByBudget } = await scope.limitWithinRowBudget(requestedLimit);
    const sourceErrors: Array<{
      source: "page_dm_threads";
      code: "statement_timeout";
      excludedFromCounts: true;
    }> = [];

    // Multi-source degradation: ONE failed source becomes a named row excluded
    // from the counts. A single-source operation answers 503 instead.
    const scopesResult = await tryAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
      listAgentCoverageScopes(tx, {
        pageIds,
        platform,
        ...personFilter,
        conversationRef,
        from: new Date(from),
        to: new Date(to),
        limit,
        after: cursor === null
          ? undefined
          : {
            sortValue: cursor.keyset.sortValue === null ? null : String(cursor.keyset.sortValue),
            key: String(cursor.keyset.key ?? ""),
          },
      }), "agent_coverage");
    if (!scopesResult.ok) {
      sourceErrors.push({
        source: "page_dm_threads",
        code: "statement_timeout",
        excludedFromCounts: true,
      });
    }
    const scopes = scopesResult.ok ? scopesResult.value : { rows: [], witnesses: [] };

    // Scoped to the GRANT, never deployment-wide: an ungranted page's earlier row
    // is not this key's floor and must not stand in for one.
    const journalFloor = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
      readAgentJournalFloor(tx, { pageIds, platform }), "agent_journal_floor");

    const operationPlanes = operationPlanesFor(MESSAGE_PLANES, claimFields);
    const notRead = planesNotRead({
      operationPlanes,
      witnesses: scopes.witnesses,
      overrides: messagePlaneOverrides(platforms),
    });

    const last = scopes.rows.at(-1);
    const hasMore = scopes.rows.length === limit;
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentCoverage",
        resource: "global",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        params: {
          from,
          to,
          platform,
          pageLabel,
          conversationRef,
          personPlatform,
          personPlatformUserId,
          claimFields,
          limit: requestedLimit,
        },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { page_dm_threads: last.conversationRef },
        seqHighWater: {},
        keyset: { sortValue: last.sortValue, key: last.keysetKey },
      }, scope.signing)
      : null;
    // `snapshotExhausted` may be true ONLY where a snapshot was genuinely frozen.
    // This traversal has no monotonic bound to freeze, so the last page still says
    // false and carries `no_frozen_snapshot`: "there is nothing more" would be a
    // claim about a population that can grow underneath the walk.
    const frozenSnapshot = false;
    const snapshotExhausted = frozenSnapshot && nextCursor === null;


    const hydration = hydrationRemedy(scope);
    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: scopes.witnesses,
      planesNotRead: notRead,
      delivery: { snapshotExhausted, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      frozenSnapshot,
      requestWindow: { from, to },
      gaps: [],
      scopeFieldStates: computeScopeFieldStates({ fields: claimFields ?? [], platforms }),
      sourceErrors,
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
      inventoryUnprovenPages: 0,
    });

    const items = scopes.rows.map((entry) => {
      const floorAt = isoOrNull(entry.archiveFloor);
      const gaps = gapBeforeCaptureFloor({
        plane: "message_archive",
        floorAt,
        windowFrom: from,
        hydration,
      });
      const perScope = buildAgentEvidence({
        planeMode: scope.planeMode,
        claimFields,
        operationPlanes,
        // THIS conversation's witnesses, carrying THIS conversation's floor. Every
        // item used to reuse the response-level witnesses, whose `message_archive`
        // floor is `unknown`; a window starting AFTER the floor produces no gap, so
        // the known date then vanished from the answer entirely.
        planeReads: entry.witnesses,
        planesNotRead: planesNotRead({
          operationPlanes,
          witnesses: entry.witnesses,
          overrides: messagePlaneOverrides([entry.platform as Platform]),
        }),
        // A per-scope evidence block, not a page of a traversal: the item's
        // blockers speak about THIS conversation's window, so the walk's own
        // pagination caveats have nothing to say about it.
        delivery: { snapshotExhausted: true, nextCursor: null },
        cursorConsumed: false,
        cursorCapable: false,
        frozenSnapshot: true,
        requestWindow: { from, to },
        gaps,
        scopeFieldStates: computeScopeFieldStates({
          fields: claimFields ?? [],
          platforms: [entry.platform as Platform],
        }),
        sourceErrors,
        scopeNarrowing: scope.scopeNarrowing,
        observedRowFloor: isoOrNull(entry.observedRowFloor),
        captureFloor: { at: floorAt, kind: floorAt === null ? "unknown" : "oldest_stored_row" },
        inventoryUnprovenPages: 0,
      });
      return {
        pageLabel: entry.pageLabel,
        platform: entry.platform as Platform,
        conversationRef: entry.conversationRef,
        fanPlatformUserId: entry.fanPlatformUserId,
        planes: perScope.capture.planes,
        observedRowFloor: isoOrNull(entry.observedRowFloor),
        gaps: perScope.capture.gaps,
        fieldStates: perScope.capture.scopeFieldStates,
        blockers: perScope.conclusion.blockers,
      };
    });

    const response: AgentCoverageResponse = {
      window: { from, to },
      items,
      journalFloor: {
        observationsFirstReceivedAt: isoOrNull(journalFloor.observationsFirstReceivedAt),
        // Both journals, because #8 reports the SHAPE of the store; the operation
        // that turns a detachment into an observations gap (#9a) takes only the
        // observations list.
        detachedPartitions: [
          ...journalFloor.detachedObservationPartitions,
          ...journalFloor.detachedDomainEventPartitions,
        ],
      },
      delivery: buildDelivery({
        returned: items.length,
        matched: { value: items.length, exact: !cursorConsumed && nextCursor === null },
        cappedBy: nextCursor === null ? null : cappedByBudget ? "budget" : "limit",
        nextCursor,
        snapshotExhausted,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(items.length);
    return response;
  } catch (error) {
    await scope.finish(0);
    throw error;
  }
}
