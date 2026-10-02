import { createHash } from "node:crypto";

import type {
  AgentDelivery,
  AgentHistoryRequestCancelBody,
  AgentHistoryRequestCancelResponse,
  AgentHistoryRequestCreateBody,
  AgentHistoryRequestCreateResponse,
  AgentHistoryRequestGetResponse,
  AgentHistoryRequestListResponse,
} from "@agency_hub_core/contracts";
import {
  countHistoryItems,
  countHistoryRequests,
  getHistoryRequestByRef,
  listHistoryRequestsKeyset,
  readHistoryRequestsHighWater,
  type HistoryItemState,
  type HistoryRequestRow,
  type HistoryRequestState,
  type PlaneReadWitness,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal } from "../../services/auth.ts";
import { AppError } from "../../services/errors.ts";
import {
  cancelHistoryRequest,
  HISTORY_ITEMS_PAGE,
  historyRequestDocument,
  HistoryRequestError,
  historyRequestViews,
  submitHistoryRequest,
  type HistoryServiceContext,
} from "../../sync/requests/history.ts";
import { toHistoryItemWire, toHistoryRequestWire } from "../../sync/requests/wire.ts";
import { decodeAgentCursor, encodeAgentCursor } from "./cursors.ts";
import { buildAgentEvidence, type AgentPlaneMode } from "./epistemics.ts";
import { staticNotFound } from "./errors.ts";
import { planesNotRead } from "./planes.ts";
import {
  AGENT_TIMEOUT_MS,
  beginAgentRequest,
  buildDelivery,
  computeScopeFieldStates,
  operationPlanesFor,
  singletonDelivery,
  withAgentTimeout,
  writeAgentAudit,
  type AgentRequestScope,
} from "./runtime.ts";

/**
 * History requests on the agent plane (Fansly Sync Engine, plan §4, design
 * §7.4): create, get (with paged fans), cancel, list.
 *
 * Like the hydration family, NOTHING HERE TALKS TO A PLATFORM: these handlers
 * write and read rows; the engine's actor reads the chats on its own pace.
 * Unlike hydration there is no owner decision — a history read costs no
 * credits and marks nothing read (plan §4.2 p.8) — and requests open per page:
 * a page not switched to the engine answers 409
 * `history_requests_unavailable_on_page` (every page in step 2).
 *
 * Visibility (design D10): a key sees and may cancel the requests of EVERY
 * requester on the pages it is granted; a request on any other page is the
 * plane's one static 404, byte-identical to an unknown ref. Capabilities
 * (design D9): filing and cancelling need `request:hydration`; anything that
 * returns fans' chat refs needs `read:messages` as well.
 */

/** The plane these operations read: the thread inventory the fans resolve to. */
const HISTORY_PLANES = ["page_dm_threads"] as const;

const GET_OPERATION = "agentHistoryRequestGet";
const LIST_OPERATION = "agentHistoryRequestList";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The service's refusals as the plane answers them: its 404 is the plane's
 *  static 404, everything else keeps its status and code. */
function planeError(error: unknown): unknown {
  if (!(error instanceof HistoryRequestError)) return error;
  if (error.status === 404) return staticNotFound();
  return new AppError(error.message, error.status, error.code);
}

async function service<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw planeError(error);
  }
}

function historyContext(appContext: AppContext, db: HistoryServiceContext["db"], planeReads: PlaneReadWitness[]): HistoryServiceContext {
  return { db, rawConfig: appContext.config, planeReads };
}

/** A request outside the key's grant does not exist, as far as the key knows. */
function grantedRequest(scope: AgentRequestScope, request: HistoryRequestRow | null): HistoryRequestRow {
  if (request === null || !scope.pageIds.includes(request.pageId)) {
    throw staticNotFound();
  }
  return request;
}

function platformsOf(scope: AgentRequestScope, pageIds: readonly number[]): Platform[] {
  return [...new Set(scope.pages.filter((page) => pageIds.includes(page.id)).map((page) => page.platform as Platform))];
}

/**
 * The envelope of a history answer.
 *
 * It establishes no capture floor — a request is a statement about work, not
 * about how far back the store reaches — so the conclusion honestly carries
 * `capture_floor_unknown`, as hydration's does. Progress and "why waiting"
 * live in the body, never in blockers.
 *
 * A page of fans (or of requests) is a frozen snapshot unless a state filter
 * is applied: fans are fixed at intake and requests are walked below a high
 * water, but a STATE changes under the walk.
 */
