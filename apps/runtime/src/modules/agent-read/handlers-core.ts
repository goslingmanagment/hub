import {
  AGENT_CAPABILITIES,
  AGENT_CLAIM_FIELDS,
  AGENT_DATASETS,
  AGENT_DATASET_NAMES,
  AGENT_PLANE_NAMES,
  AGENT_PLANNED_DATASET_NAMES,
  AGENT_PREDICATE_REGISTRY,
  KERNEL_CONTRACT_HASH,
  agentClaimFieldClass,
  agentDatasetFields,
  agentDatasetRequiredCapabilities,
  type AgentCapabilitiesResponse,
  type AgentCapability,
  type AgentDataset,
  type AgentPersonResponse,
  type AgentResolveBody,
  type AgentResolveResponse,
} from "@agency_hub_core/contracts";
import {
  agentSubscriptionState,
  findAgentPersonIdentity,
  getAgentKeyById,
  getAgentKeyUsage,
  listAgentFanThreads,
  loadAgentPersonCrm,
  loadAgentPersonIdentityExtras,
  loadAgentPersonMoney,
  loadAgentPersonPostTips,
  loadAgentPersonSubscriptions,
  readAgentPostTipParseDebt,
  resolveAgentFanCandidates,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal } from "../../services/auth.ts";
