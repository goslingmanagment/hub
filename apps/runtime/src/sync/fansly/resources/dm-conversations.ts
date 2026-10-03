import { sql } from "drizzle-orm";

import {
  countPageDmThreadsByGeneration,
  countPageDmVisibleThreads,
  getSyncPage,
  listLegacyWsHintMembershipPending,
  listOpenWorkSubjects,
  listPageDmThreadIdsStampedWithGeneration,
  listPageDmThreadListStates,
  listPageDmThreadListStatesByRecency,
  maxPageDmThreadGeneration,
  readFanslyAccountProbe,
  upsertPageDmConversationListFields,
  type Database,
  type PageDmThreadListState,
  type SyncPageRow,
} from "@agency_hub_core/db";
import {
  FANSLY_MESSAGING_GROUPS_PAGE_LIMIT,
  parseFanslyGroupDetail,
  parseFanslyMessagingGroupsPage,
  type FanslyAccount,
  type FanslyGroupDetail,
  type FanslyMessagingGroup,
  type FanslyMessagingGroupsPage,
} from "@agency_hub_core/fansly";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
  getFanslyDmMessageSyncExcludedReason,
} from "@agency_hub_core/shared";

import { FANSLY_ACCOUNT_LOOKUP_REUSE_MS, upsertHydratedFansForPage } from "../../../services/sync/fan-hydration.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  ReplayContext,
  ReplayObservation,
  ReplayVerdict,
  RequestPlan,
  ResourceModule,
  ShadowResult,
  StepPlan,
  WorkOutcome,
} from "../../engine/resource.ts";
import { routeHoldUntil } from "../../engine/route-holds.ts";
import { parseRouteState } from "../../engine/route-policy.ts";
import {
  listHeadInstant,
  listHeadNeedsRead,
  listPageUnchanged,
  nonPageMembers,
  resolveConversationListItem,
  resolveGroupDetail,
  type ListHeadFollowupState,
  type ResolvedListItem,
} from "../lib/conversation-list.ts";
import { advanceShadowWalk, offsetWalkPages, type ShadowWalkProgress } from "../lib/offset-walk.ts";
import { readFanslyPageFacts, waitForPageIdentity } from "../lib/page-facts.ts";
import { DETAIL_NOT_A_CHAT, LEGACY_WS_HINT_MEMBERSHIP_PENDING } from "../lib/replay-rules.ts";

// `dm-conversations.head`, `.full`, `.find`, `.detail`, `.ws-down` (plan §6.2,
// §7 p.3 and p.6; design §5.3): the conversation list
// `GET /messaging/groups?offset&limit=100&sortOrder=1&flags=0` (journaled as
// `dm_conversations` through the [A20] trim) and the group detail
// `GET /group/:groupId` (journaled verbatim as `group_detail`), one request a
// step.
//
// - head (planned poll, 30 min): from offset 0 to the first page whose every
//   chat is unchanged (same head id, a head with a time, nothing the legacy
//   streak counts as a change), or a short page. No membership generation.
// - full (planned poll, daily [A14]): every page to the short one, stamping a
//   fresh membership generation; no thread is ever hidden (Fansly states no
//   total, so no walk can prove a thread gone). Rows served twice inside one
//   page, or two non-final pages of nothing but repeats (a provider ignoring
//   the offset), restart the walk under a new generation after 60 s, at most
//   twice; past that it closes withheld.
// - find (urgent, a socket event in an unknown chat): the list head; if the
//   chat is not on it, its group detail, which creates the thread (D5). While
//   a 429 holds the list's route (`messaging.groups`, owner decision №22:
//   only the keys that can only read the list wait), straight to the detail.
// - detail (planned, from a list apply): the group detail of a chat whose
//   partner the list could not name; a 5xx breaks only this chat (§9).
// - ws-down (urgent, live only, step 3): the list head every 30 s while the
//   socket has been down; created by the socket's lifecycle, re-armed here
//   until the socket is up again.
//
// Every apply writes through the list's own writer
// (`upsertPageDmConversationListFields`): never the stored window, the
// coverage verdict or the chain columns (I9), never an unbinding. A listed
// head newer than what the message reads reached asks for a read:
// `dm-messages.catchup` (planned) from head/full/detail, `dm-messages.head`
// (urgent) from ws-down and for find's own chat.

export type DmConversationsVariant = "head" | "full" | "find" | "detail" | "ws-down";

const HEAD_KEY = "dm-conversations.head";
const FULL_KEY = "dm-conversations.full";
const FIND_KEY = "dm-conversations.find";
const DETAIL_KEY = "dm-conversations.detail";
const WS_DOWN_KEY = "dm-conversations.ws-down";
const MESSAGES_HEAD_KEY = "dm-messages.head";
const MESSAGES_CATCHUP_KEY = "dm-messages.catchup";
const PROBE_KEY = "fan-profiles.probe";

const LIMIT = FANSLY_MESSAGING_GROUPS_PAGE_LIMIT;

/** A full walk that cannot be trusted restarts at most this often. */
export const DM_LIST_WALK_MAX_RESTARTS = 2;
/** A restarted full walk starts again after this long. */
export const DM_LIST_WALK_RESTART_DELAY_MS = 60_000;
/** Consecutive non-final pages of nothing but repeats that restart a walk
 *  (legacy `DM_CONVERSATIONS_REPEAT_ONLY_PAGE_LIMIT`). */
export const DM_LIST_REPEAT_ONLY_PAGE_LIMIT = 2;
/** The list head is read this often while the socket is down. */
export const DM_LIST_WS_DOWN_EVERY_MS = 30_000;

