import {
  applyMessageEventsToArchive,
  CHAT_UNAVAILABLE_REASON,
  claimDmLiveMessagesForConfirm,
  clearConversationSyncHealth,
  closeOpenWork,
  confirmDmLiveMessagesInTransaction,
  deferChatUnavailableLiveMessages,
  dmReaderStoreOf,
  endChatUnavailability,
  getOpenWorkForKey,
  hasUnconfirmedDmLiveChatMessage,
  isDmArchiveScopeFenced,
  latestClosedWorkForKey,
  listDomainEventsByDedupKeys,
  listOpenHistoryItems,
  listPageDmThreadListStates,
  listUnrecordedMediaOrders,
  lockWorkRows,
  openThreadSummary,
  postponeChatUnavailabilityRetry,
  readOpenChatUnavailability,
  readThreadChain,
  readThreadStoredFacts,
  recordChatHeadRefusal,
  resolveWorkDemandMessageIds,
  tryAcquireDmArchiveWriterFenceLock,
  writeThreadChain,
  writeThreadSummary,
  type ChatUnavailabilityEndReason,
  type ChatUnavailabilityEpisode,
  type Database,
  type PageDmThreadListState,
  type SidecarOrderKey,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import {
  FANSLY_MESSAGES_PAGE_LIMIT,
  type FanslyMessage,
  type FanslyMessagesPage,
} from "@agency_hub_core/fansly";
import { compareFanslySnowflakeIds, getFanslyDmMessageSyncExcludedReason } from "@agency_hub_core/shared";

import { familyForObservation } from "../../../services/canonicalize/index.ts";
import type { CanonicalEventDraft } from "../../../services/canonicalize/types.ts";
import { canonicalizeObservationInTransaction } from "../../engine/canonicalize.ts";
import { ApplyDeferred, ApplyQuarantine, FanslyContractViolationError } from "../../engine/commit.ts";
import { BLOCKED_PROBE_EVERY_MS, type OutcomeDecision } from "../../engine/errors.ts";
import {
  WAIT_RECHECK_MS,
  type ApplyInput,
  type ApplyResult,
  type CaptureOutcomeInput,
  type CaptureOutcomeResult,
  type DemandSignal,
  type LocalApplyInput,
  type RequestPlan,
  type ResourceModule,
  type StepPlan,
  type WorkOutcome,
} from "../../engine/resource.ts";
import {
  chainPageNeedsStoredFacts,
  emptyChain,
  foldChainPage,
  sameMessageId,
  snowflakeMs,
  validateChainPage,
  type ChainAnomalyReason,
  type ChainPage,
  type ChainVerdict,
  type Segment,
  type ThreadChain,
} from "../lib/chain.ts";
import { normalizeFanslyDmMessages } from "../lib/dm-normalize.ts";
import { replaceJournalLoneSurrogates } from "../lib/journal-lone-surrogates.ts";
import { readFanslyPageFacts, waitForPageIdentity } from "../lib/page-facts.ts";
import { normalizeFanslyTimestamp } from "../lib/timestamp.ts";
import { materializeFanslyDmTipContexts } from "../lib/tip-contexts.ts";
import { needsHistoryHeadRead } from "../../requests/history-rules.ts";
import { OWN_MASS_MESSAGE_CONTAINER_TYPE } from "../ws/router.ts";
import { purchaseTargetFollowups, purchaseTargetSubject, type PurchaseTarget } from "./purchases.ts";

// `dm-messages.head`, `.catchup`, `.history` (plan §6.2, §7 p.4, §4; design
// §5.4): one `/message?groupId=<g>&limit=25[&before=<id>]` page a step,
// journaled verbatim as `dm_messages` (never CDN-stripped: the AI describer
// downloads from those URLs); the request parameters are coverage evidence
// in `sync_attempts.request` (D1).
//
// - head (urgent; WS `message_created`, the socket-down list, repair): the
//   chat's head, then `before` reads while a staged walk (§8.1: a head page
//   whose every id is above the confirmed head) has not met the chain. A
//   demanded id the walk shows is confirmed; one newer than the vendor's head
//   is retried after 15 s and 60 s, then settled `not_found` (plan §7 p.4).
// - catchup (planned; a list head newer than what the reads reached): the
//   same reads; closed without a request once the chain's head reached its
//   target, and by any `.head` walk that reaches it.
// - history (requests class; only while a history request's fan is attached
//   to it, I12): the head first while an attached fan has no anchor and the
//   walk has not read the head since that fan was filed (§7.1.4), then
//   `before = contiguous_oldest_id` down to the EMPTY page that proves the
//   start (owner decision №3). Every read runs the history hook
//   (`onThreadChainChanged`: anchors, satisfaction, closing the work when no
//   fan is left).
//
// The apply (one transaction, the commit holds the erasure fence): the page
// contract → the chain fold (pure, before any write; an anomaly the design
// sends to review quarantines the step with nothing written) → per-message
// erasure fence → tip contexts → the chain (`writeThreadChain`, the only chain
// writer, I9) and the thread summary opened (the thread row locked, the
// archive's copies of the page noted) → sync health → the overlay rows
// claimed → the inline canonicalization and the archive feed by dedup keys →
// the summary columns from the archive messages the feed stored
// (`writeThreadSummary`, engine-owned pages only) and the overlay confirmed
// against the archive (step 4, S4-08: the page's readers read the archive) →
// the work rows (demand ids resolved, a covered `.catchup` closed). The apply
// writes no `page_dm_messages` row (step 4 S4-13, I23). Excluded and unbound
// threads are never read (decision №8 has its own probe); a page whose thread
// was deleted, unbound or excluded since the plan only canonicalizes its
// observation under the same fence (stamped, so the unfenced minutely sweep
// never appends it) and closes the work.
//
// A live head for a chat with no thread row at all (a fan's first chat the
// legacy engine deferred until its list showed it — the takeover's carried
// confirmations, step 3 import I.3b — or a row gone since the demand) asks
// `dm-conversations.find` for it, as the router does for an unknown chat, but
// only on the socket's evidence of a chat (an unconfirmed overlay row of a
// demanded id, never the page's own mass-message container), at most once
// per head row and for at most `DM_HEAD_FIND_WAIT_MAX_MS`: the find creates
// the thread (list, else group detail, D5) and the head then reads it as any
// other — or, if it finds no direct chat, the head closes `thread_missing`.
//
// A chat Fansly stopped serving to the page (arena "vanished chat", plan §2:
// the chat-unavailability episode, `repositories/sync/chat-unavailability.ts`).
// A head read (no `before`) of any of the three keys that Fansly refuses
// with its own error envelope (`subject_failure` or `envelope_unsuccessful`
// and `fanslyErrorEnvelope`; never a proxy's HTML, an empty 5xx, a 429, a
// 401/403 or the wire) opens or advances the chat's episode in the capture
// transaction (`outcomeInCapture`); the episode's own 5th refusal establishes
// it. Every refusal that leaves it established closes the refused head or
// catch-up work and the chat's other open head and catch-up rows (at the
// revision they were read at, and only those whose next read is the head — a
// staged walk below a head read finishes) `chat_unavailable` with their demand
// unserved,
// defers the chat's unconfirmed socket messages
// (`chat_unavailable`, still shown), sets the retry boundary (the later of
// the refused attempt's breaker and the daily step) and the answered list
// head, and has the history requests refuse the chat's fans that need its
// head (a history walk closes only when no fan is left: an anchored fan keeps
// reading below the chain). No key reads the head of an established chat
// before the boundary (the plan waits: no background probe, owner decision
// Р5) — a new socket message or list head opens work that reads once after
// it; any head read of an established chat that does not end the episode (a
// refusal, a timeout, the wire, another 5xx, a 429, a 401) moves the boundary
// and the answered list head and finishes its work as a refusal does — one
// demand, one read (a timeout counts no refusal). An applied head
// read ends the episode (`read_served`, in the apply's transaction); a plan
// that closes the work of a chat excluded or unbound since ends it too (a
// `local` step, `thread_excluded` / `thread_unbound`). A `before` read neither
// counts nor ends.

export type DmMessagesVariant = "head" | "catchup" | "history";

const HEAD_KEY = "dm-messages.head";
const CATCHUP_KEY = "dm-messages.catchup";
const HISTORY_KEY = "dm-messages.history";
const FIND_KEY = "dm-conversations.find";

const KEY_OF: Readonly<Record<DmMessagesVariant, string>> = {
  head: HEAD_KEY,
  catchup: CATCHUP_KEY,
  history: HISTORY_KEY,
};

const LIMIT = FANSLY_MESSAGES_PAGE_LIMIT;

/** A head for a chat without a thread row waits at most this long for the
 *  `dm-conversations.find` it asked for. */
export const DM_HEAD_FIND_WAIT_MAX_MS = 10 * 60_000;
/** … and looks again this often while that find is open. */
export const DM_HEAD_FIND_RECHECK_MS = 5_000;

/** A demanded id the vendor's head does not show yet is read again after
 *  these delays, then settled `not_found` (plan §7 p.4: 15 s, 60 s). */
export const DM_HEAD_NOT_FOUND_RETRY_MS: readonly number[] = [15_000, 60_000];

/** Chain anomalies the design sends to review (§8.1): the step is quarantined
 *  with its raw page kept and nothing folded or written. `head_regressed`
 *  is not among them: the newest messages vanished (a deletion), the messages
 *  still apply and the chain stays as it is. */
const QUARANTINED_ANOMALIES: ReadonlySet<ChainAnomalyReason> = new Set([
  "empty_head_with_chain",
  "empty_head_with_stored",
  "old_chain_vanished_with_stored",
  "messages_below_proven_end",
]);

/** Verdicts whose fold moved the chain (written by `writeThreadChain`). */
const CHAIN_WRITING_VERDICTS: ReadonlySet<ChainVerdict["kind"]> = new Set([
  "started",
  "head_unchanged",
  "joined",
  "extended_down",
  "completed",
]);

const DECIMAL_ID = /^[0-9]{1,30}$/;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function decimalId(value: unknown): string | null {
  return typeof value === "string" && DECIMAL_ID.test(value) ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Snowflake order; ids that are not plain decimals never compare above. */
function above(left: string, right: string): boolean {
  return compareFanslySnowflakeIds(left, right) === 1;
}

function atMost(left: string, right: string): boolean {
  const order = compareFanslySnowflakeIds(left, right);
  return order === -1 || order === 0;
}

function maxId(ids: readonly string[]): string | null {
  let best: string | null = null;
  for (const id of ids) {
    if (!DECIMAL_ID.test(id)) continue;
    if (best === null || above(id, best)) best = id;
  }
  return best;
}

function bump(counters: Record<string, number>, name: string, by = 1): void {
  if (by > 0) counters[name] = (counters[name] ?? 0) + by;
}

function messagesRequest(groupId: string, before: string | null): RequestPlan<"messages.page"> {
  return { spec: "messages.page", params: { groupId, before } };
}

function requestedParams(request: RequestPlan): { groupId: string | null; before: string | null } {
  const params = recordOf(request.params);
  return {
    groupId: typeof params.groupId === "string" ? params.groupId : null,
    before: typeof params.before === "string" ? params.before : null,
  };
}

// ── cursor ──────────────────────────────────────────────────────────────────

export interface DmMessagesCursor {
  /** A staged head walk (§8.1) read down until it meets the chain. */
  segment: Segment | null;
  /** Pages the current walk has read (a walk: from a head read to its end). */
  walkPages: number;
  /** Demanded ids a finished walk did not show yet: misses so far. */
  misses: Record<string, number>;
  /** The receipt of the last finished walk. */
  last: Record<string, unknown> | null;
  /** `.history`: capture time of the walk's latest head read (a fan filed
   *  earlier is anchored by it; a newer one needs another, §7.1.4). */
  historyHeadAt: Date | null;
}

function parseSegment(value: unknown): Segment | null {
  const record = recordOf(value);
  const headId = decimalId(record.headId);
  const oldestId = decimalId(record.oldestId);
  const headAt = typeof record.headAt === "string" ? new Date(record.headAt) : null;
  const segmentCount = count(record.count);
  const baseHeadId = record.baseHeadId === null ? null : decimalId(record.baseHeadId);
  if (headId === null || oldestId === null || headAt === null || Number.isNaN(headAt.getTime()) || segmentCount === null) {
    return null;
  }
  if (record.baseHeadId !== null && baseHeadId === null) return null;
  const oldestCreatedAtMs = typeof record.oldestCreatedAtMs === "number" && Number.isFinite(record.oldestCreatedAtMs)
    ? record.oldestCreatedAtMs
    : null;
  return { baseHeadId, headId, headAt, oldestId, oldestCreatedAtMs, count: segmentCount };
}

function segmentJson(segment: Segment | null): Record<string, unknown> | null {
  return segment === null ? null : { ...segment, headAt: segment.headAt.toISOString() };
}

export function parseDmMessagesCursor(value: unknown): DmMessagesCursor {
  const record = recordOf(value);
  const misses: Record<string, number> = {};
  for (const [id, n] of Object.entries(recordOf(record.misses))) {
    const misses_ = count(n);
    if (DECIMAL_ID.test(id) && misses_ !== null && misses_ > 0) misses[id] = misses_;
  }
  const historyHeadAt = typeof record.historyHeadAt === "string" ? new Date(record.historyHeadAt) : null;
  return {
    segment: parseSegment(record.segment),
    walkPages: count(record.walkPages) ?? 0,
    misses,
    last: typeof record.last === "object" && record.last !== null && !Array.isArray(record.last)
      ? record.last as Record<string, unknown>
      : null,
    historyHeadAt: historyHeadAt === null || Number.isNaN(historyHeadAt.getTime()) ? null : historyHeadAt,
  };
}

function cursorJson(cursor: DmMessagesCursor): Record<string, unknown> {
  return {
    segment: segmentJson(cursor.segment),
    walkPages: cursor.walkPages,
    misses: cursor.misses,
    last: cursor.last,
    historyHeadAt: cursor.historyHeadAt === null ? null : cursor.historyHeadAt.toISOString(),
  };
}

/** The staged walk still continues the chain (its base is the chain's head). */
function liveSegment(segment: Segment | null, chain: ThreadChain): Segment | null {
  return segment !== null && sameMessageId(segment.baseHeadId, chain.headId) ? segment : null;
}

// ── the thread ──────────────────────────────────────────────────────────────

interface DmThread {
  state: PageDmThreadListState;
  chain: ThreadChain;
}

async function readThread(db: Database, pageId: number, groupId: string): Promise<DmThread | null> {
  const [state] = await listPageDmThreadListStates(db, { platformAccountId: pageId, platformConversationIds: [groupId] });
  if (state === undefined) return null;
  const chain = await readThreadChain(db, state.id);
  return { state, chain: chain?.chain ?? emptyChain() };
}

type ThreadSkip = "thread_missing" | "unbound" | "excluded";

/** Threads the engine never reads (design §5.4): gone, unbound, excluded. */
function threadSkip(thread: DmThread | null): ThreadSkip | null {
  if (thread === null) return "thread_missing";
  if (getFanslyDmMessageSyncExcludedReason(thread.state.metadata) !== null) return "excluded";
  if (thread.state.fanId === null) return "unbound";
  return null;
}

// ── plan ────────────────────────────────────────────────────────────────────

/** Every demanded id is at or below the confirmed head: a read would add
 *  nothing (an overflowed list may hide newer ids). */
function demandWithinChain(demand: SyncWorkRow["demand"], chain: ThreadChain): boolean {
  if (demand.overflow || demand.messageIds.length === 0 || chain.headId === null) return false;
  return demand.messageIds.every((id) => atMost(id, chain.headId!));
}

/**
 * A live head whose chat has no thread row (see the header): the socket's
 * evidence of a chat asks `dm-conversations.find` once and waits for it; the
 * head re-plans when the find is done (the thread exists: read it; it does
 * not: `thread_missing`). Without that evidence, after a find that ran since
 * the head was created, behind a quarantined find, or past
 * `DM_HEAD_FIND_WAIT_MAX_MS`, the head closes `thread_missing` — it never
 * asks twice, and never reads a chat the find did not create.
 */
async function planChatFind(work: SyncWorkRow, ctx: { db: Database; pageId: number; now: Date }): Promise<StepPlan> {
  const groupId = work.subject;
  const missing: StepPlan = { kind: "done", reason: "thread_missing" };
  if (ctx.now.getTime() - work.createdAt.getTime() >= DM_HEAD_FIND_WAIT_MAX_MS) return missing;
  const evidence = await hasUnconfirmedDmLiveChatMessage(ctx.db, {
    pageId: ctx.pageId,
    groupId,
    messageIds: work.demand.messageIds,
    ownContainerType: OWN_MASS_MESSAGE_CONTAINER_TYPE,
  });
  if (!evidence) return missing;
  const recheck = new Date(ctx.now.getTime() + DM_HEAD_FIND_RECHECK_MS);
  const open = await getOpenWorkForKey(ctx.db, { pageId: ctx.pageId, resource: FIND_KEY, subject: groupId });
  if (open !== null) return open.state === "quarantined" ? missing : { kind: "wait", reason: "dependency", until: recheck };
  const ran = await latestClosedWorkForKey(ctx.db, {
    pageId: ctx.pageId, resource: FIND_KEY, subject: groupId, closedAfter: work.createdAt,
  });
  if (ran !== null) return missing;
  return {
    kind: "wait",
    reason: "dependency",
    until: recheck,
    enqueue: [{ resource: FIND_KEY, subject: groupId, demand: { reason: `dependency:${HEAD_KEY}` } }],
  };
}

/** The chat's open unavailability episode, or null (plain read). */
async function openEpisodeOf(db: Database, pageId: number, groupId: string): Promise<ChatUnavailabilityEpisode | null> {
  return (await readOpenChatUnavailability(db, { pageId, groupIds: [groupId] })).get(groupId) ?? null;
}

async function planStep(variant: DmMessagesVariant, work: SyncWorkRow, ctx: {
  db: Database; pageId: number; now: Date;
}): Promise<StepPlan> {
  const groupId = work.subject;
  if (!DECIMAL_ID.test(groupId)) return { kind: "quarantine", reason: "dm_messages_subject_invalid" };
  const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
  if (facts === null) return { kind: "quarantine", reason: "page_missing" };
  if (facts.externalId === null) return waitForPageIdentity(KEY_OF[variant]);
  const thread = await readThread(ctx.db, ctx.pageId, groupId);
  if (thread === null && variant === "head") return planChatFind(work, ctx);
  const skip = threadSkip(thread);
  if (skip !== null || thread === null) {
    // The chat is no longer read: its open unavailability episode ends with
    // the work (a local step — the actor writes the episode, never a plan).
    if (thread !== null && skip !== null && (await openEpisodeOf(ctx.db, ctx.pageId, groupId)) !== null) {
      return { kind: "local", reason: skip };
    }
    return { kind: "done", reason: skip ?? "thread_missing" };
  }
  const plan = await planThreadRead(variant, work, thread, ctx);
  // A head read of a chat Fansly refuses to the page (an established episode,
  // plan §2.3, owner decision Р5): each row decides for itself, no other
  // row's capture closes it. A history walk never reads the head of such a
  // chat: a local step refuses its fans that need the head (its continuation
  // below the chain reads on). A head or catch-up row whose demand the
  // episode already answered closes itself without a request (a local step);
  // one with a newer demand waits for the episode's retry boundary (no second
  // timer) and then reads once.
  if (plan.kind !== "request" || requestedParams(plan.request).before !== null) return plan;
  const episode = await openEpisodeOf(ctx.db, ctx.pageId, groupId);
  if (episode?.state !== "established") return plan;
  if (variant === "history" || demandAnswered(work.demand, episode.handledListHeadId)) {
    return { kind: "local", reason: CHAT_UNAVAILABLE_REASON };
  }
  if (episode.retryNotBefore !== null && episode.retryNotBefore.getTime() > ctx.now.getTime()) {
    return { kind: "wait", reason: "not_due", until: episode.retryNotBefore };
  }
  return plan;
}

/**
 * The demand reasons whose messages the demand names by id: the socket's
 * message frames (`ws:message_created`, `ws:message_created:own`), the list's
 * heads (`list_head:<key>`: the lists, `.ws-down`, the repair, `.find`) and
 * the takeover's carried confirmations (`takeover_unconfirmed`). Any other
 * reason — `ws:message_invalid_known_chat` (a broken frame of a known chat:
 * a message the socket could not name), or one this rule does not know — may
 * stand for a message no id names.
 */
const ID_NAMED_DEMAND_REASONS: ReadonlySet<string> = new Set(["ws:message_created", "ws:message_created:own", "takeover_unconfirmed"]);

function idNamedReason(reason: string): boolean {
  return ID_NAMED_DEMAND_REASONS.has(reason) || reason.startsWith("list_head:");
}

/**
 * A demand an established episode already answered — its row closes itself
 * without a request: every message id it carries is at or below the
 * episode's answered head (`handled_list_head_id` — the newest id a failed
 * head read of the chat covered: the list's head or an id of the demand it
 * was admitted with, created before that read was sent), its id list did not
 * overflow, and every reason of it names its messages by those ids
 * (`ID_NAMED_DEMAND_REASONS`). A newer id, an overflow, or a reason that may
 * stand for an unnamed message (a broken socket frame) is a new demand: one
 * read after the boundary, after which the row closes by its revision.
 */
export function demandAnswered(demand: SyncWorkRow["demand"], handledListHeadId: string | null): boolean {
  if (demand.overflow) return false;
  if (!demand.reasons.every(idNamedReason)) return false;
  return demand.messageIds.every((id) => handledListHeadId !== null && atMost(id, handledListHeadId));
}

async function planThreadRead(variant: DmMessagesVariant, work: SyncWorkRow, thread: DmThread, ctx: {
  db: Database; pageId: number; now: Date;
}): Promise<StepPlan> {
  const groupId = work.subject;
  const cursor = parseDmMessagesCursor(work.cursor);
  const segment = liveSegment(cursor.segment, thread.chain);
  switch (variant) {
    case "head":
      if (segment === null && demandWithinChain(work.demand, thread.chain)) return { kind: "done", reason: "already_confirmed" };
      return { kind: "request", request: messagesRequest(groupId, segment?.oldestId ?? null) };
    case "catchup":
      // Any read that reached the target covered it (design §5.4).
      if (segment === null && demandWithinChain(work.demand, thread.chain)) return { kind: "done", reason: "covered" };
      return { kind: "request", request: messagesRequest(groupId, segment?.oldestId ?? null) };
    case "history": {
      if (thread.chain.state === "complete") return { kind: "done", reason: "history_complete" };
      // No history walk without a request (I12): the fans attached to this
      // chat's work are what it reads for.
      const fans = await listOpenHistoryItems(ctx.db, { workId: work.id });
      if (fans.length === 0) return { kind: "done", reason: "no_open_items" };
      if (segment !== null) return { kind: "request", request: messagesRequest(groupId, segment.oldestId) };
      if (thread.chain.state !== "partial" || needsHistoryHeadRead(fans, cursor.historyHeadAt)) {
        return { kind: "request", request: messagesRequest(groupId, null) };
      }
      return { kind: "request", request: messagesRequest(groupId, thread.chain.oldestId) };
    }
  }
}

// ── demand ──────────────────────────────────────────────────────────────────

export interface DemandResolutionInput {
  variant: DmMessagesVariant;
  /** `demand.messageIds` of the work row now. */
  demandIds: readonly string[];
  /** This page's ids. */
  pageIds: readonly string[];
  /** The walk ended with this page (no staged segment, no re-read). */
  walkDone: boolean;
  /** The newest id the walk's head read showed (null: an empty head). */
  restHeadId: string | null;
  /** The chain after the fold. */
  chain: ThreadChain;
  misses: Readonly<Record<string, number>>;
  /** The read's send instant (an id created later cannot be on its page). */
  sentAtMs: number | null;
}

export interface DemandResolution {
  /** Shown by this page: confirmed against what the apply wrote. */
  found: string[];
  /** Within the confirmed chain yet never shown (deleted, or never there):
   *  `not_found` unless a stored copy exists. */
  covered: string[];
  /** Missed after every retry: `not_found`. */
  expired: string[];
  /** Below what the chain proves, or not the confirmation's business
   *  (a list target): no verdict here — the passive parity pass decides. */
  dropped: string[];
  /** Still awaited (the walk goes on, or the vendor's head is behind). */
  pending: string[];
  /** The pending ids created after the read was sent: newer demand than the
   *  read served (its revision is satisfied without them, I11). */
  late: string[];
  misses: Record<string, number>;
  /** When the vendor's head is read again for the pending ids; null when
   *  nothing waits on it. */
  retryInMs: number | null;
}

/**
 * What one read did for the ids the work was demanded for (design §5.4 step
 * 10, plan §7 p.4). While a walk goes on, only the ids it showed resolve.
 * When it ends: a `.head` id newer than the vendor's head waits for the next
 * read (15 s, then 60 s, then `not_found`; an id created after the read was
 * sent is not a miss); one inside the confirmed chain that no page showed is
 * covered; one below the chain is left to the passive pass. A `.catchup` or
 * `.history` read resolves its ids when its walk ends.
 */
export function resolveDemand(input: DemandResolutionInput): DemandResolution {
  const onPage = new Set(input.pageIds);
  const resolution: DemandResolution = {
    found: [], covered: [], expired: [], dropped: [], pending: [], late: [], misses: {}, retryInMs: null,
  };
  const head = input.chain.headId;
  const oldest = input.chain.oldestId;
  for (const id of new Set(input.demandIds)) {
    if (onPage.has(id)) {
      resolution.found.push(id);
      continue;
    }
    if (!input.walkDone) {
      resolution.pending.push(id);
      if (input.misses[id] !== undefined) resolution.misses[id] = input.misses[id]!;
      continue;
    }
    if (input.variant !== "head") {
      resolution.dropped.push(id);
      continue;
    }
    if (input.restHeadId === null || above(id, input.restHeadId)) {
      const createdMs = snowflakeMs(id);
      const lateSignal = createdMs !== null && input.sentAtMs !== null && createdMs > input.sentAtMs;
      const misses = (input.misses[id] ?? 0) + (lateSignal ? 0 : 1);
      if (misses > DM_HEAD_NOT_FOUND_RETRY_MS.length) {
        resolution.expired.push(id);
      } else {
        resolution.pending.push(id);
        if (lateSignal) resolution.late.push(id);
        if (misses > 0) resolution.misses[id] = misses;
      }
      continue;
    }
    if (head !== null && oldest !== null && atMost(id, head) && atMost(oldest, id)) {
      resolution.covered.push(id);
      continue;
    }
    resolution.dropped.push(id);
  }
  if (resolution.pending.length > 0 && input.walkDone) {
    const missed = resolution.pending.map((id) => resolution.misses[id] ?? 0).filter((n) => n > 0);
    const step = missed.length === 0 ? 0 : Math.min(...missed) - 1;
    resolution.retryInMs = DM_HEAD_NOT_FOUND_RETRY_MS[Math.max(0, step)]!;
  }
  return resolution;
}

// ── erasure fence (design §5.4 step 1) ──────────────────────────────────────

interface FenceCheck {
  /** Messages an executed erasure covers: dropped from every write. */
  fencedIds: Set<string>;
  /** The page-wide check found nothing: no ref of `checkedRefs` is fenced for
   *  material at or after `checkedFrom`. */
  clear: boolean;
  checkedRefs: ReadonlySet<string>;
  checkedFrom: Date;
}

function messageMaterialAt(message: FanslyMessage, receivedAt: Date): Date {
  const raw = message.createdAt as unknown;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return receivedAt;
  const at = normalizeFanslyTimestamp(raw);
  return at.getTime() < receivedAt.getTime() ? at : receivedAt;
}

async function checkFence(
  tx: Database,
  input: { pageId: number; groupId: string; partnerId: string | null; messages: readonly FanslyMessage[]; receivedAt: Date },
): Promise<FenceCheck> {
  const refsOf = (message: FanslyMessage) => [input.groupId, message.senderId];
  const allRefs = [input.groupId, input.partnerId, ...input.messages.map((message) => message.senderId)];
  const earliest = input.messages.reduce(
    (min, message) => {
      const at = messageMaterialAt(message, input.receivedAt);
      return at.getTime() < min.getTime() ? at : min;
    },
    input.receivedAt,
  );
  // One query in the common case: nothing covers the page at its earliest
  // material instant, so nothing covers any later one either.
  const checkedRefs = new Set(allRefs.filter((ref): ref is string => typeof ref === "string" && ref.length > 0));
  if (!(await isDmArchiveScopeFenced(tx, { pageId: input.pageId, platform: "fansly", refs: allRefs, materialAt: earliest }))) {
    return { fencedIds: new Set(), clear: true, checkedRefs, checkedFrom: earliest };
  }
  const fencedIds = new Set<string>();
  for (const message of input.messages) {
    const fenced = await isDmArchiveScopeFenced(tx, {
      pageId: input.pageId,
      platform: "fansly",
      refs: refsOf(message),
      materialAt: messageMaterialAt(message, input.receivedAt),
    });
    if (fenced) fencedIds.add(message.id);
  }
  return { fencedIds, clear: false, checkedRefs, checkedFrom: earliest };
}

// ── purchases (design §5.4 step 5) ──────────────────────────────────────────

/** The order sidecars of a page (`accountMediaOrders`) as media-plane keys
 *  and the target each one names. */
function sidecarOrders(page: FanslyMessagesPage, receivedAt: Date): Array<{ key: SidecarOrderKey; target: PurchaseTarget }> {
  const orders: Array<{ key: SidecarOrderKey; target: PurchaseTarget }> = [];
  for (const order of page.accountMediaOrders ?? []) {
    const record = recordOf(order);
    const bundleId = decimalId(record.accountMediaBundleId);
    const mediaId = decimalId(record.accountMediaId);
    const buyer = typeof record.accountId === "string" && record.accountId.length > 0 ? record.accountId : null;
    const raw = record.createdAt;
    if (buyer === null || (bundleId === null && mediaId === null)) continue;
    const orderedAt = typeof raw === "number" && Number.isFinite(raw) ? normalizeFanslyTimestamp(raw) : receivedAt;
    orders.push({
      key: { mediaOfferRef: (bundleId ?? mediaId)!, buyerPlatformUserId: buyer, orderedAt },
      target: bundleId !== null ? { kind: "bundle", id: bundleId } : { kind: "media", id: mediaId! },
    });
  }
  return orders;
}

/**
 * The purchase walks a page asks for: the targets of the order sidecars the
 * media plane has not recorded yet (an order already in `media_orders` was
 * seen before; re-signalling it on every read of the chat would re-read its
 * history each time). One `purchases.targets` walk per target, subject
 * `media:<id>` | `bundle:<id>` (S2-07b).
 */
async function purchaseFollowups(
  tx: Database,
  input: { pageId: number; page: FanslyMessagesPage; receivedAt: Date; reason: string },
): Promise<DemandSignal[]> {
  const orders = sidecarOrders(input.page, input.receivedAt);
  if (orders.length === 0) return [];
  const unrecorded = await listUnrecordedMediaOrders(tx, { pageId: input.pageId, orders: orders.map((order) => order.key) });
  const targets = new Map<string, PurchaseTarget>();
  for (const index of unrecorded) {
    const target = orders[index]!.target;
    targets.set(purchaseTargetSubject(target), target);
  }
  const sorted = [...targets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, target]) => target);
  return purchaseTargetFollowups(sorted, input.reason);
}

