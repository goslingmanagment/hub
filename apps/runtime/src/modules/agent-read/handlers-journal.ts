import { createHash } from "node:crypto";

import {
  agentDatasetDefinition,
  agentDatasetFilterIssue,
  agentDatasetFieldSortable,
  agentDatasetRequiredCapabilities,
  type AGENT_DATASETS,
  type AgentCapability,
  type AgentDataset,
  type AgentDatasetQueryBody,
  type AgentDatasetQueryResponse,
  type AgentFieldState,
  type AgentIngestPath,
  type AgentObservationPayloadResponse,
  type AgentObservationsResponse,
} from "@agency_hub_core/contracts";
import {
  agentDatasetSqlMapping,
  countAgentReadAuditForSession,
  countPagesWithUnprovenCreatorVaultInventory,
  findAgentObservationPayload,
  listAgentObservations,
  queryAgentDataset,
  readAgentPostSnapshotParseDebt,
  readAgentPostTipParseDebt,
  readAgentJournalFloor,
  readAgentObservationsHighWater,
  summarizeAgentTransactionDataset,
  type AgentDatasetFilter,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  isCapturePayloadUnavailable,
  resolveCapturePayloadRow,
} from "../../services/payload-reader.ts";
import type { AgentAuthPrincipal, HumanAuthPrincipal } from "../../services/auth.ts";
import { loadEffectiveConfig } from "../../services/effective-config.ts";
import { BadRequestError } from "../../services/errors.ts";
import { POSTS_CANONICALIZER_VERSION } from "../../services/canonicalize/posts.ts";
import { buildAgentEvidence, gapBeforeCaptureFloor } from "./epistemics.ts";
import { decodeAgentCursor, encodeAgentCursor } from "./cursors.ts";
import {
  AgentCapturePayloadUnavailableError,
  AgentPlaneDisabledError,
  staticNotFound,
  toSafeNumber,
  toSafeNumberOr,
} from "./errors.ts";
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
  hydrationRemedy,
  iso,
  isoOrNull,
  observedRowFloorOf,
  operationPlanesFor,
  singletonDelivery,
  withAgentTimeout,
  writeAgentAudit,
} from "./runtime.ts";
import { postSnapshotParseDebtGaps, postTipParseDebtGaps } from "./post-tip-view.ts";

/**
 * Operations #9a (observation envelopes), #9b (owner-only payload) and #10
 * (dataset query).
 *
 * #9a and #9b are split because a route carries exactly ONE auth policy and the
 * middleware decides before the handler: "envelope to the agent, body to the
 * owner" is not expressible on one route in this codebase, so it is two.
 */