type FollowupClass = "planned" | "urgent";

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function iso(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function listRequest(offset: number): RequestPlan<"messaging.groups"> {
  return { spec: "messaging.groups", params: { offset } };
}

function detailRequest(groupId: string): RequestPlan<"group.detail"> {
  return { spec: "group.detail", params: { groupId } };
}

function requestedOffset(request: RequestPlan): number | null {
  return count(recordOf(request.params).offset);
}

function parseShadow(value: unknown): ShadowWalkProgress | null {
  const record = recordOf(value);
  const steps = count(record.steps);
  const done = count(record.done);
  return steps === null || done === null ? null : { steps, done };
}

/** The engine's start on the page: chats whose head is later began under it. */
function engineStartAt(page: Pick<SyncPageRow, "legacyImportedAt" | "modeChangedAt"> | null): Date | null {
  return page === null ? null : page.legacyImportedAt ?? page.modeChangedAt;
}

/** The first row of each group id, in served order. */
function uniqueRows(rows: readonly FanslyMessagingGroup[]): FanslyMessagingGroup[] {
  const seen = new Set<string>();
  const unique: FanslyMessagingGroup[] = [];
  for (const row of rows) {
    if (seen.has(row.groupId)) continue;
    seen.add(row.groupId);
    unique.push(row);
  }
  return unique;
}

async function pageAccountIdOrQuarantine(db: Database, pageId: number): Promise<string> {
  const facts = await readFanslyPageFacts(db, pageId);
  if (facts === null) throw new ApplyQuarantine("page_missing");
  if (facts.externalId === null) throw new ApplyQuarantine("page_account_unknown");
  return facts.externalId;
}

/** Plans that need the page's own account id (to tell the partner from the page). */
async function planWithIdentity(
  key: string,
  ctx: { db: Database; pageId: number; shadow: boolean; now: Date },
  request: () => StepPlan,
): Promise<StepPlan> {
  const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
  if (facts === null) return { kind: "quarantine", reason: "page_missing" };
  if (facts.externalId === null) return waitForPageIdentity(key, ctx.shadow, ctx.now);
  return request();
}

/** The stored probe answers of the last day for the threads excluded as
 *  unresolvable, by partner id. */
async function freshProbeAnswers(
  db: Database,
  input: { pageId: number; states: readonly PageDmThreadListState[]; now: Date },
): Promise<Map<string, "resolved" | "unresolved">> {
  const answers = new Map<string, "resolved" | "unresolved">();
  for (const state of input.states) {
    const partner = state.partnerPlatformUserId;
    if (partner === null || answers.has(partner)) continue;
    if (getFanslyDmMessageSyncExcludedReason(state.metadata) !==
      FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP) continue;
    const probe = await readFanslyAccountProbe(db, { platformAccountId: input.pageId, platformUserId: partner });
    if (probe !== null && input.now.getTime() - probe.probedAt.getTime() < FANSLY_ACCOUNT_LOOKUP_REUSE_MS) {
      answers.set(partner, probe.resolved ? "resolved" : "unresolved");
    }
  }
  return answers;
}

// ── follow-ups ──────────────────────────────────────────────────────────────

interface FollowupThread {
  state: ListHeadFollowupState;
  threadId: number;
  partnerId: string | null;
  probeDue: boolean;
  requestGroupDetail: boolean;
  followupClass: FollowupClass;
}

/**
 * The work a list read asks for (design §5.3): a message read for each chat
 * whose list head is newer than what the reads reached (`dm-messages.catchup`
 * planned — skipped while the chat has an open `dm-messages.head` — or
 * `dm-messages.head` urgent), the group detail of a chat without a partner,
 * the probe of an unresolvable partner.
 */
async function threadFollowups(
  db: Database,
  input: { pageId: number; shadow: boolean; key: string; engineStartAt: Date | null; threads: readonly FollowupThread[] },
): Promise<{ followups: DemandSignal[]; counters: Record<string, number> }> {
  const needRead = input.threads.filter((thread) => listHeadNeedsRead(thread.state, input.engineStartAt));
  const plannedSubjects = needRead.filter((thread) => thread.followupClass === "planned").map((thread) => thread.state.groupId);
  const openHeads = await listOpenWorkSubjects(db, {
    pageId: input.pageId,
    shadow: input.shadow,
    resource: MESSAGES_HEAD_KEY,
    subjects: plannedSubjects,
  });
  const followups: DemandSignal[] = [];
  const counters: Record<string, number> = {};
  const bump = (name: string) => {
    counters[name] = (counters[name] ?? 0) + 1;
  };
  for (const thread of needRead) {
    const groupId = thread.state.groupId;
    if (thread.followupClass === "planned" && openHeads.has(groupId)) {
      bump("catchup_skipped_open_head");
      continue;
    }
    followups.push({
      resource: thread.followupClass === "urgent" ? MESSAGES_HEAD_KEY : MESSAGES_CATCHUP_KEY,
      subject: groupId,
      demand: { messageIds: [thread.state.listHeadId!], reason: `list_head:${input.key}` },
    });
    bump(thread.followupClass === "urgent" ? "followup_messages_head" : "followup_messages_catchup");
  }
  for (const thread of input.threads) {
    if (thread.requestGroupDetail) {
      followups.push({ resource: DETAIL_KEY, subject: thread.state.groupId, demand: { reason: `partner:${input.key}` } });
      bump("followup_group_detail");
    }
    if (thread.probeDue && thread.partnerId !== null) {
      followups.push({
        resource: PROBE_KEY,
        subject: thread.partnerId,
        params: { conversationId: thread.threadId },
        demand: { reason: `exclusion:${input.key}` },
      });
      bump("followup_probe");
    }
  }
  return { followups, counters };
}

function mergeCounters(...all: ReadonlyArray<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const counters of all) {
    for (const [name, by] of Object.entries(counters)) merged[name] = (merged[name] ?? 0) + by;
  }
  return merged;
}

// ── the list page apply ─────────────────────────────────────────────────────

export interface ListPageOutcome {
  items: ResolvedListItem[];
  followups: DemandSignal[];
  counters: Record<string, number>;
  /** Group ids the page served. */
  groupIds: Set<string>;
}

