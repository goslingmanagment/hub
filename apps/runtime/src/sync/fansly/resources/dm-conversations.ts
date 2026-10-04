import { sql } from "drizzle-orm";

import {
  countPageDmThreadsByGeneration,
  getSyncPage,
  listOpenWorkSubjects,
  listPageDmThreadIdsStampedWithGeneration,
  listPageDmThreadListStates,
  maxPageDmThreadGeneration,
  readDmFindSharedRead,
  readFanslyAccountProbe,
  upsertPageDmConversationListFields,
  type Database,
  type DmFindSharedRead,
  type PageDmThreadListState,
  type SyncPageRow,
} from "@agency_hub_core/db";
import {
  FANSLY_MESSAGING_GROUPS_PAGE_LIMIT,
  type FanslyAccount,
  type FanslyGroupDetail,
  type FanslyMessagingGroup,
  type FanslyMessagingGroupsPage,
} from "@agency_hub_core/fansly";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
  getFanslyDmMessageSyncExcludedReason,
} from "@agency_hub_core/shared";

import { FANSLY_ACCOUNT_LOOKUP_REUSE_MS, upsertHydratedFansForPage } from "../lib/fan-hydration.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  LocalApplyInput,
  RequestPlan,
  ResourceModule,
  StepPlan,
  WorkOutcome,
} from "../../engine/resource.ts";
import { routeHoldUntil } from "../../engine/route-holds.ts";
import { routeStateOfHolds } from "../../engine/route-policy.ts";
import type { FanslyRoute } from "../routes.ts";
import {
  listHeadInstant,
  listHeadNeedsRead,
  listPageUnchanged,
  resolveConversationListItem,
  resolveGroupDetail,
  type ListHeadFollowupState,
  type ResolvedListItem,
} from "../lib/conversation-list.ts";
import { readFanslyPageFacts, waitForPageIdentity } from "../lib/page-facts.ts";

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
// - find (urgent, a socket event in an unknown chat): the list head, shared
//   by a burst (step 3b ruling 1): the first read of the list head admitted
//   since the find's first demand and applied — whichever list key made it —
//   answers every find. A chat a read wrote since the demand is found with no
//   request, before the HTTP gate (a `local` step that makes sure the chat's
//   urgent message read is asked); a chat such a head read did not show goes
//   to its group detail, which creates the thread (D5), as does every chat
//   while a 429 holds the list's route (`messaging.groups`, owner decision
//   №22: only the keys that can only read the list wait); with neither, the
//   find reads the list head itself.
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
// (urgent) from ws-down, find and repair, and for any chat a `.find` is open
// for, whichever read lists it (the read answers that find).

export type DmConversationsVariant = "head" | "full" | "find" | "detail" | "ws-down";

const HEAD_KEY = "dm-conversations.head";
const FULL_KEY = "dm-conversations.full";
const FIND_KEY = "dm-conversations.find";
const DETAIL_KEY = "dm-conversations.detail";
const WS_DOWN_KEY = "dm-conversations.ws-down";
const MESSAGES_HEAD_KEY = "dm-messages.head";
const MESSAGES_CATCHUP_KEY = "dm-messages.catchup";
const PROBE_KEY = "fan-profiles.probe";
const REPAIR_KEY = "repair.ws-gap";

/** The conversation list's route. */
const LIST_ROUTE = "messaging.groups" satisfies FanslyRoute;

/**
 * The keys that read the conversation list and write every page they read
 * through the list's writer (`applyListPage`): an applied read of the list
 * head by any of them is a `.find`'s shared read (step 3b). Every key of the
 * list route — pinned by tests/sync-registry-coverage.test.ts.
 */
export const DM_LIST_READ_KEYS: readonly string[] = [HEAD_KEY, FULL_KEY, FIND_KEY, WS_DOWN_KEY, REPAIR_KEY];

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
  ctx: { db: Database; pageId: number },
  request: () => StepPlan | Promise<StepPlan>,
): Promise<StepPlan> {
  const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
  if (facts === null) return { kind: "quarantine", reason: "page_missing" };
  if (facts.externalId === null) return waitForPageIdentity(key);
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
 * `dm-messages.head` urgent; urgent too for a chat a `.find` is open for, as
 * this read answers that find), the group detail of a chat without a
 * partner, the probe of an unresolvable partner.
 */