// ── apply ───────────────────────────────────────────────────────────────────

function chainPageOf(messages: readonly FanslyMessage[], before: string | null, input: ApplyInput): ChainPage {
  return {
    before,
    limit: LIMIT,
    // A non-string id fails the contract as `bad_id` (never coerced).
    ids: messages.map((message) => (typeof message.id === "string" ? message.id : "")),
    createdAtMs: messages.map((message) => {
      const raw = message.createdAt as unknown;
      return typeof raw === "number" && Number.isFinite(raw) ? normalizeFanslyTimestamp(raw).getTime() : null;
    }),
    capturedAt: input.observation.receivedAt,
    witness: {
      kind: "attempt",
      attemptId: input.attempt.id,
      observationId: input.observation.id,
      receivedAt: input.observation.receivedAt,
    },
  };
}

/** The walk this page belongs to goes on (another read follows now). */
function walkContinues(variant: DmMessagesVariant, verdict: ChainVerdict, segment: Segment | null, chain: ThreadChain): boolean {
  if (segment !== null) return true;
  if (verdict.kind === "segment_stale" || verdict.kind === "not_continuing") return true;
  return variant === "history" && chain.state !== "complete";
}

const DM_SYNC_FAMILY = familyForObservation({ source: "pull", kind: "dm_messages", platform: "fansly" });

