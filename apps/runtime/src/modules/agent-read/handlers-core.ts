import {
  AGENT_CAPABILITIES,
  AGENT_CLAIM_FIELDS,
  AGENT_DATASETS,
  AGENT_DATASET_NAMES,
  AGENT_PLANE_NAMES,
  AGENT_PLANNED_DATASET_NAMES,
  AGENT_PREDICATE_REGISTRY,
  KERNEL_CONTRACT_HASH,
  agentDatasetFields,
  agentDatasetRequiredCapabilities,
  type AgentCapabilitiesResponse,
  type AgentCapability,
  type AgentPersonResponse,
  type AgentResolveBody,
  type AgentResolveResponse,
} from "@agency_hub_core/contracts";
import {
  detectPgTrgmExtension,
  findAgentPersonIdentity,
  getAgentKeyById,
  getAgentKeyUsage,
  listAgentFanThreads,
  loadAgentPersonBundle,
  resolveAgentFanCandidates,
  storeDerivedWitness,
  withAgentStatementTimeout,
  type PlaneReadWitness,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal } from "../../services/auth.ts";
import { toSafeNumber, toSafeNumberOr } from "./errors.ts";
import { buildAgentEvidence } from "./epistemics.ts";
import { IDENTITY_PLANES, MESSAGE_PLANES, MONEY_PLANES, CRM_PLANES, planesNotRead } from "./planes.ts";
import {
  AGENT_CONCURRENCY_LIMIT,
  AGENT_COUNT_PROBE_MAX,
  AGENT_PLATFORM_CAPABILITIES,
  AGENT_TIMEOUT_MS,
  beginAgentRequest,
  computeScopeFieldStates,
  hasProofLaneForClaim,
  iso,
  isoOrNull,
  operationPlanesFor,
  singletonDelivery,
} from "./runtime.ts";

// #1 REPORTS the gauge; it never mutates it (the slot was taken by
// `beginAgentRequest` and is released by `finish`).
import { agentConcurrencyInUse } from "./budget.ts";

/**
 * Operations #1 (capabilities), #2 (resolve) and #3 (person).
 *
 * These three share a property worth stating once: NONE of them 404s. #1 and #2
 * are global and hold no path to somebody else's resource; #3 is keyed by a
 * GLOBAL `(platform, platformUserId)` and answers 200-with-empty by contract,
 * because a static 404 there would collapse "there is no such fan" into "the fan
 * exists on a page outside your grant" — which is the exact confusion that sent
 * the owner a false "no trace of this person" (spec §5.6).
 */

const EMPTY_GAPS = [] as const;

type MoneyByType = AgentPersonResponse["money"]["byType"][number];

// ---------------------------------------------------------------------------
// #1 agentCapabilities
// ---------------------------------------------------------------------------

