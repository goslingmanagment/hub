import { createHash, randomUUID } from "node:crypto";

import {
  agentHydrationRequestDecideBodySchema,
} from "@agency_hub_core/contracts";
import type {
  AgentHydrationRequest,
  AgentHydrationRequestCreateBody,
  AgentHydrationRequestDecideBody,
  AgentHydrationRequestDecideResponse,
  AgentHydrationRequestGetResponse,
  AgentHydrationRequestListResponse,
  AgentHydrationRequestResponse,
} from "@agency_hub_core/contracts";
import {
  createAgentHydrationRequest,
  decideAgentHydrationRequest,
  findAgentHydrationRequestByRef,
  findAgentHydrationThread,
  hydrationCoverageFingerprint,
  listAgentHydrationRequests,
  type AgentHydrationRequestRecord,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal, HumanAuthPrincipal } from "../../services/auth.ts";
import {
  AGENT_HYDRATION_LANES,
  evaluateHydrationLanes,
} from "../../services/agent-hydration.ts";
import { loadEffectiveConfig } from "../../services/effective-config.ts";
import { BadRequestError } from "../../services/errors.ts";
import { buildAgentEvidence, type AgentPlaneMode } from "./epistemics.ts";
import {
  AgentHydrationConflictError,
  AgentHydrationNotAdmissibleError,
  AgentHydrationProposalStaleError,
  AgentIdempotencyMismatchError,
  AgentPlaneDisabledError,
  staticNotFound,
} from "./errors.ts";
import {
  AGENT_TIMEOUT_MS,
  beginAgentRequest,
  iso,
  isoOrNull,
  operationPlanesFor,
  singletonDelivery,
  withAgentTimeout,
  writeAgentAudit,
} from "./runtime.ts";
import { planesNotRead } from "./planes.ts";

/**
 * Operations #11 / #12 / #13 — hydration requests.
 *
 * THE ONE THING THIS FILE MUST NEVER DO IS TALK TO A PLATFORM, and it is
 * structural rather than disciplinary: nothing here imports an adapter, a
 * vendor client or `fetch`. #11 writes an intent, #12 reads it back, #13 is the
 * owner's decision. The work itself happens later, in the worker, by handing the
 * approval to machinery that already owns the egress resolver, the proxy, the
 * pacing and the sync lease (`services/agent-hydration.ts`).
 *
 * The three refusals worth naming, because they are not interchangeable:
 *   409 `hydration_not_admissible`  — the target is out of reach or no lane
 *                                     serves this platform;
 *   409 `idempotency_mismatch`      — the same idempotency key with a different
 *                                     normalized body (silently returning the
 *                                     first request would answer a question
 *                                     nobody asked);
 *   409 `hydration_proposal_stale`  — the coverage picture moved between what
 *                                     the owner was shown and what they decided
 *                                     on. An approval is bound to the content
 *                                     hash of exactly what was displayed.
 */

/** How long an UNDECIDED request stays decidable. An intent nobody acted on
 *  must not be approvable months later against a picture nobody remembers. */
export const AGENT_HYDRATION_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** The plane this operation family reads: the thread inventory it is about. */
const HYDRATION_PLANES = ["page_dm_threads"] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The normalized request body, hashed.
 *
 * The caller's `reason` enters as its own digest, never verbatim: the
 * fingerprint has to distinguish two different requests, which a digest does,
 * and it must not become a second copy of free-form text, which storing the
 * sentence would.
 */
export function hydrationRequestFingerprint(input: {
  pageId: number;
  conversationRef: string;
  beforeAt: string | null;
  beforeMessageRef: string | null;
  reason: string;
  maxCalls: number | null;
  claimFields: readonly string[] | null;
}): string {
  return sha256(JSON.stringify([
    "agent-hydration-request-v1",
    input.pageId,
    input.conversationRef,
    input.beforeAt === null ? null : new Date(input.beforeAt).toISOString(),
    input.beforeMessageRef,
    sha256(input.reason),
    input.maxCalls,
    input.claimFields === null ? null : [...input.claimFields].sort(),
  ]));
}

/** The normalized decision body, hashed — the same idempotency law as #11. */
export function hydrationDecisionFingerprint(body: AgentHydrationRequestDecideBody): string {
  return sha256(JSON.stringify([
    "agent-hydration-decision-v1",
    body.decision,
    body.coverageFingerprint,
    body.maxCalls ?? null,
    body.maxCredits ?? null,
    body.maxPages ?? null,
    body.maxItems ?? null,
    body.expiresAt === undefined ? null : new Date(body.expiresAt).toISOString(),
    body.allowMarkReadSideEffect ?? null,
    body.reason === undefined ? null : sha256(body.reason),
  ]));
}