/** The UTC day every budget and the #9b session cap are measured in. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

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
  // The sub-flag is checked BEFORE the request budget is spent: a request that
  // never ran should not cost the caller its daily allowance.
  const preConfig = await loadEffectiveConfig(appContext.db, appContext.config);
  if (!(preConfig.agentObservationsEnabled ?? false)) {
    throw new AgentPlaneDisabledError("agent observation reads are disabled");
  }

  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentObservations",
    requiredCapabilities: ["read:observations_envelope"],
  });
  try {
    const cursorConsumed = query.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(query.cursor as string, {
        operation: "agentObservations",
        resource: "global",
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

    const requestedLimit = (stored?.limit as number | undefined) ?? query.limit;

    // THE FLOOR FIRST, AND SCOPED TO THE GRANT.
    //
    // It used to be read after the page-scoped observation query and with no scope
    // at all, so an ungranted page's January row was the minimum a key whose own
    // pages start in March was judged against: an empty February window looked
    // like a window inside the journal, and the pre-capture condition was missed.
    const journalFloor = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
      readAgentJournalFloor(tx, {
        pageIds: scope.pageIds,
        platform: effective.platform,
        pageLabel: effective.pageLabel,
      }), "agent_journal_floor");
    const floorAt = journalFloor.observationsFirstReceivedAt;

    // A window entirely before the journal begins is EMPTY BY CONSTRUCTION, not
    // by absence of fact. Saying so is the difference this operation exists for —
    // and the read is skipped rather than run and then disowned.
    const journalStartsAfterWindow = floorAt !== null && Date.parse(to) <= floorAt.getTime();

    const { limit, cappedByBudget } = journalStartsAfterWindow
      ? { limit: 0, cappedByBudget: false }
      : await scope.limitWithinRowBudget(requestedLimit);
    // The frozen bound is minted once and then CARRIED by the cursor, so every
    // page of one traversal sees the same population.
    const storedHighWater = Number(stored?.highWater ?? 0);
    const highWater = journalStartsAfterWindow
      ? 0
      : storedHighWater > 0
        ? storedHighWater
        : await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
          readAgentObservationsHighWater(tx, scope.pageIds, {
            from: new Date(from),
            to: new Date(to),
          }), "agent_observations_high_water");

    const result = journalStartsAfterWindow
      ? { rows: [], witnesses: [] }
      : await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
        listAgentObservations(tx, {
          pageIds: scope.pageIds,
          from: new Date(from),
          to: new Date(to),
          ...effective,
          limit,
          maxObservationId: highWater,
          // Rides on the witness, so `capture.planes[]` names the floor even when
          // the window starts after it and no gap is emitted.
          journalFloor: floorAt,
          after: cursor === null
            ? undefined
            : {
              sortValue: cursor.keyset.sortValue === null ? null : String(cursor.keyset.sortValue),
              key: String(cursor.keyset.key ?? ""),
            },
        }), "agent_observations");

    const witnesses = result.witnesses;
    const operationPlanes = operationPlanesFor(MESSAGE_PLANES, null);

    const hasMore = result.rows.length === limit;
    const last = result.rows.at(-1);
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentObservations",
        resource: "global",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        params: { from, to, ...effective, limit: requestedLimit, highWater },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { observations: String(highWater) },
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
      delivery: { snapshotExhausted, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      frozenSnapshot,
      requestWindow: { from, to },
      gaps: [
        // The gap this operation exists to publish: a window reaching back past the
        // scoped journal floor. Without it a February question against a March
        // journal produced an empty list, no gap and no remedy — an absence that
        // was never established.
        ...gapBeforeCaptureFloor({
          plane: "observations",
          floorAt: isoOrNull(floorAt),
          windowFrom: from,
          hydration: hydrationRemedy(scope),
        }),
        // ONLY the observations partitions: a detached `domain_events` month is a
        // hole in a different plane and used to announce a gap here.
        ...(journalFloor.detachedObservationPartitions.length === 0 ? [] : [{
          kind: "partition_detached" as const,
          from: null,
          to: null,
          plane: "observations" as const,
          remedy: { kind: "none" as const, reason: "partition_detached" as const },
        }]),
      ],
      scopeFieldStates: {},
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: observedRowFloorOf(result.rows.map((row) => row.receivedAt)),
      captureFloor: {
        at: isoOrNull(floorAt),
        kind: floorAt === null ? "unknown" : "oldest_stored_row",
      },
      inventoryUnprovenPages: 0,
    });

    const response: AgentObservationsResponse = {
      window: { from, to },
      items: result.rows.map((row) => ({
        observationRef: row.observationRef,
        receivedAt: iso(row.receivedAt),
        observedAt: isoOrNull(row.observedAt),
        source: row.source as AgentObservationsResponse["items"][number]["source"],
        producer: row.producer,
        platform: row.platform as Platform | null,
        pageLabel: row.pageLabel,
        nativeAccountRef: row.nativeAccountRef,
        kind: row.kind,
        payloadBytes: row.payloadBytes,
        payloadSha256: row.payloadSha256,
        parseVersion: row.parseVersion,
        // From the column the canonicalizer stamps. A per-row COUNT over the
        // partitioned event table used to live here and could not prune
        // partitions, so a 200-row page cost 200 partition scans.
        canonicalized: row.parseVersion > 0,
        // Whether 9b would serve this kind at all. NOT a promise of access: 9b
        // still requires an owner session.
        payloadAvailable: agentObservationPayloadAllowed(row.kind),
      })),
      delivery: buildDelivery({
        returned: result.rows.length,
        // A lower bound unless this is a complete, un-resumed read.
        matched: {
          value: result.rows.length,
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
    await scope.finish(result.rows.length);
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

  const row = await withAgentTimeout(db, AGENT_TIMEOUT_MS.short, (tx) =>
    findAgentObservationPayload(tx, params.observationRef), "agent_observation_payload");
  if (!row) {
    throw staticNotFound();
  }

  // The cap is enforced by COUNTING the audit trail, which is also what makes it
  // auditable. The window is the UTC DAY, matching every other budget on the
  // plane: it was declared per-day and measured over a rolling 24 hours. TOCTOU is
  // accepted and documented — one owner, worst case two extra reads.
  const used = await countAgentReadAuditForSession(db, {
    sessionUserId: principal.user.id,
    operation: "agentObservationPayload",
    since: startOfUtcDay(new Date()),
  });
  const remaining = Math.max(0, AGENT_OBSERVATION_PAYLOAD_SESSION_CAP - used);

  const allowed = agentObservationPayloadAllowed(row.kind);
  // G5 slice 2: the body comes through the read seam. Resolved only when it
  // will actually be served — a withheld read must not pay a catalog query,
  // and must not count as a shadow comparison of a body nobody saw.
  //
  // #223: an unreadable body is an ERROR, never a withholding. It happens
  // BEFORE the audit row on purpose: the trail records reads that were decided,
  // and a fetch that failed is not a decision about anything.
  let resolved = row;
  if (allowed && remaining > 0) {
    try {
      resolved = await resolveCapturePayloadRow(
        appContext,
        "observation",
        row.observationRef,
        row,
      );
    } catch (error) {
      if (!isCapturePayloadUnavailable(error)) {
        throw error;
      }
      throw new AgentCapturePayloadUnavailableError();
    }
  }
  const scrubbed = allowed && remaining > 0 ? scrubObservationPayload(resolved.payload) : null;
  const withheldReason = !allowed
    ? "kind_not_allowlisted" as const
    : remaining === 0
      ? "session_payload_budget_exhausted" as const
      // The scrub refuses a payload it cannot walk as an object; that refusal is a
      // WITHHOLDING with a reason, not a silent empty body.
      : scrubbed === null || scrubbed.payload === null
        ? "restricted_class" as const
        : null;

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
    frozenSnapshot: true,
    requestWindow: null,
    gaps: [],
    scopeFieldStates: {},
    sourceErrors: [],
    scopeNarrowing: { keyGrantExcludedPages: 0, totalPagesForQuery: 0 },
    observedRowFloor: null,
    captureFloor: { at: null, kind: "unknown" },
    inventoryUnprovenPages: 0,
  });

  return {
    observationRef: row.observationRef,
    kind: row.kind,
    source: row.source as AgentObservationPayloadResponse["source"],
    receivedAt: iso(row.receivedAt),
    payloadSha256: row.payloadSha256,
    // The ROW exists and the body does not: absence never encodes a decision.
    payload: withheldReason === null ? scrubbed?.payload ?? null : null,
    withheldReason,
    scrubbed: {
      signedUrlsRemoved: scrubbed?.signedUrlsRemoved ?? 0,
      secretsRedacted: scrubbed?.secretsRedacted ?? 0,
      pathsRemoved: scrubbed?.pathsRemoved ?? [],
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
        // Bound to the DATASET and PAGE as well as the operation: a cursor minted
        // for `transactions` on one page must not resume against `fan_notes` on
        // another, presenting a different population as a continuation.
        resource: `dataset:${page.id}:${params.dataset}`,
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
    const summaryRequested = (stored?.summary as boolean | undefined) ?? body.summary ?? false;
    const declaredClaimFields = (stored?.claimFields as string[] | undefined)
      ?? body.claim?.fields ?? null;
    // Summary mode has a fixed money result. It can therefore name the default
    // claim it necessarily returns instead of forcing every caller to repeat it.
    // An explicit caller claim still wins.
    const claimFields = summaryRequested && declaredClaimFields === null
      ? ["grossMills", "netMills"]
      : declaredClaimFields;
    const requestedLimit = (stored?.limit as number | undefined) ?? body.limit;

    // The registry is the ONLY bridge from a name to SQL: an unknown field is a
    // static 400 BEFORE any statement is built, and the value that reaches SQL is
    // the registry's own column constant, never the request's string.
    const filters: AgentDatasetFilter[] = rawFilters.map((filter) => {
      const issue = agentDatasetFilterIssue(params.dataset, filter);
      if (issue?.code === "unknown_field") {
        throw new BadRequestError(`field is not part of the ${params.dataset} dataset`);
      }
      if (issue?.code === "operator_not_supported") {
        throw new BadRequestError(
          `operator is not supported for ${issue.kind} field on the ${params.dataset} dataset`,
        );
      }
      if (issue?.code === "value_type_mismatch") {
        throw new BadRequestError(
          `value is not valid for ${issue.kind} field on the ${params.dataset} dataset`,
        );
      }

      const column = Object.hasOwn(mapping.fields, filter.field)
        ? mapping.fields[filter.field]
        : undefined;
      if (column === undefined) {
        throw new BadRequestError(`field is not part of the ${params.dataset} dataset`);
      }
      return { column, op: filter.op, value: filter.value };
    });

    // The registry's DEFAULT sort is honoured when the caller supplies none: the
    // first revision ignored it and silently ordered by the window column.
    const requestedSort = rawSort[0] ?? {
      field: definition.defaultSort.field,
      dir: definition.defaultSort.dir,
    };
    const sortColumn = Object.hasOwn(mapping.fields, requestedSort.field)
      ? mapping.fields[requestedSort.field]
      : undefined;
    if (
      sortColumn === undefined
      || !agentDatasetFieldSortable(params.dataset, requestedSort.field)
    ) {
      throw new BadRequestError(`field is not sortable on the ${params.dataset} dataset`);
    }
    const sortKind = (definition.fields as Record<string, string>)[requestedSort.field] ?? "string";

    if (summaryRequested) {
      if (params.dataset !== "transactions") {
        throw new BadRequestError("summary mode is currently supported only for transactions");
      }

      const result = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
        summarizeAgentTransactionDataset(tx, {
          pageId: page.id,
          from: new Date(from),
          to: new Date(to),
          filters,
        }), "agent_dataset_summary");
      const floorAt = isoOrNull(result.floorAt);
      const gaps = floorAt !== null && Date.parse(from) < Date.parse(floorAt)
        ? [{
            kind: "before_capture_floor" as const,
            from: null,
            to: floorAt,
            plane: "transactions" as const,
            // Thread hydration cannot repair a transaction-history boundary.
            remedy: { kind: "none" as const, reason: "no_remedy_exists" as const },
          }]
        : [];
      const operationPlanes = operationPlanesFor(mapping.readPlanes, claimFields);
      const evidence = buildAgentEvidence({
        planeMode: scope.planeMode,
        claimFields,
        operationPlanes,
        planeReads: result.witnesses,
        planesNotRead: planesNotRead({ operationPlanes, witnesses: result.witnesses }),
        delivery: { snapshotExhausted: true, nextCursor: null },
        cursorConsumed: false,
        cursorCapable: false,
        frozenSnapshot: true,
        requestWindow: { from, to },
        gaps,
        scopeFieldStates: computeScopeFieldStates({
          fields: claimFields ?? [],
          platforms: [page.platform as Platform],
        }),
        sourceErrors: [],
        scopeNarrowing: scope.scopeNarrowing,
        observedRowFloor: null,
        captureFloor: {
          at: floorAt,
          kind: floorAt === null ? "unknown" : "oldest_stored_row",
        },
        inventoryUnprovenPages: 0,
      });
      const groups = result.groups.map((group) => ({
        currency: group.currency,
        transactionCount: toSafeNumberOr(group.transactionCount, 0),
        grossMills: toSafeNumberOr(group.grossMills, 0),
        netMills: toSafeNumberOr(group.netMills, 0),
        feeMills: toSafeNumber(group.feeMills),
      }));
      await scope.reserveExactRows(groups.length);
      const response: AgentDatasetQueryResponse = {
        datasetRef: params.dataset,
        pageLabel: page.pageLabel,
        platform: page.platform as Platform,
        window: { from, to },
        items: [],
        summary: {
          basis: "matching_rows_in_hub",
          matchedRows: toSafeNumberOr(result.matchedRows, 0),
          groups,
        },
        predicates: buildPredicates([
          { name: "window", requested: true, applied: true },
          {
            name: "datasetFilter",
            requested: rawFilters.length > 0,
            applied: rawFilters.length > 0,
          },
        ]),
        delivery: singletonDelivery(groups.length),
        capture: evidence.capture,
        conclusion: evidence.conclusion,
      };
      await scope.finish(groups.length);
      return response;
    }

    const { limit, cappedByBudget } = await scope.limitWithinRowBudget(requestedLimit);
    const result = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, (tx) =>
      queryAgentDataset(tx, {
        dataset: params.dataset,
        pageId: page.id,
        from: new Date(from),
        to: new Date(to),
        filters,
        sort: { column: sortColumn, kind: sortKind, dir: requestedSort.dir },
        limit,
        after: cursor === null
          ? undefined
          : {
            sortValue: cursor.keyset.sortValue === null ? null : String(cursor.keyset.sortValue),
            key: String(cursor.keyset.key ?? ""),
          },
      }), "agent_dataset");

    const operationPlanes = operationPlanesFor(mapping.readPlanes, claimFields);

    const floorAt = isoOrNull(result.captureFloorAt);
    const gaps: AgentDatasetQueryResponse["capture"]["gaps"] = floorAt !== null
      && mapping.captureFloorPlane !== undefined
      && Date.parse(from) < Date.parse(floorAt)
      ? [{
          kind: "before_capture_floor" as const,
          from: null,
          to: floorAt,
          plane: mapping.captureFloorPlane as AgentDatasetQueryResponse["capture"]["gaps"][number]["plane"],
          remedy: {
            // V1 collection is incremental from the previously captured head.
            // Re-running it can observe a newer prefix, but cannot extend the
            // historical floor backwards. Advertising recapture here would
            // send an operator to an action that cannot close this gap.
            kind: "none" as const,
            reason: "journal_before_capture_start" as const,
          },
        }]
      : [];
    if (
      result.internalCaptureGap
      && mapping.internalCaptureGap !== undefined
    ) {
      gaps.push({
        kind: "internal_capture_gap",
        from,
        to,
        plane: mapping.internalCaptureGap.plane as AgentDatasetQueryResponse["capture"]["gaps"][number]["plane"],
        remedy: params.dataset === "post_attachments" ? {
          kind: "none", reason: "no_remedy_exists",
        } : {
          // Retained-raw replay closes only the subset whose original DM page
          // survived. Production contains tip ids with no retained candidate,
          // so the honest next action is a fresh pull, not a replay promise.
          kind: "recapture",
          costClass: "free",
          admissible: true,
          reason: null,
        },
      });
    }
    if (params.dataset === "post_tips") {
      const parseDebt = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
        readAgentPostTipParseDebt(tx, {
          pageIds: [page.id],
          parserVersion: POSTS_CANONICALIZER_VERSION,
        }), "agent_post_tip_parse_debt");
      gaps.push(...postTipParseDebtGaps(parseDebt));
    }
    if (["posts", "post_attachments", "post_monetization", "tip_goals"].includes(params.dataset)) {
      const parseDebt = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
        readAgentPostSnapshotParseDebt(tx, {
          pageIds: [page.id],
          parserVersion: POSTS_CANONICALIZER_VERSION,
        }), "agent_post_snapshot_parse_debt");
      gaps.push(...postSnapshotParseDebtGaps(parseDebt));
    }
    const scopeFieldStates = computeScopeFieldStates({
      fields: claimFields ?? [],
      platforms: [page.platform as Platform],
      dataset: params.dataset,
    });

    // WHETHER THE INVENTORY BEHIND THESE ROWS WAS EVER PROVEN COMPLETE. Keyed on
    // the DATASET NAME, never on the platform — a platform branch outside the
    // adapter packages is budgeted, and the question belongs to `vault_media`
    // regardless of who serves it. One extra statement, and only on this dataset:
    // no other read pays for a walk-proof scan it would not report.
    const inventoryUnprovenPages = params.dataset === "vault_media"
      ? await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
        countPagesWithUnprovenCreatorVaultInventory(tx, [page.id]),
        "agent_vault_inventory_proof")
      : 0;

    const hasMore = result.rows.length === limit;
    const last = result.rows.at(-1);
    const nextCursor = hasMore && last !== undefined
      ? encodeAgentCursor({
        operation: "agentDatasetQuery",
        resource: `dataset:${page.id}:${params.dataset}`,
        keyId: principal.agentKeyId,
        pageIds: [page.id],
        params: {
          dataset: params.dataset,
          from,
          to,
          filters: rawFilters,
          sort: [requestedSort],
          claimFields,
          limit: requestedLimit,
        },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { [params.dataset]: last.key },
        seqHighWater: {},
        keyset: { sortValue: last.sortValue, key: last.key },
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
      planesNotRead: planesNotRead({ operationPlanes, witnesses: result.witnesses }),
      delivery: { snapshotExhausted, nextCursor },
      cursorConsumed,
      cursorCapable: true,
      frozenSnapshot,
      requestWindow: { from, to },
      gaps,
      scopeFieldStates,
      sourceErrors: [],
      scopeNarrowing: scope.scopeNarrowing,
      observedRowFloor: observedRowFloorOf(result.rows.map((row) => row.occurredAt)),
      captureFloor: {
        at: floorAt,
        kind: floorAt === null ? "unknown" : "oldest_stored_row",
      },
      inventoryUnprovenPages,
    });

    // A dataset the REGISTRY declares as carrying verbatim text is audited exactly
    // like a transcript read. Driven by the flag rather than by a list of dataset
    // names here, so a future dataset that gains a text body cannot serve prose
    // without a trail: `fan_notes` shipped with the capability gate and no audit
    // row, which is half of the owner's condition for a machine principal reading
    // this material at all.
    if (definition.verbatimText) {
      await writeAgentAudit(scope.db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentDatasetQuery",
        pageIds: [page.id],
        verbatimText: true,
        requestSummary: {
          datasetRef: params.dataset,
          limit: requestedLimit,
          returned: result.rows.length,
          cursorConsumed,
          windowFrom: new Date(from).toISOString(),
          windowTo: new Date(to).toISOString(),
          platform: page.platform,
          planeMode: scope.planeMode,
        },
      });
    }

    const response: AgentDatasetQueryResponse = {
      datasetRef: params.dataset,
      pageLabel: page.pageLabel,
      platform: page.platform as Platform,
      window: { from, to },
      items: result.rows.map((row) => ({
        datasetRef: params.dataset,
        key: row.key,
        occurredAt: isoOrNull(row.occurredAt),
        fanPlatformUserId: row.fanPlatformUserId,
        fields: Object.fromEntries(Object.entries(row.fields).map(([field, value]) => [
          field,
          serializeDatasetValue(
            value,
            (definition.fields as Readonly<Record<string, string>>)[field],
          ),
        ])),
        fieldStates: datasetRowFieldStates(params.dataset, row.fields, scopeFieldStates),
        provenance: {
          ingestPaths: [row.ingestPath as AgentIngestPath],
          convergence: row.convergence,
          observationRef: row.observationRef,
        },
      })),
      predicates: buildPredicates([
        { name: "window", requested: true, applied: true },
        {
          name: "datasetFilter",
          requested: rawFilters.length > 0,
          applied: filters.length > 0,
        },
      ]),
      delivery: buildDelivery({
        returned: result.rows.length,
        matched: {
          value: result.rows.length,
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
    await scope.finish(result.rows.length);
    return response;
  } catch (error) {
    await scope.finish(0);
    throw error;
  }
}

/**
 * A dataset value on its way to the closed scalar union.
 *
 * Money columns are BIGINT and arrive as JavaScript BigInt, so they go through the
 * OVERFLOW GUARD rather than a bare `Number()`: a money path that silently stops
 * counting above 2^53 is the one conversion that must never be implicit.
 */
