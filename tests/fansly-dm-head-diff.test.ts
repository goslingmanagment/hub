// Golden table for `diffConversationHead` — the dm_conversations sweep's
// "did this conversation move?" question, extracted out of the handler.
//
// Two things are pinned here and they are NOT the same thing:
//   * `reasons` — the FULL head scope, one entry per field that moved;
//   * `LEGACY_UNCHANGED_PAGE_REASONS` / `breaksLegacyUnchangedPage` — the
//     subset the `unchangedPageStreak` predicate has always counted. The gap
//     between them IS the known wart (flags / lastUnreadMessageId /
//     subscriptionTierId move without breaking the streak), pinned by
//     tests/fansly-dm-conversations-sweep.integration.test.ts at the sweep
//     level and by the last describe block here at the function level.

import { describe, expect, it } from "vitest";

import {
  breaksLegacyUnchangedPage,
  diffConversationHead,
  LEGACY_UNCHANGED_PAGE_REASONS,
  type ConversationHeadDiffReason,
  type ConversationHeadSnapshot,
} from "../apps/runtime/src/services/sync/fansly-dm-head-diff.ts";

const HEAD_AT = new Date("2026-03-10T12:00:00.000Z");

const BASE: ConversationHeadSnapshot = {
  lastMessageId: "msg-1",
  unreadCount: 0,
  isVisible: true,
  conversationFlags: 0,
  lastUnreadMessageId: null,
  subscriptionTierId: null,
  lastMessageAt: HEAD_AT,
  lastMessageSenderId: "fan-1",
  unresolvedIdentity: false,
  messageSyncExcludedReason: null,
};

function head(overrides: Partial<ConversationHeadSnapshot> = {}): ConversationHeadSnapshot {
  return { ...BASE, ...overrides };
}

describe("diffConversationHead", () => {
  it.each<{
    name: string;
    incoming: Partial<ConversationHeadSnapshot>;
    reasons: ConversationHeadDiffReason[];
  }>([
    { name: "nothing moved", incoming: {}, reasons: [] },
    {
      name: "the head id moved",
      incoming: { lastMessageId: "msg-2" },
      reasons: ["last_message_id"],
    },
    {
      name: "the provider dropped the head id",
      incoming: { lastMessageId: null },
      reasons: ["last_message_id"],
    },
    {
      name: "unread went up",
      incoming: { unreadCount: 3 },
      reasons: ["unread_count"],
    },
    {
      name: "a hidden row is re-listed",
      // The sweep only ever writes visible rows, so this is the shape the
      // retired inline `!existing.isVisible` had.
      incoming: {},
      reasons: [],
    },
    {
      name: "conversation flags moved",
      incoming: { conversationFlags: 2 },
      reasons: ["conversation_flags"],
    },
    {
      name: "the unread pointer moved",
      incoming: { lastUnreadMessageId: "msg-1" },
      reasons: ["last_unread_message_id"],
    },
    {
      name: "the fan changed tier",
      incoming: { subscriptionTierId: "tier-vip" },
      reasons: ["subscription_tier_id"],
    },
    {
      name: "the head timestamp moved",
      incoming: { lastMessageAt: new Date("2026-03-11T09:00:00.000Z") },
      reasons: ["last_message_at"],
    },
    {
      name: "an equal-but-not-identical Date is not a change",
      incoming: { lastMessageAt: new Date(HEAD_AT.getTime()) },
      reasons: [],
    },
    {
      name: "the head timestamp disappeared",
      incoming: { lastMessageAt: null },
      reasons: ["last_message_at"],
    },
    {
      name: "the model replied last",
      incoming: { lastMessageSenderId: "acct-page" },
      reasons: ["last_message_sender_id"],
    },
    {
      name: "identity became unresolved",
      incoming: { unresolvedIdentity: true },
      reasons: ["unresolved_identity"],
    },
    {
      name: "a message-sync exclusion was stamped",
      incoming: { messageSyncExcludedReason: "partner_missing_from_aggregation_accounts" },
      reasons: ["message_sync_excluded_reason"],
    },
    {
      name: "a message-sync exclusion was cleared",
      incoming: {},
      reasons: [],
    },
    {
      name: "several fields moved at once, reported in declaration order",
      incoming: {
        lastMessageId: "msg-2",
        unreadCount: 1,
        conversationFlags: 4,
        lastMessageAt: new Date("2026-03-11T09:00:00.000Z"),
      },
      reasons: ["last_message_id", "unread_count", "conversation_flags", "last_message_at"],
    },
  ])("$name", ({ incoming, reasons }) => {
    const diff = diffConversationHead(head(), head(incoming));

    expect(diff.reasons).toEqual(reasons);
    expect(diff.changed).toBe(reasons.length > 0);
  });

  it("reports a hidden stored row as a visibility change", () => {
    const diff = diffConversationHead(head({ isVisible: false }), head());

    expect(diff.reasons).toEqual(["visibility"]);
    expect(diff.changed).toBe(true);
  });

  it("clearing an exclusion is a change in the other direction too", () => {
    const diff = diffConversationHead(
      head({ messageSyncExcludedReason: "partner_unresolvable_from_account_lookup" }),
      head(),
    );

    expect(diff.reasons).toEqual(["message_sync_excluded_reason"]);
  });

  it("reports ONE reason for a conversation with no stored row", () => {
    // Everything is new by construction; listing eleven reasons would say
    // nothing the single one does not.
    const diff = diffConversationHead(null, head());

    expect(diff).toEqual({ changed: true, reasons: ["missing_row"] });
  });

  it("does not mutate either snapshot", () => {
    const existing = head();
    const incoming = head({ unreadCount: 9 });
    diffConversationHead(existing, incoming);

    expect(existing).toEqual(head());
    expect(incoming).toEqual(head({ unreadCount: 9 }));
  });
});