/** The record, as it goes on the wire. */
export function toWireHydrationRequest(record: AgentHydrationRequestRecord): AgentHydrationRequest {
  return {
    requestRef: record.requestRef,
    state: record.state,
    pageLabel: record.pageLabel,
    platform: record.platform as Platform,
    conversationRef: record.conversationRef,
    target: {
      kind: "thread_backfill_before",
      beforeAt: isoOrNull(record.targetBeforeAt),
      beforeMessageRef: record.targetBeforeMessageRef,
    },
    admissibility: {
      orderEvaluated: record.laneOrderEvaluated,
      selected: record.laneSelected,
      admissible: record.admissible,
      reason: record.admissibilityReason as AgentHydrationRequest["admissibility"]["reason"],
      costNote: record.laneCostNote,
    },
    coverageFingerprint: record.coverageFingerprint,
    rowVersion: record.rowVersion,
    requestedBy: { principal: "agent_key", keyPrefix: record.agentKeyPrefix },
    reasonSha256: record.reasonSha256,
    reasonLength: record.reasonLength,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    expiresAt: isoOrNull(record.expiresAt),
    decision: record.decidedAt === null
      ? null
      : {
        decidedAt: iso(record.decidedAt),
        approved: record.decisionApproved === true,
        allowMarkReadSideEffect: record.decisionAllowMarkRead,
        maxCalls: record.decisionMaxCalls,
        maxCredits: record.decisionMaxCredits,
        maxPages: record.decisionMaxPages,
        maxItems: record.decisionMaxItems,
      },
    progress: {
      dispatchCount: record.dispatchCount,
      acceptedItems: record.acceptedItems,
      acceptedPages: record.acceptedPages,
      spentCredits: record.spentCredits,
      lastError: record.lastError,
      executionRef: record.executionRef,
    },
  };
}

/**
 * The envelope for a hydration response.
 *
 * These operations read ONE plane — the thread inventory the request is about —
 * and establish no capture floor from it, so the conclusion honestly carries
 * `capture_floor_unknown`. That is not a defect of the answer: a hydration
 * request is a statement about intent, not about how far back the store reaches.
 */
function hydrationEvidence(input: {
  planeMode: AgentPlaneMode;
  claimFields: readonly string[] | null;
  witnesses: Parameters<typeof buildAgentEvidence>[0]["planeReads"];
  scopeNarrowing: { keyGrantExcludedPages: number; totalPagesForQuery: number };
}) {
  const operationPlanes = operationPlanesFor([...HYDRATION_PLANES], input.claimFields);
  return buildAgentEvidence({
    planeMode: input.planeMode,
    claimFields: input.claimFields,
    operationPlanes,
    planeReads: input.witnesses,
    planesNotRead: planesNotRead({ operationPlanes, witnesses: input.witnesses }),
    delivery: { snapshotExhausted: true, nextCursor: null },
    cursorConsumed: false,
    cursorCapable: false,
    frozenSnapshot: true,
    requestWindow: null,
    gaps: [],
    scopeFieldStates: {},
    sourceErrors: [],
    scopeNarrowing: input.scopeNarrowing,
    observedRowFloor: null,
    captureFloor: { at: null, kind: "unknown" },
  });
}

const NO_NARROWING = { keyGrantExcludedPages: 0, totalPagesForQuery: 0 };

/** Every hydration route is gated by its own flag on top of the plane mode. */
async function assertHydrationEnabled(appContext: AppContext): Promise<AgentPlaneMode> {
  const config = await loadEffectiveConfig(appContext.db, appContext.config);
  const planeMode: AgentPlaneMode = config.agentReadPlaneMode ?? "off";
  if (planeMode === "off") {
    throw new AgentPlaneDisabledError();
  }
  if ((config.agentHydrationMode ?? "off") === "off") {
    throw new AgentPlaneDisabledError("agent hydration is disabled");
  }
  return planeMode;
}

// ---------------------------------------------------------------------------
// #11 agentHydrationRequestCreate
// ---------------------------------------------------------------------------

/**
 * Settles the row budget for a singleton operation.
 *
 * A refused request delivered NOTHING, so it must not spend the key's daily row
 * allowance: repeated failed polls would otherwise burn a budget for zero rows.
 * Every other handler on the plane settles zero on the error path; these did not.
 */
