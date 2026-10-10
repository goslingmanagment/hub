import type { DmSenderRole, PageDmThreadListState } from "@agency_hub_core/db";
import type {
  FanslyAccount,
  FanslyGroupDetail,
  FanslyMessage,
  FanslyMessagingAggregatedGroup,
  FanslyMessagingGroup,
} from "@agency_hub_core/fansly";
import {
  compareFanslySnowflakeIds,
  fanslySnowflakeToDate,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  getFanslyDmMessageSyncExcludedReason,
  type FanslyDmMessageSyncExcludedReason,
} from "@agency_hub_core/shared";

import {
  breaksLegacyUnchangedPage,
  diffConversationHead,
  type ConversationHeadDiffReason,
  type ConversationHeadSnapshot,
} from "./dm-head-diff.ts";
import { resolveDmSenderRole } from "./dm-normalize.ts";
import { truncateDmPreview } from "./dm-preview.ts";
import { normalizeFanslyTimestamp } from "./timestamp.ts";

// The conversation list's rules, without I/O (plan §7 p.3, §6.2; design §5.3):
// what one listed chat says about its thread, whether a page of them ends a
// head walk, and whether a chat's list head asks for a message read.
//
// A chat's list head is the newer of the row's `lastMessageId` and the
// group's embedded `lastMessage.id` (`listItemHeadId`): the row sometimes
// serves a stale id. A head above what the message reads reached asks for one
// read; once a head read the chain joined, received 75 s or more after the
// head's creation, did not show it (`listHeadAccounted`: Fansly keeps naming
// a deleted newest message, with `lastMessage: null`), it asks for none — but
// the daily full walk re-reads such a head once (`recheck`). A head walk stops
// on a page whose every head is settled: vouched for by the embedded message
// with a time, or accounted for.
//
// `resolveConversationListItem` is the pure part of the legacy
// dm_conversations sweep's per-conversation step (its loop over
// `page.items`), with its requests taken out: the group detail becomes a
// `dm-conversations.detail` follow-up, the limit-1 head repair is retired (an
// incomplete head keeps the stored id, and the next list read retries it),
// and the unresolvable-partner exclusion is gone: an account lookup that
// resolves no partner is the page's own evidence, never a reason to stop
// reading a chat (arena "vanished chat" §6), so the list neither assigns
// `partner_unresolvable_from_account_lookup` nor keeps it on a chat it writes.

/** A listed chat's head as the thread should hold it. */
export interface ResolvedListHead {
  /** The list row's own `lastMessageId`, raw (it can be stale). */
  listMessageId: string | null;
  /** The aggregation group's embedded `lastMessage.id`. */
  embeddedMessageId: string | null;
  /** The chat's head: the newer of the two (`listItemHeadId`). */
  headId: string | null;
  /** The head is accounted for (`listHeadAccounted`): the stored id is not
   *  kept for a retry. */
  headAccounted: boolean;
  /** The embedded head's creation time as served (null: absent or invalid). */
  servedAt: Date | null;
  /** The embedded head carries a usable creation time. */
  timestampValid: boolean;
  /** The creation time fails the legacy plausibility bounds (counted only). */
  timestampImplausible: boolean;
  lastMessageId: string | null;
  lastMessageAt: Date | null;
  lastMessageSenderId: string | null;
  lastMessageSenderRole: DmSenderRole;
  lastMessagePreview: string | null;
  /** The head block is incomplete: the stored id is kept for a later read. */
  preserveHeadForRetry: boolean;
}

