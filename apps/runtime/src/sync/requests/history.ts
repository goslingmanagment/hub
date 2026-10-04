import {
  closeWorkRows,
  countHistoryItems,
  endHistoryItems,
  findHistoryRequestByIdempotency,
  findHistoryThreadCandidates,
  getHistoryRequestByRef,
  getSyncPage,
  getSyncWorkRows,
  HISTORY_ITEM_OPEN_STATES,
  HISTORY_REQUEST_MAX_ITEMS,
  HISTORY_REQUEST_MAX_LATEST,
  HISTORY_REQUEST_MAX_REASON,
  HISTORY_WORK_RESOURCE,
  insertHistoryItems,
  insertHistoryRequest,
  isPageErased,
  latestWorkForSubjects,
  listHistoryItems,
  listHistoryRequests,
  listOpenHistoryItems,
  listOpenRequestsForPage,
  lockRequestsOfOpenItems,
  lockThreadsForHistoryItems,
  lockWorkRows,
  markHistoryItemsReady,
  markHistoryRequestCancelled,
  openWorkIdsForSubjects,
  readHistoryThreadFacts,
  readOpenVerifiedWsConnection,
  readRouteJournal,
  readRouteUse,
  refreshHistoryRequestCompletion,
  setHistoryItemAnchors,
  upsertDemands,
  workIdsWithOpenHistoryItems,
  type Database,
  type HistoryDepth,
  type HistoryItemAnchor,
  type HistoryItemRefusal,
  type HistoryItemRow,
  type HistoryItemState,
  type HistoryRequesterKind,
  type HistoryRequestRow,
  type HistoryRequestState,
  type HistoryThreadFacts,
  type NewHistoryItem,
  type OpenHistoryItem,
  type PlaneReadWitness,
  type SyncPageRow,
  type SyncWorkRow,
  type UpsertDemandInput,
} from "@agency_hub_core/db";
import { activeFanslyPageHold, getFanslyDmMessageSyncExcludedReason, isIndefinite, type AppConfig } from "@agency_hub_core/shared";

import { recordAudit } from "../../services/auth.ts";
import { loadEffectiveConfig } from "../../services/effective-config.ts";
import { type ResourceHoldEntry } from "../engine/errors.ts";
import {
  EMPTY_ROUTE_STATE,
  parseRouteState,
  routeAdmissionView,
  routeJournalLookbackMs,
  RouteClocks,
} from "../engine/route-policy.ts";
import {
  estimateSlotOpensAt,
  explainWork,
  ownerRunning,
  type RouteAdmissionView,
  type StatusPage,
  type StatusWork,
  type WaitingReason,
} from "../engine/status.ts";
import { FANSLY_RESOURCE_SPECS } from "../fansly/registry.ts";
import { parseDmMessagesCursor } from "../fansly/resources/dm-messages.ts";
import {
  budgetUseOf,
  estimateItemReads,
  estimateRequest,
  ETA_USE_WINDOW_MS,
  HISTORY_READ_ROUTE,
  itemEtaFacts,
  requestsCapacity,
  type EtaLimit,
  type ItemReadsEstimate,
  type RequestEta,
  type RequestsCapacity,
} from "./eta.ts";
import {
  anchorAtIntake,
  belowAnchor,
  chooseFanThread,
  decideAnchor,
  depthJson,
  historyRequestFingerprint,
  HistoryInputError,
  judgeSatisfaction,
  loadedMessages,
  normalizeHistoryInputs,
  reasonDigest,
  type HistoryFanInput,
  type NormalizedHistoryInput,
  type Satisfaction,
} from "./history-rules.ts";

// History requests (plan §4; design §7.1): intake, satisfaction, cancel and
// the views the owner CLI, the owner routes and the agent routes share.
//
// A request names a page, 1..1000 fans and a depth. Each fan becomes one item;
// the items of one chat ride on the chat's ONE `dm-messages.history` work
// row, so a read serves every request attached to the chat and counts once
// (on the item whose turn it was). The engine's requests class serves the
// items round robin (between a page's requests, then between a request's
// fans); every history read runs `onHistoryThreadChainChanged`, which anchors,
// satisfies and — when no fan is left — closes the work.
//
// Lock order (design §3.7): every transaction here takes its sync_work rows
// first (id order, then new rows by subject), then history_requests rows,
// then history_request_items rows — the order of the engine's admission and
// apply, so intake, cancel and the actor never deadlock
// (tests/sync-history-lock-order.integration.test.ts).

export const HISTORY_REQUESTS_UNAVAILABLE_CODE = "history_requests_unavailable_on_page";
export const HISTORY_REQUEST_CREATE_AUDIT_EVENT = "admin.history_request_create";
export const HISTORY_REQUEST_CANCEL_AUDIT_EVENT = "admin.history_request_cancel";
/** Items a create or a status read returns at once (the rest pages). */
export const HISTORY_ITEMS_PAGE = 200;

/** A typed refusal the routes map to their status (design §7.1.1). */
export class HistoryRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "HistoryRequestError";
  }
}

/** The 409 of step 2: requests open on a page only once it is live and its
 *  `requests_enabled_at` has passed. */
export class HistoryRequestsUnavailableError extends HistoryRequestError {
  constructor(pageId: number, page: Pick<SyncPageRow, "mode" | "requestsEnabledAt"> | null) {
    super(
      409,
      HISTORY_REQUESTS_UNAVAILABLE_CODE,
      `History requests are not open on page ${pageId}: they work on pages switched to the Fansly Sync Engine `
        + `(this page is ${page === null ? "not a Fansly sync page" : `'${page.mode}'`}); use the hydration route`,
      { pageId, mode: page?.mode ?? null, requestsEnabledAt: page?.requestsEnabledAt?.toISOString() ?? null },
    );
    this.name = "HistoryRequestsUnavailableError";
  }
}

export interface HistoryServiceContext {
  db: Database;
  /** The env config the live pause key is layered over (the ETA's S). */
  rawConfig: AppConfig;
  /**
   * Set by a reader that reports what it read (the agent plane's envelope):
   * every `page_dm_threads` read a view or a resolution runs leaves its
   * witness here. Writes inside transactions never report.
   */
  planeReads?: PlaneReadWitness[];
}

export type HistoryRequester =
  | { kind: "agent_key"; agentKeyId: number }
  | { kind: "owner_session" | "owner_cli"; userId: number | null }
  | { kind: "legacy_hydration_wrapper"; legacyRequestId: number };

export type HistoryDepthInput =
  | { kind: "all" }
  | { kind: "latest"; count: number }
  | { kind: "before_boundary"; at?: Date | null; messageRef?: string | null };

export interface HistoryIntake {
  pageId: number;
  requester: HistoryRequester;
  /** 1..1000; an identical input twice is one fan. */
  fans: readonly HistoryFanInput[];
  depth: HistoryDepthInput;
  /** 1..1000 characters; stored as a digest only. */
  reason: string;
  /** A uuid of the caller. */
  idempotencyKey: string;
}

/** Who to audit an owner action as (recordAudit); the agent routes audit
 *  their own way and pass none. */