async function applyMessagesPage(variant: DmMessagesVariant, tx: Database, input: ApplyInput): Promise<ApplyResult> {
  const key = KEY_OF[variant];
  const groupId = input.work.subject;
  const requested = requestedParams(input.request);
  if (requested.groupId !== groupId) {
    throw new ApplyQuarantine("dm_messages_subject_mismatch", { subject: groupId, requested: requested.groupId });
  }
  const before = requested.before;
  // The registry's fence is `dm_archive`: the commit took it. A direct caller
  // takes it here (a busy fence defers the apply).
  if (!input.fenced && !(await tryAcquireDmArchiveWriterFenceLock(tx, input.pageId))) throw new ApplyDeferred("erasure_busy");

  const facts = await readFanslyPageFacts(tx, input.pageId);
  if (facts === null) throw new ApplyQuarantine("page_missing");
  if (facts.externalId === null) throw new ApplyQuarantine("page_account_unknown");
  const page = input.parsed as FanslyMessagesPage;
  const messages = page.messages;
  // The wire contract checks the container only (per-message drift is the
  // lane's): an item that is not an object breaks the page contract here.
  const notObject = messages.findIndex((message) => typeof message !== "object" || message === null || Array.isArray(message));
  if (notObject !== -1) throw new FanslyContractViolationError(`messages[${notObject}]`, "not an object");
  const foreign = messages.filter((message) => typeof message.groupId === "string" && message.groupId !== groupId).length;
  if (foreign > 0) throw new ApplyQuarantine("dm_messages_foreign_group", { groupId, foreign });
  const thread = await readThread(tx, input.pageId, groupId);
  const skip = threadSkip(thread);
  if (skip !== null || thread === null) {
    return applySkippedThread(tx, input, {
      key,
      groupId,
      skip: skip ?? "thread_missing",
      partnerId: thread?.state.partnerPlatformUserId ?? null,
      ownRef: facts.externalId,
      messages,
      threadId: thread?.state.id ?? null,
    });
  }

  // 1. The page contract and the fold — pure, before anything is written.
  const chainPage = chainPageOf(messages, before, input);
  const violation = validateChainPage(chainPage);
  if (violation !== null && violation.kind === "contract_violation") {
    throw new FanslyContractViolationError(`messages.${violation.reason}`, `group ${groupId} before ${before ?? "head"}`);
  }
  const cursor = parseDmMessagesCursor(input.work.cursor);
  const stored = chainPageNeedsStoredFacts(chainPage)
    ? await readThreadStoredFacts(tx, thread.state.id, { store: dmReaderStoreOf(input.page.mode) })
    : null;
  const fold = foldChainPage(thread.chain, cursor.segment, chainPage, stored);
  if (fold.verdict.kind === "anomaly" && QUARANTINED_ANOMALIES.has(fold.verdict.reason)) {
    throw new ApplyQuarantine(`chain_${fold.verdict.reason}`, {
      groupId, before, served: messages.length, headId: thread.chain.headId, state: thread.chain.state,
    });
  }
  const counters: Record<string, number> = { messages_served: messages.length };
  bump(counters, `chain_${fold.verdict.kind}`);
  if (fold.verdict.kind === "anomaly") bump(counters, `chain_anomaly_${fold.verdict.reason}`);
  for (const reported of fold.reported) {
    bump(counters, reported.kind === "anomaly" ? `chain_anomaly_${reported.reason}` : `chain_${reported.kind}`);
  }

  // 2. Erasure fence per message: a fenced row reaches no write below.
  const fence = await checkFence(tx, {
    pageId: input.pageId,
    groupId,
    partnerId: thread.state.partnerPlatformUserId,
    messages,
    receivedAt: input.observation.receivedAt,
  });
  bump(counters, "messages_fenced", fence.fencedIds.size);
  const kept = fence.fencedIds.size === 0 ? messages : messages.filter((message) => !fence.fencedIds.has(message.id));

  // 3. The tip contexts. The page's messages go to `message_archive` (step 7);
  //    `page_dm_messages` is not written (step 4 S4-13, I23): a live page's
  //    readers read the archive, and the hot rows legacy stored stay as they
  //    were (deletion marks only, `dm-live.deletions`). The normalized rows
  //    are the page's storable messages, whose overlay rows are judged below.
  const normalized = normalizeFanslyDmMessages(kept, {
    conversationId: thread.state.id,
    platformAccountId: input.pageId,
    platform: "fansly",
    pageAccountId: facts.externalId,
    partnerPlatformUserId: thread.state.partnerPlatformUserId,
    now: input.now,
  });
  bump(counters, "messages_unparseable", normalized.unparseable.length);
  bump(counters, "timestamps_implausible", normalized.implausible.length);
  const tips = await materializeFanslyDmTipContexts(tx, {
    accountId: input.pageId,
    requestParams: { groupId, limit: LIMIT, before },
    responsePayload: input.response,
    capturedAt: input.observation.receivedAt,
    lineage: {
      kind: "observation",
      sourceObservationId: input.observation.id,
      sourceObservationReceivedAt: input.observation.receivedAt,
    },
  });
  bump(counters, "tip_contexts_upserted", tips.upserted);

  // 4. The chain (its one writer); the summary opened before the archive
  //    feed (lock order: the thread before domain_event_seq).
  const chainMoved = CHAIN_WRITING_VERDICTS.has(fold.verdict.kind);
  if (chainMoved) await writeThreadChain(tx, thread.state.id, { chain: fold.chain, source: "engine" });
  const summary = await openThreadSummary(tx, thread.state.id, chainPage.ids);
  await clearConversationSyncHealth(tx, thread.state.id);
  // A head the page was served ends the chat's unavailability episode (plan
  // §2.2), whichever key read it; a deeper page does not (the episode is
  // about the head). Before the overlay rows (lock order: episode → overlay).
  if (before === null && await endChatUnavailability(tx, { threadId: thread.state.id, reason: "read_served", at: input.now }) !== null) {
    bump(counters, "chat_unavailability_ended");
  }

  // 5. The demanded ids and the overlay (before the event appends, §3.7).
  const done = !walkContinues(variant, fold.verdict, fold.segment, fold.chain);
  const restHeadId = before === null
    ? chainPage.ids[0] ?? null
    : cursor.segment !== null && sameMessageId(before, cursor.segment.oldestId) ? cursor.segment.headId : thread.chain.headId;
  const storable = new Set(normalized.rows.map((row) => row.platformMessageId));
  const resolution = resolveDemand({
    variant,
    demandIds: input.work.demand.messageIds,
    // Shown is confirmed visible, also when the message stays unstored
    // (fenced, no date): only the overlay verdict below needs the stored copy.
    pageIds: chainPage.ids,
    walkDone: done,
    restHeadId,
    chain: fold.chain,
    misses: cursor.misses,
    sentAtMs: input.attempt.sentAt?.getTime() ?? null,
  });
  // The overlay rows are locked here (before the appends, lock order) and
  // judged against the archive once the feed below wrote it.
  const claim = await claimDmLiveMessagesForConfirm(tx, {
    pageId: input.pageId,
    // Every message of the page that can be stored (unfenced, dated): a read
    // confirms what it shows, demanded or not (an own broadcast's row is
    // confirmed by any read of its chat, D22).
    messageIds: [...storable],
    notFoundMessageIds: [...resolution.covered, ...resolution.expired],
  });
  bump(counters, "demand_dropped", resolution.dropped.length);

  // 6. Purchase walks of new order sidecars.
  const followups = await purchaseFollowups(tx, {
    pageId: input.pageId,
    page,
    receivedAt: input.observation.receivedAt,
    reason: `apply:${key}`,
  });
  bump(counters, "followup_purchase_targets", followups.length);

  // 7. The inline canonicalization (family pull/sync) and the archive feed:
  //    REST confirmation reaches message_archive in this commit even when the
  //    minutely driver appended the events first (dedup keys, §3.7.3).
  await canonicalizeAndFeedArchive(tx, {
    pageId: input.pageId,
    ownRef: facts.externalId,
    key,
    observation: input.observation,
    response: input.response,
    fence,
    now: input.now,
    counters,
  });

  // 8. What the archive now holds: the summary columns (engine-owned pages
  //    only, I9) and the overlay verdicts.
  const summarized = await writeThreadSummary(tx, summary, {
    headReadAt: before === null ? input.attempt.sentAt ?? input.observation.receivedAt : null,
  });
  bump(counters, "summary_stored", summarized.added);
  const overlay = await confirmDmLiveMessagesInTransaction(tx, claim);
  bump(counters, "live_confirm_match", overlay.match);
  bump(counters, "live_confirm_mismatch", overlay.mismatch);
  bump(counters, "live_not_found", overlay.notFound);
  for (const [field, n] of Object.entries(overlay.mismatchFields)) bump(counters, `live_mismatch_${field}`, n);

  // 9. The work rows, after every append (lock order): resolved ids leave
  //    the demand; a `.catchup` the walk reached is closed.
  const resolvedIds = [...resolution.found, ...resolution.covered, ...resolution.expired, ...resolution.dropped];
  const catchup = variant === "head" && done && fold.chain.headId !== null
    ? await getOpenWorkForKey(tx, { pageId: input.pageId, resource: CATCHUP_KEY, subject: groupId })
    : null;
  const closeCatchup = catchup !== null && catchup.state === "open" && catchupReachedBy(catchup, fold.chain);
  if (resolvedIds.length > 0 || closeCatchup) {
    await lockWorkRows(tx, closeCatchup ? [input.work.id, catchup!.id] : [input.work.id]);
    if (resolvedIds.length > 0) {
      await resolveWorkDemandMessageIds(tx, { workId: input.work.id, generation: input.attempt.ownerGeneration, messageIds: resolvedIds });
    }
    if (closeCatchup && await closeOpenWork(tx, { workId: catchup!.id, generation: input.attempt.ownerGeneration, closeReason: "covered_by_head" })) {
      bump(counters, "catchup_closed_by_head");
    }
  }

  const next: DmMessagesCursor = {
    segment: fold.segment,
    walkPages: done ? 0 : cursor.walkPages + 1,
    misses: resolution.misses,
    historyHeadAt: variant === "history" && before === null ? input.observation.receivedAt : cursor.historyHeadAt,
    last: done
      ? {
        completedAt: input.now.toISOString(),
        pages: cursor.walkPages + 1,
        verdict: fold.verdict.kind,
        headId: fold.chain.headId,
        state: fold.chain.state,
      }
      : cursor.last,
  };
  return {
    work: workOutcome(variant, { done, resolution, chain: fold.chain, cursor: next, now: input.now }),
    followups,
    counters,
    canonicalized: true,
    // Every history read runs the request hook (anchors after a head read
    // that moved nothing, satisfaction, the work's close); other reads only
    // when the chain moved.
    ...(chainMoved || variant === "history" ? { threadChainChanged: { threadId: thread.state.id } } : {}),
  };
}

