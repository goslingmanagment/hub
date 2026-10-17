import { describe, expect, it } from "vitest";

import type { PageDmThreadListState } from "@agency_hub_core/db";
import type { FanslyMessagingAggregatedGroup, FanslyMessagingGroup } from "@agency_hub_core/fansly";

import { emptyChain, foldChainPage, type ThreadChain } from "../apps/runtime/src/sync/fansly/lib/chain.ts";
import {
  listHeadNeedsRead,
  listPageUnchanged,
  resolveConversationListItem,
} from "../apps/runtime/src/sync/fansly/lib/conversation-list.ts";
import { resolveDemand } from "../apps/runtime/src/sync/fansly/resources/dm-messages.ts";

// Bug hunt 2026-10-09 (msg-read): a chat whose NEWEST message was deleted.
// Fansly's conversation list keeps naming the deleted message as the chat's
// `lastMessageId` and serves the group's `lastMessage: null` (prod: lora-3
// chat 964012116774244352, list head 964268547746312193 deleted 2026-10-07
// 17:25:01; lora-2 chat 961921420688900096, list head 962035205596536832).
// `/message` never returns that id again, so nothing the engine reads can
// ever "reach" it — and every list pass asks for it again.

const NOW = new Date("2026-10-09T14:00:00Z");
const PAGE = "743702253470232576";
const FAN = "924881748523757569";
const GROUP = "964012116774244352";
const CHAIN_HEAD = "964058353217056769"; // the newest message /message serves
const DELETED_HEAD = "964268547746312193"; // the list's lastMessageId (deleted)

function stored(overrides: Partial<PageDmThreadListState> = {}): PageDmThreadListState {
  return {
    id: 189000001,
    platformConversationId: GROUP,
    fanId: 77,
    partnerPlatformUserId: FAN,
    partnerUsername: "user924881680315981824",
    partnerDisplayName: null,
    conversationFlags: 2,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: CHAIN_HEAD,
    lastUnreadMessageId: "0",
    lastMessageAt: new Date("2026-10-07T03:29:42Z"),
    lastMessageSenderId: PAGE,
    lastMessageSenderRole: "model",
    lastMessagePreview: "not talkative today, are you babe? haha",
    isVisible: true,
    lastSeenGeneration: null,
    metadata: {},
    newestStoredMessageId: CHAIN_HEAD,
    headConfirmedId: CHAIN_HEAD,
    updatedAt: new Date("2026-10-09T13:57:00Z"),
    ...overrides,
  };
}

// The list item and its aggregation group exactly as prod served them
// (attempt 172234, page 3, 2026-10-09 ≈14:00 UTC).
const ITEM: FanslyMessagingGroup = {
  groupId: GROUP,
  partnerAccountId: FAN,
  partnerUsername: "user924881680315981824",
  flags: 2,
  unreadCount: 0,
  subscriptionTierId: null,
  lastMessageId: DELETED_HEAD,
  lastUnreadMessageId: "0",
};
const GROUP_ROW = {
  id: GROUP,
  type: 1,
  users: [
    { type: 0, userId: PAGE, groupId: GROUP, permissionFlags: 65535 },
    { type: 0, userId: FAN, groupId: GROUP, permissionFlags: 65535 },
  ],
  createdBy: PAGE,
  groupFlags: 0,
  lastMessage: null,
} as unknown as FanslyMessagingAggregatedGroup;

function chainAt(head: string): ThreadChain {
  return {
    ...emptyChain(),
    state: "partial",
    headId: head,
    headAt: new Date("2026-10-09T13:58:00Z"),
    oldestId: "964012116954587136",
    oldestCreatedAtMs: null,
    count: 4,
  };
}

/** One list pass + the `.catchup` read it asks for, as the engine runs them. */
function listPassAndCatchup(thread: PageDmThreadListState, chain: ThreadChain) {
  const item = resolveConversationListItem({
    item: ITEM,
    group: GROUP_ROW,
    accountsById: new Map([[FAN, { id: FAN, username: "user924881680315981824", displayName: null }]]),
    aggregationAccountCount: 30,
    existing: thread,
    pageAccountId: PAGE,
  }, NOW);
  const asksRead = listHeadNeedsRead({
    groupId: GROUP,
    fanId: thread.fanId,
    metadata: thread.metadata,
    headConfirmedId: thread.headConfirmedId,
    newestStoredMessageId: thread.newestStoredMessageId,
    listHeadId: item.head.listMessageId,
    listHeadAt: null,
  }, new Date("2026-10-03T19:09:00Z"));
  // The catch-up's `/message` head read: the newest served message is the
  // chain head (the deleted one is gone).
  const page = {
    before: null,
    limit: 25,
    ids: [CHAIN_HEAD, "964056000000000000", "964040000000000000"],
    createdAtMs: [Date.UTC(2026, 9, 7, 3, 29, 42), Date.UTC(2026, 9, 7, 3, 20), Date.UTC(2026, 9, 7, 2)],
    capturedAt: NOW,
    witness: { kind: "attempt" as const, attemptId: 1, observationId: 1, receivedAt: NOW },
  };
  const fold = foldChainPage(chain, null, page, null);
  const resolution = resolveDemand({
    variant: "catchup",
    demandIds: [item.head.listMessageId!],
    pageIds: page.ids,
    walkDone: true,
    restHeadId: page.ids[0]!,
    chain: fold.chain,
    misses: {},
    sentAtMs: NOW.getTime(),
  });
  return { item, asksRead, fold, resolution, storedLastMessageId: item.head.lastMessageId };
}

describe("bughunt msg-read: a deleted newest message is a phantom list head", () => {
  it("every list pass asks a catch-up the read can never satisfy (an endless loop)", () => {
    let thread = stored();
    let chain = chainAt(CHAIN_HEAD);
    const asked: boolean[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const { asksRead, fold, resolution, storedLastMessageId } = listPassAndCatchup(thread, chain);
      asked.push(asksRead);
      // What the catch-up writes back: the chain did not move, the demanded id
      // is dropped and the work closes `caught_up`.
      expect(fold.verdict.kind).toBe("head_unchanged");
      expect(resolution.dropped).toEqual([DELETED_HEAD]);
      chain = fold.chain;
      thread = { ...thread, headConfirmedId: chain.headId, lastMessageId: storedLastMessageId };
    }
    // Desired: once a read showed the chat's head without the list's id, the
    // same list head asks for no further read. Actual: [true, true, true, true].
    expect(asked).toEqual([true, false, false, false]);
  });

  it("the head walk can never stop on a page that holds the chat", () => {
    const { item } = listPassAndCatchup(stored(), chainAt(CHAIN_HEAD));
    // Nothing about the chat changed since the last pass, yet the item is
    // `unchanged: false` (the embedded head is null), so the 30-min head walk
    // reads the next 100-chat page on every pass.
    expect(listPageUnchanged([item])).toBe(true);
  });

  it("a repair or find pass spends three /message reads per phantom chat (head, +15 s, +60 s)", () => {
    const chain = chainAt(CHAIN_HEAD);
    let misses: Record<string, number> = {};
    let reads = 0;
    for (;;) {
      reads += 1;
      const resolution = resolveDemand({
        variant: "head",
        demandIds: [DELETED_HEAD],
        pageIds: [CHAIN_HEAD],
        walkDone: true,
        restHeadId: CHAIN_HEAD,
        chain,
        misses,
        sentAtMs: NOW.getTime() + reads * 60_000,
      });
      if (resolution.expired.length > 0) break;
      misses = resolution.misses;
    }
    expect(reads).toBe(3);
  });
});