import { POSTS_CANONICALIZER_VERSION } from "../../services/canonicalize/posts.ts";
import { toSafeNumber, toSafeNumberOr } from "./errors.ts";
import { buildAgentEvidence } from "./epistemics.ts";
import { IDENTITY_PLANES, MESSAGE_PLANES, MONEY_PLANES, CRM_PLANES, planesNotRead } from "./planes.ts";
import {
  AGENT_POST_TIP_VIEW_CLAIM_FIELDS,
  postTipParseDebtGaps,
  postTipViewFieldStates,
} from "./post-tip-view.ts";
import {
  AGENT_CONCURRENCY_LIMIT,
  AGENT_COUNT_PROBE_MAX,
  AGENT_PLATFORM_CAPABILITIES,
  AGENT_SEARCH_BACKEND_IN_USE,
  AGENT_TIMEOUT_MS,
  beginAgentRequest,
  buildDelivery,
  computeScopeFieldStates,
  hydrationRemedy,
  iso,
  isoOrNull,
  operationPlanesFor,
  retentionLimitFor,
  singletonDelivery,
  withAgentTimeout,
  writeAgentAudit,
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
const AGENT_PERSON_POST_TIP_LIMIT = 200;

/** Runtime catalog facts that are deliberately not part of the dataset wire
 * vocabulary. Posts are queryable on both platform implementations, but their
 * collectors roll out paused and capture is page-specific; the global catalog
 * must therefore stay `unknown` instead of advertising `present` before a page
 * has established its own floor. The page-scoped dataset response carries the
 * actual witness and floor. */
const AGENT_DATASET_CATALOG_OVERRIDES: Partial<Record<AgentDataset, {
  platforms: Platform[];
  captureState: AgentCapabilitiesResponse["datasets"][number]["captureState"];
}>> = {
  subscription_events: {
    platforms: ["onlyfans"],
    captureState: "unknown",
  },
  posts: {
    platforms: ["fansly", "onlyfans"],
    captureState: "unknown",
  },
  raw_media: { platforms: ["fansly", "onlyfans"], captureState: "unknown" },
  post_attachments: { platforms: ["fansly", "onlyfans"], captureState: "unknown" },
  post_monetization: {
    platforms: ["fansly"],
    captureState: "unknown",
  },
  post_tips: {
    platforms: ["fansly"],
    captureState: "unknown",
  },
  tip_transactions: {
    // The ledger exists on both platforms. Exact tip context is Fansly-only;
    // page-scoped field states disclose that asymmetry without hiding OF tips.
    platforms: ["fansly", "onlyfans"],
    captureState: "unknown",
  },
  tip_goals: {
    platforms: ["fansly"],
    captureState: "unknown",
  },
  // ── endpoints-cover (WP-S1) ────────────────────────────────────────────────
  // FANSLY ONLY (A28-2). No OnlyFans lane writes any of these tables, and the
  // catalog saying `["fansly", "onlyfans"]` — the default — would advertise a
  // surface that answers empty on every OF page forever.
  //
  // `captureState: "unknown"` on all but one: each lane is flag-gated and
  // page-allowlisted, so the GLOBAL catalog cannot honestly claim `present`
  // before a page has established its own floor. The page-scoped dataset
  // response carries the real witness.
  traffic_daily: { platforms: ["fansly"], captureState: "unknown" },
  media_stats: { platforms: ["fansly"], captureState: "unknown" },
  top_media: { platforms: ["fansly"], captureState: "unknown" },
  top_tags: { platforms: ["fansly"], captureState: "unknown" },
  revenue_mix: { platforms: ["fansly"], captureState: "unknown" },
  message_media_sales: { platforms: ["fansly"], captureState: "unknown" },
  comments: { platforms: ["fansly"], captureState: "unknown" },
  // THE EXCEPTION, and it is the point of declaring the dataset at all: no
  // Fansly like code is live-confirmed ([E4]), so WP-F2's layer 2 writes
  // nothing into `post_likes` and this is `not_captured` GLOBALLY — not
  // "unknown", which would invite a reader to go looking.
  likes: { platforms: ["fansly"], captureState: "not_captured" },
  vault_media: { platforms: ["fansly"], captureState: "unknown" },
  notifications: { platforms: ["fansly"], captureState: "unknown" },
  subscription_tiers: { platforms: ["fansly"], captureState: "unknown" },
  payouts: { platforms: ["fansly"], captureState: "unknown" },
  capture_coverage: { platforms: ["fansly"], captureState: "unknown" },
};

type MoneyByType = NonNullable<AgentPersonResponse["money"]>["byType"][number];

/** Claim fields whose class is money; withheld wholesale without `read:money`.
 *  Derived from the registry (plus the subscription-price field, which rides
 *  the same capability) so a money field added there cannot skip this gate. */
const MONEY_CLAIM_FIELDS: readonly string[] = [
  ...AGENT_CLAIM_FIELDS.filter((field) => agentClaimFieldClass(field) === "money"),
  "subscriptionPriceMills",
];

/**
 * Operator-written FREE TEXT about a person: the same disclosure class as verbatim
 * transcript material, so it rides `read:messages`.
 *
 * `fanFlag` is deliberately NOT here. It is a value from a closed enum, it is
 * served to every key, and listing it would have made `scopeFieldStates` declare
 * unavailable exactly what the body was handing over.
 */
const CRM_CLAIM_FIELDS = ["noteText", "summaryText", "profileBody"] as const;

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
    const [key, usage] = await Promise.all([
      getAgentKeyById(scope.db, principal.agentKeyId),
      getAgentKeyUsage(scope.db, { agentKeyId: principal.agentKeyId }),
    ]);

    // What #7 WILL RUN, not what the flag says. `fts_trgm` names a query this
    // deployment does not have; advertising it here and returning plain FTS there
    // is the same lie in two places.
    const configuredBackend = scope.config.agentSearchBackend ?? "fts";
    const searchBackend = configuredBackend === "off" ? "off" : AGENT_SEARCH_BACKEND_IN_USE;

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
      frozenSnapshot: true,
      requestWindow: null,
      gaps: EMPTY_GAPS,
      scopeFieldStates: {},
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
    });

    const resetsAt = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate() + 1,
    ));

    // The grant IS the payload here, so its size is the cost: reserved before the
    // response is built, and a partial grant refuses rather than serving pages the
    // budget could not pay for.
    await scope.reserveExactRows(scope.pages.length);

    const granted = new Set(principal.capabilities);
    const datasets: AgentCapabilitiesResponse["datasets"] = [
      ...AGENT_DATASET_NAMES.map((dataset) => {
        const runtime = AGENT_DATASET_CATALOG_OVERRIDES[dataset];
        return {
          dataset,
          availability: "available" as const,
          platforms: runtime?.platforms ?? (["fansly", "onlyfans"] as Platform[]),
          moneyBearing: AGENT_DATASETS[dataset].moneyBearing,
          requiredCapabilities: [...agentDatasetRequiredCapabilities(dataset)],
          captureState: runtime?.captureState ?? ("present" as const),
          fields: agentDatasetFields(dataset).map((field) => ({
            field: field.field,
            // The registry calls it `kind`; the wire calls it `type`.
            type: field.kind,
            filterable: field.filterable,
            sortable: field.sortable,
          })),
          defaultSort: AGENT_DATASETS[dataset].defaultSort.field,
        };
      }),
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
    // Thread inventory is MESSAGE material: a conversation ref plus a stored
    // count tells a caller who talked to whom and how much. The first revision
    // served it to any valid key because `includeThreads` defaults to true.
    const mayReadThreads = scope.has("read:messages");
    const includeThreads = body.includeThreads && mayReadThreads;

    const perInput = body.inputs.map((input) => ({
      input,
      normalized: normalizeResolveInput(input.raw, input.hint),
    }));
    const allValues = [...new Set(perInput.flatMap((entry) => entry.normalized))];

    // A resolve can carry 50 inputs x 20 candidates: charging it as one row let
    // the two fan-facing operations walk past the daily row budget entirely.
    const { limit: candidateLimit, cappedByBudget } = await scope.limitWithinRowBudget(
      Math.min(20 * body.inputs.length, 1000),
    );
    const resolved = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
      resolveAgentFanCandidates(tx, {
        pageIds: scope.pageIds,
        platform: body.platform ?? null,
        values: allValues,
        includeAliases: body.includeAliases,
        limit: candidateLimit,
      }), "agent_resolve");

    const fanIds = [...new Set(resolved.matches.map((match) => match.fanId))];
    const threads = includeThreads
      ? await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
        listAgentFanThreads(tx, { pageIds: scope.pageIds, fanIds }), "agent_resolve_threads")
      : { rows: [], witnesses: [] };

    const platforms = [...new Set(scope.pages.map((page) => page.platform))] as Platform[];
    const scopeFieldStates = computeScopeFieldStates({
      fields: claimFields ?? ["platformUserId", "username", "displayName"],
      platforms,
      ungrantedFields: mayReadThreads ? [] : ["conversationRef", "messageCount", "coverageStatus"],
    });

    // Only the stores the repository actually queried; `includeAliases: false`
    // therefore produces no alias witnesses, because no alias table was read.
    const witnesses = [...resolved.witnesses, ...threads.witnesses];
    const operationPlanes = operationPlanesFor(
      witnesses.map((witness) => witness.plane),
      claimFields,
    );

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: witnesses,
      planesNotRead: planesNotRead({
        operationPlanes,
        witnesses,
        overrides: mayReadThreads
          ? {}
          : { page_dm_threads: { state: "not_read", reason: "capability_not_granted" } },
      }),
      delivery: { snapshotExhausted: true, nextCursor: null },
      cursorConsumed: false,
      cursorCapable: false,
      frozenSnapshot: true,
      requestWindow: null,
      gaps: EMPTY_GAPS,
      scopeFieldStates,
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
    });

    const items = perInput.map((entry) => {
      const wanted = new Set(entry.normalized.map((value) => value.toLowerCase()));
      const candidates = resolved.matches
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
          pages: threads.rows
            .filter((thread) => thread.fanId === match.fanId)
            .map((thread) => ({
              pageLabel: thread.pageLabel,
              platform: thread.platform as Platform,
              conversationRef: thread.conversationRef,
              storedMessageCount: thread.storedMessageCount,
              messageCoverageStatusRaw: thread.coverageStatusRaw as
                "pending_backfill" | "partial_window" | "complete",
            })),
          // Without `read:messages` the thread section is EMPTY and the field
          // states say why — an empty array alone would read as "this fan has no
          // conversations", which is the failure the plane exists to prevent.
          fieldStates: mayReadThreads
            ? {}
            : {
              conversationRef: {
                state: "unknown" as const,
                remedy: { kind: "none" as const, reason: "capability_not_granted" as const },
              },
            },
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

    // Charged in CANDIDATES, which is what the request actually cost.
    const candidateRows = items.reduce((total, item) => total + item.candidates.length, 0);
    const response: AgentResolveResponse = {
      items,
      delivery: buildDelivery({
        returned: items.length,
        matched: { value: items.length, exact: true },
        cappedBy: cappedByBudget ? "budget" : null,
        nextCursor: null,
        snapshotExhausted: true,
        caveats: [],
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    await scope.finish(Math.max(items.length, candidateRows));
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

    // Two gates, and each one decides whether a QUERY RUNS, not merely whether
    // its result is hidden. Money is money; notes and summaries are operator-written
    // free text about a person, which is the same disclosure class as a transcript.
    const mayReadMoney = scope.has("read:money");
    const mayReadMessages = scope.has("read:messages");

    const identity = pageIds.length === 0
      ? { row: null, witnesses: [] }
      : await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
        findAgentPersonIdentity(tx, {
          pageIds,
          platform: params.platform,
          platformUserId: params.platformUserId,
        }), "agent_person_identity");

    const fanId = identity.row?.fanId ?? null;
    const [extras, money, postTips, subscriptions, crm, threads] = fanId === null
      ? [null, null, null, null, null, null]
      : await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, async (tx) => Promise.all([
        loadAgentPersonIdentityExtras(tx, { pageIds, fanId }),
        mayReadMoney ? loadAgentPersonMoney(tx, { pageIds, fanId }) : null,
        mayReadMoney
          ? loadAgentPersonPostTips(tx, {
            pageIds,
            fanId,
            limit: AGENT_PERSON_POST_TIP_LIMIT + 1,
          })
          : null,
        mayReadMoney ? loadAgentPersonSubscriptions(tx, { pageIds, fanId }) : null,
        mayReadMessages ? loadAgentPersonCrm(tx, { pageIds, fanId }) : null,
        mayReadMessages ? listAgentFanThreads(tx, { pageIds, fanIds: [fanId] }) : null,
      ]), "agent_person_bundle");
    const postTipParseDebt = mayReadMoney
      ? await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
        readAgentPostTipParseDebt(tx, {
          pageIds,
          parserVersion: POSTS_CANONICALIZER_VERSION,
        }), "agent_person_post_tip_parse_debt")
      : { topLevel: false, rejectedItems: false };

    const witnesses = [
      ...identity.witnesses,
      ...(extras?.witnesses ?? []),
      ...(money?.witnesses ?? []),
      ...(postTips?.witnesses ?? []),
      ...(subscriptions?.witnesses ?? []),
      ...(crm?.witnesses ?? []),
      ...(threads?.witnesses ?? []),
    ];
    const operationPlanes = operationPlanesFor(
      [
        ...IDENTITY_PLANES,
        ...MONEY_PLANES,
        "creator_post_tips",
        "page_subscriptions",
        ...CRM_PLANES,
        "page_dm_threads",
      ],
      claimFields,
    );

    const ungrantedFields = [
      ...(mayReadMoney
        ? []
        : [...MONEY_CLAIM_FIELDS, ...AGENT_POST_TIP_VIEW_CLAIM_FIELDS]),
      ...(mayReadMessages ? [] : CRM_CLAIM_FIELDS),
    ];
    const scopeFieldStates = computeScopeFieldStates({
      fields: claimFields ?? ["platformUserId", "username", "displayName", "membershipState"],
      platforms,
      ungrantedFields,
    });

    const overrides: Record<string, { state: "not_read"; reason: "capability_not_granted" }> = {};
    if (!mayReadMoney) {
      for (const plane of [...MONEY_PLANES, "creator_post_tips", "page_subscriptions"]) {
        overrides[plane] = { state: "not_read", reason: "capability_not_granted" };
      }
    }
    if (!mayReadMessages) {
      for (const plane of [...CRM_PLANES, "page_dm_threads"]) {
        overrides[plane] = { state: "not_read", reason: "capability_not_granted" };
      }
    }

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: witnesses,
      planesNotRead: planesNotRead({ operationPlanes, witnesses, overrides }),
      delivery: { snapshotExhausted: true, nextCursor: null },
      cursorConsumed: false,
      cursorCapable: false,
      frozenSnapshot: true,
      requestWindow: null,
      gaps: postTipParseDebtGaps(postTipParseDebt),
      scopeFieldStates,
      sourceErrors: [],
      // Mandatory even when `identity` is null: this is what makes 200-empty an
      // honest answer instead of an existence oracle.
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: null,
      captureFloor: { at: null, kind: "unknown" },
    });

    // `delivery.returned` counts PEOPLE (one, or none); the row budget counts the
    // rows the bundle actually carries, which for a busy fan is hundreds. A bundle
    // cannot be clamped to an allowance the way a page can — its size is a property
    // of the fan — so the EXACT cost is reserved before a byte of it is served: a
    // partial grant is a 429, never a full card charged as three rows.
    const bundleRows = (extras?.data.memberships.length ?? 0)
      + (extras?.data.aliases.length ?? 0)
      + (extras?.data.flags.length ?? 0)
      + (money?.data.byType.length ?? 0)
      + Math.min(postTips?.rows.length ?? 0, AGENT_PERSON_POST_TIP_LIMIT)
      + (subscriptions?.rows.length ?? 0)
      + (crm?.data.notes.length ?? 0)
      + (crm?.data.summaries.length ?? 0)
      + (threads?.rows.length ?? 0);
    const rowsServed = (identity.row === null ? 0 : 1) + bundleRows;
    await scope.reserveExactRows(rowsServed);

    const response: AgentPersonResponse = {
      identity: identity.row === null ? null : {
        platform: identity.row.platform as Platform,
        platformUserId: identity.row.platformUserId,
        username: identity.row.username,
        displayName: identity.row.displayName,
        aliases: (extras?.data.aliases ?? []).map((alias) => ({
          kind: alias.kind === "username" ? "username" as const : "alias" as const,
          value: alias.value,
          firstSeenAt: isoOrNull(alias.firstSeenAt),
          lastSeenAt: isoOrNull(alias.lastSeenAt),
        })),
        createdAtExternal: isoOrNull(identity.row.createdAtExternal),
        firstSeenAt: isoOrNull(identity.row.firstSeenAt),
        lastSeenAt: isoOrNull(identity.row.lastSeenAt),
        deletedDetectedAt: isoOrNull(identity.row.deletedDetectedAt),
        flags: (extras?.data.flags ?? []).map((flag) => ({
          pageLabel: flag.pageLabel,
          flag: flag.flag,
          value: true,
          updatedAt: iso(flag.updatedAt),
        })),
      },
      memberships: (extras?.data.memberships ?? []).map((membership) => ({
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
        lifetimeSpendMills: mayReadMoney ? toSafeNumber(membership.lifetimeSpendMills) : null,
        // WITHHELD without `read:money`: the timestamp of a payment discloses that
        // a payment happened, which is the fact the capability guards.
        lastTransactionAt: mayReadMoney ? isoOrNull(membership.lastTransactionAt) : null,
        pageAlias: membership.pageAlias,
      })),
      // null, not []: an empty array would say "this fan has no threads".
      threads: threads === null ? null : threads.rows.map((thread) => ({
        pageLabel: thread.pageLabel,
        platform: thread.platform as Platform,
        conversationRef: thread.conversationRef,
        fanPlatformUserId: identity.row?.platformUserId ?? null,
        fanUsername: identity.row?.username ?? null,
        fanDisplayName: identity.row?.displayName ?? null,
        isVisible: true,
        unreadCount: null,
        lastMessageAt: null,
        lastFanMessageAt: null,
        lastModelMessageAt: null,
        storedMessageCount: thread.storedMessageCount,
        oldestStoredMessageRef: null,
        newestStoredMessageRef: null,
        messageCoverageStatusRaw: thread.coverageStatusRaw as "complete",
        lastMessageSyncAt: null,
        breakerOpen: false,
        quarantineUntil: null,
        captureFloor: { at: null, kind: "unknown" as const },
        transcriptWillReturnRows: thread.storedMessageCount > 0,
        hydrationRemedy: hydrationRemedy(scope),
        retentionLimit: retentionLimitFor(thread.platform as Platform, null),
        fieldStates: {},
        provenance: {
          ingestPaths: ["unknown" as const],
          convergence: "no_material_lane" as const,
          observationRef: null,
        },
      })),
      // null, not a zeroed section: a silent 0 is indistinguishable from
      // "never paid", and that is the one thing money must never say by accident.
      money: money === null ? null : {
        lifetime: {
          grossMills: toSafeNumberOr(money.data.lifetime.grossMills, 0),
          netMills: toSafeNumberOr(money.data.lifetime.netMills, 0),
          transactionCount: money.data.lifetime.transactionCount,
          firstTransactionAt: isoOrNull(money.data.lifetime.firstTransactionAt),
          lastTransactionAt: isoOrNull(money.data.lifetime.lastTransactionAt),
        },
        byType: money.data.byType.map((row) => ({
          transactionType: row.transactionType as MoneyByType["transactionType"],
          transactionState: row.transactionState as MoneyByType["transactionState"],
          grossMills: toSafeNumberOr(row.grossMills, 0),
          netMills: toSafeNumberOr(row.netMills, 0),
          transactionCount: row.transactionCount,
        })),
      },
      postTips: postTips === null ? null : {
        items: postTips.rows.slice(0, AGENT_PERSON_POST_TIP_LIMIT).map((tip) => ({
          pageLabel: tip.pageLabel,
          platform: tip.platform as Platform,
          postTipPostRef: tip.postTipPostRef,
          postTipRef: tip.postTipRef,
          postTipOccurredAt: iso(tip.postTipOccurredAt),
          postTipAmountMills: toSafeNumberOr(tip.postTipAmountMills, 0),
          postTipGoalRef: tip.postTipGoalRef,
          fieldStates: postTipViewFieldStates({
            claimFields,
            scopeFieldStates,
            values: {
              postTipPostRef: tip.postTipPostRef,
              postTipRef: tip.postTipRef,
              postTipOccurredAt: tip.postTipOccurredAt,
              postTipAmountMills: tip.postTipAmountMills,
              postTipGoalRef: tip.postTipGoalRef,
            },
          }),
        })),
        capped: postTips.rows.length > AGENT_PERSON_POST_TIP_LIMIT,
      },
      subscriptions: subscriptions === null ? null : subscriptions.rows.map((subscription) => ({
        pageLabel: subscription.pageLabel,
        subscriptionRef: subscription.subscriptionRef,
        // ONE mapping, shared with the dataset projection. This branch used to map
        // only the literal `expired`, so `ended` and `cancelled` came back
        // `unknown` here and `expired` from #10 — two answers about one
        // subscription, depending on which operation was asked.
        subscriptionState: agentSubscriptionState(subscription.canonicalStatus),
        subscriptionTierName: subscription.tierName,
        subscriptionPriceMills: toSafeNumber(subscription.priceMills),
        renewPriceMills: toSafeNumber(subscription.renewPriceMills),
        autoRenew: subscription.autoRenew,
        billingCycleDays: subscription.billingCycleDays,
        startedAt: isoOrNull(subscription.startedAt),
        subscriptionExpiresAt: isoOrNull(subscription.endsAt),
        isCurrent: subscription.isCurrent,
      })),
      crm: crm === null ? null : {
        notes: crm.data.notes.map((note) => ({
          pageLabel: note.pageLabel,
          noteRef: note.noteRef,
          origin: note.origin,
          noteText: note.noteText,
          createdAt: isoOrNull(note.createdAt),
          updatedAt: isoOrNull(note.updatedAt),
        })),
        summaries: crm.data.summaries.map((summary) => ({
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
      delivery: singletonDelivery(identity.row === null ? 0 : 1),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
    // Notes and summaries are operator-written FREE TEXT about a person: the same
    // disclosure class as a transcript, and #6 and snippet-enabled #7 both leave a
    // row for it. This one served the material and left nothing, so the owner's
    // acceptance of a machine principal reading it rested on a trail with a hole
    // in it. Written BEFORE the response goes out, like the others.
    if (crm !== null) {
      await writeAgentAudit(scope.db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentPerson",
        pageIds,
        verbatimText: true,
        // Structured facts from the allowlist only: how many free-text records
        // crossed, never a character of what they said.
        requestSummary: {
          platform: params.platform,
          returned: crm.data.notes.length + crm.data.summaries.length,
          planeMode: scope.planeMode,
        },
      });
    }

    await scope.finish(rowsServed);
    return response;
  } catch (error) {
    await scope.finish(0);
    throw error;
  }
}

/** Re-exported so the registrar can name the message planes without a second list. */
export { MESSAGE_PLANES };
