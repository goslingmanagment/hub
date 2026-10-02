import { describe, expect, it } from "vitest";

import type { HistoryThreadFacts } from "@agency_hub_core/db";

import { parseFanListFile } from "../apps/runtime/src/sync/cli/history.ts";
import {
  anchorAtIntake,
  belowAnchor,
  chooseFanThread,
  decideAnchor,
  historyRequestFingerprint,
  HistoryInputError,
  judgeSatisfaction,
  loadedMessages,
  needsHistoryHeadRead,
  normalizeHistoryInputs,
  parseFanslyChatUrl,
  type ChainFacts,
} from "../apps/runtime/src/sync/requests/history-rules.ts";
import { normalizeHistoryDepth } from "../apps/runtime/src/sync/requests/history.ts";

// The pure rules of a history request (design §7.1): inputs and their
// fingerprint, which chat a fan names, anchors, the head read of a newcomer
// and satisfaction per depth.

const T0 = new Date("2026-10-02T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function chain(overrides: Partial<ChainFacts> = {}): ChainFacts {
  return {
    headConfirmedId: "1000",
    headConfirmedAt: at(0),
    contiguousOldestId: "900",
    contiguousOldestAt: at(-3600),
    contiguousCount: 60,
    chainUpwardCount: 10,
    chainEpoch: 2,
    historyState: "partial",
    historyProof: null,
    ...overrides,
  };
}

function thread(overrides: Partial<HistoryThreadFacts> = {}): HistoryThreadFacts {
  return {
    threadId: 1,
    pageId: 7,
    groupId: "800000000000000001",
    fanId: 11,
    fanPlatformUserId: "500000000000000001",
    partnerPlatformUserId: "500000000000000001",
    metadata: {},
    isVisible: true,
    lastMessageAt: at(0),
    storedMessageCount: 60,
    newestStoredMessageId: null,
    oldestStoredMessageId: null,
    effectiveHistoryState: "partial",
    ...chain(),
    ...overrides,
  } as HistoryThreadFacts;
}

describe("inputs", () => {
  it("reads a Fansly chat link with or without scheme, www, query or trailing slash", () => {
    expect(parseFanslyChatUrl("https://fansly.com/messages/790851313763098624")).toBe("790851313763098624");
    expect(parseFanslyChatUrl("fansly.com/messages/790851313763098624/")).toBe("790851313763098624");
    expect(parseFanslyChatUrl("https://www.fansly.com/messages/790851313763098624?tab=1#x")).toBe("790851313763098624");
    expect(parseFanslyChatUrl("https://fansly.com/messages")).toBeNull();
    expect(parseFanslyChatUrl("https://fansly.com/user438765948262952961")).toBeNull();
    expect(parseFanslyChatUrl("https://evil.example/messages/1")).toBeNull();
  });

  it("trims and de-duplicates; a malformed id resolves to nothing instead of failing the request", () => {
    const inputs = normalizeHistoryInputs([
      { kind: "fan", platformUserId: " 500000000000000001 " },
      { kind: "fan", platformUserId: "500000000000000001" },
      { kind: "conversation", conversationRef: "800000000000000001" },
      { kind: "chat_url", url: "https://fansly.com/messages/800000000000000002" },
      { kind: "fan", platformUserId: "not-an-id" },
    ]);
    expect(inputs.map((input) => [input.ordinal, input.inputKind, input.fanRef, input.groupId])).toEqual([
      [0, "fan_platform_user_id", "500000000000000001", null],
      [1, "conversation_ref", null, "800000000000000001"],
      [2, "chat_url", null, "800000000000000002"],
      [3, "fan_platform_user_id", null, null],
    ]);
    expect(() => normalizeHistoryInputs([{ kind: "fan", platformUserId: "  " }])).toThrow(HistoryInputError);
    expect(() => normalizeHistoryInputs([{ kind: "chat_url", url: "x".repeat(301) }])).toThrow(HistoryInputError);
  });

  it("fingerprints the normalized request, never the reason itself, independent of input order", () => {
    const fans = normalizeHistoryInputs([
      { kind: "fan", platformUserId: "1" },
      { kind: "conversation", conversationRef: "2" },
    ]);
    const reversed = normalizeHistoryInputs([
      { kind: "conversation", conversationRef: "2" },
      { kind: "fan", platformUserId: "1" },
    ]);
    const base = historyRequestFingerprint({ pageId: 7, inputs: fans, depth: { kind: "all" }, reason: "why" });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(historyRequestFingerprint({ pageId: 7, inputs: reversed, depth: { kind: "all" }, reason: "why" })).toBe(base);
    expect(historyRequestFingerprint({ pageId: 7, inputs: fans, depth: { kind: "latest", count: 5 }, reason: "why" })).not.toBe(base);
    expect(historyRequestFingerprint({ pageId: 8, inputs: fans, depth: { kind: "all" }, reason: "why" })).not.toBe(base);
    expect(historyRequestFingerprint({ pageId: 7, inputs: fans, depth: { kind: "all" }, reason: "other" })).not.toBe(base);
  });

  it("validates the depth", () => {
    expect(normalizeHistoryDepth({ kind: "latest", count: 100 })).toEqual({ kind: "latest", count: 100 });
    expect(() => normalizeHistoryDepth({ kind: "latest", count: 0 })).toThrow(/1\.\.1000000/);
    expect(() => normalizeHistoryDepth({ kind: "latest", count: 1.5 })).toThrow();
    expect(() => normalizeHistoryDepth({ kind: "before_boundary" })).toThrow(/exactly one/);
    expect(() => normalizeHistoryDepth({ kind: "before_boundary", at: T0, messageRef: "1" })).toThrow(/exactly one/);
    expect(normalizeHistoryDepth({ kind: "before_boundary", messageRef: "123" })).toEqual({ kind: "before_boundary", at: null, messageRef: "123" });
    expect(() => normalizeHistoryDepth({ kind: "everything" } as never)).toThrow();
    // The depth is mandatory (plan §4.1): no default when it is left out.
    expect(() => normalizeHistoryDepth(undefined as never)).toThrow(/depth\.kind must be/);
    expect(() => normalizeHistoryDepth({} as never)).toThrow(/depth\.kind must be/);
  });

  it("the CLI's list file: a chat link, a conversation ref, or a fan id per line", () => {
    expect(parseFanListFile("# fans\n500000000000000001\n\nhttps://fansly.com/messages/8\nconversation:9\r\n")).toEqual([
      { kind: "fan", platformUserId: "500000000000000001" },
      { kind: "chat_url", url: "https://fansly.com/messages/8" },
      { kind: "conversation", conversationRef: "9" },
    ]);
  });
});