/**
 * The thread was deleted, unbound or excluded between the plan and this
 * apply: nothing of the page reaches the chain, the summary or the overlay,
 * and the work is over. The observation is still settled here, under
 * the same per-message erasure fence (§5.4 step 1): its unfenced events are
 * appended and archived and the row is stamped. Left unstamped, the minutely
 * sweep would append every event of it with no fence, and an erasure (which
 * deletes the fan's threads) is one reason the thread is gone.
 */
async function applySkippedThread(tx: Database, input: ApplyInput, skipped: {
  key: string;
  groupId: string;
  skip: ThreadSkip;
  partnerId: string | null;
  ownRef: string;
  messages: readonly FanslyMessage[];
  threadId: number | null;
}): Promise<ApplyResult> {
  const counters: Record<string, number> = { [`skipped_${skipped.skip}`]: 1 };
  // The chat is no longer read: its unavailability episode ends here.
  const endReason = episodeEndOf(skipped.skip);
  if (skipped.threadId !== null && endReason !== null
    && await endChatUnavailability(tx, { threadId: skipped.threadId, reason: endReason, at: input.now }) !== null) {
    bump(counters, "chat_unavailability_ended");
  }
  const fence = await checkFence(tx, {
    pageId: input.pageId,
    groupId: skipped.groupId,
    partnerId: skipped.partnerId,
    messages: skipped.messages,
    receivedAt: input.observation.receivedAt,
  });
  bump(counters, "messages_fenced", fence.fencedIds.size);
  await canonicalizeAndFeedArchive(tx, {
    pageId: input.pageId,
    ownRef: skipped.ownRef,
    key: skipped.key,
    observation: input.observation,
    response: input.response,
    fence,
    now: input.now,
    counters,
  });
  return {
    work: { satisfiesRevision: true, close: "done", closeReason: skipped.skip },
    followups: [],
    counters,
    canonicalized: true,
  };
}