function historyEvidence(input: {
  planeMode: AgentPlaneMode;
  claimFields: readonly string[] | null;
  witnesses: readonly PlaneReadWitness[];
  scopeNarrowing: { keyGrantExcludedPages: number; totalPagesForQuery: number };
  platforms: readonly Platform[];
  nextCursor: string | null;
  cursorConsumed: boolean;
  frozenSnapshot: boolean;
}) {
  const operationPlanes = operationPlanesFor([...HISTORY_PLANES], input.claimFields);
  return buildAgentEvidence({
    planeMode: input.planeMode,
    claimFields: input.claimFields,
    operationPlanes,
    planeReads: input.witnesses,
    planesNotRead: planesNotRead({ operationPlanes, witnesses: input.witnesses }),
    delivery: {
      snapshotExhausted: input.frozenSnapshot && input.nextCursor === null,
      nextCursor: input.nextCursor,
    },
    cursorConsumed: input.cursorConsumed,
    // Only a filtered walk has a population that can move under it.
    cursorCapable: !input.frozenSnapshot,
    frozenSnapshot: input.frozenSnapshot,
    requestWindow: null,
    gaps: [],
    scopeFieldStates: computeScopeFieldStates({
      fields: input.claimFields ?? [],
      platforms: [...input.platforms],
    }),
    sourceErrors: [],
    scopeNarrowing: input.scopeNarrowing,
    observedRowFloor: null,
    captureFloor: { at: null, kind: "unknown" },
    inventoryUnprovenPages: 0,
  });
}

function pagedDelivery(input: {
  returned: number;
  matched: number;
  nextCursor: string | null;
  cappedByBudget: boolean;
  snapshotExhausted: boolean;
  caveats: AgentDelivery["caveats"];
}): AgentDelivery {
  return buildDelivery({
    returned: input.returned,
    matched: { value: input.matched, exact: true },
    cappedBy: input.nextCursor === null ? null : input.cappedByBudget ? "budget" : "limit",
    nextCursor: input.nextCursor,
    snapshotExhausted: input.snapshotExhausted,
    caveats: input.caveats,
  });
}

/** The cursor that pages a request's fans after `afterOrdinal`: minted by
 *  create and by get alike, so get accepts create's cursor unchanged. */
function itemsCursor(
  scope: AgentRequestScope,
  request: Pick<HistoryRequestRow, "ref" | "pageId">,
  params: { limit: number; state?: HistoryItemState },
  afterOrdinal: number,
): string {
  return encodeAgentCursor({
    operation: GET_OPERATION,
    resource: `history_request:${request.ref}`,
    keyId: scope.principal.agentKeyId,
    pageIds: [request.pageId],
    params,
    archiveGeneration: scope.archiveGeneration,
    sourceHighWaters: {},
    seqHighWater: {},
    keyset: { afterOrdinal },
  }, scope.signing);
}

// ---------------------------------------------------------------------------
// agentHistoryRequestCreate
// ---------------------------------------------------------------------------