async function finishRows<T>(
  scope: { finish(rows: number): Promise<void> },
  body: () => Promise<T>,
): Promise<T> {
  let delivered = 0;
  try {
    const result = await body();
    delivered = 1;
    return result;
  } finally {
    await scope.finish(delivered);
  }
}

export async function handleAgentHydrationRequestCreate(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { pageLabel: string; conversationRef: string },
  body: AgentHydrationRequestCreateBody,
): Promise<AgentHydrationRequestResponse> {
  // The sub-flag is checked BEFORE the request budget is spent: a request that
  // never ran should not cost the caller its daily allowance.
  await assertHydrationEnabled(appContext);

  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentHydrationRequestCreate",
    requiredCapabilities: ["request:hydration"],
  });
  return finishRows(scope, async () => {
    // In-handler grant guard (dual-layer law #143): a page outside the grant
    // answers the SAME static 404 as a page that does not exist.
    const page = scope.pages.find((candidate) => candidate.pageLabel === params.pageLabel);
    if (!page) {
      throw staticNotFound();
    }

    const { thread, witnesses } = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
      findAgentHydrationThread(tx, {
        pageId: page.id,
        conversationRef: params.conversationRef,
      }), "agent_hydration_thread");
    // The page IS in the grant, so this is not an existence oracle across the
    // grant boundary: it is "the target of this intent is out of reach", which
    // is exactly what 409 hydration_not_admissible says.
    if (!thread) {
      throw new AgentHydrationNotAdmissibleError(
        "no visible thread with this conversationRef on this page",
      );
    }

    const platform = page.platform as Platform;
    const admissibility = evaluateHydrationLanes(platform);
    if (!admissibility.admissible || admissibility.selected === null) {
      throw new AgentHydrationNotAdmissibleError("no hydration lane serves this platform");
    }

    const claimFields = body.claim?.fields ?? null;
    const coverageFingerprint = hydrationCoverageFingerprint({
      pageId: page.id,
      conversationRef: params.conversationRef,
      storedMessageCount: thread.storedMessageCount,
      oldestStoredMessageId: thread.oldestStoredMessageId,
      messageCoverageStatus: thread.messageCoverageStatus,
    });
    const requestFingerprint = hydrationRequestFingerprint({
      pageId: page.id,
      conversationRef: params.conversationRef,
      beforeAt: body.target.beforeAt ?? null,
      beforeMessageRef: body.target.beforeMessageRef ?? null,
      reason: body.reason,
      maxCalls: body.maxCalls ?? null,
      claimFields,
    });

    const { created, request } = await createAgentHydrationRequest(scope.db, {
      requestRef: randomUUID(),
      agentKeyId: principal.agentKeyId,
      pageId: page.id,
      conversationRef: params.conversationRef,
      threadId: thread.id,
      targetBeforeAt: body.target.beforeAt === undefined ? null : new Date(body.target.beforeAt),
      targetBeforeMessageRef: body.target.beforeMessageRef ?? null,
      reasonSha256: sha256(body.reason),
      reasonLength: body.reason.length,
      requestedMaxCalls: body.maxCalls ?? null,
      idempotencyKey: body.idempotencyKey,
      requestFingerprint,
      coverageFingerprint,
      laneOrderEvaluated: admissibility.orderEvaluated,
      laneSelected: admissibility.selected,
      laneCostNote: admissibility.costNote,
      admissible: admissibility.admissible,
      admissibilityReason: admissibility.reason,
      expiresAt: new Date(Date.now() + AGENT_HYDRATION_REQUEST_TTL_MS),
    });

    // Coalescing is only honest when the bodies match. The same key with a
    // DIFFERENT body is a different question, and answering it with the first
    // request would be a silent substitution.
    if (!created && request.requestFingerprint !== requestFingerprint) {
      throw new AgentIdempotencyMismatchError();
    }

    await writeAgentAudit(scope.db, {
      agentKeyId: principal.agentKeyId,
      operation: "agentHydrationRequestCreate",
      pageIds: [page.id],
      verbatimText: false,
      requestSummary: {
        reasonSha256: sha256(body.reason),
        reasonLength: body.reason.length,
        platform,
        planeMode: scope.planeMode,
        returned: 1,
      },
    });

    const evidence = hydrationEvidence({
      planeMode: scope.planeMode,
      claimFields,
      // The thread lookup above IS the plane read this answer rests on.
      witnesses,
      scopeNarrowing: scope.scopeNarrowing,
    });

    return {
      request: toWireHydrationRequest(request),
      disposition: created ? "created" : "coalesced",
      delivery: singletonDelivery(1),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
  });
}