export interface HistoryAuditActor {
  source: string;
  actorUserId?: number | null;
  actorAgentKeyId?: number | null;
}

// ── views (design §7.4 wire shapes; ISO instants) ─────────────────────────────

export type HistoryItemViewState = HistoryItemState;

export interface HistoryItemView {
  ordinal: number;
  input: { kind: NewHistoryItem["inputKind"]; ref: string };
  fanPlatformUserId: string | null;
  conversationRef: string | null;
  state: HistoryItemViewState;
  refusal: HistoryItemRefusal | null;
  excludedReason: string | null;
  /** Blocked: when the vendor is asked again (the daily probe). */
  probeAt: string | null;
  waitingReason: WaitingReason | null;
  waitingUntil: string | null;
  loadedMessages: number;
  oldestLoadedAt: string | null;
  readsSpent: number;
  historyState: "none" | "unverified" | "partial" | "complete";
  historyProof: "empty_page" | null;
  anchorMessageRef: string | null;
  satisfiedAt: string | null;
  satisfiedBy: HistoryItemRow["satisfiedBy"];
  estimate: { readsMin: number; readsEstimate: number | null };
}

/** A request's ETA (plan §4.3, step 3b ruling 11): the time its reads take
 *  at the rate its page's budgets leave it, with what stops or slows them
 *  shown apart. */
export interface HistoryEtaView {
  /** The reads it needs at least ("не меньше"), at `ratePerHour`. */
  lowerBoundSeconds: number;
  estimateSeconds: number | null;
  basis: "estimate";
  /** Reads an hour this request gets while it is not held. */
  ratePerHour: number;
  /** The requests class's share of the page's slots, in percent. */
  sharePercent: number;
  /** The budget that sets the rate: the page's slots, the `/message` route
   *  or its family (messaging). */
  limitedBy: EtaLimit;
  /** The route runs below its budget on this page after a 429 (it rises
   *  only by a deliberate step); null: at its budget. In the rate. */
  slowdown: EtaSlowdown | null;
  /** A hold in force: no read until it ends (until null: no instant ends
   *  it). Not in the seconds above. */
  hold: { scope: "page" | "route"; until: string | null } | null;
}

export interface HistoryRequestView {
  ref: string;
  pageId: number;
  pageLabel: string | null;
  state: HistoryRequestState;
  depth: { kind: HistoryDepth["kind"]; count?: number; boundaryAt?: string | null; boundaryMessageRef?: string | null };
  requesterKind: HistoryRequesterKind;
  createdAt: string;
  doneAt: string | null;
  cancelledAt: string | null;
  counts: { total: number; ready: number; queued: number; loading: number; blocked: number; refused: number; cancelled: number };
  reads: { done: number; remainingMin: number; remainingEstimate: number | null };
  eta: HistoryEtaView;
  /** 1-based position in the page's round robin of open requests. */
  queuePosition: number | null;
  waitingReason: WaitingReason | null;
  waitingUntil: string | null;
  estimateAtSubmit: Record<string, unknown>;
}

export interface HistoryRequestDocument {
  request: HistoryRequestView;
  items: HistoryItemView[];
  /** Pass as `afterOrdinal` for the next items; null: no more. */
  nextAfterOrdinal: number | null;
}

export interface HistoryIntakeResult extends HistoryRequestDocument {
  disposition: "created" | "coalesced";
}

// ── validation ────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^[0-9]{1,30}$/;

function invalid(message: string, detail: Record<string, unknown> = {}): HistoryRequestError {
  return new HistoryRequestError(400, "invalid_history_request", message, detail);
}

export function normalizeHistoryDepth(depth: HistoryDepthInput): HistoryDepth {
  switch (depth?.kind) {
    case "all":
      return { kind: "all" };
    case "latest": {
      const count = depth.count;
      if (!Number.isSafeInteger(count) || count < 1 || count > HISTORY_REQUEST_MAX_LATEST) {
        throw invalid(`depth.count must be an integer in 1..${HISTORY_REQUEST_MAX_LATEST}`);
      }
      return { kind: "latest", count };
    }
    case "before_boundary": {
      const at = depth.at ?? null;
      const messageRef = depth.messageRef ?? null;
      if ((at === null) === (messageRef === null)) throw invalid("depth before_boundary takes exactly one of at, messageRef");
      if (at !== null && Number.isNaN(at.getTime())) throw invalid("depth.at is not a time");
      if (messageRef !== null && !DECIMAL.test(messageRef)) throw invalid("depth.messageRef is not a Fansly message id");
      return { kind: "before_boundary", at, messageRef };
    }
    default:
      throw invalid("depth.kind must be all, latest or before_boundary");
  }
}

function requesterColumns(requester: HistoryRequester): {
  kind: HistoryRequesterKind;
  agentKeyId: number | null;
  userId: number | null;
  legacyHydrationRequestId: number | null;
} {
  switch (requester.kind) {
    case "agent_key":
      if (!Number.isSafeInteger(requester.agentKeyId) || requester.agentKeyId <= 0) throw invalid("requester.agentKeyId");
      return { kind: "agent_key", agentKeyId: requester.agentKeyId, userId: null, legacyHydrationRequestId: null };
    case "owner_session":
    case "owner_cli":
      if (requester.userId !== null && (!Number.isSafeInteger(requester.userId) || requester.userId <= 0)) {
        throw invalid("requester.userId");
      }
      return { kind: requester.kind, agentKeyId: null, userId: requester.userId, legacyHydrationRequestId: null };
    case "legacy_hydration_wrapper":
      return { kind: "legacy_hydration_wrapper", agentKeyId: null, userId: null, legacyHydrationRequestId: requester.legacyRequestId };
  }
}

// ── the chats of the inputs (design §7.1.2) ───────────────────────────────────

type Resolved =
  | { kind: "refused"; input: NormalizedHistoryInput; refusal: HistoryItemRefusal; excludedReason: string | null; thread: HistoryThreadFacts | null }
  | { kind: "thread"; input: NormalizedHistoryInput; thread: HistoryThreadFacts };

/** Why the engine never reads a chat (design §5.4), as an item's
 *  `excluded_reason`: its exclusion, or no bound fan. */
function exclusionOf(thread: HistoryThreadFacts): string | null {
  const excluded = getFanslyDmMessageSyncExcludedReason(thread.metadata);
  if (excluded !== null) return excluded;
  return thread.fanId === null ? "unbound" : null;
}