function serializeDatasetValue(
  value: unknown,
  kind: string | undefined,
): string | number | boolean | null | string[] {
  // Raw derived-table projections do not carry Drizzle column metadata, so pg
  // may return timestamptz values as its display string instead of a Date. The
  // dataset wire contract is RFC 3339 regardless of which mapping supplied it.
  if (kind === "timestamp" && (value instanceof Date || typeof value === "string")) {
    const instant = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(instant.getTime())) {
      return instant.toISOString();
    }
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return toSafeNumber(value);
  }
  if (
    typeof value === "string" || typeof value === "number"
    || typeof value === "boolean" || value === null
  ) {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return String(value);
}

/** Row states refine the scope-level capability without pretending that a null
 * or empty value was present. Only claim fields physically carried by this
 * dataset appear on the row; an unrelated claim remains blocked by its unread
 * plane in the top-level evidence. */
function datasetRowFieldStates(
  dataset: AgentDataset,
  fields: Readonly<Record<string, unknown>>,
  scopeFieldStates: Readonly<Record<string, AgentFieldState>>,
): Record<string, AgentFieldState> {
  const result: Record<string, AgentFieldState> = {};
  for (const [field, state] of Object.entries(scopeFieldStates)) {
    if (!Object.hasOwn(fields, field)) {
      continue;
    }
    const value = fields[field];
    if (
      state.state === "present"
      && dataset === "tip_transactions"
      && fields.contextState === "not_captured"
      && (field === "capturedConversationRef" || field === "tipMessageText")
    ) {
      result[field] = {
        state: "not_captured",
        remedy: {
          kind: "recapture",
          costClass: "free",
          admissible: true,
          reason: null,
        },
      };
      continue;
    }
    // A row-level null can refine `present` into "this source did not provide a
    // value". It must never erase a structural scope truth such as not_captured
    // or captured_unparsed — that used to make an unsupported OnlyFans field
    // look like a provider-specific omission that another pull might repair.
    if (state.state !== "present") {
      result[field] = state;
    } else if (value === null) {
      // In particular, a null postTipGoalRef is NOT direct-tip evidence.
      // Fansly's live flat /tips items identify only the post; raw capture and
      // replay retain the missing discriminator without inventing it.
      result[field] = {
        state: "source_did_not_provide",
        remedy: { kind: "none", reason: "no_remedy_exists" },
      };
    } else if (value === "") {
      result[field] = {
        state: "observed_empty",
        remedy: { kind: "none", reason: "no_remedy_exists" },
      };
    } else {
      result[field] = state;
    }
  }
  return result;
}