export async function handleAgentHistoryRequestCreate(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { pageLabel: string },
  body: AgentHistoryRequestCreateBody,
): Promise<AgentHistoryRequestCreateResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentHistoryRequestCreate",
    requiredCapabilities: ["request:hydration", "read:messages"],
  });
  let delivered = 0;
  try {
    // In-handler grant guard (dual-layer law #143): a page outside the grant
    // answers the same static 404 as a page that does not exist.
    const page = scope.pages.find((candidate) => candidate.pageLabel === params.pageLabel);
    if (!page) {
      throw staticNotFound();
    }
    const planeReads: PlaneReadWitness[] = [];
    const result = await service(() => submitHistoryRequest(historyContext(appContext, scope.db, planeReads), {
      pageId: page.id,
      requester: { kind: "agent_key", agentKeyId: principal.agentKeyId },
      fans: body.fans,
      depth: body.depth,
      reason: body.reason,
      idempotencyKey: body.idempotencyKey,
    }));
    await writeAgentAudit(scope.db, {
      agentKeyId: principal.agentKeyId,
      operation: "agentHistoryRequestCreate",
      pageIds: [page.id],
      verbatimText: false,
      requestSummary: {
        requestRef: result.request.ref,
        disposition: result.disposition,
        fans: body.fans.length,
        depthKind: body.depth.kind,
        reasonSha256: sha256(body.reason),
        reasonLength: body.reason.length,
        platform: page.platform,
        planeMode: scope.planeMode,
        returned: result.items.length,
      },
    });

    const nextCursor = result.nextAfterOrdinal === null
      ? null
      : itemsCursor(scope, result.request, { limit: HISTORY_ITEMS_PAGE }, result.nextAfterOrdinal);
    const claimFields = body.claim?.fields ?? null;
    const evidence = historyEvidence({
      planeMode: scope.planeMode,
      claimFields,
      witnesses: planeReads,
      scopeNarrowing: scope.scopeNarrowing,
      platforms: [page.platform as Platform],
      nextCursor,
      cursorConsumed: false,
      frozenSnapshot: true,
    });
    delivered = result.items.length;
    return {
      disposition: result.disposition,
      request: toHistoryRequestWire(result.request),
      items: result.items.map(toHistoryItemWire),
      delivery: pagedDelivery({
        returned: result.items.length,
        matched: result.request.counts.total,
        nextCursor,
        cappedByBudget: false,
        snapshotExhausted: nextCursor === null,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
  } finally {
    await scope.finish(delivered);
  }
}

// ---------------------------------------------------------------------------
// agentHistoryRequestGet
// ---------------------------------------------------------------------------

export async function handleAgentHistoryRequestGet(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { requestRef: string },
  query: { state?: HistoryItemState | undefined; limit: number; cursor?: string | undefined },
): Promise<AgentHistoryRequestGetResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: GET_OPERATION,
    requiredCapabilities: ["read:messages"],
  });
  let delivered = 0;
  try {
    const request = grantedRequest(scope, await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
      getHistoryRequestByRef(tx, params.requestRef), "agent_history_get"));

    const cursorConsumed = query.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(query.cursor as string, {
        operation: GET_OPERATION,
        // Bound to the REQUEST: a cursor of one request never pages another.
        resource: `history_request:${request.ref}`,
        keyId: principal.agentKeyId,
        pageIds: [request.pageId],
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;
    const stored = cursor?.params as { state?: HistoryItemState; limit?: number } | undefined;
    const state = stored?.state ?? query.state;
    const requestedLimit = stored?.limit ?? query.limit;
    const afterOrdinal = cursor === null ? null : Number(cursor.keyset.afterOrdinal);

    const { limit, cappedByBudget } = await scope.limitWithinRowBudget(requestedLimit);
    const planeReads: PlaneReadWitness[] = [];
    const { document, matched } = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, async (tx) => {
      const document = await historyRequestDocument(historyContext(appContext, tx, planeReads), request, {
        limit,
        afterOrdinal,
        ...(state === undefined ? {} : { states: [state] }),
      });
      const matched = state === undefined
        ? request.itemsTotal
        : (await countHistoryItems(tx, [request.id])).get(request.id)?.byState[state] ?? 0;
      return { document, matched };
    }, "agent_history_get");

    const nextCursor = document.nextAfterOrdinal === null
      ? null
      : itemsCursor(scope, request, {
        limit: requestedLimit,
        ...(state === undefined ? {} : { state }),
      }, document.nextAfterOrdinal);
    const frozenSnapshot = state === undefined;
    const evidence = historyEvidence({
      planeMode: scope.planeMode,
      claimFields: null,
      witnesses: planeReads,
      scopeNarrowing: scope.scopeNarrowing,
      platforms: platformsOf(scope, [request.pageId]),
      nextCursor,
      cursorConsumed,
      frozenSnapshot,
    });
    delivered = document.items.length;
    return {
      request: toHistoryRequestWire(document.request),
      items: document.items.map(toHistoryItemWire),
      delivery: pagedDelivery({
        returned: document.items.length,
        matched,
        nextCursor,
        cappedByBudget,
        snapshotExhausted: frozenSnapshot && nextCursor === null,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
  } finally {
    await scope.finish(delivered);
  }
}

// ---------------------------------------------------------------------------
// agentHistoryRequestCancel
// ---------------------------------------------------------------------------

export async function handleAgentHistoryRequestCancel(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { requestRef: string },
  body: AgentHistoryRequestCancelBody,
): Promise<AgentHistoryRequestCancelResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentHistoryRequestCancel",
    requiredCapabilities: ["request:hydration"],
  });
  let delivered = 0;
  try {
    const request = grantedRequest(scope, await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
      getHistoryRequestByRef(tx, params.requestRef), "agent_history_cancel"));
    const planeReads: PlaneReadWitness[] = [];
    const result = await service(() => cancelHistoryRequest(
      historyContext(appContext, scope.db, planeReads),
      request.ref,
      { reason: body.reason ?? null },
    ));

    await writeAgentAudit(scope.db, {
      agentKeyId: principal.agentKeyId,
      operation: "agentHistoryRequestCancel",
      pageIds: [request.pageId],
      verbatimText: false,
      requestSummary: {
        requestRef: request.ref,
        disposition: result.disposition,
        ...(body.reason === undefined
          ? {}
          : { reasonSha256: sha256(body.reason), reasonLength: body.reason.length }),
        planeMode: scope.planeMode,
        returned: 1,
      },
    });

    const evidence = historyEvidence({
      planeMode: scope.planeMode,
      claimFields: null,
      witnesses: planeReads,
      scopeNarrowing: scope.scopeNarrowing,
      platforms: platformsOf(scope, [request.pageId]),
      nextCursor: null,
      cursorConsumed: false,
      frozenSnapshot: true,
    });
    delivered = 1;
    return {
      disposition: result.disposition,
      request: toHistoryRequestWire(result.request),
      delivery: singletonDelivery(1),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
  } finally {
    await scope.finish(delivered);
  }
}