async function resolveInputs(
  db: Database,
  pageId: number,
  inputs: readonly NormalizedHistoryInput[],
  planeReads?: PlaneReadWitness[],
): Promise<Resolved[]> {
  if (await isPageErased(db, pageId)) {
    return inputs.map((input) => ({ kind: "refused", input, refusal: "page_erased", excludedReason: null, thread: null }));
  }
  const candidates = await findHistoryThreadCandidates(db, {
    pageId,
    groupIds: inputs.flatMap((input) => (input.groupId === null ? [] : [input.groupId])),
    fanRefs: inputs.flatMap((input) => (input.fanRef === null ? [] : [input.fanRef])),
  }, planeReads);
  const taken = new Set<number>();
  return inputs.map((input): Resolved => {
    const thread = input.groupId !== null
      ? candidates.byGroupId.get(input.groupId) ?? null
      : input.fanRef !== null ? chooseFanThread(candidates.byFanRef.get(input.fanRef) ?? []) : null;
    if (thread === null) return { kind: "refused", input, refusal: "not_found", excludedReason: null, thread: null };
    const excluded = exclusionOf(thread);
    if (excluded !== null) return { kind: "refused", input, refusal: "excluded", excludedReason: excluded, thread };
    // Two inputs naming one chat: the first carries the work.
    if (taken.has(thread.threadId)) return { kind: "refused", input, refusal: "duplicate", excludedReason: null, thread };
    taken.add(thread.threadId);
    return { kind: "thread", input, thread };
  });
}

function fanOf(input: NormalizedHistoryInput, thread: HistoryThreadFacts | null): string | null {
  return input.fanRef ?? thread?.fanPlatformUserId ?? thread?.partnerPlatformUserId ?? null;
}

// ── ETA context of a page ─────────────────────────────────────────────────────

/** The history read route's rate on the page after its 429s, when lower
 *  than the budget table's (a slowdown, step 3b ruling 2). */
interface EtaSlowdown {
  route: string;
  effectivePerMin: number;
  currentPerMin: number;
}

interface PageEtaContext {
  page: SyncPageRow | null;
  settingMs: number;
  /** The requests class's reads a minute between holds. */
  capacity: RequestsCapacity;
  slowdown: EtaSlowdown | null;
  /** The history read route's own hold in force (a 429's), when it ends. */
  routeHoldUntil: Date | null;
  /** The page's route state is one this build cannot read: it admits
   *  nothing (the diagnostic); null: it reads. */
  routeStateError: string | null;
  /** The route admission, for each fan's "why waiting". */
  routes: RouteAdmissionView;
  /** The page's open requests in round-robin order. */
  openRequests: Array<{ id: number; ref: string; runnable: boolean }>;
}

/**
 * What a request's ETA reads of its page (step 3b ruling 11): S, the history
 * read route's budgets as the page's route state leaves them (`/message` and
 * its family), what the other classes sent of them over the last 15 minutes,
 * and the route's hold. Requests run on the live journal; the legacy send log
 * counts on the route clocks as the live actor counts it.
 */
async function pageEtaContext(ctx: HistoryServiceContext, pageId: number): Promise<PageEtaContext> {
  const page = await getSyncPage(ctx.db, pageId);
  const settingMs = (await loadEffectiveConfig(ctx.db, ctx.rawConfig)).fanslyDefaultDelayMs;
  const now = page?.dbNow ?? new Date();
  const read = parseRouteState(page?.routeState ?? null);
  const state = read.ok ? read.state : EMPTY_ROUTE_STATE;
  const sends = page === null
    ? []
    : await readRouteJournal(ctx.db, { pageId, shadow: false, withinMs: routeJournalLookbackMs(state), legacy: true });
  const clocks = new RouteClocks({ sends, state });
  const route = clocks.view(HISTORY_READ_ROUTE);
  const family = route.family === null ? null : clocks.familyView(route.family);
  const use = budgetUseOf(await readRouteUse(ctx.db, { pageId, shadow: false, withinMs: ETA_USE_WINDOW_MS }), ETA_USE_WINDOW_MS);
  const stateError = read.ok ? null : read.diagnostic;
  return {
    page,
    settingMs,
    capacity: requestsCapacity({
      settingMs,
      routePerMin: route.effectivePerMin,
      familyPerMin: family === null ? null : family.currentPerMin,
      use,
    }),
    slowdown: route.effectivePerMin < route.currentPerMin
      ? { route: route.route, effectivePerMin: route.effectivePerMin, currentPerMin: route.currentPerMin }
      : null,
    routeHoldUntil: route.holdUntil !== null && route.holdUntil.getTime() > now.getTime() ? route.holdUntil : null,
    routeStateError: stateError,
    routes: routeAdmissionView(read.ok ? clocks : null, stateError, FANSLY_RESOURCE_SPECS, now),
    openRequests: await listOpenRequestsForPage(ctx.db, { pageId }),
  };
}

/** A known stop of a request's reads, shown beside its estimate (never in
 *  it): the page's hold, a route state this build cannot read (the page
 *  admits nothing), or the history read route's own hold. Until null: no
 *  known instant ends it (an auth or identity hold only new credentials
 *  lift; an unreadable route state, the operator). */
function etaHold(eta: PageEtaContext, now: Date): { scope: "page" | "route"; until: Date | null } | null {
  const held = eta.page === null ? null : activeFanslyPageHold(statusPageOf(eta.page), now);
  if (held !== null) return { scope: "page", until: isIndefinite(held.until) ? null : held.until };
  if (eta.routeStateError !== null) return { scope: "page", until: null };
  if (eta.routeHoldUntil !== null) return { scope: "route", until: eta.routeHoldUntil };
  return null;
}

function runnableRequestCount(eta: PageEtaContext, extra: number): number {
  return Math.max(1, eta.openRequests.filter((request) => request.runnable).length + extra);
}

function itemEstimate(item: { depth: HistoryDepth; anchor: Pick<HistoryItemAnchor, "upwardCount" | "chainEpoch"> | null }, thread: HistoryThreadFacts, now: Date): ItemReadsEstimate {
  const below = belowAnchor(item.anchor, thread);
  return estimateItemReads({
    depth: item.depth,
    anchored: below !== null,
    belowAnchor: below ?? 0,
    facts: itemEtaFacts(thread),
    now,
  });
}

function seconds(ms: number | null): number | null {
  return ms === null ? null : Math.ceil(ms / 1000);
}

// ── intake (design §7.1.1–§7.1.5) ─────────────────────────────────────────────

