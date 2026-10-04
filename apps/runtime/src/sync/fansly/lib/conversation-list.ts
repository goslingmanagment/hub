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
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
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
// `resolveConversationListItem` is the pure part of the legacy
// dm_conversations sweep's per-conversation step (its loop over
// `page.items`), with its requests taken out: the group detail becomes a
// `dm-conversations.detail` follow-up, the limit-1 head repair is retired (an
// incomplete head keeps the stored id, and the next list read retries it),
// and the unresolvable-partner probe reads its stored answer (a due probe is
// a `fan-profiles.probe` follow-up).

/** A listed chat's head as the thread should hold it. */
export interface ResolvedListHead {
  /** The list row's `lastMessageId` (what the provider says the head is). */
  listMessageId: string | null;
  /** The aggregation group's embedded `lastMessage.id`. */
  embeddedMessageId: string | null;
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
  /** The thread is excluded as unresolvable and no answer of the last day
   *  says otherwise: the probe is due. */
  probeDue: boolean;
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
  /** A stored probe answer younger than the reuse day for this thread's
   *  partner (only read for a thread excluded as unresolvable). */
  probe: "resolved" | "unresolved" | null;
  /** The exclusion reasons the page lifted (`sync_pages.lifted_dm_exclusions`,
   *  owner decision №8): never assigned to a thread this write leaves bound.
   *  Default: none. */
  liftedExclusions?: readonly string[];
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
 * The head block a served head message gives a thread, with the legacy
 * fallbacks: an incomplete head (no time or no sender) keeps the stored time,
 * sender and role — and, when the id moved, the stored id too, so the next
 * read of the list retries it (`preserveHeadForRetry`).
 */
export function resolveListHead(input: {
  listMessageId: string | null;
  headMessage: Pick<FanslyMessage, "id" | "createdAt" | "senderId" | "content"> | null | undefined;
  existing: Pick<PageDmThreadListState, "lastMessageId" | "lastMessageAt" | "lastMessageSenderId" | "lastMessageSenderRole" | "lastMessagePreview"> | null;
  pageAccountId: string;
  partnerId: string | null;
  now: Date;
}): ResolvedListHead {
  const head = input.headMessage ?? null;
  const time = fanslyMessageTime(head?.createdAt, input.now);
  const senderId = nonEmpty(head?.senderId);
  const complete = time.at !== null && senderId !== null;
  const existing = input.existing;
  const preserveHeadForRetry = input.listMessageId !== null && !complete &&
    (existing === null || existing.lastMessageId !== input.listMessageId);
  const role = resolveDmSenderRole(senderId, input.pageAccountId, input.partnerId);
  return {
    listMessageId: input.listMessageId,
    embeddedMessageId: nonEmpty(head?.id),
    servedAt: time.at,
    timestampValid: time.at !== null,
    timestampImplausible: time.implausible,
    lastMessageId: preserveHeadForRetry ? existing?.lastMessageId ?? null : input.listMessageId,
    lastMessageAt: time.at ?? existing?.lastMessageAt ?? null,
    lastMessageSenderId: senderId ?? existing?.lastMessageSenderId ?? null,
    lastMessageSenderRole: complete ? role : existing?.lastMessageSenderRole ?? "unknown",
    lastMessagePreview: truncateDmPreview(typeof head?.content === "string" ? head.content : null)
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
  const head = resolveListHead({
    listMessageId: nonEmpty(item.lastMessageId),
    headMessage: group?.lastMessage ?? null,
    existing,
    pageAccountId,
    partnerId: writtenPartnerId,
    now,
  });

  // The aggregation-missing exclusion is recomputed on every pass (it lifts
  // when the account comes back); the unresolvable one only an answer of the
  // probe lifts. A reason the page lifted (owner decision №8) is not assigned
  // to a thread this write leaves bound — the one it binds now, or bound
  // before (a pass never unbinds); an unbound thread keeps it (the engine
  // reads no unbound chat, and the lift cleared only bound ones).
  const boundAfterWrite = hydrate !== null || (existing?.fanId ?? null) !== null;
  const lifted = (reason: FanslyDmMessageSyncExcludedReason) =>
    boundAfterWrite && (input.liftedExclusions ?? []).includes(reason);
  let exclusion: FanslyDmMessageSyncExcludedReason | null =
    aggregationMissing && !lifted(FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS)
      ? FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS
      : null;
  let probeDue = false;
  if (getFanslyDmMessageSyncExcludedReason(existing?.metadata) ===
    FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP &&
    !lifted(FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP)) {
    if (input.probe !== "resolved") {
      exclusion = FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP;
      probeDue = input.probe === null && writtenPartnerId !== null;
    }
  }
  const unresolvedIdentity = writtenPartnerId === null;

  const diff = diffConversationHead(existing === null ? null : snapshotOf(existing), {
    lastMessageId: head.listMessageId,
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
  // A head the walk can vouch for: the list and its embedded message agree
  // and carry a time — or the chat has no message at all.
  const headKnown = head.listMessageId === null
    ? head.embeddedMessageId === null
    : head.listMessageId === head.embeddedMessageId && head.timestampValid;
  const unchanged = existing !== null && headKnown && !breaksLegacyUnchangedPage(diff.reasons);

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
    probeDue,
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
    })
    : null;
  return { groupId: input.detail.id, members: members.length, partnerPlatformUserId: partner, writtenPartnerId, head };
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
  /** The provider's head id for the chat. */
  listHeadId: string | null;
  /** Its creation time (embedded), else the instant in its snowflake. */
  listHeadAt: Date | null;
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
 * decision №2).
 */
export function listHeadNeedsRead(state: ListHeadFollowupState, engineStartAt: Date | null): boolean {
  if (state.fanId === null || state.listHeadId === null) return false;
  if (getFanslyDmMessageSyncExcludedReason(state.metadata) !== null) return false;
  const known = state.headConfirmedId ?? state.newestStoredMessageId;
  if (known !== null) return compareFanslySnowflakeIds(state.listHeadId, known) === 1;
  return state.listHeadAt !== null && engineStartAt !== null && state.listHeadAt.getTime() > engineStartAt.getTime();
}