function catchupReachedBy(catchup: SyncWorkRow, chain: ThreadChain): boolean {
  if (catchup.demand.overflow) return false;
  const target = maxId(catchup.demand.messageIds);
  return target === null || (chain.headId !== null && atMost(target, chain.headId));
}

function workOutcome(variant: DmMessagesVariant, input: {
  done: boolean; resolution: DemandResolution; chain: ThreadChain; cursor: DmMessagesCursor; now: Date;
}): WorkOutcome<Record<string, unknown>> {
  const cursor = cursorJson(input.cursor);
  if (!input.done) return { satisfiesRevision: false, nextDueAt: input.now, cursor };
  const proof = {
    state: input.chain.state,
    headId: input.chain.headId,
    oldestId: input.chain.oldestId,
    count: input.chain.count,
    proof: input.chain.proof,
  };
  if (variant === "head" && input.resolution.pending.length > 0) {
    const late = new Set(input.resolution.late);
    if (input.resolution.pending.every((id) => late.has(id))) {
      // Only messages created after the read was sent wait: the read did
      // everything its revision asked (I11); their own, newer revision keeps
      // the row open and decides when it runs.
      return {
        satisfiesRevision: true,
        nextDueAt: new Date(input.now.getTime() + DM_HEAD_NOT_FOUND_RETRY_MS[0]!),
        cursor,
        proof,
      };
    }
    // The vendor's head is behind the socket: read it again (plan §7 p.4).
    return {
      satisfiesRevision: false,
      nextDueAt: new Date(input.now.getTime() + (input.resolution.retryInMs ?? DM_HEAD_NOT_FOUND_RETRY_MS[0]!)),
      waitingReason: "not_due",
      cursor,
      proof,
    };
  }
  const closeReason = variant === "history" ? "history_complete" : variant === "catchup" ? "caught_up" : "confirmed";
  return { satisfiesRevision: true, close: "done", closeReason, cursor, proof };
}