function isUniqueViolation(error: unknown): boolean {
  for (let link: unknown = error, depth = 0; link !== null && link !== undefined && depth < 6; depth += 1) {
    if ((link as { code?: unknown }).code === "23505") return true;
    link = (link as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * File a history request (≤ 3 s, database only). Refuses with
 * `HistoryRequestError`: 400 for a malformed request, 409
 * `history_requests_unavailable_on_page` unless the page is live with
 * requests enabled (every page in step 2), 409 `idempotency_mismatch` for a
 * reused key with another request. A repeat with the same key and request is
 * `coalesced` (the same ref). A fan that resolves to no chat never fails the
 * request: it is refused (`not_found`, `excluded`, `page_erased`,
 * `duplicate`); a fan already satisfied is `ready` without a read.
 */
export async function submitHistoryRequest(
  ctx: HistoryServiceContext,
  input: HistoryIntake,
  options: { audit?: HistoryAuditActor } = {},
): Promise<HistoryIntakeResult> {
  if (!Array.isArray(input.fans) || input.fans.length < 1 || input.fans.length > HISTORY_REQUEST_MAX_ITEMS) {
    throw invalid(`fans: 1..${HISTORY_REQUEST_MAX_ITEMS} required`);
  }
  if (typeof input.reason !== "string" || input.reason.length < 1 || input.reason.length > HISTORY_REQUEST_MAX_REASON) {
    throw invalid(`reason: 1..${HISTORY_REQUEST_MAX_REASON} characters required`);
  }
  if (typeof input.idempotencyKey !== "string" || !UUID.test(input.idempotencyKey)) throw invalid("idempotencyKey must be a uuid");
  let inputs: NormalizedHistoryInput[];
  try {
    inputs = normalizeHistoryInputs(input.fans);
  } catch (error) {
    if (error instanceof HistoryInputError) throw invalid(error.message);
    throw error;
  }
  const depth = normalizeHistoryDepth(input.depth);
  const requester = requesterColumns(input.requester);
  const idempotencyKey = input.idempotencyKey.toLowerCase();
  const fingerprint = historyRequestFingerprint({ pageId: input.pageId, inputs, depth, reason: input.reason });
  const identity = {
    requesterKind: requester.kind,
    requesterAgentKeyId: requester.agentKeyId,
    requesterUserId: requester.userId,
    idempotencyKey,
  };

  const coalesce = async (): Promise<HistoryIntakeResult | null> => {
    const existing = await findHistoryRequestByIdempotency(ctx.db, identity);
    if (existing === null) return null;
    if (existing.fingerprint !== fingerprint || existing.pageId !== input.pageId) {
      throw new HistoryRequestError(409, "idempotency_mismatch",
        "This idempotency key was used for another request", { ref: existing.ref });
    }
    return { disposition: "coalesced", ...(await historyRequestDocument(ctx, existing, { limit: HISTORY_ITEMS_PAGE })) };
  };
  const repeated = await coalesce();
  if (repeated !== null) return repeated;

  const page = await getSyncPage(ctx.db, input.pageId);
  if (page === null || page.mode !== "live" || page.requestsEnabledAt === null
    || page.requestsEnabledAt.getTime() > page.dbNow.getTime()) {
    throw new HistoryRequestsUnavailableError(input.pageId, page);
  }

  // (1) Resolve and classify every input — reads only.
  const resolved = await resolveInputs(ctx.db, input.pageId, inputs, ctx.planeReads);
  const threads = resolved.flatMap((entry) => (entry.kind === "thread" ? [entry.thread] : []));
  const latest = await latestWorkForSubjects(ctx.db, {
    pageId: input.pageId,
    shadow: false,
    resourceFile: "dm-messages",
    subjects: threads.map((thread) => thread.groupId),
  });
  const socket = threads.length === 0 ? null : await readOpenVerifiedWsConnection(ctx.db, input.pageId);
  const now = page.dbNow;
  const items: NewHistoryItem[] = [];
  const needWork = new Map<string, { thread: HistoryThreadFacts; dueAt: Date | null }>();
  const estimates: ItemReadsEstimate[] = [];
  let unanchored = 0;
  for (const entry of resolved) {
    const base = {
      ordinal: entry.input.ordinal,
      inputKind: entry.input.inputKind,
      inputRef: entry.input.inputRef,
      fanPlatformUserId: fanOf(entry.input, entry.thread),
      fanId: entry.thread?.fanId ?? null,
      threadId: entry.thread?.threadId ?? null,
      conversationRef: entry.thread?.groupId ?? entry.input.groupId,
    };
    if (entry.kind === "refused") {
      items.push({
        ...base,
        state: "refused",
        refusal: entry.refusal,
        excludedReason: entry.excludedReason,
        workId: null,
        anchor: null,
        estimateReadsMin: null,
        estimateReads: null,
        satisfiedBy: null,
        satisfiedOldestId: null,
        satisfiedCount: null,
        final: { readsSpent: 0, refusedAtIntake: true },
      });
      continue;
    }
    const thread = entry.thread;
    const anchor = anchorAtIntake(thread, socket);
    const satisfied = judgeSatisfaction({ depth, anchor }, thread);
    if (satisfied !== null) {
      items.push({
        ...base,
        state: "ready",
        refusal: null,
        excludedReason: null,
        workId: null,
        anchor,
        estimateReadsMin: 0,
        estimateReads: 0,
        satisfiedBy: "already_satisfied",
        satisfiedOldestId: satisfied.oldestId,
        satisfiedCount: satisfied.count,
        final: finalOf({ readsSpent: 0, estimateReads: 0, estimateReadsMin: 0, depth, anchor }, thread),
      });
      continue;
    }
    // The vendor keeps refusing this chat (any of its DM reads): the fan is
    // blocked and its first read waits for the daily probe.
    const previous = latest.get(thread.groupId) ?? null;
    const blocked = previous !== null && previous.blockedByVendorAt !== null;
    const estimate = itemEstimate({ depth, anchor }, thread, now);
    estimates.push(estimate);
    if (anchor === null) unanchored += 1;
    needWork.set(thread.groupId, { thread, dueAt: blocked ? previous.breakerUntil : null });
    items.push({
      ...base,
      state: blocked ? "blocked" : "queued",
      refusal: null,
      excludedReason: null,
      workId: null,
      anchor,
      estimateReadsMin: estimate.readsMin,
      estimateReads: estimate.readsEstimate,
      satisfiedBy: null,
      satisfiedOldestId: null,
      satisfiedCount: null,
      final: null,
    });
  }

  const eta = await pageEtaContext(ctx, input.pageId);
  const requestEta = estimateRequest({
    items: estimates,
    unanchoredItems: unanchored,
    capacity: eta.capacity,
    k: runnableRequestCount(eta, estimates.length > 0 ? 1 : 0),
  });
  // Written once, with the request, and never again: the forecast a backtest
  // holds the fact against (ruling 11). A hold in force is beside it, not in
  // it.
  const hold = etaHold(eta, eta.page?.dbNow ?? new Date());
  const estimateAtSubmit = {
    readsMin: requestEta.remainingMin,
    readsEstimate: requestEta.remainingEstimate,
    etaMinMs: requestEta.etaMinMs,
    etaEstimateMs: requestEta.etaEstimateMs,
    sharePercent: Math.round(requestEta.share * 100),
    settingMs: eta.settingMs,
    ratePerHour: requestEta.ratePerHour,
    limitedBy: requestEta.limitedBy,
    k: requestEta.k,
    slowdown: eta.slowdown,
    hold: hold === null ? null : { scope: hold.scope, until: iso(hold.until) },
  };

  let created: HistoryRequestRow;
  try {
    created = await ctx.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      // (2) The chats the fans reference first (page_dm_threads before
      //     sync_work, §3.7), then their shared work rows: the existing ones
      //     locked in id order, then the demand upserted by group id (new
      //     rows in key order).
      await lockThreadsForHistoryItems(tx, items.flatMap((item) => (item.threadId === null ? [] : [item.threadId])));
      const groups = [...needWork.keys()].sort();
      const existing = await openWorkIdsForSubjects(tx, {
        pageId: input.pageId, shadow: false, resource: HISTORY_WORK_RESOURCE, subjects: groups,
      });
      await lockWorkRows(tx, [...existing.values()]);
      const upserts: UpsertDemandInput[] = groups.map((groupId) => ({
        pageId: input.pageId,
        shadow: false,
        resource: HISTORY_WORK_RESOURCE,
        subject: groupId,
        kind: "goal",
        class: "requests",
        dueAt: needWork.get(groupId)!.dueAt,
        demand: { reasons: ["request"] },
      }));
      const results = await upsertDemands(tx, upserts);
      const workOf = new Map(groups.map((groupId, index) => [groupId, results[index]!.id]));
      // (3) The request, then its fans (history_* after every sync_work row).
      const request = await insertHistoryRequest(tx, {
        pageId: input.pageId,
        requesterKind: requester.kind,
        requesterAgentKeyId: requester.agentKeyId,
        requesterUserId: requester.userId,
        idempotencyKey,
        fingerprint,
        depth,
        reasonSha256: reasonDigest(input.reason),
        reasonLength: input.reason.length,
        itemsTotal: items.length,
        estimateAtSubmit,
        legacyHydrationRequestId: requester.legacyHydrationRequestId,
      });
      await insertHistoryItems(tx, {
        requestId: request.id,
        pageId: input.pageId,
        items: items.map((item) => ({
          ...item,
          workId: item.state === "queued" || item.state === "blocked"
            ? workOf.get(item.conversationRef ?? "") ?? null
            : null,
        })),
      });
      // (4) The open fans of the same chats (this request's and earlier
      //     ones') against the chain as it stands.
      await settleOpenItemsOfThreads(tx, {
        pageId: input.pageId,
        threadIds: [...needWork.values()].map((entry) => entry.thread.threadId),
      });
      await refreshHistoryRequestCompletion(tx, [request.id]);
      if (options.audit !== undefined) {
        await recordAudit({ db: tx }, {
          ...options.audit,
          eventType: HISTORY_REQUEST_CREATE_AUDIT_EVENT,
          platformAccountId: input.pageId,
          metadata: {
            ref: request.ref,
            requesterKind: requester.kind,
            depth: depthJson(depth),
            fans: items.length,
            refused: items.filter((item) => item.state === "refused").length,
            alreadySatisfied: items.filter((item) => item.state === "ready").length,
            reasonSha256: request.reasonSha256,
          },
        });
      }
      return request;
    });
  } catch (error) {
    // A concurrent intake with the same key won the idempotency index.
    if (isUniqueViolation(error)) {
      const winner = await coalesce();
      if (winner !== null) return winner;
    }
    throw error;
  }
  const document = await historyRequestDocument(ctx, (await getHistoryRequestByRef(ctx.db, created.ref)) ?? created, {
    limit: HISTORY_ITEMS_PAGE,
  });
  return { disposition: "created", ...document };
}

// ── satisfaction (design §7.1.6) ──────────────────────────────────────────────

function finalOf(
  item: { readsSpent: number; estimateReads: number | null; estimateReadsMin: number | null; depth: HistoryDepth; anchor: Pick<HistoryItemAnchor, "upwardCount" | "chainEpoch"> | null },
  thread: HistoryThreadFacts | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    readsSpent: item.readsSpent,
    estimateReads: item.estimateReads,
    estimateReadsMin: item.estimateReadsMin,
    loadedMessages: thread === null ? null : loadedMessages(item, thread),
    oldestLoadedAt: thread?.contiguousOldestAt?.toISOString() ?? null,
    ...extra,
  };
}