async function threadFollowups(
  db: Database,
  input: { pageId: number; key: string; engineStartAt: Date | null; threads: readonly FollowupThread[] },
): Promise<{ followups: DemandSignal[]; counters: Record<string, number> }> {
  const needRead = input.threads.filter((thread) => listHeadNeedsRead(thread.state, input.engineStartAt));
  const openFinds = await listOpenWorkSubjects(db, {
    pageId: input.pageId,
    resource: FIND_KEY,
    subjects: needRead.filter((thread) => thread.followupClass === "planned").map((thread) => thread.state.groupId),
  });
  const classOf = (thread: FollowupThread): FollowupClass =>
    thread.followupClass === "planned" && openFinds.has(thread.state.groupId) ? "urgent" : thread.followupClass;
  const openHeads = await listOpenWorkSubjects(db, {
    pageId: input.pageId,
    resource: MESSAGES_HEAD_KEY,
    subjects: needRead.filter((thread) => classOf(thread) === "planned").map((thread) => thread.state.groupId),
  });
  const followups: DemandSignal[] = [];
  const counters: Record<string, number> = {};
  const bump = (name: string) => {
    counters[name] = (counters[name] ?? 0) + 1;
  };
  for (const thread of needRead) {
    const groupId = thread.state.groupId;
    const followupClass = classOf(thread);
    if (followupClass === "planned" && openHeads.has(groupId)) {
      bump("catchup_skipped_open_head");
      continue;
    }
    if (followupClass !== thread.followupClass) bump("followup_urgent_open_find");
    followups.push({
      resource: followupClass === "urgent" ? MESSAGES_HEAD_KEY : MESSAGES_CATCHUP_KEY,
      subject: groupId,
      demand: { messageIds: [thread.state.listHeadId!], reason: `list_head:${input.key}` },
    });
    bump(followupClass === "urgent" ? "followup_messages_head" : "followup_messages_catchup");
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
    return planWithIdentity(HEAD_KEY, ctx, () => ({ kind: "request", request: listRequest(cursor.walk?.offset ?? 0) }));
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
        cursor: { ...cursor, generation: walk.generation, walk: null, restartCount: walk.restartCount + 1 },
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
      cursor: { ...cursor, generation: walk.generation, walk: null, restartCount: 0, last: receipt },
      result: receipt,
    },
    followups: [],
    counters: { walk_withheld: 1 },
  };
}

const fullModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseDmListFullCursor(work.cursor);
    return planWithIdentity(FULL_KEY, ctx, () => ({ kind: "request", request: listRequest(cursor.walk?.offset ?? 0) }));
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
          cursor: { ...cursor, generation: walk.generation, walk: { ...next, offset: walk.offset + LIMIT } },
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
        cursor: { ...cursor, generation: walk.generation, walk: null, restartCount: 0, last: receipt },
        proof: receipt,
      },
      followups: outcome.followups,
      counters,
    };
  },
};

// ── find ────────────────────────────────────────────────────────────────────

export interface DmListFindCursor {
  /** `detail` once the list head did not show the chat. */
  step: "list" | "detail";
}

function parseFindCursor(value: unknown): DmListFindCursor {
  return { step: recordOf(value).step === "detail" ? "detail" : "list" };
}

/** The list cannot be read now: a 429 holds its route (`messaging.groups`,
 *  owner decision №22) in the page's hold set. */
function listHeld(page: SyncPageRow, now: Date): boolean {
  const read = routeStateOfHolds(page.holds);
  return read.ok && routeHoldUntil(read.state, LIST_ROUTE, now) !== null;
}

/** The receipt of a find another key's read answered: that read (null: the
 *  chat was written by a read that was no list head read since the demand). */