// ---------------------------------------------------------------------------
// #12 agentHydrationRequestGet
// ---------------------------------------------------------------------------

export async function handleAgentHydrationRequestGet(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  params: { requestRef: string },
): Promise<AgentHydrationRequestGetResponse> {
  await assertHydrationEnabled(appContext);

  const scope = await beginAgentRequest(appContext, principal, {
    operation: "agentHydrationRequestGet",
    requiredCapabilities: ["request:hydration"],
  });
  return finishRows(scope, async () => {
    const { request, witnesses } = await withAgentTimeout(scope.db, AGENT_TIMEOUT_MS.short, (tx) =>
      findAgentHydrationRequestByRef(tx, params.requestRef), "agent_hydration_get");

    // Three different misses, ONE answer. A request that does not exist, one on
    // a page outside the grant, and one filed by another key must be
    // indistinguishable — otherwise polling uuids maps out somebody else's work.
    if (
      !request
      || request.agentKeyId !== principal.agentKeyId
      || !scope.pageIds.includes(request.pageId)
    ) {
      throw staticNotFound();
    }

    const evidence = hydrationEvidence({
      planeMode: scope.planeMode,
      claimFields: null,
      witnesses,
      scopeNarrowing: scope.scopeNarrowing,
    });

    return {
      request: toWireHydrationRequest(request),
      delivery: singletonDelivery(1),
      capture: evidence.capture,
      conclusion: evidence.conclusion,
    };
  });
}

// ---------------------------------------------------------------------------
// #13 agentHydrationRequestDecide (owner session)
// ---------------------------------------------------------------------------

export interface HydrationDecisionOutcome {
  planeMode: AgentPlaneMode;
  request: AgentHydrationRequestRecord;
  disposition: "approved" | "rejected" | "already_decided";
  witnesses: Parameters<typeof buildAgentEvidence>[0]["planeReads"];
}

/**
 * The decision itself, shared by the HTTP route and the owner CLI.
 *
 * §13 rules that #13 has BOTH clients. They must not be two implementations of
 * "approve": the CAS, the coverage-staleness check, the idempotency replay and
 * the #158 consent rule are the whole safety of this operation, and a CLI that
 * re-implemented them would be the one that gets them wrong.
 */