describe("which chat a fan names ([A16])", () => {
  it("the visible chat with the latest message, then the newest row", () => {
    const old = thread({ threadId: 9474, lastMessageAt: at(-86_400) });
    const recent = thread({ threadId: 7094, lastMessageAt: at(0) });
    const silent = thread({ threadId: 19061, lastMessageAt: null });
    expect(chooseFanThread([old, recent, silent])?.threadId).toBe(7094);
    expect(chooseFanThread([silent, thread({ threadId: 12327, lastMessageAt: null })])?.threadId).toBe(19061);
    expect(chooseFanThread([thread({ isVisible: false })])).toBeNull();
    expect(chooseFanThread([])).toBeNull();
  });
});

describe("anchors (§7.1.4)", () => {
  it("at intake only when the socket has been verified since before the head was confirmed", () => {
    expect(anchorAtIntake(chain(), { verifiedAt: at(-10) })).toEqual({ messageId: "1000", upwardCount: 10, chainEpoch: 2 });
    expect(anchorAtIntake(chain(), { verifiedAt: at(10) })).toBeNull();
    expect(anchorAtIntake(chain(), null)).toBeNull();
    expect(anchorAtIntake(chain({ headConfirmedId: null, headConfirmedAt: null }), { verifiedAt: at(-10) })).toBeNull();
  });

  it("a head confirmed after the fan was filed anchors it; a head read of the walk does unless a walk is staged", () => {
    const filed = { anchor: null, createdAt: at(5) };
    const walk = { historyHeadAt: null, segmentStaged: false };
    expect(decideAnchor(filed, chain({ headConfirmedAt: at(6) }), walk)).toEqual({ kind: "set", anchor: { messageId: "1000", upwardCount: 10, chainEpoch: 2 } });
    expect(decideAnchor(filed, chain({ headConfirmedAt: at(4) }), walk)).toEqual({ kind: "keep" });
    expect(decideAnchor(filed, chain(), { historyHeadAt: at(6), segmentStaged: false }).kind).toBe("set");
    expect(decideAnchor(filed, chain(), { historyHeadAt: at(6), segmentStaged: true }).kind).toBe("keep");
    expect(decideAnchor(filed, chain({ headConfirmedId: null }), { historyHeadAt: at(6), segmentStaged: false }).kind).toBe("keep");
  });

  it("an anchor of another chain epoch is cleared", () => {
    expect(decideAnchor({ anchor: { chainEpoch: 1 }, createdAt: at(0) }, chain(), { historyHeadAt: null, segmentStaged: false }))
      .toEqual({ kind: "clear" });
    expect(decideAnchor({ anchor: { chainEpoch: 2 }, createdAt: at(0) }, chain(), { historyHeadAt: null, segmentStaged: false }))
      .toEqual({ kind: "keep" });
  });

  it("a newcomer without an anchor needs one head read since it was filed — never a loop", () => {
    expect(needsHistoryHeadRead([{ anchor: null, createdAt: at(5) }], null)).toBe(true);
    expect(needsHistoryHeadRead([{ anchor: null, createdAt: at(5) }], at(4))).toBe(true);
    expect(needsHistoryHeadRead([{ anchor: null, createdAt: at(5) }], at(5))).toBe(false);
    expect(needsHistoryHeadRead([{ anchor: { chainEpoch: 2 }, createdAt: at(5) }], null)).toBe(false);
  });
});