function sharedReadResult(groupId: string, read: DmFindSharedRead["headRead"]): Record<string, unknown> {
  return {
    groupId,
    step: "list",
    sharedRead: read === null ? null : { attemptId: read.attemptId, resource: read.resource, subject: read.subject },
  };
}

/** What the page's reads since this find's first demand tell it. */
function findSharedRead(db: Database, input: { workId: number; pageId: number; groupId: string }): Promise<DmFindSharedRead> {
  return readDmFindSharedRead(db, {
    workId: input.workId,
    pageId: input.pageId,
    platformConversationId: input.groupId,
    listOperation: LIST_ROUTE,
    listKeys: DM_LIST_READ_KEYS,
  });
}

/** The reason a find closes on another read (`found_by_shared_read`). */
const FOUND_BY_SHARED_READ = "found_by_shared_read";

const findModule: ResourceModule = {
  // Planned before the HTTP gate too (`planBeforeGate`): a find the shared
  // read answered closes there, with no slot.
  async plan(work, ctx): Promise<StepPlan> {
    const groupId = work.subject;
    if (groupId.length === 0) return { kind: "quarantine", reason: "find_without_chat" };
    const cursor = parseFindCursor(work.cursor);
    return planWithIdentity(FIND_KEY, ctx, async (): Promise<StepPlan> => {
      const shared = await findSharedRead(ctx.db, { workId: work.id, pageId: ctx.pageId, groupId });
      // A read since the demand wrote the chat: found, nothing to send — the
      // local step makes sure its urgent message read is asked.
      if (shared.found) return { kind: "local", reason: FOUND_BY_SHARED_READ };
      // Not on a head read since the demand, or the list is held: the chat is
      // found through its group detail alone.
      if (cursor.step === "detail" || shared.headRead !== null || listHeld(ctx.page, ctx.now)) {
        return { kind: "request", request: detailRequest(groupId) };
      }
      return { kind: "request", request: listRequest(0) };
    });
  },

  /**
   * A find a read since its demand answered closes, and its chat's
   * urgent message read is asked unless one is open — the read that wrote the
   * chat asked it when it saw this find open, but a find whose demand
   * committed while that read's apply ran was not there to be seen. Only
   * while the list head is newer than what the message reads reached (a read
   * since may have confirmed it).
   */
  async applyLocal(tx, input: LocalApplyInput): Promise<ApplyResult> {
    const groupId = input.work.subject;
    const shared = await findSharedRead(tx, { workId: input.work.id, pageId: input.pageId, groupId });
    // The thread is gone since the plan (an erasure ran before this step took
    // the fence): the find plans again.
    if (!shared.found) return { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] };
    const [state] = await listPageDmThreadListStates(tx, { platformAccountId: input.pageId, platformConversationIds: [groupId] });
    const openHead = await listOpenWorkSubjects(tx, { pageId: input.pageId, resource: MESSAGES_HEAD_KEY, subjects: [groupId] });
    const page = await getSyncPage(tx, input.pageId);
    const listHeadId = state?.lastMessageId ?? null;
    const needsRead = state !== undefined && !openHead.has(groupId) && listHeadNeedsRead({
      groupId,
      fanId: state.fanId,
      metadata: state.metadata,
      headConfirmedId: state.headConfirmedId,
      newestStoredMessageId: state.newestStoredMessageId,
      listHeadId,
      listHeadAt: listHeadInstant(listHeadId, state.lastMessageAt),
    }, engineStartAt(page));
    const followups: DemandSignal[] = needsRead
      ? [{ resource: MESSAGES_HEAD_KEY, subject: groupId, demand: { messageIds: [listHeadId!], reason: `list_head:${FIND_KEY}` } }]
      : [];
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: FOUND_BY_SHARED_READ,
        cursor: { step: "list" } satisfies DmListFindCursor,
        result: sharedReadResult(groupId, shared.headRead),
      },
      followups,
      counters: needsRead ? { find_shared_read: 1, followup_messages_head: 1 } : { find_shared_read: 1 },
    };
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
};

// ── ws-down (step 3) ────────────────────────────────────────────────────────

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
