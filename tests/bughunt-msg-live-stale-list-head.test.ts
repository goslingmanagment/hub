import { describe, expect, it } from "vitest";

import type { PageDmThreadListState } from "@agency_hub_core/db";
import type { FanslyAccount, FanslyMessagingAggregatedGroup, FanslyMessagingGroup } from "@agency_hub_core/fansly";

import {
  listHeadInstant,
  listHeadNeedsRead,
  listPageUnchanged,
  resolveConversationListItem,
} from "../apps/runtime/src/sync/fansly/lib/conversation-list.ts";

// Bug hunt 2026-10-09 (msg-live): Fansly's conversation list can serve a STALE
// `lastMessageId` for a chat — older than the group's embedded
// `aggregationData.groups[].lastMessage.id` — and sort the chat by that stale
// id. Prod, ari-1 (page 10) chat 963752637080039424: every list read from
// 2026-10-09 05:12 to 12:49 UTC (14 head polls, offset 100) served
// lastMessageId 964389149329092608 (a model message of 10-08 01:24) while the
// embedded lastMessage was 964808195857985536 (the fan's message of 10-09
// 05:09:18). 42 such stale rows on four pages in six days, the longest one
// 18 h (lora-1). The socket happened to deliver every hidden message; the list
// path — the repair after a socket gap, `.ws-down` while the socket is down,
// the 30-min head poll and the daily full walk — never asks for a read of such
// a chat, because `listHeadNeedsRead` compares the STALE list id only.

const NOW = new Date("2026-10-09T05:12:25Z");
const PAGE = "300000000000000001";
const FAN = "962915146519961600";
const GROUP = "963752637080039424";
const STALE_LIST_HEAD = "964389149329092608"; // model, 2026-10-08 01:24:10
const HIDDEN_FAN_MESSAGE = "964808195857985536"; // fan, 2026-10-09 05:09:18
const HIDDEN_AT_MS = Date.parse("2026-10-09T05:09:18.707Z");

// The thread as it stands when the socket missed the 05:09 message: the reads
// reached the model's 01:24 message (the list's stale head).
function stored(): PageDmThreadListState {
  return {
    id: 189021682,
    platformConversationId: GROUP,
    fanId: 31052,
    partnerPlatformUserId: FAN,
    partnerUsername: "fan",
    partnerDisplayName: null,
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: STALE_LIST_HEAD,
    lastUnreadMessageId: null,
    lastMessageAt: new Date("2026-10-08T01:24:10Z"),
    lastMessageSenderId: PAGE,
    lastMessageSenderRole: "model",
    lastMessagePreview: "…",
    isVisible: true,
    lastSeenGeneration: null,
    metadata: {},
    newestStoredMessageId: STALE_LIST_HEAD,
    headConfirmedId: STALE_LIST_HEAD,
    updatedAt: new Date("2026-10-09T04:40:00Z"),
  };
}

const ITEM: FanslyMessagingGroup = {
  groupId: GROUP,
  partnerAccountId: FAN,
  partnerUsername: "fan",
  flags: 0,
  unreadCount: 1,
  subscriptionTierId: null,
  lastMessageId: STALE_LIST_HEAD,
  lastUnreadMessageId: null,
};

const GROUP_ROW: FanslyMessagingAggregatedGroup = {
  id: GROUP,
  users: [
    { groupId: GROUP, userId: PAGE, type: 0, permissionFlags: 0 },
    { groupId: GROUP, userId: FAN, type: 0, permissionFlags: 0 },
  ],
  lastMessage: {
    id: HIDDEN_FAN_MESSAGE,
    type: 1,
    dataVersion: 1,
    content: "…",
    groupId: GROUP,
    senderId: FAN,
    correlationId: null,
    inReplyTo: null,
    inReplyToRoot: null,
    createdAt: HIDDEN_AT_MS / 1000,
    attachments: [],
    embeds: [],
    interactions: [],
    likes: [],
  },
} as unknown as FanslyMessagingAggregatedGroup;

const ACCOUNT: FanslyAccount = { id: FAN, username: "fan", displayName: null };

describe("a stale list lastMessageId hides a new message from every list read", () => {
  const item = resolveConversationListItem({
    item: ITEM,
    group: GROUP_ROW,
    accountsById: new Map([[FAN, ACCOUNT]]),
    aggregationAccountCount: 1,
    existing: stored(),
    pageAccountId: PAGE,
  }, NOW);

  it("the list item knows the newer message (embedded) but keeps the stale id as the head", () => {
    expect(item.head.embeddedMessageId).toBe(HIDDEN_FAN_MESSAGE);
    expect(item.head.listMessageId).toBe(STALE_LIST_HEAD);
    // What the writer stores: the stale id, with the NEWER message's time and
    // sender — a head block that mixes two messages.
    expect(item.head.lastMessageId).toBe(STALE_LIST_HEAD);
    expect(item.head.lastMessageAt?.getTime()).toBe(HIDDEN_AT_MS);
    expect(item.head.lastMessageSenderId).toBe(FAN);
    expect(item.head.lastMessageSenderRole).toBe("fan");
  });

  it("no message read is asked for the chat (the follow-up rule sees the stale id only)", () => {
    const needsRead = listHeadNeedsRead({
      groupId: GROUP,
      fanId: 31052,
      metadata: {},
      headConfirmedId: STALE_LIST_HEAD,
      newestStoredMessageId: STALE_LIST_HEAD,
      // applyListPage passes the list's own id (servedAt only when the ids agree).
      listHeadId: item.head.listMessageId,
      listHeadAt: listHeadInstant(item.head.listMessageId, null),
    }, new Date("2026-10-03T19:08:19Z"));
    // EXPECTED (the embedded head is newer than what the reads reached): true.
    expect(needsRead).toBe(false);
  });

  it("the same chat with the embedded id as its head would be read", () => {
    const needsRead = listHeadNeedsRead({
      groupId: GROUP,
      fanId: 31052,
      metadata: {},
      headConfirmedId: STALE_LIST_HEAD,
      newestStoredMessageId: STALE_LIST_HEAD,
      listHeadId: HIDDEN_FAN_MESSAGE,
      listHeadAt: new Date(HIDDEN_AT_MS),
    }, new Date("2026-10-03T19:08:19Z"));
    expect(needsRead).toBe(true);
  });

  it("the head poll does not stop on the page (head not 'known'), yet reads nothing for it", () => {
    expect(item.unchanged).toBe(false);
    expect(listPageUnchanged([item])).toBe(false);
  });
});