/**
 * Settle the open fans of these chats against their chains (the hook of every
 * DM read, and intake): an anchor of another epoch is cleared, a fan without
 * one is anchored once a head was accepted after it was filed, a satisfied fan
 * becomes `ready`, its request `done` when no fan is left open, and a chat's
 * work closes `goal_satisfied` when no fan rides on it.
 *
 * Runs inside the caller's transaction after its own sync_work writes, in the
 * lock order of §3.7 whoever calls it: the chats' history works (id order)
 * before any request, requests before items. A `.head` or `.catchup` apply
 * reaches here without holding the chat's `.history` work, so the hook takes
 * it itself. Only fans of the requests it locked are written, and only works
 * it locked are closed: a fan filed (or a work created) after those locks is
 * left to its own intake and to the work's own plan (`no_open_items`).
 */
export async function settleOpenItemsOfThreads(
  tx: Database,
  input: { pageId: number; threadIds: readonly number[] },
): Promise<{ anchored: number; ready: number; closedWorks: number[] }> {
  const threadIds = [...new Set(input.threadIds)];
  const nothing = { anchored: 0, ready: 0, closedWorks: [] as number[] };
  if (threadIds.length === 0) return nothing;
  // sync_work first: the works the chats' open fans ride on, read without a
  // lock, then locked in id order (a no-op for the rows the caller holds).
  const riding = await listOpenHistoryItems(tx, { threadIds });
  if (riding.length === 0) return nothing;
  const lockedWorks = await lockWorkRows(tx, riding.flatMap((item) => (item.workId === null ? [] : [item.workId])));
  const requestIds = await lockRequestsOfOpenItems(tx, { threadIds });
  if (requestIds.length === 0) return nothing;
  const items = await listOpenHistoryItems(tx, { threadIds, requestIds, lock: true });
  if (items.length === 0) return nothing;
  const facts = await readHistoryThreadFacts(tx, threadIds);
  const works = new Map(lockedWorks.map((work) => [work.id, work]));
  const unlocked = items.flatMap((item) => (item.workId === null || works.has(item.workId) ? [] : [item.workId]));
  for (const [id, work] of await getSyncWorkRows(tx, unlocked)) works.set(id, work);

  const toClear: number[] = [];
  const toSet = new Map<number, { anchor: Omit<HistoryItemAnchor, "fixedAt">; itemIds: number[] }>();
  const ready: Parameters<typeof markHistoryItemsReady>[1][number][] = [];
  for (const item of items) {
    const thread = item.threadId === null ? undefined : facts.get(item.threadId);
    if (thread === undefined) continue;
    const work = item.workId === null ? undefined : works.get(item.workId);
    const cursor = parseDmMessagesCursor(work?.cursor);
    const decision = decideAnchor(item, thread, {
      historyHeadAt: cursor.historyHeadAt,
      segmentStaged: cursor.segment !== null && cursor.segment.baseHeadId === thread.headConfirmedId,
    });
    let anchor: Pick<HistoryItemAnchor, "upwardCount" | "chainEpoch"> | null = item.anchor;
    if (decision.kind === "clear") {
      toClear.push(item.id);
      anchor = null;
    } else if (decision.kind === "set") {
      const entry = toSet.get(thread.threadId) ?? { anchor: decision.anchor, itemIds: [] };
      entry.itemIds.push(item.id);
      toSet.set(thread.threadId, entry);
      anchor = decision.anchor;
    }
    const satisfied: Satisfaction | null = judgeSatisfaction({ depth: item.depth, anchor }, thread);
    if (satisfied !== null) {
      ready.push({
        itemId: item.id,
        satisfiedBy: satisfied.by,
        satisfiedOldestId: satisfied.oldestId,
        satisfiedCount: satisfied.count,
        final: finalOf({ ...item, anchor }, thread),
      });
    }
  }
  await setHistoryItemAnchors(tx, { itemIds: toClear, anchor: null });
  let anchored = 0;
  for (const entry of toSet.values()) anchored += await setHistoryItemAnchors(tx, entry);
  await markHistoryItemsReady(tx, ready);
  await refreshHistoryRequestCompletion(tx, requestIds);
  // A work no open fan rides on any more is done (only an open one this
  // transaction locked: a running read's own apply runs this again).
  const lockedWorkIds = new Set(lockedWorks.map((work) => work.id));
  const workIds = [...new Set(items.flatMap((item) => (item.workId !== null && lockedWorkIds.has(item.workId) ? [item.workId] : [])))];
  const stillNeeded = await workIdsWithOpenHistoryItems(tx, workIds);
  const closedWorks = await closeWorkRows(tx, {
    workIds: workIds.filter((id) => !stillNeeded.has(id)),
    to: "done",
    closeReason: "goal_satisfied",
  });
  return { anchored, ready: ready.length, closedWorks };
}

