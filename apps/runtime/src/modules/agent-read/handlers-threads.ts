import { createHash } from "node:crypto";

import type {
  AgentCoverageResponse,
  AgentGap,
  AgentPersonTimelineResponse,
  AgentPlaneReason,
  AgentSearchCaveat,
  AgentSearchMessagesBody,
  AgentSearchMessagesResponse,
  AgentThreadMessagesResponse,
  AgentThreadsResponse,
} from "@agency_hub_core/contracts";
import {
  countAgentThreads,
  countAgentTranscript,
  isStatementTimeout,
  listAgentCoverageScopes,
  listAgentThreads,
  listAgentTimeline,
  listAgentTranscript,
  proofWitness,
  readAgentCoverageProofs,
  readAgentJournalFloor,
  readAgentLaneCeilings,
  searchAgentArchive,
  storeDerivedWitness,
  withAgentStatementTimeout,
  type AgentCoverageProofRow,
  type AgentTranscriptFilters,
  type PlaneReadWitness,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal } from "../../services/auth.ts";
import { buildAgentEvidence, type PlaneNotReadReason } from "./epistemics.ts";
import { decodeAgentCursor, encodeAgentCursor } from "./cursors.ts";
import { staticNotFound, toSafeNumber } from "./errors.ts";
import { MESSAGE_PLANES, MONEY_PLANES, planesNotRead } from "./planes.ts";
import {
  AGENT_COUNT_PROBE_MAX,
  AGENT_PLATFORM_CAPABILITIES,
  AGENT_TIMEOUT_MS,
  beginAgentRequest,
  buildDelivery,
  buildPredicates,
  computeScopeFieldStates,
  hasProofLaneForClaim,
  iso,
  isoOrNull,
  operationPlanesFor,
  writeAgentAudit,
} from "./runtime.ts";

/**
 * Operations #4 (timeline), #5 (threads), #6 (transcript), #7 (search) and #8
 * (coverage).
 *
 * The shape they share: a keyset traversal over a mutable sort key. That is why
 * every paged response here carries the `mutable_sort_key` caveat, and why a
 * response that CONSUMED a cursor carries the `mutable_sort_key_traversal`
 * BLOCKER instead — within one request the read is snapshot-consistent, across
 * pages it is not, and no caveat can cure a skipped row.
 *
 * #7 pages not at all, on purpose ("bound it, do not paginate"): it returns at
 * most 100 locators with an inexact `matchedInScope`, and its two structurally
 * unindexed planes make `absenceProvable` permanently false there.
 */

const NO_LANE_CEILING = {
  at: null,
  kind: "no_lane" as const,
  laneCadenceSeconds: null,
  breakerOpen: false,
};

/** The lane ceiling for a set of pages: the OLDEST successful pull wins, because
 *  a scope is only as fresh as its stalest member. */
function mergeLaneCeiling(
  ceilings: ReadonlyArray<{ succeededAt: Date | null; cadenceSeconds: number; status: string }>,
) {
  if (ceilings.length === 0) {
    return NO_LANE_CEILING;
  }
  let at: Date | null = null;
  let cadence: number | null = null;
  let breakerOpen = false;
  for (const ceiling of ceilings) {
    if (ceiling.succeededAt === null) {
      at = null;
      breakerOpen = true;
      break;
    }
    if (at === null || ceiling.succeededAt.getTime() < at.getTime()) {
      at = ceiling.succeededAt;
    }
    cadence = cadence === null
      ? ceiling.cadenceSeconds
      : Math.max(cadence, ceiling.cadenceSeconds);
    if (ceiling.status === "blocked" || ceiling.status === "paused") {
      breakerOpen = true;
    }
  }
  return {
    at: at?.toISOString() ?? null,
    kind: at === null ? ("no_lane" as const) : ("last_successful_pull" as const),
    laneCadenceSeconds: cadence !== null && cadence > 0 ? cadence : null,
    breakerOpen,
  };
}

/** The OF-only archive is a REQUIRED plane for message claims, so on a Fansly
 *  scope it is `not_read` with its real reason — which is precisely why no Fansly
 *  answer can ever be `absenceProvable`. */
function messagePlaneOverrides(
  platforms: readonly Platform[],
): Record<string, { state: "not_read" | "not_indexed"; reason: AgentPlaneReason }> {
  const overrides: Record<string, { state: "not_read" | "not_indexed"; reason: AgentPlaneReason }> = {
    observations: { state: "not_read", reason: "not_queried_by_this_operation" },
    sync_raw_payloads: { state: "not_read", reason: "not_queried_by_this_operation" },
  };
  // The OF-only archive is decided by the capability table, not by naming a
  // platform: `hasCoverageProofs` is the same fact ("this platform has an OFAPI
  // lane") that makes `dm_message_archive` exist at all.
  if (platforms.length > 0 && platforms.every((platform) =>
    !AGENT_PLATFORM_CAPABILITIES[platform].hasCoverageProofs)) {
    overrides.dm_message_archive = { state: "not_read", reason: "onlyfans_only" };
  }
  return overrides;
}

