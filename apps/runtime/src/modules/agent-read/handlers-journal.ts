import { createHash } from "node:crypto";

import {
  agentDatasetDefinition,
  agentDatasetFieldSortable,
  agentDatasetRequiredCapabilities,
  type AGENT_DATASETS,
  type AgentCapability,
  type AgentDatasetQueryBody,
  type AgentDatasetQueryResponse,
  type AgentObservationPayloadResponse,
  type AgentObservationsResponse,
} from "@agency_hub_core/contracts";
import {
  agentDatasetSqlMapping,
  countAgentReadAuditForSession,
  findAgentObservationPayload,
  listAgentObservations,
  queryAgentDataset,
  readAgentJournalFloor,
  storeDerivedWitness,
  withAgentStatementTimeout,
  type AgentDatasetFilter,
  type PlaneReadWitness,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal, HumanAuthPrincipal } from "../../services/auth.ts";
import { loadEffectiveConfig } from "../../services/effective-config.ts";
import { buildAgentEvidence } from "./epistemics.ts";
import { decodeAgentCursor, encodeAgentCursor } from "./cursors.ts";
import { AgentPlaneDisabledError, staticNotFound } from "./errors.ts";
import { BadRequestError } from "../../services/errors.ts";
import {
  AGENT_OBSERVATION_PAYLOAD_SESSION_CAP,
  agentObservationPayloadAllowed,
  scrubObservationPayload,
} from "./observation-scrub.ts";
import { MESSAGE_PLANES, planesNotRead } from "./planes.ts";
import {
  AGENT_TIMEOUT_MS,
  beginAgentRequest,
  buildDelivery,
  buildPredicates,
  computeScopeFieldStates,
  hasProofLaneForClaim,
  iso,
  isoOrNull,
  operationPlanesFor,
  singletonDelivery,
  writeAgentAudit,
} from "./runtime.ts";

/**
 * Operations #9a (observation envelopes), #9b (owner-only payload) and #10
 * (dataset query).
 *
 * #9a and #9b are split because a route carries exactly ONE auth policy and the
 * middleware decides before the handler: "envelope to the agent, body to the
 * owner" is not expressible on one route in this codebase, so it is two.
 */

// ---------------------------------------------------------------------------
// #9a agentObservations
// ---------------------------------------------------------------------------