/**
 * One accepted `/messaging/groups` page into the page's threads, in the apply
 * transaction (the erasure fence is held, `fence: dm_archive`): the partner
 * fans, then each chat through the list's writer, then the follow-ups.
 */
export async function applyListPage(
  tx: Database,
  input: {
    pageId: number;
    now: Date;
    key: string;
    page: FanslyMessagingGroupsPage;
    generation: number | null;
    classOf: (groupId: string) => FollowupClass;
  },
): Promise<ListPageOutcome> {
  const pageAccountId = await pageAccountIdOrQuarantine(tx, input.pageId);
  const rows = uniqueRows(input.page.data);
  const accounts = input.page.aggregationData?.accounts ?? [];
  const accountsById = new Map(accounts.map((account) => [account.id, account] as const));
  const groupsById = new Map((input.page.aggregationData?.groups ?? []).map((group) => [group.id, group] as const));
  const states = await listPageDmThreadListStates(tx, {
    platformAccountId: input.pageId,
    platformConversationIds: rows.map((row) => row.groupId),
  });
  const existingByGroup = new Map(states.map((state) => [state.platformConversationId, state] as const));
  const probes = await freshProbeAnswers(tx, { pageId: input.pageId, states, now: input.now });
  // The page row: its lifted exclusions (owner decision №8) and the engine's
  // start on it (the follow-ups).
  const page = await getSyncPage(tx, input.pageId);
  const liftedExclusions = page?.liftedDmExclusions ?? [];

  const items = rows.map((item) => {
    const existing = existingByGroup.get(item.groupId) ?? null;
    const partner = existing?.partnerPlatformUserId ?? null;
    return resolveConversationListItem({
      item,
      group: groupsById.get(item.groupId) ?? null,
      accountsById,
      aggregationAccountCount: accounts.length,
      existing,
      pageAccountId,
      probe: partner === null ? null : probes.get(partner) ?? null,
      liftedExclusions,
    }, input.now);
  });

  // The partners' fans: a profile served with the list, or an id ensured
  // unverified (no profile is not deletion evidence).
  const profiles = new Map<string, FanslyAccount>();
  for (const item of items) {
    if (item.hydrate !== null && "account" in item.hydrate) profiles.set(item.hydrate.account.id, item.hydrate.account);
  }
  const unverified = [...new Set(items.flatMap((item) =>
    item.hydrate !== null && "unverifiedId" in item.hydrate && !profiles.has(item.hydrate.unverifiedId)
      ? [item.hydrate.unverifiedId]
      : []))];
  const fanMap = profiles.size + unverified.length === 0
    ? new Map<string, number>()
    : await upsertHydratedFansForPage(tx, {
      platformAccountId: input.pageId,
      accounts: [...profiles.values()],
      unverifiedIds: unverified,
    });

  const counters: Record<string, number> = { listed_chats: items.length };
  const bump = (name: string, when: boolean) => {
    if (when) counters[name] = (counters[name] ?? 0) + 1;
  };
  const threads: FollowupThread[] = [];
  for (const item of items) {
    const existing = existingByGroup.get(item.groupId) ?? null;
    const fanId = item.aggregationMissing || item.partnerPlatformUserId === null
      ? null
      : fanMap.get(item.partnerPlatformUserId) ?? null;
    const written = await upsertPageDmConversationListFields(tx, {
      platformAccountId: input.pageId,
      platformConversationId: item.groupId,
      fanId,
      partnerPlatformUserId: item.partnerPlatformUserId,
      partnerUsername: item.partnerUsername,
      partnerDisplayName: item.partnerDisplayName,
      list: item.list,
      head: {
        lastMessageId: item.head.lastMessageId,
        lastMessageAt: item.head.lastMessageAt,
        lastMessageSenderId: item.head.lastMessageSenderId,
        lastMessageSenderRole: item.head.lastMessageSenderRole,
        lastMessagePreview: item.head.lastMessagePreview,
      },
      lastSeenGeneration: input.generation,
      unresolvedIdentity: item.unresolvedIdentity,
      messageSyncExcludedReason: item.messageSyncExcludedReason,
    });
    bump("threads_created", written.inserted);
    bump("head_kept_for_retry", item.head.preserveHeadForRetry);
    bump("head_time_implausible", item.head.timestampImplausible);
    bump("scalar_drift", item.scalarDrift);
    bump("partner_missing_from_accounts", item.aggregationMissing);
    bump("partner_missing_lifted", item.aggregationMissing && item.messageSyncExcludedReason === null);
    bump("partner_contradictory", item.contradictory);
    const servedAt = item.head.embeddedMessageId === item.head.listMessageId ? item.head.servedAt : null;
    threads.push({
      state: {
        groupId: item.groupId,
        fanId: written.fanId,
        metadata: written.metadata,
        headConfirmedId: existing?.headConfirmedId ?? null,
        newestStoredMessageId: existing?.newestStoredMessageId ?? null,
        listHeadId: item.head.listMessageId,
        listHeadAt: listHeadInstant(item.head.listMessageId, servedAt),
      },
      threadId: written.id,
      partnerId: written.partnerPlatformUserId,
      probeDue: item.probeDue,
      requestGroupDetail: item.requestGroupDetail,
      followupClass: input.classOf(item.groupId),
    });
  }
  const followups = await threadFollowups(tx, {
    pageId: input.pageId,
    shadow: false,
    key: input.key,
    engineStartAt: engineStartAt(page),
    threads,
  });
  return {
    items,
    followups: followups.followups,
    counters: mergeCounters(counters, followups.counters),
    groupIds: new Set(rows.map((row) => row.groupId)),
  };
}

/**
 * One accepted group detail into its thread (`.find` step 2, `.detail`): the
 * partner when the group names exactly one besides the page (its fan ensured
 * unverified), the detail's head when it is newer than the stored one; the
 * list's own fields and the exclusion stay as they are. A new thread is
 * created from the detail alone (D5) only for a direct chat: a detail that
 * names no single partner (the page's own mass-message container, a group of
 * several) creates nothing — a thread for it would be a visible inbox row
 * with nobody in it, re-found by every later own message into it.
 */