/** The engine's tx-3 hook (`CommitDeps.onThreadChainChanged`): every history
 *  read and every DM read that moved a chain. */
export async function onHistoryThreadChainChanged(tx: Database, input: { pageId: number; threadId: number }): Promise<void> {
  await settleOpenItemsOfThreads(tx, { pageId: input.pageId, threadIds: [input.threadId] });
}

/**
 * The engine's work-closed hook (`CommitDeps.onWorkClosed`): a chat's history
 * work closed for a reason of its own — the chat was deleted, unbound or
 * excluded since intake, or proven complete. Its open fans end now: satisfied
 * ones `ready`, the rest refused (`not_found`, `excluded`) or `cancelled`
 * with the reason in `final`. Other works are not the requests' business.
 */
export async function onHistoryWorkClosed(
  tx: Database,
  input: { pageId: number; workId: number; resource: string; closeReason: string | null },
): Promise<void> {
  if (input.resource !== HISTORY_WORK_RESOURCE) return;
  // The caller closed (so holds) the work: requests, then their fans.
  const requestIds = await lockRequestsOfOpenItems(tx, { workIds: [input.workId] });
  if (requestIds.length === 0) return;
  const items = await listOpenHistoryItems(tx, { workId: input.workId, requestIds, lock: true });
  const facts = await readHistoryThreadFacts(tx, items.flatMap((item) => (item.threadId === null ? [] : [item.threadId])));
  const ready: Parameters<typeof markHistoryItemsReady>[1][number][] = [];
  const ended: Array<{ item: OpenHistoryItem; state: "refused" | "cancelled"; refusal: HistoryItemRefusal | null; excludedReason: string | null; thread: HistoryThreadFacts | null }> = [];
  for (const item of items) {
    const thread = item.threadId === null ? null : facts.get(item.threadId) ?? null;
    const satisfied = thread === null ? null : judgeSatisfaction(item, thread);
    if (satisfied !== null && thread !== null) {
      ready.push({
        itemId: item.id,
        satisfiedBy: satisfied.by,
        satisfiedOldestId: satisfied.oldestId,
        satisfiedCount: satisfied.count,
        final: finalOf(item, thread),
      });
      continue;
    }
    if (thread === null || !thread.isVisible || input.closeReason === "thread_missing") {
      ended.push({ item, state: "refused", refusal: "not_found", excludedReason: null, thread });
      continue;
    }
    const excluded = exclusionOf(thread);
    if (excluded !== null || input.closeReason === "excluded" || input.closeReason === "unbound") {
      ended.push({ item, state: "refused", refusal: "excluded", excludedReason: excluded ?? input.closeReason, thread });
      continue;
    }
    ended.push({ item, state: "cancelled", refusal: null, excludedReason: null, thread });
  }
  await markHistoryItemsReady(tx, ready);
  for (const entry of ended) {
    await endHistoryItems(tx, {
      itemIds: [entry.item.id],
      state: entry.state,
      refusal: entry.refusal,
      excludedReason: entry.excludedReason,
      final: finalOf(entry.item, entry.thread, { closeReason: input.closeReason }),
    });
  }
  await refreshHistoryRequestCompletion(tx, requestIds);
}

// ── cancel (design §7.1.7) ────────────────────────────────────────────────────

export interface HistoryCancelResult {
  disposition: "cancelled" | "already_cancelled" | "already_done";
  request: HistoryRequestView;
}

/**
 * Cancel a request: its open fans are cancelled, chats no other request reads
 * any more stop being read (their work closes `cancelled`); what was loaded
 * stays loaded and every chain stays. Idempotent.
 */
export async function cancelHistoryRequest(
  ctx: HistoryServiceContext,
  ref: string,
  options: { reason?: string | null; audit?: HistoryAuditActor } = {},
): Promise<HistoryCancelResult> {
  const reason = options.reason ?? null;
  if (reason !== null && (reason.length < 1 || reason.length > HISTORY_REQUEST_MAX_REASON)) {
    throw invalid(`reason: 1..${HISTORY_REQUEST_MAX_REASON} characters`);
  }
  const before = await getHistoryRequestByRef(ctx.db, ref);
  if (before === null) throw new HistoryRequestError(404, "history_request_not_found", `No history request ${ref}`);
  const disposition = await ctx.db.transaction(async (raw): Promise<HistoryCancelResult["disposition"]> => {
    const tx = raw as unknown as Database;
    // sync_work first (id order), then the request, then its fans.
    const open = await listOpenHistoryItems(tx, { requestId: before.id });
    const workIds = [...new Set(open.flatMap((item) => (item.workId === null ? [] : [item.workId])))];
    await lockWorkRows(tx, workIds);
    const request = await getHistoryRequestByRef(tx, ref, { forUpdate: true });
    if (request === null) throw new HistoryRequestError(404, "history_request_not_found", `No history request ${ref}`);
    if (request.state === "cancelled") return "already_cancelled";
    if (request.state === "done") return "already_done";
    const items = await listOpenHistoryItems(tx, { requestId: request.id, lock: true });
    const facts = await readHistoryThreadFacts(tx, items.flatMap((item) => (item.threadId === null ? [] : [item.threadId])));
    for (const item of items) {
      await endHistoryItems(tx, {
        itemIds: [item.id],
        state: "cancelled",
        final: finalOf(item, item.threadId === null ? null : facts.get(item.threadId) ?? null, { cancelled: true }),
      });
    }
    await markHistoryRequestCancelled(tx, { requestId: request.id, reasonSha256: reason === null ? null : reasonDigest(reason) });
    const stillNeeded = await workIdsWithOpenHistoryItems(tx, workIds);
    await closeWorkRows(tx, { workIds: workIds.filter((id) => !stillNeeded.has(id)), to: "cancelled", closeReason: "request_cancelled" });
    if (options.audit !== undefined) {
      await recordAudit({ db: tx }, {
        ...options.audit,
        eventType: HISTORY_REQUEST_CANCEL_AUDIT_EVENT,
        platformAccountId: request.pageId,
        metadata: {
          ref: request.ref,
          cancelledFans: items.length,
          reasonSha256: reason === null ? null : reasonDigest(reason),
        },
      });
    }
    return "cancelled";
  });
  const after = (await getHistoryRequestByRef(ctx.db, ref)) ?? before;
  return { disposition, request: (await historyRequestViews(ctx, [after]))[0]! };
}