export interface ResolvedListItem {
  groupId: string;
  /** The partner this pass resolved (list row, then the single non-page member). */
  partnerPlatformUserId: string | null;
  /** The partner the row holds after the write (a pass never unbinds). */
  writtenPartnerId: string | null;
  contradictory: boolean;
  aggregationMissing: boolean;
  /** Legacy's condition for an inline `/group/:id` read. */
  needsGroupDetail: boolean;
  /** Ask `dm-conversations.detail`: the detail is needed and could change
   *  what the row holds (no partner yet, a new row, or a new contradiction). */
  requestGroupDetail: boolean;
  /** The fan to ensure for the partner: a profile served with the list, or an
   *  id without one (ensured unverified); null for none (or an excluded chat,
   *  which keeps the fan it had). */
  hydrate: { account: FanslyAccount } | { unverifiedId: string } | null;
  partnerUsername: string | null;
  partnerDisplayName: string | null;
  list: { conversationFlags: number; unreadCount: number; subscriptionTierId: string | null; lastUnreadMessageId: string | null };
  head: ResolvedListHead;
  unresolvedIdentity: boolean;
  messageSyncExcludedReason: FanslyDmMessageSyncExcludedReason | null;
  /** A served scalar was not an integer (the stored value is kept). */
  scalarDrift: boolean;
  diffReasons: readonly ConversationHeadDiffReason[];
  /** The item leaves its thread as it was: the head walk may stop here. */
  unchanged: boolean;
}

export interface ResolveListItemInput {
  item: FanslyMessagingGroup;
  group: FanslyMessagingAggregatedGroup | null;
  accountsById: ReadonlyMap<string, FanslyAccount>;
  /** `aggregationData.accounts.length` of the page. */
  aggregationAccountCount: number;
  existing: PageDmThreadListState | null;
  /** The page's own Fansly account id. */
  pageAccountId: string;
  /** The exclusion reasons the page lifted (`sync_pages.lifted_dm_exclusions`,
   *  owner decision №8): never assigned to a thread this write leaves bound.
   *  Default: none. */
  liftedExclusions?: readonly string[];
  /** The engine's start on the page (`legacy_imported_at ?? mode_changed_at`):
   *  only a head read since then accounts for a list head. */
  engineStartAt: Date | null;
}

const EARLIEST_PLAUSIBLE_MS = Date.UTC(2010, 0, 1);
const LATEST_PLAUSIBLE_AHEAD_MS = 24 * 60 * 60 * 1000;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** A Fansly message time (seconds or ms) as a Date, or null when absent. */
export function fanslyMessageTime(value: unknown, now: Date): { at: Date | null; implausible: boolean } {
  if (typeof value !== "number" || !Number.isFinite(value)) return { at: null, implausible: false };
  const at = normalizeFanslyTimestamp(value);
  if (Number.isNaN(at.getTime())) return { at: null, implausible: false };
  const ms = at.getTime();
  return { at, implausible: ms < EARLIEST_PLAUSIBLE_MS || ms > now.getTime() + LATEST_PLAUSIBLE_AHEAD_MS };
}