async function applyGroupDetail(
  tx: Database,
  input: { pageId: number; now: Date; key: string; detail: FanslyGroupDetail; followupClass: FollowupClass },
): Promise<{ followups: DemandSignal[]; counters: Record<string, number>; result: Record<string, unknown> }> {
  const pageAccountId = await pageAccountIdOrQuarantine(tx, input.pageId);
  const groupId = input.detail.id;
  const [existing = null] = await listPageDmThreadListStates(tx, { platformAccountId: input.pageId, platformConversationIds: [groupId] });
  const resolved = resolveGroupDetail({ detail: input.detail, existing, pageAccountId, now: input.now });
  const partner = resolved.partnerPlatformUserId;
  if (existing === null && partner === null) {
    return {
      followups: [],
      counters: { detail_not_a_chat: 1 },
      result: { groupId, threadId: null, created: false, notAChat: true, type: input.detail.type, members: resolved.members },
    };
  }
  const fanMap = partner === null
    ? new Map<string, number>()
    : await upsertHydratedFansForPage(tx, { platformAccountId: input.pageId, accounts: [], unverifiedIds: [partner] });
  const exclusion = getFanslyDmMessageSyncExcludedReason(existing?.metadata);
  const head = resolved.head;
  const written = await upsertPageDmConversationListFields(tx, {
    platformAccountId: input.pageId,
    platformConversationId: groupId,
    fanId: partner === null ? null : fanMap.get(partner) ?? null,
    partnerPlatformUserId: partner,
    partnerUsername: null,
    partnerDisplayName: null,
    ...(head === null ? {} : {
      head: {
        lastMessageId: head.lastMessageId,
        lastMessageAt: head.lastMessageAt,
        lastMessageSenderId: head.lastMessageSenderId,
        lastMessageSenderRole: head.lastMessageSenderRole,
        lastMessagePreview: head.lastMessagePreview,
      },
    }),
    lastSeenGeneration: null,
    unresolvedIdentity: resolved.writtenPartnerId === null,
    messageSyncExcludedReason: exclusion,
  });
  const message = input.detail.lastMessage ?? null;
  const listHeadId = typeof message?.id === "string" && message.id.length > 0 ? message.id : null;
  const servedAt = head?.servedAt ?? null;
  const page = await getSyncPage(tx, input.pageId);
  const followups = await threadFollowups(tx, {
    pageId: input.pageId,
    shadow: false,
    key: input.key,
    engineStartAt: engineStartAt(page),
    threads: [{
      state: {
        groupId,
        fanId: written.fanId,
        metadata: written.metadata,
        headConfirmedId: existing?.headConfirmedId ?? null,
        newestStoredMessageId: existing?.newestStoredMessageId ?? null,
        listHeadId,
        listHeadAt: listHeadInstant(listHeadId, servedAt),
      },
      threadId: written.id,
      partnerId: written.partnerPlatformUserId,
      probeDue: false,
      requestGroupDetail: false,
      followupClass: input.followupClass,
    }],
  });
  return {
    followups: followups.followups,
    counters: mergeCounters({ threads_created: written.inserted ? 1 : 0, detail_partner_found: partner === null ? 0 : 1 }, followups.counters),
    result: {
      groupId,
      threadId: written.id,
      created: written.inserted,
      partner: written.partnerPlatformUserId,
      detailPartner: partner,
      members: resolved.members,
    },
  };
}

// ── shadow estimates ────────────────────────────────────────────────────────

/** The follow-ups a live read of these threads would ask for, judged on what
 *  the database holds (the list head legacy last stored stands for the served
 *  one). Never writes. */
async function shadowFollowups(
  db: Database,
  input: { pageId: number; key: string; page: SyncPageRow; now: Date; states: readonly PageDmThreadListState[]; classOf: (groupId: string) => FollowupClass },
): Promise<{ followups: DemandSignal[]; counters: Record<string, number> }> {
  const probes = await freshProbeAnswers(db, { pageId: input.pageId, states: input.states, now: input.now });
  const threads = input.states.map((state): FollowupThread => {
    const reason = getFanslyDmMessageSyncExcludedReason(state.metadata);
    const partner = state.partnerPlatformUserId;
    return {
      state: {
        groupId: state.platformConversationId,
        fanId: state.fanId,
        metadata: state.metadata,
        headConfirmedId: state.headConfirmedId,
        newestStoredMessageId: state.newestStoredMessageId,
        listHeadId: state.lastMessageId,
        listHeadAt: listHeadInstant(state.lastMessageId, state.lastMessageAt),
      },
      threadId: state.id,
      partnerId: partner,
      probeDue: reason === FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP &&
        partner !== null && !probes.has(partner),
      requestGroupDetail: partner === null &&
        reason !== FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
      followupClass: input.classOf(state.platformConversationId),
    };
  });
  const result = await threadFollowups(db, {
    pageId: input.pageId,
    shadow: true,
    key: input.key,
    engineStartAt: engineStartAt(input.page),
    threads,
  });
  return { followups: result.followups, counters: mergeCounters({ simulated_chats: threads.length }, result.counters) };
}

// ── replay (design §3.12 B5) ────────────────────────────────────────────────

function changedSince(state: PageDmThreadListState, receivedAt: Date): boolean {
  return state.updatedAt.getTime() > receivedAt.getTime();
}

/**
 * Replay of a legacy `dm_conversations` observation: the new contract accepts
 * the journaled page, every chat on it has a thread on the page, and the
 * partner the list names is the stored one (or the row changed later). A body
 * legacy refused is journaled trimmed, so it cannot be re-judged.
 */
