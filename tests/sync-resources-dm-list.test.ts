import { describe, expect, it } from "vitest";

import type { PageDmThreadListState } from "@agency_hub_core/db";
import type { FanslyAccount, FanslyMessagingAggregatedGroup, FanslyMessagingGroup } from "@agency_hub_core/fansly";
import {
  compareFanslyFollowIds,
  compareFanslySnowflakeIds,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
} from "@agency_hub_core/shared";

import { prepareJournalBody } from "../apps/runtime/src/sync/fansly/capture.ts";
import { emptyChain, foldChainPage, type ThreadChain } from "../apps/runtime/src/sync/fansly/lib/chain.ts";
import {
  DM_LIST_HEAD_ANSWERED_AFTER_MS,
  listHeadAccounted,
  listHeadInstant,
  listHeadNeedsRead,
  listItemHeadId,
  listPageUnchanged,
  resolveConversationListItem,
  resolveGroupDetail,
  type ListHeadFollowupState,
  type ResolvedListItem,
  type ResolveListItemInput,
} from "../apps/runtime/src/sync/fansly/lib/conversation-list.ts";
import { truncateDmPreview } from "../apps/runtime/src/sync/fansly/lib/dm-preview.ts";
import {
  parseDmListFullCursor,
  parseDmListHeadCursor,
} from "../apps/runtime/src/sync/fansly/resources/dm-conversations.ts";
import { DM_HEAD_NOT_FOUND_RETRY_MS } from "../apps/runtime/src/sync/fansly/resources/dm-messages.ts";

// The conversation list's rules without I/O (design §5.3): what a listed chat
// says about its thread, when a page of chats ends a head walk, when a list
// head asks for a message read, and the cursors and journal around them.

const NOW = new Date("2026-10-02T12:00:00Z");
const PAGE = "300000000000000001";
const FAN = "500000000000000001";
const OTHER = "500000000000000002";
const GROUP = "700000000000000001";
const HEAD_ID = "910000000000000005";
const HEAD_AT_MS = Date.UTC(2026, 9, 2, 11, 0, 0);

function state(overrides: Partial<PageDmThreadListState> = {}): PageDmThreadListState {
  return {
    id: 1,
    platformConversationId: GROUP,
    fanId: 10,
    partnerPlatformUserId: FAN,
    partnerUsername: "fan",
    partnerDisplayName: "Fan",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: HEAD_ID,
    lastUnreadMessageId: null,
    lastMessageAt: new Date(HEAD_AT_MS),
    lastMessageSenderId: FAN,
    lastMessageSenderRole: "fan",
    lastMessagePreview: "hi",
    isVisible: true,
    lastSeenGeneration: null,
    metadata: {},
    newestStoredMessageId: HEAD_ID,
    headConfirmedId: null,
    headConfirmedAt: null,
    updatedAt: new Date(HEAD_AT_MS),
    ...overrides,
  };
}

function row(overrides: Partial<FanslyMessagingGroup> = {}): FanslyMessagingGroup {
  return {
    groupId: GROUP,
    partnerAccountId: FAN,
    partnerUsername: "fan",
    flags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: HEAD_ID,
    lastUnreadMessageId: null,
    ...overrides,
  };
}

function group(overrides: Partial<FanslyMessagingAggregatedGroup> = {}, message: Record<string, unknown> = {}): FanslyMessagingAggregatedGroup {
  return {
    id: GROUP,
    users: [
      { groupId: GROUP, userId: PAGE, type: 0, permissionFlags: 0 },
      { groupId: GROUP, userId: FAN, type: 0, permissionFlags: 0 },
    ],
    lastMessage: {
      id: HEAD_ID,
      type: 1,
      dataVersion: 1,
      content: "hi",
      groupId: GROUP,
      senderId: FAN,
      correlationId: null,
      inReplyTo: null,
      inReplyToRoot: null,
      createdAt: HEAD_AT_MS,
      attachments: [],
      embeds: [],
      interactions: [],
      likes: [],
      ...message,
    },
    ...overrides,
  };
}

function account(id: string): FanslyAccount {
  return { id, username: `u${id.slice(-4)}`, displayName: `Fan ${id.slice(-4)}` };
}

