import { describe, expect, it } from "vitest";

import type { PageDmThreadListState } from "@agency_hub_core/db";
import type { FanslyAccount, FanslyMessagingAggregatedGroup, FanslyMessagingGroup } from "@agency_hub_core/fansly";
import {
  compareFanslyFollowIds,
  compareFanslySnowflakeIds,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
} from "@agency_hub_core/shared";

import { truncateDmPreview } from "../apps/runtime/src/services/sync/dm-preview.ts";
import { prepareJournalBody } from "../apps/runtime/src/sync/fansly/capture.ts";
import {
  listHeadInstant,
  listHeadNeedsRead,
  listPageUnchanged,
  resolveConversationListItem,
  resolveGroupDetail,
  type ListHeadFollowupState,
  type ResolveListItemInput,
} from "../apps/runtime/src/sync/fansly/lib/conversation-list.ts";
import {
  parseDmListFullCursor,
  parseDmListHeadCursor,
} from "../apps/runtime/src/sync/fansly/resources/dm-conversations.ts";

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
    probe: null,
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
      probeDue: false,
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

  it("a head the walk cannot vouch for keeps the page changed: list and embedded ids disagree, or no time", () => {
    expect(resolveConversationListItem(input({ group: group({}, { id: "910000000000000004" }) }), NOW).unchanged).toBe(false);
    expect(resolveConversationListItem(input({ group: group({}, { createdAt: null }) }), NOW).unchanged).toBe(false);
    expect(resolveConversationListItem(input({ group: null }), NOW).unchanged).toBe(false);
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

  it("an unresolvable exclusion: lifted by a resolved answer of the day, kept otherwise, probed when no answer is fresh", () => {
    const excluded = state({ metadata: { messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP } });
    expect(resolveConversationListItem(input({ existing: excluded, probe: "resolved" }), NOW)).toMatchObject({
      messageSyncExcludedReason: null,
      probeDue: false,
    });
    expect(resolveConversationListItem(input({ existing: excluded, probe: "unresolved" }), NOW)).toMatchObject({
      messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
      probeDue: false,
    });
    expect(resolveConversationListItem(input({ existing: excluded, probe: null }), NOW)).toMatchObject({
      messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
      probeDue: true,
    });
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
    // Legacy writes `conversation.<field> ?? null` (services/sync/fansly-dm-conversations.ts)
    // and its writer stores it unchanged, so an empty string stays an empty string.
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

  it("a head's instant: the served time, else its snowflake's", () => {
    const served = new Date("2026-10-02T11:00:00Z");
    expect(listHeadInstant("910000000000000006", served)).toBe(served);
    // 1561494359900 is the epoch of Fansly snowflakes.
    expect(listHeadInstant((1000n << 22n).toString(), null)).toEqual(new Date(1561494359900 + 1000));
    expect(listHeadInstant("not-an-id", null)).toBeNull();
    expect(listHeadInstant(null, null)).toBeNull();
  });
});

describe("cursors, preview and journal", () => {
  it("cursors survive whatever a row holds", () => {
    expect(parseDmListHeadCursor(null)).toEqual({ walk: null, last: null });
    expect(parseDmListHeadCursor({ walk: { offset: 200, pageCount: 2, startedAt: NOW.toISOString() } }).walk)
      .toEqual({ offset: 200, pageCount: 2, startedAt: NOW.toISOString() });
    expect(parseDmListHeadCursor({ walk: { offset: -1, startedAt: "x" } }).walk).toBeNull();
    expect(parseDmListFullCursor({})).toEqual({ generation: 0, walk: null, restartCount: 0, last: null, shadow: null });
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
      shadow: { steps: 3, done: 1 },
    });
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