async function replayConversationList(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
  if (recordOf(observation.payload).contractAccepted === false) {
    return { kind: "not_replayable", reason: "legacy_refused_body_trimmed" };
  }
  const page = parseFanslyMessagingGroupsPage(observation.payload);
  if (page === null) return { kind: "mismatch", reason: "contract_refused" };
  const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
  if (facts?.externalId == null) return { kind: "not_replayable", reason: "page_account_unknown" };
  const rows = uniqueRows(page.data);
  if (rows.length === 0) return { kind: "match", detail: { served: 0 } };
  const groupsById = new Map((page.aggregationData?.groups ?? []).map((group) => [group.id, group] as const));
  const states = await listPageDmThreadListStates(ctx.db, {
    platformAccountId: ctx.pageId,
    platformConversationIds: rows.map((row) => row.groupId),
  });
  const byGroup = new Map(states.map((state) => [state.platformConversationId, state] as const));
  const missing: string[] = [];
  const partnerDiffers: string[] = [];
  for (const row of rows) {
    const state = byGroup.get(row.groupId);
    if (state === undefined) {
      missing.push(row.groupId);
      continue;
    }
    const members = nonPageMembers(groupsById.get(row.groupId)?.users, facts.externalId);
    const partner = (typeof row.partnerAccountId === "string" && row.partnerAccountId.length > 0 ? row.partnerAccountId : null)
      ?? (members.length === 1 ? members[0]! : null);
    if (partner !== null && state.partnerPlatformUserId !== partner && !changedSince(state, observation.receivedAt)) {
      partnerDiffers.push(row.groupId);
    }
  }
  if (missing.length === 0 && partnerDiffers.length === 0) return { kind: "match", detail: { served: rows.length } };
  return {
    kind: "mismatch",
    reason: missing.length > 0 ? "threads_missing" : "partner_differs",
    detail: {
      served: rows.length,
      missing: missing.length,
      partnerDiffers: partnerDiffers.length,
      examples: [...missing, ...partnerDiffers].slice(0, 5),
    },
  };
}

/**
 * Replay of a legacy `group_detail` observation: a body legacy refused (kept
 * as `{contractAccepted: false, raw}`) is refused by the new contract too; an
 * accepted one names a thread of the page whose stored partner is the
 * detail's single non-page member (or the row changed later). Without a
 * thread: a detail that is no direct chat matches (neither side stores one);
 * a direct chat legacy's socket-hint path journaled and deferred on purpose
 * (its own `membership_pending` record of the group) is legacy's gap — it
 * stored nothing, the engine's `.find` creates the thread (D5); any other is
 * `thread_missing`.
 */
async function replayGroupDetail(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
  const payload = recordOf(observation.payload);
  if (payload.contractAccepted === false) {
    const raw = recordOf(payload.raw);
    const id = typeof raw.id === "string" ? raw.id : "";
    return parseFanslyGroupDetail(payload.raw, id).ok
      ? { kind: "mismatch", reason: "legacy_refused_new_accepts" }
      : { kind: "match", detail: { legacyRefused: true } };
  }
  if (typeof payload.id !== "string" || payload.id.length === 0) return { kind: "mismatch", reason: "contract_refused" };
  const parsed = parseFanslyGroupDetail(observation.payload, payload.id);
  if (!parsed.ok) return { kind: "mismatch", reason: "contract_refused", detail: { ...parsed.violation } };
  const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
  if (facts?.externalId == null) return { kind: "not_replayable", reason: "page_account_unknown" };
  const [state] = await listPageDmThreadListStates(ctx.db, { platformAccountId: ctx.pageId, platformConversationIds: [parsed.value.id] });
  const members = nonPageMembers(parsed.value.users, facts.externalId);
  if (state === undefined) {
    if (members.length !== 1) {
      return { kind: "match", detail: { notAChat: true, members: members.length, type: parsed.value.type }, via: [DETAIL_NOT_A_CHAT] };
    }
    const deferred = await listLegacyWsHintMembershipPending(ctx.db, { pageId: ctx.pageId, groupRefs: [parsed.value.id] });
    if (deferred.includes(parsed.value.id)) return { kind: "not_replayable", reason: LEGACY_WS_HINT_MEMBERSHIP_PENDING };
    return { kind: "mismatch", reason: "thread_missing", detail: { groupId: parsed.value.id } };
  }
  const partner = members.length === 1 ? members[0]! : null;
  if (partner !== null && state.partnerPlatformUserId !== partner && !changedSince(state, observation.receivedAt)) {
    return { kind: "mismatch", reason: "partner_differs", detail: { groupId: parsed.value.id } };
  }
  return { kind: "match", detail: { members: members.length } };
}

// ── head ────────────────────────────────────────────────────────────────────

interface HeadWalk {
  offset: number;
  pageCount: number;
  /** ISO: the admission of the walk's first page. */
  startedAt: string;
}

export interface DmListHeadCursor {
  walk: HeadWalk | null;
  /** The receipt of the last finished walk. */
  last: Record<string, unknown> | null;
}

export function parseDmListHeadCursor(value: unknown): DmListHeadCursor {
  const record = recordOf(value);
  const walk = recordOf(record.walk);
  const offset = count(walk.offset);
  const startedAt = iso(walk.startedAt);
  return {
    walk: offset === null || startedAt === null ? null : { offset, pageCount: count(walk.pageCount) ?? 0, startedAt },
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
  };
}

const headModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseDmListHeadCursor(work.cursor);
    return planWithIdentity(HEAD_KEY, ctx, () => ({
      kind: "request",
      request: listRequest(ctx.shadow ? 0 : cursor.walk?.offset ?? 0),
    }));
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const cursor = parseDmListHeadCursor(input.work.cursor);
    const walk: HeadWalk = cursor.walk ?? { offset: 0, pageCount: 0, startedAt: input.attempt.admittedAt.toISOString() };
    const offset = requestedOffset(input.request);
    if (offset !== walk.offset) throw new ApplyQuarantine("dm_list_cursor_mismatch", { requestedOffset: offset, walkOffset: walk.offset });
    const page = input.parsed as FanslyMessagingGroupsPage;
    const outcome = await applyListPage(tx, {
      pageId: input.pageId, now: input.now, key: HEAD_KEY, page, generation: null, classOf: () => "planned",
    });
    const pageCount = walk.pageCount + 1;
    const short = page.data.length < LIMIT;
    const unchanged = listPageUnchanged(outcome.items);
    if (!short && !unchanged) {
      return {
        work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, walk: { ...walk, offset: walk.offset + LIMIT, pageCount } } },
        followups: outcome.followups,
        counters: outcome.counters,
      };
    }
    // head_known_item: the walk reached a page of chats it already knew (or
    // the list's end).
    const receipt = {
      startedAt: walk.startedAt,
      completedAt: input.now.toISOString(),
      pageCount,
      stop: unchanged ? "unchanged_page" : "short_page",
      knownChats: outcome.items.filter((item) => item.unchanged).length,
    };
    return {
      work: { satisfiesRevision: true, close: "done", closeReason: "head_known", cursor: { walk: null, last: receipt }, proof: receipt },
      followups: outcome.followups,
      counters: outcome.counters,
    };
  },

  async shadow(work, _request, ctx): Promise<ShadowResult> {
    // One page (design §5.3): the newest chats as the database holds them.
    const states = await listPageDmThreadListStatesByRecency(ctx.db, { platformAccountId: ctx.pageId, offset: 0, limit: LIMIT });
    const estimate = await shadowFollowups(ctx.db, { pageId: ctx.pageId, key: HEAD_KEY, page: ctx.page, now: ctx.now, states, classOf: () => "planned" });
    return {
      work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: parseDmListHeadCursor(work.cursor) },
      followups: estimate.followups,
      counters: estimate.counters,
    };
  },

  replay: replayConversationList,
};

// ── full ────────────────────────────────────────────────────────────────────

type WithheldReason = "duplicate_ids_in_page" | "repeat_only_pages";

interface FullWalk {
  generation: number;
  /** ISO: the admission of the walk's first page. */
  startedAt: string;
  offset: number;
  pageCount: number;
  /** Distinct chats the walk applied. */
  observedCount: number;
  /** Chats an earlier page of the walk had already applied (counted once). */
  repeatsCountedOnce: number;
  repeatOnlyPageStreak: number;
  restartCount: number;
}

export interface DmListFullCursor {
  /** The newest generation a walk of this row used. */
  generation: number;
  walk: FullWalk | null;
  /** The next walk restarts an abandoned one (its restart count). */
  restartCount: number;
  last: Record<string, unknown> | null;
  shadow: ShadowWalkProgress | null;
}

export function parseDmListFullCursor(value: unknown): DmListFullCursor {
  const record = recordOf(value);
  const walk = recordOf(record.walk);
  const generation = count(walk.generation);
  const offset = count(walk.offset);
  const startedAt = iso(walk.startedAt);
  return {
    generation: count(record.generation) ?? 0,
    walk: generation === null || offset === null || startedAt === null ? null : {
      generation,
      startedAt,
      offset,
      pageCount: count(walk.pageCount) ?? 0,
      observedCount: count(walk.observedCount) ?? 0,
      repeatsCountedOnce: count(walk.repeatsCountedOnce) ?? 0,
      repeatOnlyPageStreak: count(walk.repeatOnlyPageStreak) ?? 0,
      restartCount: count(walk.restartCount) ?? 0,
    },
    restartCount: count(record.restartCount) ?? 0,
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
    shadow: parseShadow(record.shadow),
  };
}

/** A walk that cannot be trusted: a fresh generation from offset 0 after a
 *  minute, at most `DM_LIST_WALK_MAX_RESTARTS` times; past that the walk
 *  closes withheld and the poll waits for its period. Nothing of the refused
 *  page is written either way. */
function restartOrWithhold(
  cursor: DmListFullCursor,
  walk: FullWalk,
  reason: WithheldReason,
  now: Date,
  detail: Record<string, unknown>,
): ApplyResult {
  if (walk.restartCount < DM_LIST_WALK_MAX_RESTARTS) {
    return {
      work: {
        satisfiesRevision: false,
        nextDueAt: new Date(now.getTime() + DM_LIST_WALK_RESTART_DELAY_MS),
        waitingReason: "not_due",
        cursor: { ...cursor, generation: walk.generation, walk: null, restartCount: walk.restartCount + 1, shadow: null },
        result: { restartReason: reason, restartCount: walk.restartCount + 1, pageCount: walk.pageCount, ...detail },
      },
      followups: [],
      counters: { [`walk_restart_${reason}`]: 1 },
    };
  }
  const receipt = {
    generation: walk.generation,
    startedAt: walk.startedAt,
    completedAt: now.toISOString(),
    pageCount: walk.pageCount,
    observedCount: walk.observedCount,
    restartCount: walk.restartCount,
    withheldReason: reason,
    ...detail,
  };
  return {
    work: {
      satisfiesRevision: true,
      close: "done",
      closeReason: "walk_withheld",
      cursor: { ...cursor, generation: walk.generation, walk: null, restartCount: 0, last: receipt, shadow: null },
      result: receipt,
    },
    followups: [],
    counters: { walk_withheld: 1 },
  };
}

/** The pages a full sweep of the list reads: the page's visible chats at
 *  `LIMIT` a page, the list stating no total, so it ends on a short page (the
 *  shadow's estimate at a sweep's start, and the shadow report's assumed run
 *  size, rule A1.rate-assumed). */
async function fullSweepPages(db: Database, pageId: number): Promise<number> {
  const total = await countPageDmVisibleThreads(db, pageId);
  return offsetWalkPages({ total, limit: LIMIT, statedTotal: false });
}