// ── views (design §7.1.8: computed on read, nothing duplicated) ──────────────

/** An instant of a view; an indefinite one (an auth or identity hold only
 *  new credentials lift) has none: null. */
function iso(date: Date | null | undefined): string | null {
  return date === null || date === undefined || isIndefinite(date) ? null : date.toISOString();
}

function statusPageOf(page: SyncPageRow): StatusPage {
  return {
    mode: page.mode,
    pausedAll: page.pausedAll,
    pausedRequests: page.pausedRequests,
    pausedResources: page.pausedResources,
    holdKind: page.holdKind,
    holdUntil: page.holdUntil,
    holdSince: page.holdSince,
    holdDetail: page.holdDetail,
    resourceHolds: page.resourceHolds as Record<string, ResourceHoldEntry>,
    owner: page.owner,
  };
}

function statusWorkOf(work: SyncWorkRow): StatusWork {
  return {
    id: work.id,
    resource: work.resource,
    subject: work.subject,
    class: work.class,
    state: work.state,
    dueAt: work.dueAt,
    breakerUntil: work.breakerUntil,
    blockedByVendorAt: work.blockedByVendorAt,
    waitingReason: work.waitingReason,
    waitingUntil: work.waitingUntil,
  };
}

/** What a request waits for as a whole: the page (an owner pause, no running
 *  live owner, a page hold, a route state this build cannot read), or the
 *  hold of the route every history read takes, else nothing. The pause is
 *  named first (G19): the open requests of a page whose requests are paused
 *  read `paused` (plan §15), not `ownership_unconfirmed`, also when the page
 *  runs no owner. */
function requestWaiting(eta: PageEtaContext, now: Date): { reason: WaitingReason; until: Date | null } | null {
  const page = eta.page;
  if (page === null) return { reason: "ownership_unconfirmed", until: null };
  if (page.pausedAll || page.pausedRequests) return { reason: "paused", until: null };
  const status = statusPageOf(page);
  if (page.mode !== "live" || !ownerRunning(status, now)) return { reason: "ownership_unconfirmed", until: null };
  const hold = etaHold(eta, now);
  if (hold === null) return null;
  // A route's hold is its budget's business (`pacer`, as "why waiting" names
  // a route its hold or budget keeps closed).
  return { reason: hold.scope === "page" ? "page_hold" : "pacer", until: hold.until };
}

const OPEN_ITEM_STATES: ReadonlySet<string> = new Set(HISTORY_ITEM_OPEN_STATES);

/** The fan's state as served: `blocked` when it was filed on a chat the
 *  vendor kept refusing (until its probe read is admitted, which makes it
 *  `loading`), or when its chat's shared work reached `blocked_by_vendor`
 *  since (the work carries the block, design §7.1.6). */
function effectiveItemState(item: HistoryItemRow, work: SyncWorkRow | undefined): HistoryItemViewState {
  if (!OPEN_ITEM_STATES.has(item.state)) return item.state;
  if (work !== undefined && work.blockedByVendorAt !== null && (work.state === "open" || work.state === "running")) return "blocked";
  return item.state;
}

/** When a blocked fan's chat is asked again: the work's breaker, or — filed
 *  blocked — the probe instant its first read waits for. */
function probeAtOf(work: SyncWorkRow | undefined): Date | null {
  if (work === undefined) return null;
  return work.breakerUntil ?? work.dueAt;
}

interface ViewInputs {
  facts: Map<number, HistoryThreadFacts>;
  works: Map<number, SyncWorkRow>;
  pages: Map<number, PageEtaContext>;
}

function itemView(item: HistoryItemRow, depth: HistoryDepth, inputs: ViewInputs, now: Date): HistoryItemView {
  const thread = item.threadId === null ? undefined : inputs.facts.get(item.threadId);
  const work = item.workId === null ? undefined : inputs.works.get(item.workId);
  const state = effectiveItemState(item, work);
  const open = OPEN_ITEM_STATES.has(state);
  const eta = inputs.pages.get(item.pageId);
  const page = eta?.page ?? null;
  // A paused page or requests class is named before the owner (G19), as for
  // the request as a whole.
  const paused = open && work !== undefined && page !== null && work.state !== "running"
    && (page.pausedAll || (work.class === "requests" && page.pausedRequests));
  const waiting = paused
    ? { reason: "paused" as const, until: null }
    : open && work !== undefined && eta !== undefined && page !== null
    ? explainWork(statusWorkOf(work), statusPageOf(page), {
      slotOpensAt: estimateSlotOpensAt({
        lastSendAt: page.lastSendAt,
        lastCompletedAt: page.lastCompletedAt,
        settingMs: eta.settingMs,
      }),
      // The fan's chat waits on its route's budget or hold like any work.
      routes: eta.routes,
    }, now)
    : null;
  const frozen = !open && item.final !== null;
  const estimate = open && thread !== undefined
    ? itemEstimate({ depth, anchor: item.anchor }, thread, now)
    : { readsMin: 0, readsEstimate: 0, readsMax: null };
  const loaded = frozen && typeof item.final!.loadedMessages === "number"
    ? item.final!.loadedMessages
    : thread === undefined ? 0 : loadedMessages({ depth, anchor: item.anchor }, thread);
  const oldestLoadedAt = frozen && typeof item.final!.oldestLoadedAt === "string"
    ? item.final!.oldestLoadedAt
    : iso(thread?.contiguousOldestAt);
  return {
    ordinal: item.ordinal,
    input: { kind: item.inputKind, ref: item.inputRef },
    fanPlatformUserId: item.fanPlatformUserId,
    conversationRef: item.conversationRef,
    state,
    refusal: item.refusal,
    excludedReason: item.excludedReason,
    probeAt: state === "blocked" ? iso(probeAtOf(work)) : null,
    waitingReason: waiting?.reason ?? null,
    waitingUntil: iso(waiting?.until),
    loadedMessages: loaded,
    oldestLoadedAt,
    readsSpent: item.readsSpent,
    historyState: thread?.effectiveHistoryState ?? "none",
    historyProof: thread?.historyProof ?? null,
    anchorMessageRef: item.anchor?.messageId ?? null,
    satisfiedAt: iso(item.satisfiedAt),
    satisfiedBy: item.satisfiedBy,
    estimate: { readsMin: estimate.readsMin, readsEstimate: estimate.readsEstimate },
  };
}

function depthView(depth: HistoryDepth): HistoryRequestView["depth"] {
  switch (depth.kind) {
    case "all":
      return { kind: "all" };
    case "latest":
      return { kind: "latest", count: depth.count };
    case "before_boundary":
      return { kind: "before_boundary", boundaryAt: iso(depth.at), boundaryMessageRef: depth.messageRef };
  }
}