export async function applyHydrationDecision(
  appContext: AppContext,
  input: {
    requestRef: string;
    actorUserId: number;
    body: AgentHydrationRequestDecideBody;
  },
): Promise<HydrationDecisionOutcome> {
  const planeMode = await assertHydrationEnabled(appContext);
  const db = appContext.db;
  // The body is validated HERE, not only by the route serializer: the owner CLI
  // calls this function directly, and a second client that skipped the cross-field
  // rules (every ceiling named, an expiry present, the #158 answer stated) would
  // be exactly the client that files an unexecutable approval.
  const parsed = agentHydrationRequestDecideBodySchema.safeParse(input.body);
  if (!parsed.success) {
    throw new BadRequestError(
      `hydration decision is not valid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const body = parsed.data;

  const { request, witnesses } = await withAgentTimeout(db, AGENT_TIMEOUT_MS.short, (tx) =>
    findAgentHydrationRequestByRef(tx, input.requestRef), "agent_hydration_decide");
  if (!request) {
    throw staticNotFound();
  }

  const decisionFingerprint = hydrationDecisionFingerprint(body);

  // Replay of the SAME decision: same key, same body, same answer. This is the
  // only path that succeeds on an already-decided request; every other second
  // decision is a conflict.
  if (request.decisionIdempotencyKey === body.idempotencyKey) {
    if (request.decisionFingerprint !== decisionFingerprint) {
      throw new AgentIdempotencyMismatchError();
    }
    return { planeMode, request, disposition: "already_decided", witnesses };
  }

  const platform = request.platform as Platform;
  const lane = AGENT_HYDRATION_LANES[platform];
  // #158: an approval that refuses the side effect cannot be executed on a
  // platform whose history read performs it. Refusing HERE is the honest place:
  // an "approved" request the executor would never run is a lie in the queue.
  if (
    body.decision === "approve"
    && lane.readMarksThreadRead
    && body.allowMarkReadSideEffect !== true
  ) {
    throw new AgentHydrationNotAdmissibleError(
      "this platform's history read marks the thread read; approval requires"
        + " allowMarkReadSideEffect",
    );
  }
  // A ceiling this lane cannot run on is not an approval, it is a job that dies
  // on its first lease — and the attempt it burns is the owner's only one.
  if (
    body.decision === "approve"
    && (body.maxCredits ?? 0) < lane.minimumCredits
  ) {
    throw new AgentHydrationNotAdmissibleError(
      `this platform's capture lane cannot run below maxCredits ${lane.minimumCredits}`,
    );
  }

  const approved = body.decision === "approve";
  // The coverage comparison, the CAS, the journal event and the audit row all
  // happen INSIDE one transaction: the quoted fingerprint is checked against
  // freshly read thread state, not against the request's own stored copy (which
  // would be the proposal compared with itself).
  const { outcome, request: decided } = await decideAgentHydrationRequest(db, {
    id: request.id,
    coverageFingerprint: body.coverageFingerprint,
    audit: {
      sessionUserId: input.actorUserId,
      operation: "agentHydrationRequestDecide",
      pageIds: [request.pageId],
      verbatimText: false,
      requestSummary: {
        ...(body.reason === undefined
          ? {}
          : { reasonSha256: sha256(body.reason), reasonLength: body.reason.length }),
        platform,
        planeMode,
        returned: 1,
      },
    },
    expectedVersion: body.expectedVersion,
    approved,
    sessionUserId: input.actorUserId,
    allowMarkReadSideEffect: body.allowMarkReadSideEffect ?? null,
    maxCalls: body.maxCalls ?? null,
    maxCredits: body.maxCredits ?? null,
    maxPages: body.maxPages ?? null,
    maxItems: body.maxItems ?? null,
    expiresAt: body.expiresAt === undefined ? null : new Date(body.expiresAt),
    reasonSha256: body.reason === undefined ? null : sha256(body.reason),
    reasonLength: body.reason === undefined ? null : body.reason.length,
    idempotencyKey: body.idempotencyKey,
    decisionFingerprint,
  });

  // The thread's depth moved between the proposal and the decision: the owner
  // would be paying for history somebody already fetched.
  if (outcome === "coverage_stale") {
    throw new AgentHydrationProposalStaleError();
  }
  // The CAS lost: somebody decided first, or the request left `requested` (it
  // expired, or it is already executing). Never an overwrite.
  if (outcome === "conflict" || !decided) {
    throw new AgentHydrationConflictError();
  }

  return {
    planeMode,
    request: decided,
    disposition: approved ? "approved" : "rejected",
    witnesses,
  };
}

export async function handleAgentHydrationRequestDecide(
  appContext: AppContext,
  principal: HumanAuthPrincipal,
  params: { requestRef: string },
  body: AgentHydrationRequestDecideBody,
): Promise<AgentHydrationRequestDecideResponse> {
  const outcome = await applyHydrationDecision(appContext, {
    requestRef: params.requestRef,
    actorUserId: principal.user.id,
    body,
  });

  const evidence = hydrationEvidence({
    planeMode: outcome.planeMode,
    claimFields: null,
    witnesses: outcome.witnesses,
    scopeNarrowing: NO_NARROWING,
  });

  return {
    request: toWireHydrationRequest(outcome.request),
    disposition: outcome.disposition,
    delivery: singletonDelivery(1),
    capture: evidence.capture,
    conclusion: evidence.conclusion,
  };
}

// ---------------------------------------------------------------------------
// The owner approval queue (dashboard, §13 "both clients")
// ---------------------------------------------------------------------------

export async function handleAgentHydrationRequestList(
  appContext: AppContext,
  _principal: HumanAuthPrincipal,
  query: { state?: string | undefined; limit: number },
): Promise<AgentHydrationRequestListResponse> {
  const planeMode = await assertHydrationEnabled(appContext);
  const db = appContext.db;

  const { rows, witnesses } = await withAgentTimeout(db, AGENT_TIMEOUT_MS.short, (tx) =>
    listAgentHydrationRequests(tx, {
      ...(query.state === undefined
        ? {}
        : { states: [query.state as AgentHydrationRequestRecord["state"]] }),
      limit: query.limit,
    }), "agent_hydration_list");

  const evidence = hydrationEvidence({
    planeMode,
    claimFields: null,
    witnesses,
    scopeNarrowing: NO_NARROWING,
  });

  return {
    items: rows.map(toWireHydrationRequest),
    delivery: singletonDelivery(rows.length),
    capture: evidence.capture,
    conclusion: evidence.conclusion,
  };
}