export async function handleAgentObservations(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  query: {
    from?: string | undefined;
    to?: string | undefined;
    platform?: Platform | undefined;
    pageLabel?: string | undefined;
    source?: string | undefined;
    kind?: string | undefined;
    producer?: string | undefined;
    parseVersion?: number | undefined;
    sortDir: "asc" | "desc";
    limit: number;
    cursor?: string | undefined;
  },
): Promise<AgentObservationsResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentObservations",
    requiredCapabilities: ["read:observations_envelope"],
  });
  try {
    if (!(scope.config.agentObservationsEnabled ?? false)) {
      throw new AgentPlaneDisabledError("agent observation reads are disabled");
    }

    const cursorConsumed = query.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(query.cursor as string, {
        operation: "agentObservations",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;
    const stored = cursor?.params as Record<string, unknown> | undefined;
    const from = String(stored?.from ?? query.from ?? "");
    const to = String(stored?.to ?? query.to ?? "");
    const effective = {
      platform: (stored?.platform as Platform | undefined) ?? query.platform,
      pageLabel: (stored?.pageLabel as string | undefined) ?? query.pageLabel,
      source: (stored?.source as string | undefined) ?? query.source,
      kind: (stored?.kind as string | undefined) ?? query.kind,
      producer: (stored?.producer as string | undefined) ?? query.producer,
      parseVersion: (stored?.parseVersion as number | undefined) ?? query.parseVersion,
      sortDir: (stored?.sortDir as "asc" | "desc" | undefined) ?? query.sortDir,
    };

    const rows = await withAgentStatementTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
      listAgentObservations(tx, {
        pageIds: scope.pageIds,
        from: new Date(from),
        to: new Date(to),
        ...effective,
        limit: query.limit,
        after: cursor === null
          ? undefined
          : {
            receivedAt: String(cursor.keyset.receivedAt ?? ""),
            observationRef: Number(cursor.keyset.observationRef ?? 0),
          },
      }));

    const journalFloor = await readAgentJournalFloor(scope.db);
    const platforms = [...new Set(scope.pages.map((page) => page.platform))] as Platform[];

    // A window entirely before the journal begins is EMPTY BY CONSTRUCTION, not
    // by absence of fact. Saying so is the difference this operation exists for.
    const journalStartsAfterWindow = journalFloor.observationsFirstReceivedAt !== null
      && Date.parse(to) <= journalFloor.observationsFirstReceivedAt.getTime();

    const witnesses: PlaneReadWitness[] = journalStartsAfterWindow
      ? []
      : [storeDerivedWitness({ plane: "observations", ceilingAt: null, ceilingKind: "no_lane" })];
    const operationPlanes = operationPlanesFor(MESSAGE_PLANES, null);

    const hasMore = rows.length === query.limit;
    const last = rows.at(-1);
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentObservations",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        params: { from, to, ...effective, limit: query.limit },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { observations: String(last.observationRef) },
        seqHighWater: {},
        keyset: { receivedAt: iso(last.receivedAt), observationRef: last.observationRef },
      }, scope.signing)
      : null;

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields: null,
      operationPlanes,
      planeReads: witnesses,
      planesNotRead: planesNotRead({
        operationPlanes,
        witnesses,
        overrides: journalStartsAfterWindow
          ? { observations: { state: "not_read", reason: "journal_starts_after_window" } }
          : {},
      }),
      delivery: { snapshotExhausted: nextCursor === null, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      requestWindow: { from, to },
      gaps: journalFloor.detachedPartitions.length === 0 ? [] : [{
        kind: "partition_detached" as const,
        from: null,
        to: null,
        plane: "observations" as const,
        remedy: { kind: "none" as const, reason: "partition_detached" as const },
      }],
      gapDetection: "head_only",
      scopeFieldStates: {},
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: isoOrNull(rows.at(0)?.receivedAt ?? null),
      captureFloor: { at: null, kind: "unknown" },
      captureCeiling: { at: null, kind: "no_lane", laneCadenceSeconds: null, breakerOpen: false },
      basis: "store_derived",
      proof: null,
      parseDebt: 0,
      rejected: 0,
      servingHighWaterSatisfied: true,
      hasProofLaneForClaim: hasProofLaneForClaim(null, platforms),
    });

    const response = {
      window: { from, to },
      items: rows.map((row) => ({
        observationRef: row.observationRef,
        receivedAt: iso(row.receivedAt),
        observedAt: isoOrNull(row.observedAt),
        source: row.source as "pull",
        producer: row.producer,
        platform: row.platform as Platform | null,
        pageLabel: row.pageLabel,
        nativeAccountRef: row.nativeAccountRef,
        kind: row.kind,
        payloadBytes: row.payloadBytes,
        payloadSha256: row.payloadSha256,
        parseVersion: row.parseVersion,
        canonicalized: row.domainEventCount > 0,
        domainEventCount: row.domainEventCount,
        // Whether 9b would serve this kind at all. NOT a promise of access: 9b
        // still requires an owner session.
        payloadAvailable: agentObservationPayloadAllowed(row.kind),
      })),
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
// #9b agentObservationPayload — owner session
// ---------------------------------------------------------------------------

export async function handleAgentObservationPayload(
  appContext: AppContext,
  principal: HumanAuthPrincipal,
  params: { observationRef: number },
  query: { reason: string },
): Promise<AgentObservationPayloadResponse> {
  const db = appContext.db;
  const config = await loadEffectiveConfig(db, appContext.config);
  const planeMode = config.agentReadPlaneMode ?? "off";
  if (planeMode === "off") {
    throw new AgentPlaneDisabledError();
  }
  if (!(config.agentObservationsEnabled ?? false)) {
    throw new AgentPlaneDisabledError("agent observation reads are disabled");
  }

  const row = await findAgentObservationPayload(db, params.observationRef);
  if (!row) {
    throw staticNotFound();
  }

  // The cap is enforced by COUNTING the audit trail, which is also what makes it
  // auditable. TOCTOU is accepted and documented: one owner, worst case two extra
  // reads, and the alternative is a lock on a journal table.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const used = await countAgentReadAuditForSession(db, {
    sessionUserId: principal.user.id,
    operation: "agentObservationPayload",
    since,
  });
  const remaining = Math.max(0, AGENT_OBSERVATION_PAYLOAD_SESSION_CAP - used);

  const allowed = agentObservationPayloadAllowed(row.kind);
  const withheldReason = !allowed
    ? "kind_not_allowlisted" as const
    : remaining === 0
      ? "session_payload_budget_exhausted" as const
      : null;

  const scrubbed = withheldReason === null
    ? scrubObservationPayload(row.payload)
    : { payload: {}, signedUrlsRemoved: 0, secretsRedacted: 0, pathsRemoved: [] as string[] };

  // EVERY call writes a row, including a withheld one: an owner asking about a
  // forbidden kind is itself the fact the trail exists to record.
  const auditRef = await writeAgentAudit(db, {
    sessionUserId: principal.user.id,
    operation: "agentObservationPayload",
    pageIds: [],
    verbatimText: withheldReason === null,
    requestSummary: {
      reasonSha256: createHash("sha256").update(query.reason, "utf8").digest("hex"),
      reasonLength: query.reason.length,
      observationKind: /^[A-Za-z0-9_:.-]{1,64}$/.test(row.kind) ? row.kind : "unnamed",
      returned: withheldReason === null ? 1 : 0,
      planeMode,
    },
  });

  const evidence = buildAgentEvidence({
    planeMode,
    claimFields: null,
    operationPlanes: [],
    planeReads: [],
    planesNotRead: [],
    delivery: { snapshotExhausted: true, nextCursor: null },
    cursorConsumed: false,
    cursorCapable: false,
    requestWindow: null,
    gaps: [],
    gapDetection: "head_only",
    scopeFieldStates: {},
    sourceErrors: [],
    scopeNarrowing: { keyGrantExcludedPages: 0, totalPagesForQuery: 0 },
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

  return {
    observationRef: row.observationRef,
    kind: row.kind,
    source: row.source as AgentObservationPayloadResponse["source"],
    receivedAt: iso(row.receivedAt),
    payloadSha256: row.payloadSha256,
    // The ROW exists and the body does not: absence never encodes a decision.
    payload: withheldReason === null ? scrubbed.payload : null,
    withheldReason,
    scrubbed: {
      signedUrlsRemoved: scrubbed.signedUrlsRemoved,
      secretsRedacted: scrubbed.secretsRedacted,
      pathsRemoved: scrubbed.pathsRemoved,
    },
    auditRef,
    sessionPayloadReadsRemaining: Math.max(0, remaining - (withheldReason === null ? 1 : 0)),
    delivery: singletonDelivery(withheldReason === null ? 1 : 0),
    capture: evidence.capture,
    conclusion: evidence.conclusion,
  };
}

// ---------------------------------------------------------------------------
// #10 agentDatasetQuery
// ---------------------------------------------------------------------------

export async function handleAgentDatasetQuery(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { pageLabel: string; dataset: keyof typeof AGENT_DATASETS },
  body: AgentDatasetQueryBody,
): Promise<AgentDatasetQueryResponse> {
  const required = agentDatasetRequiredCapabilities(params.dataset);
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentDatasetQuery",
    requiredCapabilities: required as readonly AgentCapability[],
  });
  try {
    const page = scope.pages.find((candidate) => candidate.pageLabel === params.pageLabel);
    if (!page) {
      throw staticNotFound();
    }

    const definition = agentDatasetDefinition(params.dataset);
    const mapping = agentDatasetSqlMapping(params.dataset);
    if (!definition || !mapping) {
      throw staticNotFound();
    }

    const cursorConsumed = body.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(body.cursor as string, {
        operation: "agentDatasetQuery",
        keyId: principal.agentKeyId,
        pageIds: [page.id],
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;
    const stored = cursor?.params as Record<string, unknown> | undefined;
    const from = String(stored?.from ?? body.from ?? "");
    const to = String(stored?.to ?? body.to ?? "");
    const rawFilters = (stored?.filters as AgentDatasetQueryBody["filters"] | undefined)
      ?? body.filters;
    const rawSort = (stored?.sort as AgentDatasetQueryBody["sort"] | undefined) ?? body.sort;
    const claimFields = (stored?.claimFields as string[] | undefined)
      ?? body.claim?.fields ?? null;

    // The registry is the ONLY bridge from a name to SQL: an unknown field is a
    // static 400 BEFORE any statement is built, and the value that reaches SQL is
    // the registry's own column constant, never the request's string.
    const filters: AgentDatasetFilter[] = rawFilters.map((filter) => {
      const column = Object.hasOwn(mapping.fields, filter.field)
        ? mapping.fields[filter.field]
        : undefined;
      if (column === undefined) {
        throw new BadRequestError(`field is not part of the ${params.dataset} dataset`);
      }
      return { column, op: filter.op, value: filter.value };
    });
    const sort = rawSort.map((entry) => {
      const column = Object.hasOwn(mapping.fields, entry.field)
        ? mapping.fields[entry.field]
        : undefined;
      if (column === undefined || !agentDatasetFieldSortable(params.dataset, entry.field)) {
        throw new BadRequestError(`field is not sortable on the ${params.dataset} dataset`);
      }
      return { column, dir: entry.dir };
    });

    const rows = await withAgentStatementTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
      queryAgentDataset(tx, {
        dataset: params.dataset,
        pageId: page.id,
        from: new Date(from),
        to: new Date(to),
        filters,
        sort,
        limit: body.limit,
        after: cursor === null
          ? undefined
          : {
            sortValue: cursor.keyset.sortValue === null ? null : String(cursor.keyset.sortValue),
            key: String(cursor.keyset.key ?? ""),
          },
      }));

    const witnesses: PlaneReadWitness[] = [
      storeDerivedWitness({ plane: "page_fans", ceilingAt: null, ceilingKind: "no_lane" }),
    ];
    const operationPlanes = operationPlanesFor(["page_fans"], claimFields);

    const hasMore = rows.length === body.limit;
    const last = rows.at(-1);
    const primarySortColumn = sort[0]?.column ?? mapping.windowColumn;
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentDatasetQuery",
        keyId: principal.agentKeyId,
        pageIds: [page.id],
        params: {
          dataset: params.dataset,
          from,
          to,
          filters: rawFilters,
          sort: rawSort,
          claimFields,
          limit: body.limit,
        },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { [params.dataset]: last.key },
        seqHighWater: {},
        keyset: {
          sortValue: primarySortColumn === mapping.windowColumn
            ? isoOrNull(last.occurredAt)
            : String(last.fields[Object.entries(mapping.fields)
              .find(([, column]) => column === primarySortColumn)?.[0] ?? ""] ?? ""),
          key: last.key,
        },
      }, scope.signing)
      : null;

    const evidence = buildAgentEvidence({
      planeMode: scope.planeMode,
      claimFields,
      operationPlanes,
      planeReads: witnesses,
      planesNotRead: planesNotRead({ operationPlanes, witnesses }),
      delivery: { snapshotExhausted: nextCursor === null, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      requestWindow: { from, to },
      gaps: [],
      gapDetection: "head_only",
      scopeFieldStates: computeScopeFieldStates({
        fields: claimFields ?? [],
        platforms: [page.platform as Platform],
      }),
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: isoOrNull(rows.at(0)?.occurredAt ?? null),
      captureFloor: { at: null, kind: "unknown" },
      captureCeiling: { at: null, kind: "no_lane", laneCadenceSeconds: null, breakerOpen: false },
      basis: "store_derived",
      proof: null,
      parseDebt: 0,
      rejected: 0,
      servingHighWaterSatisfied: true,
      hasProofLaneForClaim: hasProofLaneForClaim(claimFields, [page.platform as Platform]),
    });

    const response = {
      datasetRef: params.dataset,
      pageLabel: page.pageLabel,
      platform: page.platform as Platform,
      window: { from, to },
      items: rows.map((row) => ({
        datasetRef: params.dataset,
        key: row.key,
        occurredAt: isoOrNull(row.occurredAt),
        fanPlatformUserId: row.fanPlatformUserId,
        fields: Object.fromEntries(Object.entries(row.fields).map(([field, value]) => [
          field,
          value instanceof Date
            ? value.toISOString()
            : typeof value === "bigint"
              ? Number(value)
              : typeof value === "string" || typeof value === "number"
                  || typeof value === "boolean" || value === null
                ? value
                : String(value),
        ])),
        fieldStates: {},
        provenance: {
          ingestPaths: ["unknown" as const],
          convergence: "no_material_lane" as const,
          observationRef: null,
        },
      })),
      predicates: buildPredicates([
        { name: "window", requested: true },
        { name: "datasetFilter", requested: rawFilters.length > 0 },
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