function gapBeforeFloor(plane: string, floorAt: string | null, windowFrom: string): AgentGap[] {
  if (floorAt !== null && Date.parse(windowFrom) >= Date.parse(floorAt)) {
    return [];
  }
  // The window (or part of it) predates anything this system can attest to. The
  // remedy is a targeted hydration, and naming it is what turns "nothing found"
  // into "nothing was ever captured, and here is how to change that".
  return [{
    kind: "before_capture_floor",
    from: null,
    to: floorAt,
    plane: plane as AgentGap["plane"],
    remedy: {
      kind: "hydration_request",
      costClass: "vendor_paid_low",
      admissible: true,
      reason: null,
    },
  }];
}

// ---------------------------------------------------------------------------
// #4 agentPersonTimeline
// ---------------------------------------------------------------------------

const TIMELINE_LANES = ["messages", "money", "subscriptions", "follows", "presence"] as const;

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
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;

    const params0 = cursor?.params as Record<string, unknown> | undefined;
    const from = String(params0?.from ?? query.from ?? "");
    const to = String(params0?.to ?? query.to ?? "");
    const lanes = ((params0?.lanes as string[] | undefined) ?? query.lanes
      ?? [...TIMELINE_LANES]) as Array<(typeof TIMELINE_LANES)[number]>;
    const pageLabel = (params0?.pageLabel as string | undefined) ?? query.pageLabel;
    const sortDir = (params0?.sortDir as "asc" | "desc" | undefined) ?? query.sortDir;
    const claimFields = (params0?.claimFields as string[] | undefined) ?? query.claimFields ?? null;
    const normalizedParams = { from, to, lanes, pageLabel, sortDir, claimFields, limit: query.limit };

    const narrowed = pageLabel === undefined
      ? scope.pages
      : scope.pages.filter((page) => page.pageLabel === pageLabel);
    const pageIds = narrowed.map((page) => page.id);
    const platforms = [...new Set(narrowed.map((page) => page.platform))] as Platform[];

    const identity = pageIds.length === 0
      ? null
      : await withAgentStatementTimeout(scope.db, AGENT_TIMEOUT_MS.long, async (tx) => {
        const { findAgentPersonIdentity } = await import("@agency_hub_core/db");
        return findAgentPersonIdentity(tx, {
          pageIds,
          platform: params.platform,
          platformUserId: params.platformUserId,
        });
      });

    const after = cursor === null
      ? undefined
      : {
        occurredAt: String(cursor.keyset.occurredAt ?? ""),
        stableRef: String(cursor.keyset.stableRef ?? ""),
      };

    const rows = identity === null
      ? []
      : await withAgentStatementTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
        listAgentTimeline(tx, {
          pageIds,
          fanId: identity.fanId,
          from: new Date(from),
          to: new Date(to),
          lanes,
          sortDir,
          limit: query.limit,
          after,
        }));

    const laneCeilings = await readAgentLaneCeilings(scope.db, pageIds, "dm_messages");
    const ceiling = mergeLaneCeiling(laneCeilings);

    const readPlanes = [
      "message_archive",
      "dm_message_archive",
      "page_dm_messages",
      ...(scope.has("read:money") ? ["transactions"] : []),
      "page_subscriptions",
      "page_follows",
      "page_fans",
    ];
    const witnesses: PlaneReadWitness[] = readPlanes.map((plane) => storeDerivedWitness({
      plane,
      ceilingAt: ceiling.at,
      ceilingKind: ceiling.kind,
      laneCadenceSeconds: ceiling.laneCadenceSeconds,
      breakerOpen: ceiling.breakerOpen,
    }));
    const operationPlanes = operationPlanesFor(
      [...readPlanes, ...MESSAGE_PLANES, ...MONEY_PLANES],
      claimFields,
    );

    const hasMore = rows.length === query.limit;
    const last = rows.at(-1);
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentPersonTimeline",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        params: normalizedParams,
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { timeline: iso(last.occurredAt) },
        seqHighWater: {},
        keyset: { occurredAt: iso(last.occurredAt), stableRef: last.stableRef },
      }, scope.signing)
      : null;

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: witnesses,
      planesNotRead: planesNotRead({
        operationPlanes,
        witnesses,
        overrides: messagePlaneOverrides(platforms),
      }),
      delivery: { snapshotExhausted: nextCursor === null, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      requestWindow: { from, to },
      gaps: gapBeforeFloor("message_archive", null, from),
      gapDetection: "head_only",
      scopeFieldStates: computeScopeFieldStates({
        fields: claimFields ?? [],
        platforms,
        ungrantedFields: scope.has("read:money") ? [] : ["grossMills", "netMills", "amountMills"],
      }),
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: isoOrNull(rows.at(0)?.occurredAt ?? null),
      captureFloor: { at: null, kind: "unknown" },
      captureCeiling: ceiling,
      basis: "store_derived",
      proof: null,
      parseDebt: 0,
      rejected: 0,
      servingHighWaterSatisfied: true,
      hasProofLaneForClaim: hasProofLaneForClaim(claimFields, platforms),
    });

    const response = {
      window: { from, to },
      lanesRequested: lanes,
      lanesServed: lanes,
      items: rows.map((row) => ({
        lane: row.lane as (typeof TIMELINE_LANES)[number],
        kind: row.kind as "message.received",
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
        fieldStates: {},
        provenance: {
          ingestPaths: ["unknown" as const],
          convergence: "no_material_lane" as const,
          observationRef: null,
        },
      })),
      predicates: buildPredicates([
        { name: "window", requested: true },
        { name: "lanes", requested: query.lanes !== undefined },
        { name: "pageLabel", requested: pageLabel !== undefined },
      ]),
      delivery: buildDelivery({
        returned: rows.length,
        matched: { value: rows.length, exact: nextCursor === null },
        cappedBy: nextCursor === null ? null : "limit",
        nextCursor,
        snapshotExhausted: nextCursor === null,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(rows.length);
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
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;
    const stored = cursor?.params as Record<string, unknown> | undefined;
    const effective = {
      platform: (stored?.platform as Platform | undefined) ?? query.platform,
      pageLabel: (stored?.pageLabel as string | undefined) ?? query.pageLabel,
      coverageStatus: (stored?.coverageStatus as string | undefined) ?? query.coverageStatus,
      quarantined: (stored?.quarantined as boolean | undefined) ?? query.quarantined,
      hasMessagesSince: (stored?.hasMessagesSince as string | undefined) ?? query.hasMessagesSince,
      minStoredMessages: (stored?.minStoredMessages as number | undefined) ?? query.minStoredMessages,
      orderBy: (stored?.orderBy as typeof query.orderBy | undefined) ?? query.orderBy,
      sortDir: (stored?.sortDir as "asc" | "desc" | undefined) ?? query.sortDir,
      claimFields: (stored?.claimFields as string[] | undefined) ?? query.claimFields ?? null,
    };

    const narrowed = effective.pageLabel === undefined
      ? scope.pages
      : scope.pages.filter((page) => page.pageLabel === effective.pageLabel);
    const pageIds = narrowed.map((page) => page.id);
    const platforms = [...new Set(narrowed.map((page) => page.platform))] as Platform[];

    const dbQuery = {
      pageIds,
      platform: effective.platform,
      coverageStatus: effective.coverageStatus,
      quarantined: effective.quarantined,
      hasMessagesSince: effective.hasMessagesSince === undefined
        ? undefined
        : new Date(effective.hasMessagesSince),
      minStoredMessages: effective.minStoredMessages,
      orderBy: effective.orderBy,
      sortDir: effective.sortDir,
      limit: query.limit,
      after: cursor === null
        ? undefined
        : {
          sortValue: cursor.keyset.sortValue === null ? null : String(cursor.keyset.sortValue),
          threadId: Number(cursor.keyset.threadId ?? 0),
        },
    };

    const [rows, matched] = await withAgentStatementTimeout(
      scope.db,
      AGENT_TIMEOUT_MS.short,
      async (tx) => Promise.all([
        listAgentThreads(tx, dbQuery),
        countAgentThreads(tx, dbQuery, AGENT_COUNT_PROBE_MAX),
      ]),
    );

    const laneCeilings = await readAgentLaneCeilings(scope.db, pageIds, "dm_messages");
    const ceiling = mergeLaneCeiling(laneCeilings);

    const readPlanes = ["message_archive", "dm_message_archive", "page_dm_messages", "page_dm_threads"];
    const witnesses: PlaneReadWitness[] = readPlanes.map((plane) => storeDerivedWitness({
      plane,
      ceilingAt: ceiling.at,
      ceilingKind: ceiling.kind,
      laneCadenceSeconds: ceiling.laneCadenceSeconds,
      breakerOpen: ceiling.breakerOpen,
    }));
    const operationPlanes = operationPlanesFor([...readPlanes, ...MESSAGE_PLANES], effective.claimFields);

    const hasMore = rows.length === query.limit;
    const last = rows.at(-1);
    const sortValue = last === undefined
      ? null
      : effective.orderBy === "storedMessageCount"
        ? String(last.storedMessageCount)
        : effective.orderBy === "pageLabel"
          ? last.pageLabel
          : isoOrNull(last.lastMessageAt);
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentThreads",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        params: { ...effective, limit: query.limit },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { page_dm_threads: String(last.threadId) },
        seqHighWater: {},
        keyset: { sortValue, threadId: last.threadId },
      }, scope.signing)
      : null;

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields: effective.claimFields,
      operationPlanes,
      planeReads: witnesses,
      planesNotRead: planesNotRead({
        operationPlanes,
        witnesses,
        overrides: messagePlaneOverrides(platforms),
      }),
      delivery: { snapshotExhausted: nextCursor === null, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      requestWindow: null,
      gaps: [],
      gapDetection: "head_only",
      scopeFieldStates: computeScopeFieldStates({
        fields: effective.claimFields ?? [],
        platforms,
      }),
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
      captureCeiling: ceiling,
      basis: "store_derived",
      proof: null,
      parseDebt: 0,
      rejected: 0,
      servingHighWaterSatisfied: true,
      hasProofLaneForClaim: hasProofLaneForClaim(effective.claimFields, platforms),
    });

    const response = {
      items: rows.map((row) => {
        const capabilities = AGENT_PLATFORM_CAPABILITIES[row.platform as Platform];
        const retentionLimit = capabilities.depthCap === null
          ? null
          : (row.lifetimeSpendMills ?? 0n) > 0n
            ? capabilities.depthCap.lifetimeSpender
            : capabilities.depthCap.default;
        return {
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
          basis: "store_derived" as const,
          captureFloor: { at: null, kind: "unknown" as const },
          captureCeiling: ceiling,
          // The overview lesson: predict what the detail call will return, using
          // the SAME predicate, so a caller never chases a thread that answers
          // nothing.
          transcriptWillReturnRows: row.storedMessageCount > 0,
          hydrationRemedy: {
            kind: "hydration_request" as const,
            costClass: "vendor_paid_low" as const,
            admissible: (scope.config.agentHydrationMode ?? "off") !== "off",
            reason: (scope.config.agentHydrationMode ?? "off") === "off"
              ? ("hydration_mode_off" as const)
              : null,
          },
          retentionLimit,
          fieldStates: {},
          provenance: {
            ingestPaths: ["unknown" as const],
            convergence: "no_material_lane" as const,
            observationRef: null,
          },
        };
      }),
      predicates: buildPredicates([
        { name: "platform", requested: effective.platform !== undefined },
        { name: "pageLabel", requested: effective.pageLabel !== undefined },
        { name: "person", requested: query.personPlatformUserId !== undefined },
        { name: "coverageStatus", requested: effective.coverageStatus !== undefined },
        { name: "quarantined", requested: effective.quarantined !== undefined },
        { name: "hasMessagesSince", requested: effective.hasMessagesSince !== undefined },
        { name: "minStoredMessages", requested: effective.minStoredMessages !== undefined },
      ]),
      delivery: buildDelivery({
        returned: rows.length,
        matched,
        cappedBy: nextCursor === null ? null : "limit",
        nextCursor,
        snapshotExhausted: nextCursor === null,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(rows.length);
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
    // In-handler guard (#143 dual layer): the declarative middleware may run in
    // `log` mode, so the page grant is re-checked here, and a miss answers the
    // SAME static 404 the middleware would have produced.
    const page = scope.pages.find((candidate) => candidate.pageLabel === params.pageLabel);
    if (!page) {
      throw staticNotFound();
    }

    const cursorConsumed = query.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(query.cursor as string, {
        operation: "agentThreadMessages",
        keyId: principal.agentKeyId,
        pageIds: [page.id],
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;
    const stored = cursor?.params as Record<string, unknown> | undefined;
    const from = String(stored?.from ?? query.from ?? "");
    const to = String(stored?.to ?? query.to ?? "");
    const filters: AgentTranscriptFilters = {
      direction: (stored?.direction as typeof query.direction) ?? query.direction,
      senderRole: (stored?.senderRole as typeof query.senderRole) ?? query.senderRole,
      hasMedia: (stored?.hasMedia as boolean | undefined) ?? query.hasMedia,
      hasPrice: (stored?.hasPrice as boolean | undefined) ?? query.hasPrice,
      isTip: (stored?.isTip as boolean | undefined) ?? query.isTip,
      includeDeleted: (stored?.includeDeleted as boolean | undefined) ?? query.includeDeleted,
    };
    const sortDir = (stored?.sortDir as "asc" | "desc" | undefined) ?? query.sortDir;
    const claimFields = (stored?.claimFields as string[] | undefined) ?? query.claimFields ?? null;

    const transcriptInput = {
      pageId: page.id,
      platform: page.platform,
      conversationRef: params.conversationRef,
      from: new Date(from),
      to: new Date(to),
      sortDir,
      limit: query.limit,
      filters,
      after: cursor === null
        ? undefined
        : {
          occurredAt: cursor.keyset.occurredAt === null ? null : String(cursor.keyset.occurredAt),
          messageRef: String(cursor.keyset.messageRef ?? ""),
        },
    };

    const [rows, matched] = await withAgentStatementTimeout(
      scope.db,
      AGENT_TIMEOUT_MS.long,
      async (tx) => Promise.all([
        listAgentTranscript(tx, transcriptInput),
        countAgentTranscript(tx, transcriptInput, AGENT_COUNT_PROBE_MAX),
      ]),
    );

    const [proofs, laneCeilings] = await Promise.all([
      readAgentCoverageProofs(scope.db, [page.id], [params.conversationRef]),
      readAgentLaneCeilings(scope.db, [page.id], "dm_messages"),
    ]);
    const ceiling = mergeLaneCeiling(laneCeilings);
    const proofRow: AgentCoverageProofRow | undefined = proofs[0];

    // The ONE path to a cryptographic proof in this system. It exists only for
    // OnlyFans, which is why a Fansly transcript can never prove an absence.
    const archiveWitness = proofRow === undefined
      ? storeDerivedWitness({
        plane: "message_archive",
        ceilingAt: ceiling.at,
        ceilingKind: ceiling.kind,
        laneCadenceSeconds: ceiling.laneCadenceSeconds,
        breakerOpen: ceiling.breakerOpen,
      })
      : proofWitness(proofRow, "message_archive");

    const pageCapabilities = AGENT_PLATFORM_CAPABILITIES[page.platform as Platform];
    const witnesses: PlaneReadWitness[] = [
      archiveWitness,
      // The OF-only store is read only where it can exist; the capability table
      // decides, so no handler names a platform.
      ...(pageCapabilities.hasCoverageProofs
        ? [storeDerivedWitness({ plane: "dm_message_archive", ceilingAt: ceiling.at })]
        : []),
      storeDerivedWitness({ plane: "page_dm_messages", ceilingAt: ceiling.at }),
      storeDerivedWitness({ plane: "page_dm_threads", ceilingAt: ceiling.at }),
    ];
    const operationPlanes = operationPlanesFor(MESSAGE_PLANES, claimFields);

    const hasMore = rows.length === query.limit;
    const last = rows.at(-1);
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentThreadMessages",
        keyId: principal.agentKeyId,
        pageIds: [page.id],
        params: { from, to, ...filters, sortDir, claimFields, limit: query.limit },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { message_archive: last.messageRef },
        seqHighWater: { [String(page.id)]: last.sourceAccountSeq ?? 0 },
        keyset: {
          occurredAt: isoOrNull(last.occurredAt),
          messageRef: last.messageRef,
        },
      }, scope.signing)
      : null;

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: witnesses,
      planesNotRead: planesNotRead({
        operationPlanes,
        witnesses,
        overrides: messagePlaneOverrides([page.platform as Platform]),
      }),
      delivery: { snapshotExhausted: nextCursor === null, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      requestWindow: { from, to },
      gaps: gapBeforeFloor("message_archive", archiveWitness.captureFloor.at, from),
      gapDetection: "head_only",
      scopeFieldStates: computeScopeFieldStates({
        fields: claimFields ?? [],
        platforms: [page.platform as Platform],
      }),
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: isoOrNull(
        rows.reduce<Date | null>((floor, row) =>
          row.occurredAt !== null && (floor === null || row.occurredAt < floor)
            ? row.occurredAt
            : floor, null),
      ),
      captureFloor: archiveWitness.captureFloor,
      captureCeiling: archiveWitness.captureCeiling.at === null
        ? ceiling
        : archiveWitness.captureCeiling,
      basis: archiveWitness.basis,
      proof: archiveWitness.proof,
      parseDebt: archiveWitness.parseDebt,
      rejected: archiveWitness.rejected,
      servingHighWaterSatisfied: archiveWitness.servingHighWaterSatisfied,
      hasProofLaneForClaim: hasProofLaneForClaim(claimFields, [page.platform as Platform]),
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
        limit: query.limit,
        returned: rows.length,
        cursorConsumed,
        windowFrom: new Date(from).toISOString(),
        windowTo: new Date(to).toISOString(),
        platform: page.platform,
        planeMode: scope.planeMode,
      },
    });

    const response = {
      scope: {
        pageLabel: page.pageLabel,
        platform: page.platform as Platform,
        conversationRef: params.conversationRef,
        fanPlatformUserId: rows.at(0)?.fanPlatformUserId ?? null,
      },
      window: { from, to },
      items: rows.map((row) => ({
        pageLabel: page.pageLabel,
        platform: page.platform as Platform,
        conversationRef: params.conversationRef,
        messageRef: row.messageRef,
        nativeMessageRef: row.nativeMessageRef,
        fanPlatformUserId: row.fanPlatformUserId,
        senderPlatformUserId: row.senderPlatformUserId,
        senderRole: row.senderRole as "fan",
        direction: (row.isSentByMe ? "outbound" : row.senderRole === "unknown" ? "unknown" : "inbound") as "inbound",
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
          width: typeof media.width === "number" ? media.width : null,
          height: typeof media.height === "number" ? media.height : null,
          durationSeconds: typeof media.duration === "number" ? media.duration : null,
          sizeBytes: typeof media.size === "number" ? media.size : null,
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
        { name: "window", requested: true },
        { name: "direction", requested: filters.direction !== undefined },
        { name: "senderRole", requested: filters.senderRole !== undefined },
        // A predicate over a field the platform never parsed is NOT applied, and
        // says so with `unsupported_for_plane`. Silently "applying" it would let
        // `hasMedia=true` return nothing and read as "there was no media" —
        // exactly the inference the whole envelope exists to prevent. The verdict
        // comes from the capability table, never from a platform literal.
        {
          name: "hasMedia",
          requested: filters.hasMedia !== undefined,
          applied: filters.hasMedia !== undefined
            && pageCapabilities.capturesMediaMetadata === "present",
          reason: filters.hasMedia === undefined
            ? "not_requested"
            : pageCapabilities.capturesMediaMetadata === "present"
              ? "applied"
              : "unsupported_for_plane",
        },
        {
          name: "hasPrice",
          requested: filters.hasPrice !== undefined,
          applied: filters.hasPrice !== undefined
            && pageCapabilities.capturesMessagePrice === "present",
          reason: filters.hasPrice === undefined
            ? "not_requested"
            : pageCapabilities.capturesMessagePrice === "present"
              ? "applied"
              : "unsupported_for_plane",
        },
        { name: "isTip", requested: filters.isTip !== undefined },
        { name: "includeDeleted", requested: true },
      ]),
      delivery: buildDelivery({
        returned: rows.length,
        matched,
        cappedBy: nextCursor === null ? null : "limit",
        nextCursor,
        snapshotExhausted: nextCursor === null,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(rows.length);
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
    extraGate: {
      enabled: (appContext.config.agentSearchBackend ?? "fts") !== "off",
      reason: "agent message search is disabled",
    },
  });
  try {
    const configured = scope.config.agentSearchBackend ?? "fts";
    if (configured === "off") {
      // Re-checked against the EFFECTIVE config: `beginAgentRequest` saw the boot
      // value, and a live flip must take effect on the next request.
      const { AgentPlaneDisabledError } = await import("./errors.ts");
      throw new AgentPlaneDisabledError("agent message search is disabled");
    }

    const narrowed = body.pageLabels === undefined
      ? scope.pages
      : scope.pages.filter((page) => body.pageLabels?.includes(page.pageLabel));
    const pageIds = narrowed.map((page) => page.id);
    const platforms = [...new Set(narrowed.map((page) => page.platform))] as Platform[];

    const { detectPgTrgmExtension } = await import("@agency_hub_core/db");
    const trgmPresent = configured === "fts_trgm" ? await detectPgTrgmExtension(scope.db) : false;
    const backend = configured === "fts_trgm" && trgmPresent ? "fts_trgm" as const : "fts" as const;

    const from = body.from ?? "";
    const to = body.to ?? "";
    const rows = await withAgentStatementTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
      searchAgentArchive(tx, {
        pageIds,
        query: body.q,
        from: new Date(from),
        to: new Date(to),
        platform: body.platform,
        conversationRefs: body.conversationRefs,
        fanNativeId: body.person?.platformUserId,
        direction: body.direction,
        senderRole: body.senderRole,
        includeSnippet: body.includeSnippet,
        limit: body.limit,
      }));

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
    if (rows.length >= body.limit) {
      caveats.push("result_capped_at_limit");
    }

    const claimFields = body.claim?.fields ?? null;
    const witnesses: PlaneReadWitness[] = [
      storeDerivedWitness({ plane: "message_archive", ceilingAt: null, ceilingKind: "no_lane" }),
    ];
    const operationPlanes = operationPlanesFor(MESSAGE_PLANES, claimFields);

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: witnesses,
      planesNotRead: planesNotRead({
        operationPlanes,
        witnesses,
        overrides: {
          // The other two message stores have NO text-search index and none is
          // being built. Declaring that makes a miss visible as non-coverage
          // rather than as absence — and it is why #7 can never prove an absence.
          dm_message_archive: { state: "not_indexed", reason: "not_indexed_for_text_search" },
          page_dm_messages: { state: "not_indexed", reason: "not_indexed_for_text_search" },
          observations: { state: "not_read", reason: "not_queried_by_this_operation" },
          sync_raw_payloads: { state: "not_read", reason: "not_queried_by_this_operation" },
          page_dm_threads: { state: "not_read", reason: "not_queried_by_this_operation" },
        },
      }),
      delivery: { snapshotExhausted: false, nextCursor: null },
      cursorConsumed: false,
      cursorCapable: false,
      requestWindow: { from, to },
      gaps: [],
      gapDetection: "head_only",
      scopeFieldStates: computeScopeFieldStates({ fields: claimFields ?? [], platforms }),
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
      captureCeiling: NO_LANE_CEILING,
      basis: "store_derived",
      proof: null,
      parseDebt: 0,
      rejected: 0,
      servingHighWaterSatisfied: true,
      hasProofLaneForClaim: false,
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
          returned: rows.length,
          windowFrom: new Date(from).toISOString(),
          windowTo: new Date(to).toISOString(),
          planeMode: scope.planeMode,
        },
      });
    }

    const response = {
      backend,
      caveats,
      items: rows.map((row) => ({
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
        { name: "textSearch", requested: true },
        { name: "window", requested: true },
        { name: "platform", requested: body.platform !== undefined },
        { name: "pageLabel", requested: body.pageLabels !== undefined },
        { name: "person", requested: body.person !== undefined },
        { name: "conversationRef", requested: body.conversationRefs !== undefined },
        { name: "direction", requested: body.direction !== undefined },
        { name: "senderRole", requested: body.senderRole !== undefined },
      ]),
      delivery: buildDelivery({
        returned: rows.length,
        // "Bound it, do not paginate": at the cap the count is a LOWER BOUND, and
        // there is deliberately no cursor to walk past it.
        matched: { value: rows.length, exact: rows.length < body.limit },
        cappedBy: rows.length >= body.limit ? "limit" : null,
        nextCursor: null,
        snapshotExhausted: false,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(rows.length);
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
  const scope = await beginAgentRequest(appContext, principal, { operation: "agentCoverage" });
  try {
    const cursorConsumed = query.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(query.cursor as string, {
        operation: "agentCoverage",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;
    const stored = cursor?.params as Record<string, unknown> | undefined;
    const from = String(stored?.from ?? query.from ?? "");
    const to = String(stored?.to ?? query.to ?? "");
    const pageLabel = (stored?.pageLabel as string | undefined) ?? query.pageLabel;
    const conversationRef = (stored?.conversationRef as string | undefined) ?? query.conversationRef;
    const claimFields = (stored?.claimFields as string[] | undefined) ?? query.claimFields ?? null;

    const narrowed = pageLabel === undefined
      ? scope.pages
      : scope.pages.filter((page) => page.pageLabel === pageLabel);
    const pageIds = narrowed.map((page) => page.id);
    const platforms = [...new Set(narrowed.map((page) => page.platform))] as Platform[];

    const sourceErrors: Array<{
      source: "page_dm_threads";
      code: "statement_timeout";
      excludedFromCounts: true;
    }> = [];
    let scopes: Awaited<ReturnType<typeof listAgentCoverageScopes>> = [];
    try {
      scopes = await withAgentStatementTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
        listAgentCoverageScopes(tx, {
          pageIds,
          platform: query.platform,
          conversationRef,
          from: new Date(from),
          to: new Date(to),
          limit: query.limit,
          after: cursor === null
            ? undefined
            : {
              pageLabel: String(cursor.keyset.pageLabel ?? ""),
              conversationRef: String(cursor.keyset.conversationRef ?? ""),
            },
        }));
    } catch (error) {
      if (!isStatementTimeout(error)) {
        throw error;
      }
      // Multi-source degradation: ONE failed source becomes a named row excluded
      // from the counts, and a non-empty `sourceErrors` forces the conclusion
      // false. A single-source operation would answer 503 instead.
      sourceErrors.push({
        source: "page_dm_threads",
        code: "statement_timeout",
        excludedFromCounts: true,
      });
    }

    const [proofs, laneCeilings, journalFloor] = await Promise.all([
      readAgentCoverageProofs(scope.db, pageIds, scopes.map((entry) => entry.conversationRef)),
      readAgentLaneCeilings(scope.db, pageIds, "dm_messages"),
      readAgentJournalFloor(scope.db),
    ]);
    const ceiling = mergeLaneCeiling(laneCeilings);
    const proofByScope = new Map(proofs.map((proof) => [`${proof.pageId}:${proof.chatId}`, proof]));

    const operationPlanes = operationPlanesFor(MESSAGE_PLANES, claimFields);
    const aggregateWitnesses: PlaneReadWitness[] = [
      storeDerivedWitness({
        plane: "message_archive",
        ceilingAt: ceiling.at,
        ceilingKind: ceiling.kind,
        laneCadenceSeconds: ceiling.laneCadenceSeconds,
        breakerOpen: ceiling.breakerOpen,
      }),
      storeDerivedWitness({ plane: "page_dm_threads", ceilingAt: ceiling.at }),
    ];
    const notRead: PlaneNotReadReason[] = planesNotRead({
      operationPlanes,
      witnesses: aggregateWitnesses,
      overrides: messagePlaneOverrides(platforms),
    });

    const last = scopes.at(-1);
    const hasMore = scopes.length === query.limit;
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentCoverage",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        params: { from, to, pageLabel, conversationRef, claimFields, limit: query.limit },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { page_dm_threads: last.conversationRef },
        seqHighWater: {},
        keyset: { pageLabel: last.pageLabel, conversationRef: last.conversationRef },
      }, scope.signing)
      : null;

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: aggregateWitnesses,
      planesNotRead: notRead,
      delivery: { snapshotExhausted: nextCursor === null, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      requestWindow: { from, to },
      gaps: gapBeforeFloor("message_archive", null, from),
      gapDetection: "head_only",
      scopeFieldStates: computeScopeFieldStates({ fields: claimFields ?? [], platforms }),
      sourceErrors,
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
      captureCeiling: ceiling,
      basis: "store_derived",
      proof: null,
      parseDebt: 0,
      rejected: 0,
      servingHighWaterSatisfied: true,
      hasProofLaneForClaim: hasProofLaneForClaim(claimFields, platforms),
    });

    const items = scopes.map((entry) => {
      const proof = proofByScope.get(`${entry.pageId}:${entry.conversationRef}`);
      const witness = proof === undefined
        ? storeDerivedWitness({
          plane: "message_archive",
          ceilingAt: ceiling.at,
          ceilingKind: ceiling.kind,
          laneCadenceSeconds: ceiling.laneCadenceSeconds,
          breakerOpen: ceiling.breakerOpen,
        })
        : proofWitness(proof, "message_archive");
      const perScope = buildAgentEvidence({
        planeMode: scope.planeMode,
        claimFields,
        operationPlanes,
        planeReads: [witness, storeDerivedWitness({ plane: "page_dm_threads", ceilingAt: ceiling.at })],
        planesNotRead: notRead,
        delivery: { snapshotExhausted: true, nextCursor: null },
        cursorConsumed,
        cursorCapable: true,
        requestWindow: { from, to },
        gaps: gapBeforeFloor("message_archive", witness.captureFloor.at, from),
        gapDetection: "head_only",
        scopeFieldStates: computeScopeFieldStates({
          fields: claimFields ?? [],
          platforms: [entry.platform as Platform],
        }),
        sourceErrors,
        scopeNarrowing: scope.scopeNarrowing,
        observedRowFloor: isoOrNull(entry.observedRowFloor),
        captureFloor: witness.captureFloor,
        captureCeiling: ceiling,
        basis: witness.basis,
        proof: witness.proof,
        parseDebt: witness.parseDebt,
        rejected: witness.rejected,
        servingHighWaterSatisfied: witness.servingHighWaterSatisfied,
        hasProofLaneForClaim: hasProofLaneForClaim(claimFields, [entry.platform as Platform]),
      });
      return {
        pageLabel: entry.pageLabel,
        platform: entry.platform as Platform,
        conversationRef: entry.conversationRef,
        fanPlatformUserId: entry.fanPlatformUserId,
        planes: perScope.capture.planes,
        gapDetection: "head_only" as const,
        observedRowFloor: isoOrNull(entry.observedRowFloor),
        gaps: perScope.capture.gaps,
        windowCovered: perScope.conclusion.absenceProvable,
        fieldStates: perScope.capture.scopeFieldStates,
        blockers: perScope.conclusion.blockers,
      };
    });

    const response = {
      window: { from, to },
      items,
      journalFloor: {
        observationsFirstReceivedAt: isoOrNull(journalFloor.observationsFirstReceivedAt),
        detachedPartitions: journalFloor.detachedPartitions,
      },
      delivery: buildDelivery({
        returned: items.length,
        matched: { value: items.length, exact: nextCursor === null },
        cappedBy: nextCursor === null ? null : "limit",
        nextCursor,
        snapshotExhausted: nextCursor === null,
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