const fullModule: ResourceModule = {
  async estimateRunSteps(_work, ctx): Promise<number> {
    return fullSweepPages(ctx.db, ctx.pageId);
  },

  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseDmListFullCursor(work.cursor);
    const offset = ctx.shadow ? (cursor.shadow?.done ?? 0) * LIMIT : cursor.walk?.offset ?? 0;
    return planWithIdentity(FULL_KEY, ctx, () => ({ kind: "request", request: listRequest(offset) }));
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const cursor = parseDmListFullCursor(input.work.cursor);
    const walk: FullWalk = cursor.walk ?? {
      generation: Math.max(cursor.generation, await maxPageDmThreadGeneration(tx, input.pageId)) + 1,
      startedAt: input.attempt.admittedAt.toISOString(),
      offset: 0,
      pageCount: 0,
      observedCount: 0,
      repeatsCountedOnce: 0,
      repeatOnlyPageStreak: 0,
      restartCount: cursor.restartCount,
    };
    const offset = requestedOffset(input.request);
    if (offset !== walk.offset) throw new ApplyQuarantine("dm_list_cursor_mismatch", { requestedOffset: offset, walkOffset: walk.offset });
    const page = input.parsed as FanslyMessagingGroupsPage;
    const ids = page.data.map((row) => row.groupId);
    const unique = new Set(ids);
    // Decided before any write: a refused page writes nothing.
    if (ids.length > unique.size) {
      return restartOrWithhold(cursor, walk, "duplicate_ids_in_page", input.now, { offset: walk.offset, duplicates: ids.length - unique.size });
    }
    // Chats an earlier page of THIS walk applied carry its generation (only
    // this walk writes it); read before this page's writes stamp it.
    const repeated = await listPageDmThreadIdsStampedWithGeneration(tx, {
      platformAccountId: input.pageId,
      generation: walk.generation,
      platformConversationIds: [...unique],
    });
    const done = page.data.length < LIMIT;
    const repeatOnlyPageStreak = !done && unique.size > 0 && repeated.length === unique.size ? walk.repeatOnlyPageStreak + 1 : 0;
    if (repeatOnlyPageStreak >= DM_LIST_REPEAT_ONLY_PAGE_LIMIT) {
      return restartOrWithhold(cursor, walk, "repeat_only_pages", input.now, { offset: walk.offset, repeatOnlyPageStreak });
    }
    const outcome = await applyListPage(tx, {
      pageId: input.pageId, now: input.now, key: FULL_KEY, page, generation: walk.generation, classOf: () => "planned",
    });
    const next: FullWalk = {
      ...walk,
      pageCount: walk.pageCount + 1,
      observedCount: walk.observedCount + unique.size - repeated.length,
      repeatsCountedOnce: walk.repeatsCountedOnce + repeated.length,
      repeatOnlyPageStreak,
    };
    const counters = repeated.length === 0 ? outcome.counters : mergeCounters(outcome.counters, { repeats_counted_once: repeated.length });
    if (!done) {
      return {
        work: {
          satisfiesRevision: false,
          nextDueAt: input.now,
          cursor: { ...cursor, generation: walk.generation, walk: { ...next, offset: walk.offset + LIMIT }, shadow: null },
        },
        followups: outcome.followups,
        counters,
      };
    }
    // offset_stable (counts only): no thread is hidden, so the generation set
    // is a receipt, not a verdict.
    const generationSetCount = await countPageDmThreadsByGeneration(tx, { platformAccountId: input.pageId, generation: walk.generation });
    const total = page.aggregationData?.total;
    const receipt = {
      generation: walk.generation,
      startedAt: walk.startedAt,
      completedAt: input.now.toISOString(),
      pageCount: next.pageCount,
      observedCount: next.observedCount,
      generationSetCount,
      repeatsCountedOnce: next.repeatsCountedOnce,
      restartCount: walk.restartCount,
      providerReportedTotal: typeof total === "number" && Number.isSafeInteger(total) ? total : null,
    };
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: "walk_complete",
        cursor: { ...cursor, generation: walk.generation, walk: null, restartCount: 0, last: receipt, shadow: null },
        proof: receipt,
      },
      followups: outcome.followups,
      counters,
    };
  },

  async shadow(work, _request, ctx): Promise<ShadowResult> {
    const cursor = parseDmListFullCursor(work.cursor);
    const pages = cursor.shadow === null ? await fullSweepPages(ctx.db, ctx.pageId) : cursor.shadow.steps;
    const step = advanceShadowWalk(cursor.shadow, () => pages);
    const states = await listPageDmThreadListStatesByRecency(ctx.db, {
      platformAccountId: ctx.pageId,
      offset: (step.progress.done - 1) * LIMIT,
      limit: LIMIT,
    });
    const estimate = await shadowFollowups(ctx.db, { pageId: ctx.pageId, key: FULL_KEY, page: ctx.page, now: ctx.now, states, classOf: () => "planned" });
    return step.finished
      ? {
        work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: { ...cursor, shadow: null } },
        followups: estimate.followups,
        counters: estimate.counters,
      }
      : {
        work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: { ...cursor, shadow: step.progress } },
        followups: estimate.followups,
        counters: estimate.counters,
      };
  },

  replay: replayConversationList,
};

// ── find ────────────────────────────────────────────────────────────────────

export interface DmListFindCursor {
  /** `detail` once the list head did not show the chat. */
  step: "list" | "detail";
}

function parseFindCursor(value: unknown): DmListFindCursor {
  return { step: recordOf(value).step === "detail" ? "detail" : "list" };
}

const findModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const groupId = work.subject;
    if (groupId.length === 0) return { kind: "quarantine", reason: "find_without_chat" };
    const cursor = parseFindCursor(work.cursor);
    // While a 429 holds the list's route, the chat is found through its group
    // detail alone.
    const routes = parseRouteState(ctx.page.routeState);
    const listHeld = routes.ok && routeHoldUntil(routes.state, "messaging.groups", ctx.now) !== null;
    return planWithIdentity(FIND_KEY, ctx, () => ({
      kind: "request",
      request: !ctx.shadow && (cursor.step === "detail" || listHeld) ? detailRequest(groupId) : listRequest(0),
    }));
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const groupId = input.work.subject;
    if (input.request.spec === "group.detail") {
      const applied = await applyGroupDetail(tx, {
        pageId: input.pageId, now: input.now, key: FIND_KEY, detail: input.parsed as FanslyGroupDetail, followupClass: "urgent",
      });
      return {
        work: {
          satisfiesRevision: true,
          close: "done",
          closeReason: applied.result.notAChat === true ? "not_a_chat" : "found_by_detail",
          cursor: { step: "detail" },
          result: applied.result,
        },
        followups: applied.followups,
        counters: applied.counters,
      };
    }
    // The list head: the new chat is usually on it (the socket just told us).
    const outcome = await applyListPage(tx, {
      pageId: input.pageId,
      now: input.now,
      key: FIND_KEY,
      page: input.parsed as FanslyMessagingGroupsPage,
      generation: null,
      classOf: (id) => (id === groupId ? "urgent" : "planned"),
    });
    if (outcome.groupIds.has(groupId)) {
      return {
        work: { satisfiesRevision: true, close: "done", closeReason: "found_in_list", cursor: { step: "list" }, result: { groupId, step: "list" } },
        followups: outcome.followups,
        counters: outcome.counters,
      };
    }
    // Not on the list head: its group detail next (D5).
    return {
      work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { step: "detail" } satisfies DmListFindCursor },
      followups: outcome.followups,
      counters: mergeCounters(outcome.counters, { find_not_on_list_head: 1 }),
    };
  },

  async shadow(work, _request, ctx): Promise<ShadowResult> {
    // One list read (design §5.3); the chat's own read if the database
    // already knows it (legacy listed it meanwhile).
    const groupId = work.subject;
    const states = await listPageDmThreadListStates(ctx.db, { platformAccountId: ctx.pageId, platformConversationIds: [groupId] });
    const estimate = await shadowFollowups(ctx.db, { pageId: ctx.pageId, key: FIND_KEY, page: ctx.page, now: ctx.now, states, classOf: () => "urgent" });
    return {
      work: { satisfiesRevision: true, close: "done", closeReason: "shadow" },
      followups: estimate.followups.filter((signal) => signal.resource === MESSAGES_HEAD_KEY),
      counters: estimate.counters,
    };
  },

  replay: replayGroupDetail,
};

// ── detail ──────────────────────────────────────────────────────────────────

const detailModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const groupId = work.subject;
    if (groupId.length === 0) return { kind: "quarantine", reason: "detail_without_chat" };
    return planWithIdentity(DETAIL_KEY, ctx, () => ({ kind: "request", request: detailRequest(groupId) }));
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const applied = await applyGroupDetail(tx, {
      pageId: input.pageId, now: input.now, key: DETAIL_KEY, detail: input.parsed as FanslyGroupDetail, followupClass: "planned",
    });
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: applied.result.notAChat === true ? "not_a_chat" : "detail_applied",
        result: applied.result,
      },
      followups: applied.followups,
      counters: applied.counters,
    };
  },

  async shadow(): Promise<ShadowResult> {
    return { work: { satisfiesRevision: true, close: "done", closeReason: "shadow" }, followups: [] };
  },

  replay: replayGroupDetail,
};

// ── ws-down (live only, step 3) ─────────────────────────────────────────────

/** A socket whose receiver last proved itself longer ago than this is not
 *  up: the receiver's guard runs every 5 s, so a row it stopped touching is a
 *  process that died with the row open (design G10, E13). */
export const DM_LIST_SOCKET_GUARD_FRESH_MS = 30_000;

/** The page's socket is connected, verified and alive (no `.ws-down` reads
 *  needed). A row left open by a killed process is not: its guard went stale. */
export async function socketUp(db: Database, pageId: number): Promise<boolean> {
  const result = await db.execute<{ up: boolean }>(sql`
    select exists (
      select 1 from fansly_ws_connections c
       where c.page_id = ${pageId} and c.closed_at is null and c.verified_at is not null
         and c.last_guard_at > clock_timestamp() - ${DM_LIST_SOCKET_GUARD_FRESH_MS}::double precision * interval '1 millisecond'
    ) as up
  `);
  return result.rows[0]?.up === true;
}

const wsDownModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    if (await socketUp(ctx.db, ctx.pageId)) return { kind: "done", reason: "socket_up" };
    return planWithIdentity(WS_DOWN_KEY, ctx, () => ({ kind: "request", request: listRequest(0) }));
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    // The socket was down: the list is the live signal, every chat whose head
    // moved is read now.
    const outcome = await applyListPage(tx, {
      pageId: input.pageId,
      now: input.now,
      key: WS_DOWN_KEY,
      page: input.parsed as FanslyMessagingGroupsPage,
      generation: null,
      classOf: () => "urgent",
    });
    const work: WorkOutcome = await socketUp(tx, input.pageId)
      ? { satisfiesRevision: true, close: "done", closeReason: "socket_up" }
      : { satisfiesRevision: true, nextDueAt: new Date(input.now.getTime() + DM_LIST_WS_DOWN_EVERY_MS) };
    return { work, followups: outcome.followups, counters: outcome.counters };
  },

  async shadow(): Promise<ShadowResult> {
    // Live only: a shadow page never runs it (the registry's `liveOnly`).
    return { work: { satisfiesRevision: true, close: "done", closeReason: "shadow" }, followups: [] };
  },

  replay: replayConversationList,
};

export function dmConversationsModule(variant: DmConversationsVariant): ResourceModule {
  switch (variant) {
    case "head":
      return headModule;
    case "full":
      return fullModule;
    case "find":
      return findModule;
    case "detail":
      return detailModule;
    case "ws-down":
      return wsDownModule;
  }
}