async function canonicalizeAndFeedArchive(tx: Database, input: {
  pageId: number;
  ownRef: string;
  key: string;
  observation: { id: number; receivedAt: Date };
  response: unknown;
  fence: FenceCheck;
  now: Date;
  counters: Record<string, number>;
}): Promise<void> {
  if (DM_SYNC_FAMILY === null) throw new Error("no canonicalizer family claims Fansly dm_messages");
  const draftFenced = new Map<string, boolean>();
  const excludeDraft = async (draft: CanonicalEventDraft): Promise<boolean> => {
    const messageRef = draft.messageRef ?? null;
    // Material of a message: decided by that message's own fence check.
    if (messageRef !== null) return input.fence.fencedIds.has(messageRef);
    const refs = [draft.fanIdentityRef, draft.conversationRef].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
    if (refs.length === 0) return false;
    const materialAt = draft.occurredAt.getTime() < input.observation.receivedAt.getTime() ? draft.occurredAt : input.observation.receivedAt;
    if (input.fence.clear && materialAt.getTime() >= input.fence.checkedFrom.getTime()
      && refs.every((ref) => input.fence.checkedRefs.has(ref))) return false;
    const cacheKey = `${refs.join(",")}@${materialAt.toISOString()}`;
    let fenced = draftFenced.get(cacheKey);
    if (fenced === undefined) {
      fenced = await isDmArchiveScopeFenced(tx, { pageId: input.pageId, platform: "fansly", refs, materialAt });
      draftFenced.set(cacheKey, fenced);
    }
    return fenced;
  };
  const canon = await canonicalizeObservationInTransaction(tx, DM_SYNC_FAMILY, {
    id: input.observation.id,
    source: "pull",
    producer: `fansly-sync:${input.key}`,
    platform: "fansly",
    accountId: input.pageId,
    kind: "dm_messages",
    // The body as journaled (§3.11): dm_messages is never CDN-stripped.
    payload: replaceJournalLoneSurrogates(input.response).value,
    observedAt: null,
    receivedAt: input.observation.receivedAt,
  }, {
    nativeAccountRefByAccountId: new Map([[input.pageId, input.ownRef]]),
    now: input.now,
    excludeDraft,
  });
  bump(input.counters, `canonicalize_${canon.outcome}`);
  if (canon.outcome === "rejected") return;
  bump(input.counters, "drafts_fenced", canon.excluded);
  if (canon.outcome === "stamped") bump(input.counters, "events_appended", canon.appended);
  if (canon.messageDedupKeys.length === 0) return;
  const events = await listDomainEventsByDedupKeys(tx, input.pageId, canon.messageDedupKeys);
  const archived = await applyMessageEventsToArchive(tx, { accountId: input.pageId, platform: "fansly", events });
  bump(input.counters, "archive_inserted", archived.inserted);
}