function input(overrides: Partial<ResolveListItemInput> = {}): ResolveListItemInput {
  return {
    item: row(),
    group: group(),
    accountsById: new Map([[FAN, account(FAN)]]),
    aggregationAccountCount: 1,
    existing: state(),
    pageAccountId: PAGE,
    engineStartAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

describe("resolveConversationListItem", () => {
  it("an unchanged chat: same head, a head with a time, nothing the streak counts", () => {
    const item = resolveConversationListItem(input(), NOW);
    expect(item).toMatchObject({
      partnerPlatformUserId: FAN,
      writtenPartnerId: FAN,
      contradictory: false,
      aggregationMissing: false,
      needsGroupDetail: false,
      requestGroupDetail: false,
      unresolvedIdentity: false,
      messageSyncExcludedReason: null,
      unchanged: true,
    });
    expect(item.hydrate).toEqual({ account: { id: FAN, username: `u${FAN.slice(-4)}`, displayName: `Fan ${FAN.slice(-4)}` } });
    expect(item.head).toMatchObject({
      listMessageId: HEAD_ID,
      lastMessageId: HEAD_ID,
      lastMessageAt: new Date(HEAD_AT_MS),
      lastMessageSenderRole: "fan",
      preserveHeadForRetry: false,
    });
  });

  it("a moved head, a new row and a moved unread count each change the page; flags alone do not (legacy streak)", () => {
    const newer = "910000000000000009";
    expect(resolveConversationListItem(input({
      item: row({ lastMessageId: newer }),
      group: group({}, { id: newer, createdAt: HEAD_AT_MS + 1000 }),
    }), NOW)).toMatchObject({ unchanged: false, diffReasons: expect.arrayContaining(["last_message_id"]) });
    expect(resolveConversationListItem(input({ existing: null }), NOW)).toMatchObject({ unchanged: false, diffReasons: ["missing_row"] });
    expect(resolveConversationListItem(input({ item: row({ unreadCount: 3 }) }), NOW).unchanged).toBe(false);
    expect(resolveConversationListItem(input({ item: row({ flags: 4 }) }), NOW)).toMatchObject({
      unchanged: true,
      diffReasons: ["conversation_flags"],
    });
  });

  it("a head newer than the reads that the walk cannot vouch for keeps the page changed; one the reads reached does not", () => {
    // List and embedded ids disagree, the embedded head has no time, or no
    // aggregation group: the reads reached an older message, nothing answered
    // the head.
    const behind = state({ newestStoredMessageId: "910000000000000003" });
    expect(resolveConversationListItem(input({ group: group({}, { id: "910000000000000004" }), existing: behind }), NOW).unchanged).toBe(false);
    expect(resolveConversationListItem(input({ group: group({}, { createdAt: null }), existing: behind }), NOW).unchanged).toBe(false);
    expect(resolveConversationListItem(input({ group: null, existing: behind }), NOW).unchanged).toBe(false);
    // The same three with the head the reads reached: nothing new, the walk may stop.
    expect(resolveConversationListItem(input({ group: group({}, { id: "910000000000000004" }) }), NOW).unchanged).toBe(true);
    expect(resolveConversationListItem(input({ group: group({}, { createdAt: null }) }), NOW).unchanged).toBe(true);
    expect(resolveConversationListItem(input({ group: null }), NOW).unchanged).toBe(true);
    // A chat without any message is as known as it gets.
    const empty = resolveConversationListItem(input({
      item: row({ lastMessageId: null }),
      group: group({ lastMessage: null }),
      existing: state({ lastMessageId: null, lastMessageAt: null, lastMessageSenderId: null, lastMessageSenderRole: "unknown" }),
    }), NOW);
    expect(empty.unchanged).toBe(true);
  });

  it("an incomplete new head keeps the stored id, time and sender for a later read", () => {
    const newer = "910000000000000009";
    const item = resolveConversationListItem(input({
      item: row({ lastMessageId: newer }),
      group: group({}, { id: newer, createdAt: null, senderId: null, content: "new text" }),
    }), NOW);
    expect(item.head).toMatchObject({
      listMessageId: newer,
      lastMessageId: HEAD_ID,
      lastMessageAt: new Date(HEAD_AT_MS),
      lastMessageSenderId: FAN,
      lastMessageSenderRole: "fan",
      lastMessagePreview: "new text",
      preserveHeadForRetry: true,
    });
    expect(item.unchanged).toBe(false);
  });

  it("names the partner from the single non-page member, and asks for the detail when nothing names one", () => {
    const fromGroup = resolveConversationListItem(input({ item: row({ partnerAccountId: null }) }), NOW);
    expect(fromGroup).toMatchObject({ partnerPlatformUserId: FAN, contradictory: false, needsGroupDetail: false });

    const nothing = resolveConversationListItem(input({ item: row({ partnerAccountId: null }), group: null, existing: null }), NOW);
    expect(nothing).toMatchObject({
      partnerPlatformUserId: null,
      writtenPartnerId: null,
      needsGroupDetail: true,
      requestGroupDetail: true,
      unresolvedIdentity: true,
      hydrate: null,
    });
  });

  it("never unbinds: a pass without a partner keeps the stored one and asks for no detail", () => {
    const item = resolveConversationListItem(input({ item: row({ partnerAccountId: null }), group: null }), NOW);
    expect(item).toMatchObject({
      partnerPlatformUserId: null,
      writtenPartnerId: FAN,
      needsGroupDetail: true,
      requestGroupDetail: false,
      unresolvedIdentity: false,
    });
  });

  it("a contradiction asks for the detail only when it could change the row", () => {
    const twoMembers = group({
      users: [
        { groupId: GROUP, userId: PAGE, type: 0, permissionFlags: 0 },
        { groupId: GROUP, userId: FAN, type: 0, permissionFlags: 0 },
        { groupId: GROUP, userId: OTHER, type: 0, permissionFlags: 0 },
      ],
    });
    const stable = resolveConversationListItem(input({ group: twoMembers }), NOW);
    expect(stable).toMatchObject({ contradictory: true, needsGroupDetail: true, requestGroupDetail: false, partnerPlatformUserId: FAN });
    const fresh = resolveConversationListItem(input({ group: twoMembers, existing: null }), NOW);
    expect(fresh.requestGroupDetail).toBe(true);
    const moved = resolveConversationListItem(input({ group: twoMembers, existing: state({ partnerPlatformUserId: OTHER }) }), NOW);
    expect(moved.requestGroupDetail).toBe(true);
  });

  it("a partner the page's accounts omit is excluded, ensures no fan and gets no detail; the flag lifts when it returns", () => {
    const missing = resolveConversationListItem(input({ accountsById: new Map([[OTHER, account(OTHER)]]) }), NOW);
    expect(missing).toMatchObject({
      aggregationMissing: true,
      needsGroupDetail: false,
      hydrate: null,
      messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
    });
    const back = resolveConversationListItem(input({
      existing: state({
        metadata: { messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS },
      }),
    }), NOW);
    expect(back.messageSyncExcludedReason).toBeNull();
    // Without any accounts on the page there is nothing to miss: the fan is
    // ensured without a profile.
    const noAccounts = resolveConversationListItem(input({ accountsById: new Map(), aggregationAccountCount: 0 }), NOW);
    expect(noAccounts).toMatchObject({ aggregationMissing: false, hydrate: { unverifiedId: FAN } });
  });

  it("a stored unresolvable exclusion (a lookup miss, page-local evidence) is not kept: the write takes it off, nothing is probed", () => {
    const excluded = state({ metadata: { messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP } });
    const item = resolveConversationListItem(input({ existing: excluded }), NOW);
    expect(item).toMatchObject({ messageSyncExcludedReason: null, hydrate: { account: expect.objectContaining({ id: FAN }) } });
    expect(item).not.toHaveProperty("probeDue");
    // The exclusion leaving is a change: a head walk does not stop on it.
    expect(item.diffReasons).toEqual(["message_sync_excluded_reason"]);
    expect(item.unchanged).toBe(false);
    // Whatever the page lifted, and on an unbound thread too.
    for (const liftedExclusions of [[], [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP]]) {
      expect(resolveConversationListItem(input({ existing: excluded, liftedExclusions }), NOW).messageSyncExcludedReason).toBeNull();
    }
    const unbound = state({ fanId: null, metadata: excluded.metadata });
    expect(resolveConversationListItem(input({ existing: unbound }), NOW).messageSyncExcludedReason).toBeNull();
    // An aggregation miss of the same chat is excluded for that reason alone.
    expect(resolveConversationListItem(input({ existing: excluded, accountsById: new Map([[OTHER, account(OTHER)]]) }), NOW)
      .messageSyncExcludedReason).toBe(FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS);
  });

  it("a reason the page lifted (owner decision №8) is never assigned to a bound thread; an unbound one keeps it", () => {
    const missingAccounts = { accountsById: new Map([[OTHER, account(OTHER)]]) };
    const lifted = [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS];
    // Bound before (a pass never unbinds): the lifted reason is not assigned,
    // the pass still ensures no fan and asks for no detail.
    expect(resolveConversationListItem(input({ ...missingAccounts, liftedExclusions: lifted }), NOW)).toMatchObject({
      aggregationMissing: true,
      hydrate: null,
      needsGroupDetail: false,
      messageSyncExcludedReason: null,
    });
    // Unbound: the engine reads no unbound chat, the lift cleared only bound ones.
    expect(resolveConversationListItem(input({ ...missingAccounts, liftedExclusions: lifted, existing: state({ fanId: null }) }), NOW))
      .toMatchObject({ messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS });
    expect(resolveConversationListItem(input({ ...missingAccounts, liftedExclusions: lifted, existing: null }), NOW))
      .toMatchObject({ messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS });
    // Another reason lifted, or none: excluded as before.
    for (const other of [[], [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP]]) {
      expect(resolveConversationListItem(input({ ...missingAccounts, liftedExclusions: other }), NOW).messageSyncExcludedReason)
        .toBe(FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS);
    }
  });

  it("keeps the stored count when a served scalar is not an integer", () => {
    const item = resolveConversationListItem(input({
      item: row({ unreadCount: "7" as unknown as number }),
      existing: state({ unreadCount: 2 }),
    }), NOW);
    expect(item.list.unreadCount).toBe(2);
    expect(item.scalarDrift).toBe(true);
  });

  it("stores the tier and unread ids as legacy does: served as is, null only when absent", () => {
    // Legacy wrote `conversation.<field> ?? null` (its dm_conversations sweep, deleted at
    // step 4, S4-14) and its writer stores it unchanged, so an empty string stays an empty string.
    for (const served of ["", "88", null, undefined]) {
      const fields = served === undefined ? {} : { subscriptionTierId: served, lastUnreadMessageId: served };
      const { subscriptionTierId: _tier, lastUnreadMessageId: _unread, ...rest } = row();
      const item = resolveConversationListItem(input({
        item: { ...rest, ...fields },
        existing: state({ subscriptionTierId: "77", lastUnreadMessageId: "66" }),
      }), NOW);
      expect(item.list, String(served)).toEqual(expect.objectContaining({
        subscriptionTierId: served ?? null,
        lastUnreadMessageId: served ?? null,
      }));
    }
  });

  it("the page ends a head walk only when every chat on it is unchanged", () => {
    expect(listPageUnchanged([{ unchanged: true }, { unchanged: true }])).toBe(true);
    expect(listPageUnchanged([{ unchanged: true }, { unchanged: false }])).toBe(false);
    expect(listPageUnchanged([])).toBe(false);
  });
});

describe("resolveGroupDetail", () => {
  const detail = (users: string[], message: Record<string, unknown> | null) => ({
    id: GROUP,
    type: 1,
    groupFlags: 0,
    users: users.map((userId) => ({ groupId: GROUP, userId, type: 0, permissionFlags: 0 })),
    lastMessage: message === null ? null : {
      id: "910000000000000009", type: 1, dataVersion: 1, content: "hey", groupId: GROUP, senderId: FAN,
      correlationId: null, inReplyTo: null, inReplyToRoot: null, createdAt: HEAD_AT_MS + 5000,
      attachments: [], embeds: [], interactions: [], likes: [], ...message,
    },
  });

  it("names the single non-page member, and writes its head only when newer than the stored one", () => {
    const resolved = resolveGroupDetail({ detail: detail([PAGE, FAN], {}), existing: null, pageAccountId: PAGE, now: NOW });
    expect(resolved).toMatchObject({ partnerPlatformUserId: FAN, writtenPartnerId: FAN });
    expect(resolved.head).toMatchObject({ lastMessageId: "910000000000000009", lastMessageSenderRole: "fan", lastMessagePreview: "hey" });
    const older = resolveGroupDetail({
      detail: detail([PAGE, FAN], { id: "910000000000000001" }),
      existing: state(),
      pageAccountId: PAGE,
      now: NOW,
    });
    expect(older.head).toBeNull();
  });

  it("keeps a stored aggregation-missing exclusion, never a stored unresolvable one", () => {
    const keep = (reason: string | undefined) => resolveGroupDetail({
      detail: detail([PAGE, FAN], {}),
      existing: state({ metadata: reason === undefined ? {} : { messageSyncExcludedReason: reason, other: 1 } }),
      pageAccountId: PAGE,
      now: NOW,
    }).messageSyncExcludedReason;
    expect(keep(FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS))
      .toBe(FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS);
    expect(keep(FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP)).toBeNull();
    expect(keep(undefined)).toBeNull();
    expect(resolveGroupDetail({ detail: detail([PAGE, FAN], {}), existing: null, pageAccountId: PAGE, now: NOW }).messageSyncExcludedReason)
      .toBeNull();
  });

  it("several members name no partner, and the stored one stays", () => {
    const resolved = resolveGroupDetail({ detail: detail([PAGE, FAN, OTHER], null), existing: state(), pageAccountId: PAGE, now: NOW });
    expect(resolved).toMatchObject({ members: 2, partnerPlatformUserId: null, writtenPartnerId: FAN, head: null });
  });

  it("counts the members besides the page: a direct chat has one, the page's mass-message container none", () => {
    expect(resolveGroupDetail({ detail: detail([PAGE, FAN], {}), existing: null, pageAccountId: PAGE, now: NOW }))
      .toMatchObject({ members: 1, partnerPlatformUserId: FAN });
    // Production shape (lilly-1/lilly-2): type 3, the page alone, recipients
    // lists, the page's own broadcast as its head.
    const container = {
      ...detail([PAGE], { senderId: PAGE, type: 3, correlationId: GROUP }),
      type: 3,
      groupFlags: 62,
      recipients: [{ type: 30001, id: "920000000000000001" }],
    };
    expect(resolveGroupDetail({ detail: container, existing: null, pageAccountId: PAGE, now: NOW }))
      .toMatchObject({ members: 0, partnerPlatformUserId: null, writtenPartnerId: null });
  });
});

describe("listHeadNeedsRead", () => {
  const engineStart = new Date("2026-10-01T00:00:00Z");
  function follow(overrides: Partial<ListHeadFollowupState> = {}): ListHeadFollowupState {
    return {
      groupId: GROUP,
      fanId: 10,
      metadata: {},
      headConfirmedId: null,
      newestStoredMessageId: "910000000000000005",
      listHeadId: "910000000000000006",
      listHeadAt: new Date("2026-10-02T11:00:00Z"),
      headConfirmedAt: null,
      ...overrides,
    };
  }

  it("a list head strictly newer than what the reads reached; the confirmed head wins over the stored one", () => {
    expect(listHeadNeedsRead(follow(), engineStart)).toBe(true);
    expect(listHeadNeedsRead(follow({ listHeadId: "910000000000000005" }), engineStart)).toBe(false);
    expect(listHeadNeedsRead(follow({ listHeadId: "910000000000000004" }), engineStart)).toBe(false);
    expect(listHeadNeedsRead(follow({ headConfirmedId: "910000000000000006" }), engineStart)).toBe(false);
    // Snowflakes compare by value, not as text.
    expect(listHeadNeedsRead(follow({ newestStoredMessageId: "99", listHeadId: "100" }), engineStart)).toBe(true);
  });

  it("never for an unbound or excluded chat, or a chat without a head", () => {
    expect(listHeadNeedsRead(follow({ fanId: null }), engineStart)).toBe(false);
    expect(listHeadNeedsRead(follow({
      metadata: { messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS },
    }), engineStart)).toBe(false);
    expect(listHeadNeedsRead(follow({ listHeadId: null }), engineStart)).toBe(false);
  });

  it("a never-read chat only when its head is later than the engine's start (older is history, decision №2)", () => {
    const neverRead = { newestStoredMessageId: null, headConfirmedId: null };
    expect(listHeadNeedsRead(follow({ ...neverRead, listHeadAt: new Date("2026-10-02T11:00:00Z") }), engineStart)).toBe(true);
    expect(listHeadNeedsRead(follow({ ...neverRead, listHeadAt: new Date("2026-09-20T11:00:00Z") }), engineStart)).toBe(false);
    expect(listHeadNeedsRead(follow({ ...neverRead }), null)).toBe(false);
  });

  it("a head above the reads that a chain-joined head read received 75 s after its creation did not show asks for none; the full walk re-reads it", () => {
    const createdMs = Date.parse("2026-10-02T10:00:00Z");
    const head = (BigInt(createdMs - 1561494359900) << 22n).toString();
    const base = { listHeadId: head, headConfirmedId: "910000000000000005", newestStoredMessageId: "910000000000000005" };
    const early = new Date(createdMs + 74_999);
    const late = new Date(createdMs + 75_000);
    // Whether the embedded message vouches for the head (its served time) or not.
    expect(listHeadNeedsRead(follow({ ...base, headConfirmedAt: early, listHeadAt: new Date(createdMs) }), engineStart)).toBe(true);
    expect(listHeadNeedsRead(follow({ ...base, headConfirmedAt: late, listHeadAt: new Date(createdMs) }), engineStart)).toBe(false);
    expect(listHeadNeedsRead(follow({ ...base, headConfirmedAt: late, listHeadAt: null }), engineStart)).toBe(false);
    // A chat no read reached a message of (a chain proven empty): the same.
    expect(listHeadNeedsRead(follow({ ...base, headConfirmedId: null, newestStoredMessageId: null, headConfirmedAt: late }), engineStart)).toBe(false);
    // A read before the engine's start on the page accounts for nothing.
    expect(listHeadNeedsRead(follow({ ...base, headConfirmedAt: late }), new Date(late.getTime() + 1))).toBe(true);
    expect(listHeadAccounted({ headId: head, known: null, headConfirmedAt: late, engineStartAt: null })).toBe(false);
    // An id that is not a decimal snowflake has no creation instant: never accounted by time.
    expect(listHeadAccounted({ headId: "not-an-id", known: null, headConfirmedAt: late, engineStartAt: engineStart })).toBe(false);
    expect(listHeadNeedsRead(follow({
      listHeadId: "not-an-id", headConfirmedId: null, newestStoredMessageId: null, headConfirmedAt: late, listHeadAt: new Date(createdMs),
    }), engineStart)).toBe(true);
    // The full walk (recheck): a head accounted by time gets its read; one the reads reached does not.
    expect(listHeadNeedsRead(follow({ ...base, headConfirmedAt: late }), engineStart, true)).toBe(true);
    expect(listHeadNeedsRead(follow({ listHeadId: "910000000000000005", headConfirmedAt: late }), engineStart, true)).toBe(false);
    expect(listHeadNeedsRead(follow({ listHeadId: "910000000000000004", headConfirmedAt: late }), engineStart, true)).toBe(false);
    // A head a chat-unavailability episode answered asks for none, re-read or not.
    expect(listHeadNeedsRead(follow({ ...base, headConfirmedAt: late, unavailableHandledHeadId: head }), engineStart, true)).toBe(false);
    expect(listHeadNeedsRead(follow({ ...base, headConfirmedAt: early, unavailableHandledHeadId: head }), engineStart)).toBe(false);
  });

  it("the 75 s are the head read's own patience before `not_found` (15 s + 60 s)", () => {
    expect(DM_LIST_HEAD_ANSWERED_AFTER_MS).toBe(DM_HEAD_NOT_FOUND_RETRY_MS.reduce((a, b) => a + b, 0));
  });

  it("a head's instant: the served time, else its snowflake's", () => {
    const served = new Date("2026-10-02T11:00:00Z");
    expect(listHeadInstant("910000000000000006", served)).toBe(served);
    // 1561494359900 is the epoch of Fansly snowflakes.
    expect(listHeadInstant((1000n << 22n).toString(), null)).toEqual(new Date(1561494359900 + 1000));
    expect(listHeadInstant("not-an-id", null)).toBeNull();
    expect(listHeadInstant(null, null)).toBeNull();
  });
});

// ── a chat's list head (У5: Д4, Д7) ─────────────────────────────────────────

/** The follow-up state `applyListPage` builds for a listed chat. */
function followOf(item: ResolvedListItem, thread: PageDmThreadListState): ListHeadFollowupState {
  const servedAt = item.head.embeddedMessageId === item.head.headId ? item.head.servedAt : null;
  return {
    groupId: item.groupId,
    fanId: thread.fanId,
    metadata: thread.metadata,
    headConfirmedId: thread.headConfirmedId,
    newestStoredMessageId: thread.newestStoredMessageId,
    listHeadId: item.head.headId,
    listHeadAt: listHeadInstant(item.head.headId, servedAt),
    headConfirmedAt: thread.headConfirmedAt,
  };
}

/** The thread after the list's writer wrote the item. */
function writtenBy(thread: PageDmThreadListState, item: ResolvedListItem): PageDmThreadListState {
  return {
    ...thread,
    conversationFlags: item.list.conversationFlags,
    unreadCount: item.list.unreadCount,
    subscriptionTierId: item.list.subscriptionTierId,
    lastUnreadMessageId: item.list.lastUnreadMessageId,
    lastMessageId: item.head.lastMessageId,
    lastMessageAt: item.head.lastMessageAt,
    lastMessageSenderId: item.head.lastMessageSenderId,
    lastMessageSenderRole: item.head.lastMessageSenderRole,
    lastMessagePreview: item.head.lastMessagePreview,
  };
}

describe("listItemHeadId", () => {
  it("the newer of the row's id and the embedded one; an id that is not decimal never wins over the row's", () => {
    expect(listItemHeadId("100", "99")).toBe("100");
    expect(listItemHeadId("99", "100")).toBe("100");
    expect(listItemHeadId("100", null)).toBe("100");
    expect(listItemHeadId(null, "100")).toBe("100");
    expect(listItemHeadId(null, null)).toBeNull();
    expect(listItemHeadId("100", "x")).toBe("100");
    expect(listItemHeadId("x", "100")).toBe("x");
  });
});

describe("a phantom list head (Д4, prod lora-3)", () => {
  // Fansly keeps naming the chat's deleted newest message as the row's
  // `lastMessageId` and serves the group's `lastMessage: null`; `/message`
  // never shows it again (lora-3 chat 964012116774244352, 2026-10-07).
  const OWN = "743702253470232576";
  const PARTNER = "924881748523757569";
  const CHAT = "964012116774244352";
  const CHAIN_HEAD = "964058353217056769"; // 2026-10-07 03:29:42, REST's newest
  const PHANTOM = "964268547746312193"; // 2026-10-07 17:24:56, deleted
  const PHANTOM_AT_MS = listHeadInstant(PHANTOM, null)!.getTime();
  const ENGINE_START = new Date("2026-10-03T19:09:00Z");
  const READ_AT = new Date("2026-10-09T14:00:00Z");

  const ITEM: FanslyMessagingGroup = {
    groupId: CHAT,
    partnerAccountId: PARTNER,
    partnerUsername: "user924881680315981824",
    flags: 2,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: PHANTOM,
    lastUnreadMessageId: "0",
  };
  const GROUP_ROW = {
    id: CHAT,
    type: 1,
    users: [
      { type: 0, userId: OWN, groupId: CHAT, permissionFlags: 65535 },
      { type: 0, userId: PARTNER, groupId: CHAT, permissionFlags: 65535 },
    ],
    createdBy: OWN,
    groupFlags: 0,
    lastMessage: null,
  } as unknown as FanslyMessagingAggregatedGroup;

  /** The thread with the chain on REST's newest message, confirmed before the phantom was created. */
  function stored(overrides: Partial<PageDmThreadListState> = {}): PageDmThreadListState {
    return state({
      platformConversationId: CHAT,
      partnerPlatformUserId: PARTNER,
      partnerUsername: "user924881680315981824",
      partnerDisplayName: null,
      conversationFlags: 2,
      lastUnreadMessageId: "0",
      lastMessageId: CHAIN_HEAD,
      lastMessageAt: new Date("2026-10-07T03:29:42Z"),
      lastMessageSenderId: OWN,
      lastMessageSenderRole: "model",
      lastMessagePreview: "not talkative today, are you babe? haha",
      newestStoredMessageId: CHAIN_HEAD,
      headConfirmedId: CHAIN_HEAD,
      headConfirmedAt: new Date("2026-10-07T03:30:10Z"),
      ...overrides,
    });
  }

  function pass(thread: PageDmThreadListState, engineStartAt = ENGINE_START) {
    const item = resolveConversationListItem({
      item: ITEM,
      group: GROUP_ROW,
      accountsById: new Map([[PARTNER, { id: PARTNER, username: "user924881680315981824", displayName: null }]]),
      aggregationAccountCount: 30,
      existing: thread,
      pageAccountId: OWN,
      engineStartAt,
    }, READ_AT);
    return { item, needsRead: listHeadNeedsRead(followOf(item, thread), engineStartAt) };
  }

  /** The catch-up's head read as the apply folds it: REST's newest message
   *  is still the chain head (`head_unchanged`), received at READ_AT. */
  function catchupRead(thread: PageDmThreadListState): PageDmThreadListState {
    const chain: ThreadChain = {
      ...emptyChain(),
      state: "partial",
      headId: thread.headConfirmedId,
      headAt: thread.headConfirmedAt,
      oldestId: "964040000000000000",
      oldestCreatedAtMs: listHeadInstant("964040000000000000", null)!.getTime(),
      count: 3,
    };
    const ids = [CHAIN_HEAD, "964056000000000000", "964040000000000000"];
    const fold = foldChainPage(chain, null, {
      before: null,
      limit: 25,
      ids,
      createdAtMs: ids.map((id) => listHeadInstant(id, null)!.getTime()),
      capturedAt: READ_AT,
      witness: { kind: "attempt", attemptId: 1, observationId: 1, receivedAt: READ_AT },
    }, null);
    expect(fold.verdict.kind).toBe("head_unchanged");
    return { ...thread, headConfirmedId: fold.chain.headId, headConfirmedAt: fold.chain.headAt };
  }

  it("(а) no head read since the phantom: a read is asked, the stored head kept for it, the page not ended", () => {
    const { item, needsRead } = pass(stored());
    expect(needsRead).toBe(true);
    expect(item.head).toMatchObject({
      listMessageId: PHANTOM, embeddedMessageId: null, headId: PHANTOM, lastMessageId: CHAIN_HEAD, preserveHeadForRetry: true,
    });
    expect(item.unchanged).toBe(false);
  });

  it("(б) four passes ask for one read: the pass after it writes the phantom, the next ones end the head walk on the page", () => {
    let thread = stored();
    const asked: boolean[] = [];
    const items: ResolvedListItem[] = [];
    for (let n = 0; n < 4; n += 1) {
      const { item, needsRead } = pass(thread);
      asked.push(needsRead);
      items.push(item);
      thread = writtenBy(thread, item);
      if (needsRead) thread = catchupRead(thread);
    }
    // Before the fix: [true, true, true, true], and no pass ended the walk.
    expect(asked).toEqual([true, false, false, false]);
    // The pass after the read writes the phantom with the last visible
    // message's time and sender: a one-off change of the page.
    expect(items[1]!.head).toMatchObject({
      headId: PHANTOM, lastMessageId: PHANTOM, preserveHeadForRetry: false, lastMessageAt: new Date("2026-10-07T03:29:42Z"),
      lastMessageSenderId: OWN, lastMessageSenderRole: "model",
    });
    expect(items[1]!.unchanged).toBe(false);
    for (const item of items.slice(2)) {
      expect(item.diffReasons).toEqual([]);
      expect(item.unchanged).toBe(true);
      expect(listPageUnchanged([item])).toBe(true);
    }
    expect(thread).toMatchObject({ lastMessageId: PHANTOM, headConfirmedId: CHAIN_HEAD, headConfirmedAt: READ_AT });
  });

  it("(в) the head read counts from 75 s after the head's creation", () => {
    expect(pass(stored({ headConfirmedAt: new Date(PHANTOM_AT_MS + 74_999) })).needsRead).toBe(true);
    expect(pass(stored({ headConfirmedAt: new Date(PHANTOM_AT_MS + 75_000) })).needsRead).toBe(false);
  });

  it("(г) a head read before the engine's start on the page accounts for nothing", () => {
    expect(pass(stored({ headConfirmedAt: READ_AT }), new Date(READ_AT.getTime() + 1)).needsRead).toBe(true);
    expect(pass(stored({ headConfirmedAt: READ_AT }), READ_AT).needsRead).toBe(false);
  });

  it("(д) a head deleted after the reads confirmed it (lora-1 form): no read, the head written once, then the walk stops", () => {
    const confirmed = stored({ headConfirmedId: PHANTOM, newestStoredMessageId: PHANTOM, headConfirmedAt: null });
    const first = pass(confirmed);
    expect(first.needsRead).toBe(false);
    expect(first.item.head).toMatchObject({ headId: PHANTOM, lastMessageId: PHANTOM, preserveHeadForRetry: false });
    expect(first.item.unchanged).toBe(false);
    const second = pass(writtenBy(confirmed, first.item));
    expect(second.needsRead).toBe(false);
    expect(second.item.unchanged).toBe(true);
  });
});

describe("a stale list row (Д7, prod ari-1)", () => {
  // The row serves an old `lastMessageId` while the group's embedded
  // `lastMessage` is newer (ari-1 chat 963752637080039424, 2026-10-09).
  const OWN = "300000000000000001";
  const PARTNER = "962915146519961600";
  const CHAT = "963752637080039424";
  const STALE = "964389149329092608"; // model, 2026-10-08 01:24:10
  const EMBEDDED = "964808195857985536"; // fan, 2026-10-09 05:09:18
  const EMBEDDED_AT_MS = Date.parse("2026-10-09T05:09:18.707Z");
  const ENGINE_START = new Date("2026-10-03T19:08:19Z");
  const LIST_AT = new Date("2026-10-09T05:12:25Z");

  const ITEM: FanslyMessagingGroup = {
    groupId: CHAT,
    partnerAccountId: PARTNER,
    partnerUsername: "fan",
    flags: 0,
    unreadCount: 1,
    subscriptionTierId: null,
    lastMessageId: STALE,
    lastUnreadMessageId: null,
  };
  const GROUP_ROW = {
    id: CHAT,
    users: [
      { groupId: CHAT, userId: OWN, type: 0, permissionFlags: 0 },
      { groupId: CHAT, userId: PARTNER, type: 0, permissionFlags: 0 },
    ],
    lastMessage: {
      id: EMBEDDED, type: 1, dataVersion: 1, content: "hidden", groupId: CHAT, senderId: PARTNER, correlationId: null,
      inReplyTo: null, inReplyToRoot: null, createdAt: EMBEDDED_AT_MS / 1000, attachments: [], embeds: [], interactions: [], likes: [],
    },
  } as unknown as FanslyMessagingAggregatedGroup;

  /** The reads reached the row's stale id (the socket missed the 05:09 message). */
  function stored(overrides: Partial<PageDmThreadListState> = {}): PageDmThreadListState {
    return state({
      platformConversationId: CHAT,
      partnerPlatformUserId: PARTNER,
      lastMessageId: STALE,
      lastMessageAt: new Date("2026-10-08T01:24:10Z"),
      lastMessageSenderId: OWN,
      lastMessageSenderRole: "model",
      lastMessagePreview: "stale",
      newestStoredMessageId: STALE,
      headConfirmedId: STALE,
      headConfirmedAt: new Date("2026-10-09T04:40:00Z"),
      ...overrides,
    });
  }

  function pass(thread: PageDmThreadListState) {
    const item = resolveConversationListItem({
      item: ITEM,
      group: GROUP_ROW,
      accountsById: new Map([[PARTNER, { id: PARTNER, username: "fan", displayName: null }]]),
      aggregationAccountCount: 1,
      existing: thread,
      pageAccountId: OWN,
      engineStartAt: ENGINE_START,
    }, LIST_AT);
    return { item, needsRead: listHeadNeedsRead(followOf(item, thread), ENGINE_START) };
  }

  it("the head is the embedded message: the written head is that one message, and a read is asked", () => {
    const { item, needsRead } = pass(stored());
    // Before the fix: the stale id with the embedded message's time and sender, and no read.
    expect(item.head).toMatchObject({
      listMessageId: STALE,
      embeddedMessageId: EMBEDDED,
      headId: EMBEDDED,
      lastMessageId: EMBEDDED,
      lastMessageSenderId: PARTNER,
      lastMessageSenderRole: "fan",
      lastMessagePreview: "hidden",
      preserveHeadForRetry: false,
    });
    expect(item.head.lastMessageAt?.getTime()).toBe(EMBEDDED_AT_MS);
    expect(needsRead).toBe(true);
    expect(item.diffReasons).toEqual(expect.arrayContaining(["last_message_id"]));
    expect(item.unchanged).toBe(false);
  });

  it("delivered by the socket (the chain on the embedded message): no read, and once the head is written the walk stops", () => {
    const delivered = stored({ headConfirmedId: EMBEDDED, newestStoredMessageId: EMBEDDED });
    const first = pass(delivered);
    expect(first.needsRead).toBe(false);
    const second = pass(writtenBy(delivered, first.item));
    expect(second.needsRead).toBe(false);
    expect(second.item.unchanged).toBe(true);
  });
});

describe("cursors, preview and journal", () => {
  it("cursors survive whatever a row holds", () => {
    expect(parseDmListHeadCursor(null)).toEqual({ walk: null, last: null });
    expect(parseDmListHeadCursor({ walk: { offset: 200, pageCount: 2, startedAt: NOW.toISOString() } }).walk)
      .toEqual({ offset: 200, pageCount: 2, startedAt: NOW.toISOString() });
    expect(parseDmListHeadCursor({ walk: { offset: -1, startedAt: "x" } }).walk).toBeNull();
    expect(parseDmListFullCursor({})).toEqual({ generation: 0, walk: null, restartCount: 0, last: null });
    const full = parseDmListFullCursor({
      generation: 7,
      restartCount: 1,
      walk: { generation: 8, startedAt: NOW.toISOString(), offset: 100, pageCount: 1, observedCount: 100 },
      shadow: { steps: 3, done: 1 },
    });
    expect(full).toMatchObject({
      generation: 7,
      restartCount: 1,
      walk: { generation: 8, offset: 100, pageCount: 1, observedCount: 100, repeatsCountedOnce: 0, repeatOnlyPageStreak: 0 },
    });
    // What a shadow sweep left in a cursor (step 4 S4-23 removed it) is not read.
    expect(full).not.toHaveProperty("shadow");
  });

  it("the list preview is the legacy one", () => {
    expect(truncateDmPreview("  hello<br>world ")).toBe("hello\nworld");
    expect(truncateDmPreview(null)).toBeNull();
    const long = truncateDmPreview("x".repeat(400))!;
    expect(long).toHaveLength(280);
    expect(long.endsWith("…")).toBe(true);
  });

  it("a group detail the contract refused is journaled as legacy wraps it", () => {
    const raw = { id: GROUP, users: [{ userId: "" }] };
    expect(prepareJournalBody({ kind: "group_detail" }, { response: raw, contractAccepted: false }).payload)
      .toEqual({ contractAccepted: false, raw });
    expect(prepareJournalBody({ kind: "group_detail" }, { response: raw }).payload).toBe(raw);
  });

  it("snowflake ids compare by value", () => {
    expect(compareFanslySnowflakeIds("100", "99")).toBe(1);
    expect(compareFanslySnowflakeIds("99", "100")).toBe(-1);
    expect(compareFanslySnowflakeIds("5", "5")).toBe(0);
    expect(compareFanslySnowflakeIds("x", "5")).toBeNull();
    expect(compareFanslyFollowIds("100", "99")).toBe(1);
  });
});