/** The non-page members of a group (unique, in served order). */
function nonPageMembers(users: ReadonlyArray<{ userId?: unknown }> | undefined, pageAccountId: string): string[] {
  const ids: string[] = [];
  for (const user of users ?? []) {
    const id = nonEmpty(user.userId);
    if (id !== null && id !== pageAccountId && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function snapshotOf(state: PageDmThreadListState): ConversationHeadSnapshot {
  return {
    lastMessageId: state.lastMessageId,
    unreadCount: state.unreadCount,
    isVisible: state.isVisible,
    conversationFlags: state.conversationFlags,
    lastUnreadMessageId: state.lastUnreadMessageId,
    subscriptionTierId: state.subscriptionTierId,
    lastMessageAt: state.lastMessageAt,
    lastMessageSenderId: state.lastMessageSenderId,
    unresolvedIdentity: state.metadata.unresolvedIdentity === true,
    messageSyncExcludedReason: getFanslyDmMessageSyncExcludedReason(state.metadata),
  };
}

/**
 * A chat's head: the newer (snowflake) of the list row's `lastMessageId` and
 * the group's embedded `lastMessage.id` (design §5.3) — the row sometimes
 * serves a stale id. Ids that do not compare (not decimal) leave the row's.
 */
export function listItemHeadId(listId: string | null, embeddedId: string | null): string | null {
  if (listId !== null && embeddedId !== null && compareFanslySnowflakeIds(embeddedId, listId) === 1) return embeddedId;
  return listId ?? embeddedId;
}

/** How long `.head` waits for a missing id before `not_found`: 15 s + 60 s
 *  (`DM_HEAD_NOT_FOUND_RETRY_MS`, pinned by a test). */
export const DM_LIST_HEAD_ANSWERED_AFTER_MS = 75_000;

/**
 * A list head the message reads already account for: at or below what they
 * reached (`known` = `coalesce(head_confirmed_id, newest_stored_message_id)`),
 * or above it while the chain joined a head read received at least 75 s after
 * the head's creation (`head_confirmed_at`, no earlier than the engine's start
 * on the page). That read showed the chat's newest messages and its walk
 * reached the chain, so a head above the chain is one REST did not serve
 * (deleted, or never served): another read would add nothing. A walk that
 * has not reached the chain — still going, or closed before it — moves no
 * `head_confirmed_at` and accounts for nothing.
 */
export function listHeadAccounted(input: {
  headId: string;
  known: string | null;
  headConfirmedAt: Date | null;
  engineStartAt: Date | null;
}): boolean {
  if (input.known !== null) {
    const order = compareFanslySnowflakeIds(input.headId, input.known);
    if (order === -1 || order === 0) return true;
  }
  const createdAt = listHeadInstant(input.headId, null);
  if (createdAt === null || input.headConfirmedAt === null || input.engineStartAt === null) return false;
  const confirmedMs = input.headConfirmedAt.getTime();
  return confirmedMs >= input.engineStartAt.getTime() && confirmedMs >= createdAt.getTime() + DM_LIST_HEAD_ANSWERED_AFTER_MS;
}

/**
 * The head block a served head message gives a thread, with the legacy
 * fallbacks. The head is `listItemHeadId`; the embedded message gives the
 * time, sender, role and preview only when it is that head. An incomplete
 * head (the embedded message is not the head, or has no time or no sender)
 * keeps the stored time, sender and role — and, when the id moved and the
 * head is not accounted for, the stored id too, so the next read of the list
 * retries it (`preserveHeadForRetry`). An accounted head is written with the
 * stored time and sender.
 */
export function resolveListHead(input: {
  listMessageId: string | null;
  headMessage: Pick<FanslyMessage, "id" | "createdAt" | "senderId" | "content"> | null | undefined;
  existing: Pick<PageDmThreadListState, "lastMessageId" | "lastMessageAt" | "lastMessageSenderId" | "lastMessageSenderRole" | "lastMessagePreview"> | null;
  pageAccountId: string;
  partnerId: string | null;
  now: Date;
  /** `listHeadAccounted` for the head (false for a group detail). */
  headAccounted: boolean;
}): ResolvedListHead {
  const head = input.headMessage ?? null;
  const embeddedMessageId = nonEmpty(head?.id);
  const headId = listItemHeadId(input.listMessageId, embeddedMessageId);
  const isHead = embeddedMessageId !== null && embeddedMessageId === headId;
  const time = fanslyMessageTime(head?.createdAt, input.now);
  const senderId = nonEmpty(head?.senderId);
  const headAt = isHead ? time.at : null;
  const headSenderId = isHead ? senderId : null;
  const headComplete = headAt !== null && headSenderId !== null;
  const existing = input.existing;
  const preserveHeadForRetry = headId !== null && !headComplete && !input.headAccounted &&
    (existing === null || existing.lastMessageId !== headId);
  const role = resolveDmSenderRole(headSenderId, input.pageAccountId, input.partnerId);
  return {
    listMessageId: input.listMessageId,
    embeddedMessageId,
    headId,
    headAccounted: input.headAccounted,
    servedAt: time.at,
    timestampValid: time.at !== null,
    timestampImplausible: time.implausible,
    lastMessageId: preserveHeadForRetry ? existing?.lastMessageId ?? null : headId,
    lastMessageAt: headAt ?? existing?.lastMessageAt ?? null,
    lastMessageSenderId: headSenderId ?? existing?.lastMessageSenderId ?? null,
    lastMessageSenderRole: headComplete ? role : existing?.lastMessageSenderRole ?? "unknown",
    lastMessagePreview: (isHead ? truncateDmPreview(typeof head?.content === "string" ? head.content : null) : null)
      ?? existing?.lastMessagePreview ?? null,
    preserveHeadForRetry,
  };
}

/**
 * What one listed chat says about its thread. Pure: the probe answer and the
 * stored row are read by the caller.
 */
export function resolveConversationListItem(input: ResolveListItemInput, now: Date): ResolvedListItem {
  const { item, group, existing, pageAccountId } = input;
  const groupId = item.groupId;
  const aggregated = nonPageMembers(group?.users, pageAccountId);
  let partner = nonEmpty(item.partnerAccountId);
  const contradictory = (aggregated.length === 1 && partner !== null && aggregated[0] !== partner) ||
    aggregated.length > 1;
  if (partner === null && aggregated.length === 1) partner = aggregated[0]!;
  const aggregationMissing = partner !== null && input.aggregationAccountCount > 0 && !input.accountsById.has(partner);
  const needsGroupDetail = (partner === null || contradictory) && !aggregationMissing;
  const writtenPartnerId = partner ?? existing?.partnerPlatformUserId ?? null;
  const requestGroupDetail = needsGroupDetail &&
    (writtenPartnerId === null || existing === null || (partner !== null && existing.partnerPlatformUserId !== partner));

  const snapshot = partner === null ? null : input.accountsById.get(partner) ?? null;
  const partnerUsername = snapshot?.username ?? nonEmpty(item.partnerUsername) ?? existing?.partnerUsername ?? null;
  const partnerDisplayName = snapshot?.displayName ?? existing?.partnerDisplayName ?? null;
  let hydrate: ResolvedListItem["hydrate"] = null;
  if (partner !== null && !aggregationMissing) {
    hydrate = snapshot === null
      ? { unverifiedId: partner }
      : {
        account: {
          id: partner,
          username: partnerUsername,
          displayName: partnerDisplayName,
          ...(snapshot.createdAt === undefined ? {} : { createdAt: snapshot.createdAt }),
          ...(snapshot.notes === undefined ? {} : { notes: snapshot.notes }),
        },
      };
  }

  const flags = int(item.flags);
  const unread = int(item.unreadCount);
  const list = {
    conversationFlags: flags ?? existing?.conversationFlags ?? 0,
    unreadCount: unread ?? existing?.unreadCount ?? 0,
    subscriptionTierId: text(item.subscriptionTierId),
    lastUnreadMessageId: text(item.lastUnreadMessageId),
  };
  const listMessageId = nonEmpty(item.lastMessageId);
  const headId = listItemHeadId(listMessageId, nonEmpty(group?.lastMessage?.id));
  const headAccounted = existing !== null && headId !== null && listHeadAccounted({
    headId,
    known: existing.headConfirmedId ?? existing.newestStoredMessageId,
    headConfirmedAt: existing.headConfirmedAt,
    engineStartAt: input.engineStartAt,
  });
  const head = resolveListHead({
    listMessageId,
    headMessage: group?.lastMessage ?? null,
    existing,
    pageAccountId,
    partnerId: writtenPartnerId,
    now,
    headAccounted,
  });

  // The aggregation-missing exclusion is the only one the list writes, and it
  // is recomputed on every pass (it lifts when the account comes back). A
  // stored unresolvable one is not kept: this write takes it off. A reason the
  // page lifted (owner decision №8) is not assigned to a thread this write
  // leaves bound — the one it binds now, or bound before (a pass never
  // unbinds); an unbound thread keeps it (the engine reads no unbound chat,
  // and the lift cleared only bound ones).
  const boundAfterWrite = hydrate !== null || (existing?.fanId ?? null) !== null;
  const lifted = (reason: FanslyDmMessageSyncExcludedReason) =>
    boundAfterWrite && (input.liftedExclusions ?? []).includes(reason);
  const exclusion: FanslyDmMessageSyncExcludedReason | null =
    aggregationMissing && !lifted(FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS)
      ? FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS
      : null;
  const unresolvedIdentity = writtenPartnerId === null;

  const diff = diffConversationHead(existing === null ? null : snapshotOf(existing), {
    lastMessageId: head.headId,
    unreadCount: list.unreadCount,
    isVisible: true,
    conversationFlags: list.conversationFlags,
    lastUnreadMessageId: list.lastUnreadMessageId,
    subscriptionTierId: list.subscriptionTierId,
    lastMessageAt: head.lastMessageAt,
    lastMessageSenderId: head.lastMessageSenderId,
    unresolvedIdentity,
    messageSyncExcludedReason: exclusion,
  });
  // A settled head: the embedded message is the head and carries a time (or
  // the chat has no message at all), or the reads account for it — it tells
  // the walk nothing new, and the next page is not about this chat.
  const vouched = head.headId === null || (head.embeddedMessageId === head.headId && head.timestampValid);
  const unchanged = existing !== null && (vouched || head.headAccounted) && !breaksLegacyUnchangedPage(diff.reasons);

  return {
    groupId,
    partnerPlatformUserId: partner,
    writtenPartnerId,
    contradictory,
    aggregationMissing,
    needsGroupDetail,
    requestGroupDetail,
    hydrate,
    partnerUsername,
    partnerDisplayName,
    list,
    head,
    unresolvedIdentity,
    messageSyncExcludedReason: exclusion,
    scalarDrift: (item.flags !== undefined && flags === null) || (item.unreadCount !== undefined && unread === null),
    diffReasons: diff.reasons,
    unchanged,
  };
}

/** A page of the list ends a head walk: every item leaves its thread as it was. */
export function listPageUnchanged(items: readonly Pick<ResolvedListItem, "unchanged">[]): boolean {
  return items.length > 0 && items.every((item) => item.unchanged);
}

/** What a group detail says about its thread (`.find`, `.detail`). */
export interface ResolvedGroupDetail {
  groupId: string;
  /** How many members the group has besides the page: a detail creates a
   *  thread only for exactly one (D5) — the page's own mass-message container
   *  (a type-3 group of the page alone) and a group of several are no chat. */
  members: number;
  /** The single non-page member, or null (none, or several). */
  partnerPlatformUserId: string | null;
  writtenPartnerId: string | null;
  /** The detail's head, when it improves on the stored one (a new row, no
   *  stored head, or a newer id); else null (the stored head stays). */
  head: ResolvedListHead | null;
  /** The exclusion the write keeps: the stored aggregation-missing one (a
   *  detail serves no page accounts to recompute it from), never a stored
   *  unresolvable one, which the list no longer keeps. */
  messageSyncExcludedReason: FanslyDmMessageSyncExcludedReason | null;
}

export function resolveGroupDetail(input: {
  detail: FanslyGroupDetail;
  existing: PageDmThreadListState | null;
  pageAccountId: string;
  now: Date;
}): ResolvedGroupDetail {
  const members = nonPageMembers(input.detail.users, input.pageAccountId);
  const partner = members.length === 1 ? members[0]! : null;
  const writtenPartnerId = partner ?? input.existing?.partnerPlatformUserId ?? null;
  const message = input.detail.lastMessage ?? null;
  const messageId = nonEmpty(message?.id);
  const storedId = input.existing?.lastMessageId ?? null;
  const newer = messageId !== null &&
    (input.existing === null || storedId === null || compareFanslySnowflakeIds(messageId, storedId) === 1);
  const head = newer
    ? resolveListHead({
      listMessageId: messageId,
      headMessage: message,
      existing: input.existing,
      pageAccountId: input.pageAccountId,
      partnerId: writtenPartnerId,
      now: input.now,
      headAccounted: false,
    })
    : null;
  const stored = getFanslyDmMessageSyncExcludedReason(input.existing?.metadata);
  const messageSyncExcludedReason =
    stored === FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS ? stored : null;
  return {
    groupId: input.detail.id,
    members: members.length,
    partnerPlatformUserId: partner,
    writtenPartnerId,
    head,
    messageSyncExcludedReason,
  };
}

// ── follow-ups: does a chat need a message read? ────────────────────────────

/** A thread as the follow-up rule sees it after the list wrote it. */
export interface ListHeadFollowupState {
  groupId: string;
  fanId: number | null;
  metadata: Record<string, unknown>;
  /** The message reads' position (read before the list write; the list never moves it). */
  headConfirmedId: string | null;
  newestStoredMessageId: string | null;
  /** `head_confirmed_at`: the receipt of the newest head read the chain
   *  joined (read before the list write; the list never moves it). */
  headConfirmedAt: Date | null;
  /** The chat's head: the newer of the list row's id and the embedded
   *  `lastMessage.id` (`listItemHeadId`). */
  listHeadId: string | null;
  /** Its creation time (embedded), else the instant in its snowflake. */
  listHeadAt: Date | null;
  /** The newest list head an established chat-unavailability episode of the
   *  chat already answered with a read (`handled_list_head_id`; absent or
   *  null: none). */
  unavailableHandledHeadId?: string | null;
}

/** The creation instant of a list head: the time served with it, else the
 *  instant in its snowflake. */
export function listHeadInstant(listHeadId: string | null, servedAt: Date | null): Date | null {
  if (servedAt !== null) return servedAt;
  if (listHeadId === null || !/^\d+$/.test(listHeadId)) return null;
  return fanslySnowflakeToDate(listHeadId);
}

/**
 * Whether a listed chat needs its messages read (design §5.3 follow-ups): a
 * bound, non-excluded thread whose list head is strictly newer (snowflake)
 * than what the message reads reached, `coalesce(head_confirmed_id,
 * newest_stored_message_id)`. A thread neither has read (nothing stored,
 * never confirmed) only when its head is later than the engine's start on the
 * page (`engineStartAt`): a chat that began under the engine and was missed
 * live. An older never-read chat is history — read by request only (owner
 * decision №2). A chat Fansly refuses to the page (an established
 * chat-unavailability episode, arena "vanished chat" §2.3) asks for no read
 * of a list head its episode already answered: only a newer head gives one
 * read (after the episode's retry boundary, which the read's plan waits for).
 * A head a late enough chain-joined head read did not show asks for no read
 * (`listHeadAccounted`), except on the full walk (`recheck`): a message the
 * socket missed and REST served later than 75 s is read within a day.
 */
export function listHeadNeedsRead(state: ListHeadFollowupState, engineStartAt: Date | null, recheck = false): boolean {
  if (state.fanId === null || state.listHeadId === null) return false;
  if (getFanslyDmMessageSyncExcludedReason(state.metadata) !== null) return false;
  const handled = state.unavailableHandledHeadId ?? null;
  if (handled !== null && compareFanslySnowflakeIds(state.listHeadId, handled) !== 1) return false;
  const known = state.headConfirmedId ?? state.newestStoredMessageId;
  if (!recheck && listHeadAccounted({ headId: state.listHeadId, known, headConfirmedAt: state.headConfirmedAt, engineStartAt })) {
    return false;
  }
  if (known !== null) return compareFanslySnowflakeIds(state.listHeadId, known) === 1;
  return state.listHeadAt !== null && engineStartAt !== null && state.listHeadAt.getTime() > engineStartAt.getTime();
}