// ── the chat Fansly stopped serving (arena "vanished chat", plan §2) ────────

/** How a skip ends the chat's unavailability episode (null: it does not —
 *  a deleted thread took its episodes with it). */
function episodeEndOf(skip: ThreadSkip): ChatUnavailabilityEndReason | null {
  switch (skip) {
    case "excluded":
      return "thread_excluded";
    case "unbound":
      return "thread_unbound";
    case "thread_missing":
      return null;
  }
}

/**
 * The `local` steps of the three keys, re-judged in the commit's transaction
 * (the erasure fence held; the work row is settled at the revision the plan
 * read, so a demand that came since keeps it open and it plans anew):
 * - a chat with an open unavailability episode that is no longer read
 *   (excluded or unbound since): the episode ends and the work closes as the
 *   plan's `done` would have closed it;
 * - a head or catch-up row of a chat whose episode is established, whose
 *   next read is the head and whose demand the episode already answered: it
 *   closes itself `chat_unavailable` with its demand unserved, and the chat's
 *   unconfirmed socket messages are deferred — no request;
 * - a history walk of such a chat whose next read is the head: no request —
 *   the history requests refuse its fans that need the head after the settle
 *   (`chatUnavailable`, the capture's rule), closing the walk when no fan is
 *   left; a fan anchored below the chain keeps the walk, which reads `before`
 *   at its next plan (a minute on: no tight loop on a host without the
 *   history hook).
 * Anything else (the exclusion lifted, a new demand, the episode ended) is
 * planned anew.
 */
async function applyLocalStep(variant: DmMessagesVariant, tx: Database, input: LocalApplyInput): Promise<ApplyResult> {
  const replan: ApplyResult = { work: { satisfiesRevision: false }, followups: [] };
  const groupId = input.work.subject;
  const thread = await readThread(tx, input.pageId, groupId);
  const skip = threadSkip(thread);
  const counters: Record<string, number> = {};
  if (skip !== null) {
    const endReason = episodeEndOf(skip);
    if (thread !== null && endReason !== null
      && await endChatUnavailability(tx, { threadId: thread.state.id, reason: endReason, at: input.now }) !== null) {
      bump(counters, "chat_unavailability_ended");
    }
    return { work: { satisfiesRevision: true, close: "done", closeReason: skip }, followups: [], counters };
  }
  if (thread === null) return replan;
  const episode = await openEpisodeOf(tx, input.pageId, groupId);
  if (episode?.state !== "established") return replan;
  if (variant !== "history" && !demandAnswered(input.work.demand, episode.handledListHeadId)) return replan;
  const next = await planThreadRead(variant, input.work, thread, { db: tx, pageId: input.pageId, now: input.now });
  if (next.kind !== "request" || requestedParams(next.request).before !== null) return replan;
  if (variant === "history") {
    bump(counters, "chat_unavailable_history_refused");
    return {
      work: { satisfiesRevision: false, nextDueAt: new Date(input.now.getTime() + WAIT_RECHECK_MS), waitingReason: "dependency" },
      followups: [],
      counters,
      chatUnavailable: { threadId: thread.state.id },
    };
  }
  await deferChatUnavailableLiveMessages(tx, { pageId: input.pageId, groupId });
  bump(counters, "chat_unavailable_closed");
  return {
    work: {
      satisfiesRevision: false,
      close: "done",
      closeReason: CHAT_UNAVAILABLE_REASON,
      result: { ...episodeAccount(episode), unservedMessageIds: input.work.demand.messageIds },
    },
    followups: [],
    counters,
  };
}