// ---------------------------------------------------------------------------
// agentHistoryRequestList
// ---------------------------------------------------------------------------

export async function handleAgentHistoryRequestList(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  query: { pageLabel?: string | undefined; state?: HistoryRequestState | undefined; limit: number; cursor?: string | undefined },
): Promise<AgentHistoryRequestListResponse> {
  const scope = await beginAgentRequest(appContext, principal, {
    operation: LIST_OPERATION,
    requiredCapabilities: ["read:messages"],
  });
  let delivered = 0;
  try {
    const cursorConsumed = query.cursor !== undefined;
    const cursor = cursorConsumed
      ? decodeAgentCursor(query.cursor as string, {
        operation: LIST_OPERATION,
        resource: "global",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        archiveGeneration: scope.archiveGeneration,
      }, scope.signing)
      : null;
    const stored = cursor?.params as
      | { pageLabel?: string; state?: HistoryRequestState; limit?: number; highWater?: number }
      | undefined;
    const pageLabel = stored?.pageLabel ?? query.pageLabel;
    const state = stored?.state ?? query.state;
    const requestedLimit = stored?.limit ?? query.limit;
    // A label outside the grant narrows to nothing; it never widens the walk.
    const pageIds = (pageLabel === undefined ? scope.pages : scope.pages.filter((page) => page.pageLabel === pageLabel))
      .map((page) => page.id);

    const { limit, cappedByBudget } = await scope.limitWithinRowBudget(requestedLimit);
    const planeReads: PlaneReadWitness[] = [];
    const { rows, views, matched, highWater } = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.long, async (tx) => {
      const highWater = stored?.highWater ?? await readHistoryRequestsHighWater(tx, pageIds);
      const rows = await listHistoryRequestsKeyset(tx, {
        pageIds,
        ...(state === undefined ? {} : { state }),
        ...(cursor === null ? {} : { beforeId: Number(cursor.keyset.beforeId) }),
        maxId: highWater,
        limit,
      });
      const views = await historyRequestViews(historyContext(appContext, tx, planeReads), rows);
      const matched = await countHistoryRequests(tx, {
        pageIds,
        ...(state === undefined ? {} : { state }),
        maxId: highWater,
      });
      return { rows, views, matched, highWater };
    }, "agent_history_list");

    const last = rows.at(-1);
    const nextCursor = rows.length === limit && last !== undefined
      ? encodeAgentCursor({
        operation: LIST_OPERATION,
        resource: "global",
        keyId: principal.agentKeyId,
        pageIds: scope.pageIds,
        params: {
          ...(pageLabel === undefined ? {} : { pageLabel }),
          ...(state === undefined ? {} : { state }),
          limit: requestedLimit,
          highWater,
        },
        archiveGeneration: scope.archiveGeneration,
        sourceHighWaters: { history_requests: String(highWater) },
        seqHighWater: {},
        keyset: { beforeId: last.id },
      }, scope.signing)
      : null;
    const frozenSnapshot = state === undefined;
    const evidence = historyEvidence({
      planeMode: scope.planeMode,
      claimFields: null,
      witnesses: planeReads,
      scopeNarrowing: scope.scopeNarrowing,
      platforms: platformsOf(scope, pageIds),
      nextCursor,
      cursorConsumed,
      frozenSnapshot,
    });
    delivered = views.length;
    return {
      items: views.map(toHistoryRequestWire),
      delivery: pagedDelivery({
        returned: views.length,
        matched,
        nextCursor,
        cappedByBudget,
        snapshotExhausted: frozenSnapshot && nextCursor === null,
        caveats: evidence.deliveryCaveats,
      }),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
  } finally {
    await scope.finish(delivered);
  }
}