describe("satisfaction (§7.1.6)", () => {
  const anchor = { upwardCount: 4, chainEpoch: 2 };

  it("all: only a chain proven complete by an empty page (owner decision №3)", () => {
    expect(judgeSatisfaction({ depth: { kind: "all" }, anchor: null }, chain())).toBeNull();
    expect(judgeSatisfaction({ depth: { kind: "all" }, anchor: null }, chain({ historyState: "complete", historyProof: "empty_page" })))
      .toEqual({ by: "empty_page", oldestId: "900", count: 60 });
    expect(judgeSatisfaction({ depth: { kind: "all" }, anchor: null }, chain({ historyState: "complete", historyProof: null }))).toBeNull();
  });

  it("latest N counts the chain below the anchor of its epoch; messages added above the anchor do not count", () => {
    // 60 in the chain, 6 added above the anchor since: 54 below it.
    expect(belowAnchor(anchor, chain())).toBe(54);
    expect(judgeSatisfaction({ depth: { kind: "latest", count: 54 }, anchor }, chain())).toEqual({ by: "latest_n", oldestId: "900", count: 54 });
    expect(judgeSatisfaction({ depth: { kind: "latest", count: 55 }, anchor }, chain())).toBeNull();
    expect(judgeSatisfaction({ depth: { kind: "latest", count: 5 }, anchor: null }, chain())).toBeNull();
    expect(judgeSatisfaction({ depth: { kind: "latest", count: 5 }, anchor: { upwardCount: 4, chainEpoch: 1 } }, chain())).toBeNull();
    // A complete chat shorter than N is satisfied.
    expect(judgeSatisfaction({ depth: { kind: "latest", count: 500 }, anchor }, chain({ historyState: "complete", historyProof: "empty_page" })))
      .toMatchObject({ by: "latest_n", count: 54 });
    expect(loadedMessages({ depth: { kind: "latest", count: 20 }, anchor }, chain())).toBe(20);
    expect(loadedMessages({ depth: { kind: "all" }, anchor: null }, chain())).toBe(60);
  });

  it("before_boundary: the chain reaches the boundary by time or by message id", () => {
    expect(judgeSatisfaction({ depth: { kind: "before_boundary", at: at(-3600), messageRef: null }, anchor: null }, chain()))
      .toMatchObject({ by: "boundary" });
    expect(judgeSatisfaction({ depth: { kind: "before_boundary", at: at(-7200), messageRef: null }, anchor: null }, chain())).toBeNull();
    expect(judgeSatisfaction({ depth: { kind: "before_boundary", at: null, messageRef: "950" }, anchor: null }, chain()))
      .toMatchObject({ by: "boundary" });
    expect(judgeSatisfaction({ depth: { kind: "before_boundary", at: null, messageRef: "850" }, anchor: null }, chain())).toBeNull();
    expect(judgeSatisfaction({ depth: { kind: "before_boundary", at: null, messageRef: "950" }, anchor: null },
      chain({ historyState: "unverified", headConfirmedId: null, contiguousOldestId: null, contiguousCount: 0 }))).toBeNull();
  });
});