/** What a work closed `chat_unavailable` records of the episode. */
function episodeAccount(episode: ChatUnavailabilityEpisode): Record<string, unknown> {
  return {
    chatUnavailable: {
      episodeId: episode.id,
      refusals: episode.refusals,
      establishedAt: episode.establishedAt?.toISOString() ?? null,
      retryNotBefore: episode.retryNotBefore?.toISOString() ?? null,
    },
  };
}

/**
 * A qualifying refusal (plan §2.2): a `messages.page` read of the chat's head
 * (no `before`) that Fansly itself refused — `subject_failure` or
 * `envelope_unsuccessful` carrying its own error envelope. A proxy's HTML
 * page, an empty 5xx, a 429, a 401/403 and a wire failure are not the chat's
 * answer.
 */
export function isQualifyingChatRefusal(decision: Pick<OutcomeDecision, "errorClass">, input: Pick<CaptureOutcomeInput, "step">): boolean {
  const { step } = input;
  return step.outcome === "response"
    && step.request.spec === "messages.page"
    && requestedParams(step.request).before === null
    && (decision.errorClass === "subject_failure" || decision.errorClass === "envelope_unsuccessful")
    && step.fanslyErrorEnvelope;
}

/** The retry boundary an established refusal sets: the later of the refused
 *  attempt's breaker and the daily step (the blocked step of the ladder, which
 *  a key reading the chat's head for the first time in the episode does not
 *  reach by its own count). */
export function chatRetryNotBefore(decision: Pick<OutcomeDecision, "subjectBreaker">, now: Date): Date {
  const daily = new Date(now.getTime() + BLOCKED_PROBE_EVERY_MS);
  const breaker = decision.subjectBreaker?.breakerUntil ?? null;
  return breaker !== null && breaker.getTime() > daily.getTime() ? breaker : daily;
}

/**
 * The capture transaction's hook of the three keys (`outcomeInCapture`), for
 * a head read (no `before`) that went out and did not succeed. A request that
 * never left (a proxy tunnel that never came up) is no read: nothing here,
 * the network rules as ever.
 *
 * A qualifying refusal opens or advances the chat's episode (its own count:
 * refusals, the latest attempt and answer). Any other failed head read — the
 * wire, a timeout, a proxy's page, a 5xx without the envelope, a 429 or a 401
 * — counts no refusal and changes no page or route hold, but on an
 * established episode it moves the retry boundary and the answered head all
 * the same: only an applied read ends the episode. The answered head is the
 * newest of the chat's list head and the ids of the demand this read was
 * admitted with (`input.demand`, read under the admission's lock) that was
 * created before the read was sent (`sentAt`, never later than the send) — a
 * message created during the flight is a new demand.
 *
 * Only the work whose request this was is settled here (`settleOwnRead`); no
 * other row of the chat is touched by this capture — each decides by its own
 * plan (an answered demand closes itself, a newer one reads once after the
 * boundary), so a demand that lands during the flight is never lost.
 */
async function chatRefusalInCapture(tx: Database, decision: OutcomeDecision, input: CaptureOutcomeInput): Promise<CaptureOutcomeResult> {
  const unchanged: CaptureOutcomeResult = { decision };
  const groupId = input.work.subject;
  if (!input.sent || decision.errorClass === "ok" || input.step.request.spec !== "messages.page"
    || requestedParams(input.step.request).before !== null || !DECIMAL_ID.test(groupId)) return unchanged;
  const thread = await readThread(tx, input.pageId, groupId);
  if (thread === null) return unchanged;
  const retryNotBefore = chatRetryNotBefore(decision, input.now);
  const sentAtMs = input.sentAt.getTime();
  // The demand this read was admitted with (read under the admission's lock:
  // a signal between the pick and the admission is in it).
  const handledListHeadId = maxId([
    ...(thread.state.lastMessageId === null ? [] : [thread.state.lastMessageId]),
    ...input.demand.messageIds,
  ].filter((id) => {
    const createdMs = snowflakeMs(id);
    return createdMs !== null && createdMs <= sentAtMs;
  }));
  let episode: ChatUnavailabilityEpisode | null;
  if (isQualifyingChatRefusal(decision, input) && input.observation !== null) {
    const recorded = await recordChatHeadRefusal(tx, {
      pageId: input.pageId,
      groupId,
      generation: input.generation,
      attemptId: input.attemptId,
      httpStatus: input.step.httpStatus,
      observation: input.observation,
      at: input.now,
      retryNotBefore,
      handledListHeadId,
    });
    episode = recorded?.episode ?? null;
  } else {
    const postponed = await postponeChatUnavailabilityRetry(tx, {
      pageId: input.pageId, groupId, generation: input.generation, retryNotBefore, handledListHeadId,
    });
    if (!postponed) return unchanged;
    episode = await openEpisodeOf(tx, input.pageId, groupId);
  }
  if (episode === null || episode.state !== "established") return unchanged;
  return settleOwnRead(tx, decision, input, thread, episode);
}

/**
 * A failed head read of an established chat settles its own work, in its
 * capture transaction: the chat's unconfirmed socket messages are deferred
 * (`chat_unavailable`, still shown); a head or catch-up work closes
 * `chat_unavailable` with its demand unserved — `settleWork`'s compare-and-set
 * on the revision it was admitted at (I11: a demand that arrived during the
 * flight keeps it open, and that demand gets one read after the boundary); a
 * history walk stays as the decision leaves it and the history requests
 * refuse the chat's fans that need the head (`CommitDeps.onChatUnavailable`;
 * an anchored fan keeps reading below the chain under the key's own breaker,
 * the walk closes when no fan is left). A decision that does not reopen the
 * work (a quarantine) is left as it is. Lock order: the episode → the overlay
 * rows → the work row; the history rows follow the commit's settle. The
 * erasure fence is not taken: nothing here writes archive material.
 */
async function settleOwnRead(
  tx: Database,
  decision: OutcomeDecision,
  input: CaptureOutcomeInput,
  thread: DmThread,
  episode: ChatUnavailabilityEpisode,
): Promise<CaptureOutcomeResult> {
  await deferChatUnavailableLiveMessages(tx, { pageId: input.pageId, groupId: input.work.subject });
  const chatUnavailable = { threadId: thread.state.id };
  if (input.work.resource === HISTORY_KEY || decision.work.action !== "reopen") return { decision, chatUnavailable };
  const [own] = await lockWorkRows(tx, [input.work.id]);
  const reopen = decision.work;
  return {
    decision: {
      ...decision,
      work: {
        action: "close",
        closeReason: CHAT_UNAVAILABLE_REASON,
        satisfiesRevision: false,
        result: { ...episodeAccount(episode), unservedMessageIds: (own ?? input.work).demand.messageIds },
        dueAt: reopen.dueAt,
        waitingReason: reopen.waitingReason,
        waitingUntil: reopen.waitingUntil,
      },
    },
    chatUnavailable,
  };
}

// ── modules ─────────────────────────────────────────────────────────────────

function variantModule(variant: DmMessagesVariant): ResourceModule {
  return {
    plan: (work, ctx) => planStep(variant, work, ctx),
    apply: (tx, input) => applyMessagesPage(variant, tx, input),
    applyLocal: (tx, input) => applyLocalStep(variant, tx, input),
    outcomeInCapture: (tx, decision, input) => chatRefusalInCapture(tx, decision, input),
  };
}

const MODULES: Readonly<Record<DmMessagesVariant, ResourceModule>> = {
  head: variantModule("head"),
  catchup: variantModule("catchup"),
  history: variantModule("history"),
};

export function dmMessagesModule(variant: DmMessagesVariant): ResourceModule {
  return MODULES[variant];
}
