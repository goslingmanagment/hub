// "Did this conversation's head move?" — one pure function over the whole
// mutable head scope, with the reason list as its output rather than a bare
// boolean.
//
// The legacy dm_conversations sweep (deleted at step 4, S4-14) answered this
// inline, over a HALF of the scope: `lastMessageId`, `unreadCount`,
// `isVisible` and the two metadata markers. A page on which only
// `conversationFlags`, `lastUnreadMessageId` or `subscriptionTierId` moved was
// therefore classified "unchanged" and grew `unchangedPageStreak` — its
// behaviour, not the desired one.
//
// This module keeps both readings available at once, which is the point:
//   * `reasons` is the FULL scope, for a caller that wants the truth;
//   * `LEGACY_UNCHANGED_PAGE_REASONS` is the subset that streak predicate
//     looked at, so the engine's conversation list (`conversation-list.ts`)
//     reproduces that verdict byte for byte.

export type ConversationHeadDiffReason =
  /** No stored row at all — every field below is new by construction, so the
   *  diff reports this ONE reason instead of the whole list. */
  | "missing_row"
  | "last_message_id"
  | "unread_count"
  | "visibility"
  | "unresolved_identity"
  | "message_sync_excluded_reason"
  | "conversation_flags"
  | "last_unread_message_id"
  | "subscription_tier_id"
  | "last_message_at"
  | "last_message_sender_id";

/**
 * The head fields the sweep may rewrite, normalized on both sides so the diff
 * never has to know where a value came from (aggregation block, group detail,
 * head repair, or the stored row it fell back to).
 */
export type ConversationHeadSnapshot = {
  /** For the INCOMING side this is the chat's head — the newer of the list
   *  row's `lastMessageId` and the embedded `lastMessage.id` — NOT the value
   *  the sweep ends up writing: when the head block is incomplete the sweep
   *  preserves the stored id for a later retry (`preserveHeadForRetry`) while
   *  still treating the head as evidence it moved. That is the historical
   *  predicate and it is what the streak reproduces. */
  lastMessageId: string | null;
  unreadCount: number;
  isVisible: boolean;
  conversationFlags: number;
  lastUnreadMessageId: string | null;
  subscriptionTierId: string | null;
  /** The EFFECTIVE value the sweep writes (post head-repair, post fallback to
   *  the stored head), so "changed" means the row's head actually moved. */
  lastMessageAt: Date | null;
  /** Same rule as `lastMessageAt`: the effective written sender. */
  lastMessageSenderId: string | null;
  unresolvedIdentity: boolean;
  messageSyncExcludedReason: string | null;
};

export type ConversationHeadDiff = {
  changed: boolean;
  reasons: readonly ConversationHeadDiffReason[];
};

/**
 * The reasons the `unchangedPageStreak` predicate has always counted. Kept as
 * an explicit constant rather than a second inline condition. A0 does not
 * change this business streak; its diagnostic streak uses the full scope.
 */
export const LEGACY_UNCHANGED_PAGE_REASONS = [
  "missing_row",
  "last_message_id",
  "unread_count",
  "visibility",
  "unresolved_identity",
  "message_sync_excluded_reason",
] as const satisfies readonly ConversationHeadDiffReason[];

const LEGACY_UNCHANGED_PAGE_REASON_SET: ReadonlySet<ConversationHeadDiffReason> = new Set(
  LEGACY_UNCHANGED_PAGE_REASONS,
);

function sameInstant(left: Date | null, right: Date | null) {
  if (left === null || right === null) {
    return left === right;
  }
  return left.getTime() === right.getTime();
}

/**
 * `existing === null` means the sweep has never stored this conversation.
 * Reasons come back in the declaration order above, so a caller may compare
 * them with `toEqual` without sorting.
 */
export function diffConversationHead(
  existing: ConversationHeadSnapshot | null,
  incoming: ConversationHeadSnapshot,
): ConversationHeadDiff {
  if (!existing) {
    return { changed: true, reasons: ["missing_row"] };
  }

  const reasons: ConversationHeadDiffReason[] = [];
  if (existing.lastMessageId !== incoming.lastMessageId) {
    reasons.push("last_message_id");
  }
  if (existing.unreadCount !== incoming.unreadCount) {
    reasons.push("unread_count");
  }
  if (existing.isVisible !== incoming.isVisible) {
    reasons.push("visibility");
  }
  if (existing.unresolvedIdentity !== incoming.unresolvedIdentity) {
    reasons.push("unresolved_identity");
  }
  if (existing.messageSyncExcludedReason !== incoming.messageSyncExcludedReason) {
    reasons.push("message_sync_excluded_reason");
  }
  if (existing.conversationFlags !== incoming.conversationFlags) {
    reasons.push("conversation_flags");
  }
  if (existing.lastUnreadMessageId !== incoming.lastUnreadMessageId) {
    reasons.push("last_unread_message_id");
  }
  if (existing.subscriptionTierId !== incoming.subscriptionTierId) {
    reasons.push("subscription_tier_id");
  }
  if (!sameInstant(existing.lastMessageAt, incoming.lastMessageAt)) {
    reasons.push("last_message_at");
  }
  if (existing.lastMessageSenderId !== incoming.lastMessageSenderId) {
    reasons.push("last_message_sender_id");
  }

  return { changed: reasons.length > 0, reasons };
}

/** True when the diff carries a reason the legacy streak predicate counted,
 *  i.e. this conversation is what makes its page "changed" today. */
export function breaksLegacyUnchangedPage(
  reasons: readonly ConversationHeadDiffReason[],
) {
  return reasons.some((reason) => LEGACY_UNCHANGED_PAGE_REASON_SET.has(reason));
}