describe("the legacy streak subset (current behaviour, not desired)", () => {
  it("is exactly the five fields the inline predicate compared, plus the missing row", () => {
    expect([...LEGACY_UNCHANGED_PAGE_REASONS]).toEqual([
      "missing_row",
      "last_message_id",
      "unread_count",
      "visibility",
      "unresolved_identity",
      "message_sync_excluded_reason",
    ]);
  });

  it.each<{ name: string; incoming: Partial<ConversationHeadSnapshot> }>([
    { name: "conversationFlags", incoming: { conversationFlags: 2 } },
    { name: "lastUnreadMessageId", incoming: { lastUnreadMessageId: "msg-1" } },
    { name: "subscriptionTierId", incoming: { subscriptionTierId: "tier-vip" } },
    { name: "lastMessageAt", incoming: { lastMessageAt: new Date("2026-03-11T09:00:00.000Z") } },
    { name: "lastMessageSenderId", incoming: { lastMessageSenderId: "acct-page" } },
  ])("$name moves the head but does NOT break the streak today", ({ incoming }) => {
    const diff = diffConversationHead(head(), head(incoming));

    // The full scope sees it…
    expect(diff.changed).toBe(true);
    // …and the streak, deliberately, does not. A0 flips the sweep onto
    // `diff.changed` and these become "true" without the diff changing.
    expect(breaksLegacyUnchangedPage(diff.reasons)).toBe(false);
  });

  it.each<{ name: string; existing: ConversationHeadSnapshot | null; incoming: Partial<ConversationHeadSnapshot> }>([
    { name: "a brand new conversation", existing: null, incoming: {} },
    { name: "a moved head id", existing: head(), incoming: { lastMessageId: "msg-2" } },
    { name: "a new unread count", existing: head(), incoming: { unreadCount: 3 } },
    { name: "a re-listed hidden row", existing: head({ isVisible: false }), incoming: {} },
    { name: "identity turning unresolved", existing: head(), incoming: { unresolvedIdentity: true } },
    {
      name: "an exclusion being stamped",
      existing: head(),
      incoming: { messageSyncExcludedReason: "partner_missing_from_aggregation_accounts" },
    },
  ])("$name breaks the streak", ({ existing, incoming }) => {
    const diff = diffConversationHead(existing, head(incoming));

    expect(diff.changed).toBe(true);
    expect(breaksLegacyUnchangedPage(diff.reasons)).toBe(true);
  });

  it("an unchanged conversation breaks nothing", () => {
    expect(breaksLegacyUnchangedPage(diffConversationHead(head(), head()).reasons)).toBe(false);
  });
});