async function loadViewInputs(
  ctx: HistoryServiceContext,
  requests: readonly HistoryRequestRow[],
  items: readonly HistoryItemRow[],
): Promise<ViewInputs> {
  const pages = new Map<number, PageEtaContext>();
  for (const pageId of new Set(requests.map((request) => request.pageId))) pages.set(pageId, await pageEtaContext(ctx, pageId));
  return {
    facts: await readHistoryThreadFacts(
      ctx.db,
      items.flatMap((item) => (item.threadId === null ? [] : [item.threadId])),
      ctx.planeReads,
    ),
    works: await getSyncWorkRows(ctx.db, items.flatMap((item) => (item.workId === null ? [] : [item.workId]))),
    pages,
  };
}

/** Request views (counts, reads, ETA, queue position) of these requests. */
export async function historyRequestViews(
  ctx: HistoryServiceContext,
  requests: readonly HistoryRequestRow[],
): Promise<HistoryRequestView[]> {
  if (requests.length === 0) return [];
  const counts = await countHistoryItems(ctx.db, requests.map((request) => request.id));
  const openItems = new Map<number, OpenHistoryItem[]>();
  for (const request of requests) {
    openItems.set(request.id, request.state === "open" ? await listOpenHistoryItems(ctx.db, { requestId: request.id }) : []);
  }
  const inputs = await loadViewInputs(ctx, requests, [...openItems.values()].flat());
  return requests.map((request) => {
    const eta = inputs.pages.get(request.pageId)!;
    const now = eta.page?.dbNow ?? new Date();
    const open = openItems.get(request.id) ?? [];
    const byState = { ready: 0, queued: 0, loading: 0, blocked: 0, refused: 0, cancelled: 0 };
    const stored = counts.get(request.id)!;
    for (const state of ["ready", "refused", "cancelled"] as const) byState[state] = stored.byState[state];
    const estimates: ItemReadsEstimate[] = [];
    let unanchored = 0;
    let runnable = false;
    for (const item of open) {
      const work = item.workId === null ? undefined : inputs.works.get(item.workId);
      const state = effectiveItemState(item, work);
      if (state === "queued" || state === "loading" || state === "blocked") byState[state] += 1;
      if (state !== "blocked") runnable = true;
      const thread = item.threadId === null ? undefined : inputs.facts.get(item.threadId);
      if (thread === undefined) continue;
      estimates.push(itemEstimate(item, thread, now));
      if (belowAnchor(item.anchor, thread) === null) unanchored += 1;
    }
    const requestEta: RequestEta = estimateRequest({
      items: estimates,
      unanchoredItems: unanchored,
      capacity: eta.capacity,
      k: runnableRequestCount(eta, 0),
    });
    const position = eta.openRequests.findIndex((entry) => entry.id === request.id);
    const waiting = request.state === "open" && runnable ? requestWaiting(eta, now) : null;
    const hold = request.state === "open" ? etaHold(eta, now) : null;
    return {
      ref: request.ref,
      pageId: request.pageId,
      pageLabel: request.pageLabel,
      state: request.state,
      depth: depthView(request.depth),
      requesterKind: request.requesterKind,
      createdAt: request.createdAt.toISOString(),
      doneAt: iso(request.doneAt),
      cancelledAt: iso(request.cancelledAt),
      counts: { total: request.itemsTotal, ...byState },
      reads: {
        done: stored.readsSpent,
        remainingMin: requestEta.remainingMin,
        remainingEstimate: requestEta.remainingEstimate,
      },
      eta: {
        lowerBoundSeconds: seconds(requestEta.etaMinMs) ?? 0,
        estimateSeconds: seconds(requestEta.etaEstimateMs),
        basis: "estimate",
        ratePerHour: requestEta.ratePerHour,
        sharePercent: Math.round(requestEta.share * 100),
        limitedBy: requestEta.limitedBy,
        slowdown: request.state === "open" ? eta.slowdown : null,
        hold: hold === null ? null : { scope: hold.scope, until: iso(hold.until) },
      },
      queuePosition: request.state === "open" && position !== -1 ? position + 1 : null,
      waitingReason: waiting?.reason ?? null,
      waitingUntil: iso(waiting?.until),
      estimateAtSubmit: request.estimateAtSubmit,
    };
  });
}

/** One request with a page of its fans (ordinal order, after `afterOrdinal`). */
export async function historyRequestDocument(
  ctx: HistoryServiceContext,
  request: HistoryRequestRow,
  options: { limit?: number; afterOrdinal?: number | null; states?: readonly HistoryItemState[] } = {},
): Promise<HistoryRequestDocument> {
  const limit = Math.max(1, Math.min(HISTORY_ITEMS_PAGE, options.limit ?? HISTORY_ITEMS_PAGE));
  const rows = await listHistoryItems(ctx.db, {
    requestId: request.id,
    afterOrdinal: options.afterOrdinal ?? null,
    limit: limit + 1,
    ...(options.states === undefined ? {} : { states: options.states }),
  });
  const page = rows.slice(0, limit);
  const [view] = await historyRequestViews(ctx, [request]);
  const inputs = await loadViewInputs(ctx, [request], page);
  const now = inputs.pages.get(request.pageId)?.page?.dbNow ?? new Date();
  return {
    request: view!,
    items: page.map((item) => itemView(item, request.depth, inputs, now)),
    nextAfterOrdinal: rows.length > limit ? page.at(-1)!.ordinal : null,
  };
}

/** `sync history status` / the GET routes: a request by ref (404 unknown). */
export async function getHistoryRequest(
  ctx: HistoryServiceContext,
  ref: string,
  options: { limit?: number; afterOrdinal?: number | null; states?: readonly HistoryItemState[] } = {},
): Promise<HistoryRequestDocument> {
  const request = await getHistoryRequestByRef(ctx.db, ref);
  if (request === null) throw new HistoryRequestError(404, "history_request_not_found", `No history request ${ref}`);
  return historyRequestDocument(ctx, request, options);
}

/** `sync history list` / the list routes: requests newest first. */
export async function listHistoryRequestViews(
  ctx: HistoryServiceContext,
  options: { pageId?: number; state?: HistoryRequestState; limit?: number; offset?: number } = {},
): Promise<HistoryRequestView[]> {
  return historyRequestViews(ctx, await listHistoryRequests(ctx.db, options));
}

/** The open requests of a page for its status (design §3.9 `requests`). */
export async function pageRequestProgress(
  ctx: HistoryServiceContext,
  pageId: number,
): Promise<Array<{ ref: string; itemsReady: number; itemsTotal: number; readsDone: number; readsRemainingMin: number; etaEstimateSeconds: number | null }>> {
  const views = await listHistoryRequestViews(ctx, { pageId, state: "open", limit: 100 });
  return views.map((view) => ({
    ref: view.ref,
    itemsReady: view.counts.ready,
    itemsTotal: view.counts.total,
    readsDone: view.reads.done,
    readsRemainingMin: view.reads.remainingMin,
    etaEstimateSeconds: view.eta.estimateSeconds,
  }));
}