export async function handleAgentCapabilities(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
): Promise<AgentCapabilitiesResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentCapabilities",
  });
  try {
    const [key, usage, trgm] = await Promise.all([
      getAgentKeyById(scope.db, principal.agentKeyId),
      getAgentKeyUsage(scope.db, { agentKeyId: principal.agentKeyId }),
      detectPgTrgmExtension(scope.db),
    ]);

    const configuredBackend = scope.config.agentSearchBackend ?? "fts";
    const searchBackend = configuredBackend === "fts_trgm" && !trgm ? "fts" : configuredBackend;

    // The degenerate envelope of a control operation, normative per §17.15.5: the
    // grant is never truncated, so the snapshot is exhausted by definition, and
    // no plane is a source for a question nobody asked.
    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields: null,
      operationPlanes: [],
      planeReads: [],
      planesNotRead: [],
      delivery: { snapshotExhausted: true, nextCursor: null },
      cursorConsumed: false,
      cursorCapable: false,
      requestWindow: null,
      gaps: EMPTY_GAPS,
      gapDetection: "head_only",
      scopeFieldStates: {},
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
      captureCeiling: { at: null, kind: "no_lane", laneCadenceSeconds: null, breakerOpen: false },
      basis: "none",
      proof: null,
      parseDebt: 0,
      rejected: 0,
      servingHighWaterSatisfied: true,
      hasProofLaneForClaim: false,
    });

    const resetsAt = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate() + 1,
    ));

    const granted = new Set(principal.capabilities);
    const datasets: AgentCapabilitiesResponse["datasets"] = [
      ...AGENT_DATASET_NAMES.map((dataset) => ({
        dataset,
        availability: "available" as const,
        platforms: ["fansly", "onlyfans"] as Platform[],
        moneyBearing: AGENT_DATASETS[dataset].moneyBearing,
        requiredCapabilities: [...agentDatasetRequiredCapabilities(dataset)],
        captureState: "present" as const,
        fields: agentDatasetFields(dataset).map((field) => ({
          field: field.field,
          // The registry calls it `kind`; the wire calls it `type`.
          type: field.kind,
          filterable: field.filterable,
          sortable: field.sortable,
        })),
        defaultSort: AGENT_DATASETS[dataset].defaultSort.field,
      })),
      // The catalog NAMES its holes. A dataset omitted because it has no serving
      // table would be indistinguishable from one that does not exist, which is
      // the whole failure mode this plane exists to remove.
      ...AGENT_PLANNED_DATASET_NAMES.map((dataset) => ({
        dataset,
        availability: "planned" as const,
        platforms: [] as Platform[],
        moneyBearing: false,
        requiredCapabilities: [] as AgentCapability[],
        captureState: "captured_unparsed" as const,
        fields: [],
        defaultSort: null,
      })),
    ];

    const response: AgentCapabilitiesResponse = {
      contract: {
        contractHash: KERNEL_CONTRACT_HASH,
        planeMode: scope.planeMode,
        searchBackend,
        hydrationMode: scope.config.agentHydrationMode ?? "off",
        observationsEnabled: scope.config.agentObservationsEnabled ?? false,
        fanslyReplayMode: scope.config.fanslyReplayMode ?? "off",
        archiveGeneration: scope.archiveGeneration,
      },
      key: {
        keyId: principal.agentKeyId,
        keyPrefix: key?.keyPrefix ?? "",
        capabilities: AGENT_CAPABILITIES.map((capability) => ({
          capability,
          granted: granted.has(capability),
        })),
        expiresAt: iso(key?.expiresAt ?? new Date()),
      },
      budgets: {
        timezone: "UTC",
        resetsAt: iso(resetsAt),
        requestsUsed: usage.requests,
        requestsRemaining: Math.max(0, (key?.dailyRequestBudget ?? 0) - usage.requests),
        rowsUsed: usage.rowsReturned,
        rowsRemaining: Math.max(0, (key?.dailyRowBudget ?? 0) - usage.rowsReturned),
        concurrentInUse: agentConcurrencyInUse(principal.agentKeyId),
        concurrentLimit: AGENT_CONCURRENCY_LIMIT,
      },
      limits: {
        paginationDefault: 50,
        paginationMax: 200,
        transcriptPerMinute: 60,
        searchPerMinute: 20,
        datasetPerMinute: 20,
        searchResultMax: 100,
        countProbeMax: AGENT_COUNT_PROBE_MAX,
        observationPayloadPerSession: 25,
      },
      grant: {
        pages: scope.pages.map((page) => ({
          pageLabel: page.pageLabel,
          platform: page.platform as Platform,
          modelSlug: page.modelSlug,
          modelName: page.modelName,
        })),
        totalPages: scope.totalPages,
      },
      platforms: (["fansly", "onlyfans"] as const).map((platform) => {
        const capabilities = AGENT_PLATFORM_CAPABILITIES[platform];
        return {
          platform,
          conversationIdSemantics: capabilities.conversationIdSemantics,
          hasCoverageProofs: capabilities.hasCoverageProofs,
          capturesMediaMetadata: capabilities.capturesMediaMetadata,
          capturesMessagePrice: capabilities.capturesMessagePrice,
          capturesPurchaseState: capabilities.capturesPurchaseState,
          depthCap: capabilities.depthCap,
          streamCadenceSeconds: { dm_messages: capabilities.dmMessagesCadenceSeconds },
        };
      }),
      planes: AGENT_PLANE_NAMES.map((plane) => ({
        plane,
        enabled: true,
        // Only ONE plane has a text-search index, and saying so is what keeps a
        // search miss from reading as an absence.
        textSearchIndexed: plane === "message_archive",
      })),
      datasets,
      predicates: AGENT_PREDICATE_REGISTRY.map((entry) => ({
        predicate: entry.predicate,
        appliesTo: [...entry.appliesTo],
        description: entry.description,
      })),
      claimFields: [...AGENT_CLAIM_FIELDS],
      delivery: singletonDelivery(scope.pages.length),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(scope.pages.length);
    return response;
  } catch (error) {
    await scope.finish(0);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// #2 agentResolve
// ---------------------------------------------------------------------------

/**
 * Normalizes ONE input into every form worth trying.
 *
 * The `user` prefix is NEVER stripped. `fansly.com/user438765948262952961` is a
 * USERNAME whose owner's `platform_user_id` is a different number entirely, and
 * the first pass of the production gate answered "no such fan" about a fan who
 * had paid $100 precisely because it treated the slug as an id.
 */
export function normalizeResolveInput(raw: string, hint: string): string[] {
  const forms: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !forms.includes(trimmed)) {
      forms.push(trimmed);
    }
  };

  const trimmed = raw.trim();
  push(trimmed);

  if (hint === "url" || hint === "auto") {
    // Hand-parsed: `new URL` throws on plenty of strings a human pastes, and a
    // throw here would turn a resolvable slug into an error.
    const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const withoutQuery = withoutScheme.split(/[?#]/, 1)[0] ?? "";
    const segments = withoutQuery.split("/").filter((segment) => segment.length > 0);
    // EVERY segment after the host, not just the last one: a profile link with a
    // trailing section (`/posts`, `/media`) would otherwise resolve the section
    // instead of the person. `normalized[]` reports exactly what was tried.
    for (const segment of segments.slice(1)) {
      push(segment);
    }
  }
  return forms;
}

export async function handleAgentResolve(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  body: AgentResolveBody,
): Promise<AgentResolveResponse> {
  const scope = await beginAgentRequest(appContext, principal, { operation: "agentResolve" });
  try {
    const claimFields = body.claim?.fields ?? null;
    const perInput = body.inputs.map((input) => ({
      input,
      normalized: normalizeResolveInput(input.raw, input.hint),
    }));
    const allValues = [...new Set(perInput.flatMap((entry) => entry.normalized))];

    const matches = await withAgentStatementTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
      resolveAgentFanCandidates(tx, {
        pageIds: scope.pageIds,
        platform: body.platform ?? null,
        values: allValues,
        // 20 candidates per input, capped by the input count; the response caps
        // each input's own list at 20 as the contract declares.
        limit: Math.min(20 * body.inputs.length, 1000),
      }));

    const fanIds = [...new Set(matches.map((match) => match.fanId))];
    const threads = body.includeThreads
      ? await listAgentFanThreads(scope.db, { pageIds: scope.pageIds, fanIds })
      : [];

    const platforms = [...new Set(scope.pages.map((page) => page.platform))] as Platform[];
    const scopeFieldStates = computeScopeFieldStates({
      fields: claimFields ?? ["platformUserId", "username", "displayName"],
      platforms,
    });

    const witnesses: PlaneReadWitness[] = IDENTITY_PLANES.map((plane) =>
      storeDerivedWitness({ plane, ceilingAt: null, ceilingKind: "no_lane" }));
    const operationPlanes = operationPlanesFor(IDENTITY_PLANES, claimFields);

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: witnesses,
      planesNotRead: planesNotRead({ operationPlanes, witnesses: witnesses }),
      delivery: { snapshotExhausted: true, nextCursor: null },
      cursorConsumed: false,
      cursorCapable: false,
      requestWindow: null,
      gaps: EMPTY_GAPS,
      gapDetection: "head_only",
      scopeFieldStates,
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
      captureCeiling: { at: null, kind: "no_lane", laneCadenceSeconds: null, breakerOpen: false },
      basis: "store_derived",
      proof: null,
      parseDebt: 0,
      rejected: 0,
      servingHighWaterSatisfied: true,
      hasProofLaneForClaim: hasProofLaneForClaim(claimFields, platforms),
    });

    const items = perInput.map((entry) => {
      const wanted = new Set(entry.normalized.map((value) => value.toLowerCase()));
      const candidates = matches
        .filter((match) =>
          wanted.has(match.matchedValue.toLowerCase())
          || wanted.has(match.platformUserId.toLowerCase()))
        .slice(0, 20)
        .map((match) => ({
          platform: match.platform as Platform,
          platformUserId: match.platformUserId,
          username: match.username,
          displayName: match.displayName,
          matchKind: match.matchKind,
          matchedValue: match.matchedValue,
          confidence: match.matchKind === "platformUserId"
            ? "exact" as const
            : match.matchKind === "alias" ? "alias_historical" as const : "normalized" as const,
          createdAtExternal: isoOrNull(match.createdAtExternal),
          deletedDetectedAt: isoOrNull(match.deletedDetectedAt),
          pages: threads
            .filter((thread) => thread.fanId === match.fanId)
            .map((thread) => ({
              pageLabel: thread.pageLabel,
              platform: thread.platform as Platform,
              conversationRef: thread.conversationRef,
              storedMessageCount: thread.storedMessageCount,
              messageCoverageStatusRaw: thread.coverageStatusRaw as
                "pending_backfill" | "partial_window" | "complete",
            })),
          fieldStates: {},
          provenance: {
            ingestPaths: ["unknown" as const],
            convergence: "no_material_lane" as const,
            observationRef: null,
          },
        }));
      return {
        input: { raw: entry.input.raw, hint: entry.input.hint },
        normalized: entry.normalized,
        candidates,
        candidatesCapped: candidates.length >= 20,
      };
    });

    const response = {
      items,
      delivery: singletonDelivery(items.length),
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

// ---------------------------------------------------------------------------
// #3 agentPerson
// ---------------------------------------------------------------------------

export async function handleAgentPerson(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { platform: Platform; platformUserId: string },
  query: { claimFields?: string[] | undefined; pageLabel?: string | undefined },
): Promise<AgentPersonResponse> {
  const scope = await beginAgentRequest(appContext, principal, { operation: "agentPerson" });
  try {
    const claimFields = query.claimFields ?? null;
    const narrowed = query.pageLabel === undefined
      ? scope.pages
      : scope.pages.filter((page) => page.pageLabel === query.pageLabel);
    const pageIds = narrowed.map((page) => page.id);
    const platforms = [...new Set(narrowed.map((page) => page.platform))] as Platform[];

    const identity = pageIds.length === 0
      ? null
      : await withAgentStatementTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
        findAgentPersonIdentity(tx, {
          pageIds,
          platform: params.platform,
          platformUserId: params.platformUserId,
        }));

    const bundle = identity === null
      ? null
      : await withAgentStatementTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
        loadAgentPersonBundle(tx, { pageIds, fanId: identity.fanId }));

    const hasMoney = scope.has("read:money");
    const readPlanes = [
      ...IDENTITY_PLANES,
      ...(hasMoney ? MONEY_PLANES : []),
      "page_subscriptions",
      ...CRM_PLANES,
    ];
    const witnesses: PlaneReadWitness[] = readPlanes.map((plane) =>
      storeDerivedWitness({ plane, ceilingAt: null, ceilingKind: "no_lane" }));
    const operationPlanes = operationPlanesFor(
      [...IDENTITY_PLANES, ...MONEY_PLANES, "page_subscriptions", ...CRM_PLANES],
      claimFields,
    );

    // Degradation, not refusal (§17.0.5): a key without `read:money` gets an
    // empty money section, the money plane reported as `not_read` with its real
    // reason, and `unknown` field states — never a silent zero.
    const moneyFields = ["grossMills", "netMills", "feeMills", "amountMills", "currency", "transactionState", "lifetimeSpendMills"];
    const scopeFieldStates = computeScopeFieldStates({
      fields: claimFields ?? ["platformUserId", "username", "displayName", "membershipState"],
      platforms,
      ungrantedFields: hasMoney ? [] : moneyFields,
    });

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: witnesses,
      planesNotRead: planesNotRead({
        operationPlanes,
        witnesses,
        overrides: hasMoney
          ? {}
          : Object.fromEntries(MONEY_PLANES.map((plane) => [
            plane,
            { state: "not_read" as const, reason: "capability_not_granted" as const },
          ])),
      }),
      delivery: { snapshotExhausted: true, nextCursor: null },
      cursorConsumed: false,
      cursorCapable: false,
      requestWindow: null,
      gaps: EMPTY_GAPS,
      gapDetection: "head_only",
      scopeFieldStates,
      sourceErrors: [],
      // Mandatory even when `identity` is null — that is what makes 200-empty an
      // honest answer instead of an existence oracle.
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
      captureCeiling: { at: null, kind: "no_lane", laneCadenceSeconds: null, breakerOpen: false },
      basis: "store_derived",
      proof: null,
      parseDebt: 0,
      rejected: 0,
      servingHighWaterSatisfied: true,
      hasProofLaneForClaim: hasProofLaneForClaim(claimFields, platforms),
    });

    const response: AgentPersonResponse = {
      identity: identity === null ? null : {
        platform: identity.platform as Platform,
        platformUserId: identity.platformUserId,
        username: identity.username,
        displayName: identity.displayName,
        aliases: (bundle?.aliases ?? []).map((alias) => ({
          kind: alias.kind === "username" ? "username" as const : "alias" as const,
          value: alias.value,
          firstSeenAt: isoOrNull(alias.firstSeenAt),
          lastSeenAt: isoOrNull(alias.lastSeenAt),
        })),
        createdAtExternal: isoOrNull(identity.createdAtExternal),
        firstSeenAt: isoOrNull(identity.firstSeenAt),
        lastSeenAt: isoOrNull(identity.lastSeenAt),
        deletedDetectedAt: isoOrNull(identity.deletedDetectedAt),
        flags: (bundle?.flags ?? []).map((flag) => ({
          pageLabel: flag.pageLabel,
          flag: flag.flag,
          value: true,
          updatedAt: iso(flag.updatedAt),
        })),
      },
      memberships: (bundle?.memberships ?? []).map((membership) => ({
        pageLabel: membership.pageLabel,
        platform: membership.platform as Platform,
        membershipState: membership.isSubscriber || membership.isFollower
          ? "active" as const
          : "inactive" as const,
        isFollower: membership.isFollower,
        followerSince: isoOrNull(membership.followerSince),
        isSubscriber: membership.isSubscriber,
        subscriberSince: isoOrNull(membership.subscriberSince),
        subscriptionExpiresAt: isoOrNull(membership.subscriptionExpiresAt),
        autoRenew: membership.autoRenew,
        autoRenewOffDetectedAt: isoOrNull(membership.autoRenewOffDetectedAt),
        lifetimeSpendMills: hasMoney ? toSafeNumber(membership.lifetimeSpendMills) : null,
        lastTransactionAt: isoOrNull(membership.lastTransactionAt),
        pageAlias: membership.pageAlias,
      })),
      threads: [],
      money: {
        lifetime: {
          grossMills: hasMoney ? toSafeNumberOr(bundle?.moneyLifetime.grossMills, 0) : 0,
          netMills: hasMoney ? toSafeNumberOr(bundle?.moneyLifetime.netMills, 0) : 0,
          transactionCount: hasMoney ? bundle?.moneyLifetime.transactionCount ?? 0 : 0,
          firstTransactionAt: hasMoney ? isoOrNull(bundle?.moneyLifetime.firstTransactionAt) : null,
          lastTransactionAt: hasMoney ? isoOrNull(bundle?.moneyLifetime.lastTransactionAt) : null,
        },
        byType: hasMoney
          ? (bundle?.moneyByType ?? []).map((row) => ({
            transactionType: row.transactionType as MoneyByType["transactionType"],
            transactionState: row.transactionState as MoneyByType["transactionState"],
            grossMills: toSafeNumberOr(row.grossMills, 0),
            netMills: toSafeNumberOr(row.netMills, 0),
            transactionCount: row.transactionCount,
          }))
          : [],
      },
      subscriptions: (bundle?.subscriptions ?? []).map((subscription) => ({
        pageLabel: subscription.pageLabel,
        subscriptionRef: subscription.subscriptionRef,
        subscriptionState: subscription.canonicalStatus === "active"
          ? "active" as const
          : subscription.canonicalStatus === "expired" ? "expired" as const : "unknown" as const,
        subscriptionTierName: subscription.tierName,
        subscriptionPriceMills: hasMoney ? toSafeNumber(subscription.priceMills) : null,
        renewPriceMills: hasMoney ? toSafeNumber(subscription.renewPriceMills) : null,
        autoRenew: subscription.autoRenew,
        billingCycleDays: subscription.billingCycleDays,
        startedAt: isoOrNull(subscription.startedAt),
        subscriptionExpiresAt: isoOrNull(subscription.endsAt),
        isCurrent: subscription.isCurrent,
      })),
      crm: {
        notes: (bundle?.notes ?? []).map((note) => ({
          pageLabel: note.pageLabel,
          noteRef: note.noteRef,
          origin: note.origin,
          noteText: note.noteText,
          createdAt: isoOrNull(note.createdAt),
          updatedAt: isoOrNull(note.updatedAt),
        })),
        summaries: (bundle?.summaries ?? []).map((summary) => ({
          pageLabel: summary.pageLabel,
          summaryRef: summary.summaryRef,
          summaryText: summary.summaryText,
          createdAt: isoOrNull(summary.createdAt),
        })),
      },
      fieldStates: {},
      provenance: {
        ingestPaths: ["unknown"],
        convergence: "no_material_lane",
        observationRef: null,
      },
      delivery: singletonDelivery(identity === null ? 0 : 1),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(identity === null ? 0 : 1);
    return response;
  } catch (error) {
    await scope.finish(0);
    throw error;
  }
}

/** Re-exported so the registrar can name the message planes without a second list. */
export { MESSAGE_PLANES };
