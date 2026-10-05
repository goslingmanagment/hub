import { describe, expect, it } from "vitest";

import * as contracts from "@agency_hub_core/contracts";
import {
  CLIENT_COVERAGE_LEVELS,
  CLIENT_CURSOR_REFUSAL_REASONS,
  CLIENT_FEED_DEFAULT_LIMIT,
  CLIENT_FEED_MAX_LIMIT,
  CLIENT_FEED_PING_SEGMENTS,
  CLIENT_FEED_SENDERS,
  CLIENT_FEED_SOURCES,
  CLIENT_FEED_SUMMARY_WINDOW_DEFAULT,
  CLIENT_FEED_SUMMARY_WINDOW_MAX,
  CLIENT_FEED_SUMMARY_WINDOW_MIN,
  CLIENT_HUB_CAPABILITY_NAMES,
  CLIENT_TOKEN_PROFILES,
  clientConversationFeedQuerySchema,
  clientConversationFeedResponseSchema,
  clientCursorSchema,
  clientFeedItemSchema,
  routeSchemas,
} from "@agency_hub_core/contracts";
import {
  CONVERSATION_FEED_SUMMARY_DEFAULT_WINDOW,
  CONVERSATION_FEED_SUMMARY_MAX_WINDOW,
  conversationFeedSummaryWindow,
  type ConversationFeedRow,
} from "@agency_hub_core/db";

import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { CLIENT_FEATURE_REQUIREMENTS, evaluateClientFeature } from "../apps/runtime/src/services/client-features.ts";
import { CLIENT_BOOTSTRAP_LIMITS } from "../apps/runtime/src/services/client-limits.ts";
import {
  CLIENT_FEED_CURSOR_DOMAIN,
  conversationFeedSourceOf,
  toClientFeedItem,
} from "../apps/runtime/src/services/conversation-feed.ts";
import { SIGNED_CURSOR_MAX_LENGTH } from "../apps/runtime/src/services/signed-cursor.ts";
import * as sdk from "../packages/sdk/src/index.ts";
import { kernelOperations } from "../packages/sdk/src/operations.ts";
import {
  FROZEN_FEED_LIMITS,
  FROZEN_FEED_SENDERS,
  FROZEN_PING_SEGMENTS,
  frozenFeedItemSchema,
  frozenFeedPageSchema,
  frozenFeedQuerySchema,
} from "./helpers/client-feed-frozen.ts";

// chat-extension H-9c: the wire shape of the archive feed
// (`clientConversationFeed`). The chat extension froze this route in its
// contracts before the hub shipped it (tests/helpers/client-feed-frozen.ts), so
// the hub must take every query the client can build and answer a page the
// client parses. The behaviour over real rows is
// tests/client-feed.integration.test.ts.

const FAN = "518588958";
const ISO = "2026-10-03T12:00:00.000Z";

/** The client's own sample of a first page (its packages/contracts/test/fixtures/hub.ts). */
function clientSample(): Record<string, unknown> {
  const item = {
    messageId: "9002",
    at: ISO,
    sender: "fan",
    text: "hey",
    automatic: null,
    deleted: false,
    tipMills: null,
    priceMills: null,
    attachmentLabels: [],
  };
  return {
    target: { pageLabel: "lora-of", fanRef: FAN },
    source: "union",
    snapshotRevision: "snap-1",
    asOf: ISO,
    coverage: "complete",
    head: { messageRef: "9002", at: ISO, sender: "fan" },
    newestKnownAt: ISO,
    nextOlderCursor: "cur-older-1",
    items: [
      item,
      { ...item, messageId: "9001", sender: "model", text: "", priceMills: 15_000, attachmentLabels: ["[Photo]"] },
    ],
    summary: {
      pingSegment: "segment-a",
      fanSilenceDays: 0,
      window: { requested: 100, served: 40 },
      coverage: "complete",
      asOf: ISO,
    },
  };
}

function storedRow(over: Partial<ConversationFeedRow> = {}): ConversationFeedRow {
  return {
    messageRef: "9002",
    occurredAt: new Date(ISO),
    position: { at: "2026-10-03T12:00:00.000000Z", ref: "9002" },
    textPlain: "hey",
    senderRole: "fan",
    isSentByMe: false,
    priceMills: null,
    isTip: false,
    tipAmountMills: "0",
    mediaMetadata: null,
    isOpened: null,
    deleted: false,
    ...over,
  };
}

describe("archive feed contract (H-9c)", () => {
  it("declares a page-scoped device-token GET with the page and the fan in the path", () => {
    const route = routeSchemas.clientConversationFeed as {
      auth: { kind: string; scope?: string };
      tags: readonly string[];
      body?: unknown;
      querystring?: unknown;
      params?: { safeParse(value: unknown): { success: boolean } };
      response: Record<number, unknown>;
    };
    expect(route.auth).toEqual({ kind: "apiKey", scope: "page" });
    expect(route.tags).toEqual(["client"]);
    expect(route.body).toBeUndefined();
    expect(route.querystring).toBe(clientConversationFeedQuerySchema);
    expect(route.response[200]).toBe(clientConversationFeedResponseSchema);
    expect(Object.keys(route.response).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    expect(route.params?.safeParse({ pageLabel: "lora-of", fanRef: FAN }).success).toBe(true);
    // The fan id has one shape on every client route (critic item 14).
    for (const fanRef of ["0518588958", "fan-1", "", "5".repeat(31)]) {
      expect(route.params?.safeParse({ pageLabel: "lora-of", fanRef }).success, fanRef).toBe(false);
    }
    expect(kernelOperations.clientConversationFeed).toEqual({
      method: "GET",
      path: "/api/v1/client/pages/:pageLabel/conversations/:fanRef/feed",
    });
  });

  it("takes every query the client can build, as the query string carries it", () => {
    expect(clientConversationFeedQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(clientConversationFeedQuerySchema.parse({ cursor: "cur-older-1", limit: "100", summaryWindow: "1500" }))
      .toEqual({ cursor: "cur-older-1", limit: 100, summaryWindow: 1500 });
    for (const limit of [1, 2, 50, 99, 100]) {
      for (const summaryWindow of [5, 100, 200, 1500]) {
        const query = { cursor: "c".repeat(2048), limit, summaryWindow };
        // The client builds it (its frozen query schema, with the two path params)…
        expect(frozenFeedQuerySchema.safeParse({ pageLabel: "lora-of", fanRef: FAN, ...query }).success).toBe(true);
        // …and the hub takes it off the query string.
        expect(clientConversationFeedQuerySchema.parse({
          cursor: query.cursor, limit: String(limit), summaryWindow: String(summaryWindow),
        })).toEqual(query);
      }
    }
  });

  it("refuses a query the client cannot build: limits out of range, a deep summary, an unknown key", () => {
    const refused: Array<Record<string, unknown>> = [
      { limit: "0" },
      { limit: "101" },
      { limit: "1.5" },
      { limit: "many" },
      { summaryWindow: "4" },
      { summaryWindow: "1501" },
      // The deep read (3000) is the full Recap's alone (critic item 15).
      { summaryWindow: "3000" },
      { summaryWindow: "7.5" },
      { cursor: "" },
      { cursor: "c".repeat(2049) },
      // The page and the fan are the path's: named in the query they would not
      // be scope-checked, so the strict query refuses them instead of ignoring them.
      { pageLabel: "mia-of" },
      { fanRef: "777000888" },
      { conversationRef: "777000888" },
      { userId: "1" },
      // No other way to move through the feed than the cursor.
      { offset: "50" },
      { before: "9001" },
      { source: "union" },
    ];
    for (const query of refused) {
      expect(clientConversationFeedQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it("answers a page the client parses, and parses the client's own sample", () => {
    const sample = clientSample();
    expect(clientConversationFeedResponseSchema.parse(sample)).toEqual(sample);
    expect(frozenFeedPageSchema.parse(sample)).toEqual(sample);

    // An empty conversation, and a later page of a walk.
    const empty = { ...sample, coverage: "unknown", head: null, newestKnownAt: null, nextOlderCursor: null, items: [] };
    const later = { ...sample, summary: null };
    for (const body of [empty, later]) {
      expect(clientConversationFeedResponseSchema.parse(body)).toEqual(body);
      expect(frozenFeedPageSchema.safeParse(body).success).toBe(true);
    }
  });

  it("keeps the growing vocabularies open, and strips a key it does not know", () => {
    const sample = clientSample();
    const future = {
      ...sample,
      source: "some_future_reader",
      coverage: "some_future_coverage",
      head: { messageRef: "9002", at: null, sender: "some-future-sender" },
      items: [{ ...(sample.items as Array<Record<string, unknown>>)[0], sender: "some-future-sender", automatic: true }],
      summary: { ...(sample.summary as Record<string, unknown>), pingSegment: "segment-c", fanSilenceDays: null },
    };
    expect(clientConversationFeedResponseSchema.parse(future)).toEqual(future);
    expect(clientConversationFeedResponseSchema.parse({ ...sample, someFutureField: { x: 1 } }))
      .not.toHaveProperty("someFutureField");
  });

  it("holds the bounds the client froze: a page of at most 100, captions of at most 80, whole mills", () => {
    const sample = clientSample();
    const item = (sample.items as Array<Record<string, unknown>>)[0]!;
    const refused: Array<Record<string, unknown>> = [
      { ...sample, items: Array.from({ length: 101 }, () => item) },
      { ...sample, items: [{ ...item, attachmentLabels: ["x".repeat(81)] }] },
      { ...sample, items: [{ ...item, attachmentLabels: Array.from({ length: 51 }, () => "[Photo]") }] },
      { ...sample, items: [{ ...item, tipMills: 1.25 }] },
      { ...sample, items: [{ ...item, priceMills: "15000" }] },
      { ...sample, target: { pageLabel: "lora-of", fanRef: "fan-1" } },
      { ...sample, summary: { ...(sample.summary as Record<string, unknown>), fanSilenceDays: -1 } },
      { ...sample, nextOlderCursor: "" },
    ];
    for (const body of refused) {
      expect(clientConversationFeedResponseSchema.safeParse(body).success, JSON.stringify(body).slice(0, 120)).toBe(false);
    }
    expect(clientConversationFeedResponseSchema.safeParse({
      ...sample, items: Array.from({ length: 100 }, () => item),
    }).success).toBe(true);
  });

  it("states the client's limits and vocabularies as constants, the same in the contract, the reader and the bootstrap", () => {
    expect({
      defaultLimit: CLIENT_FEED_DEFAULT_LIMIT,
      maxLimit: CLIENT_FEED_MAX_LIMIT,
      summaryWindowDefault: CLIENT_FEED_SUMMARY_WINDOW_DEFAULT,
      summaryWindowMin: CLIENT_FEED_SUMMARY_WINDOW_MIN,
      summaryWindowMax: CLIENT_FEED_SUMMARY_WINDOW_MAX,
    }).toEqual(FROZEN_FEED_LIMITS);
    expect(CLIENT_FEED_SENDERS).toEqual(FROZEN_FEED_SENDERS);
    expect(CLIENT_FEED_PING_SEGMENTS).toEqual(FROZEN_PING_SEGMENTS);
    expect(CLIENT_FEED_SOURCES).toEqual(["archive", "union"]);
    expect(CLIENT_CURSOR_REFUSAL_REASONS).toEqual(["cursor_invalid"]);
    expect(CLIENT_COVERAGE_LEVELS).toEqual(["complete", "partial", "unknown"]);

    // The bootstrap announces the page size the route enforces.
    expect(CLIENT_BOOTSTRAP_LIMITS.feedMax).toBe(CLIENT_FEED_MAX_LIMIT);
    // The summary reads through the transcript readers, at their window.
    expect(CONVERSATION_FEED_SUMMARY_DEFAULT_WINDOW).toBe(CLIENT_FEED_SUMMARY_WINDOW_DEFAULT);
    expect(CONVERSATION_FEED_SUMMARY_MAX_WINDOW).toBe(CLIENT_FEED_SUMMARY_WINDOW_MAX);
    expect(conversationFeedSummaryWindow(undefined)).toBe(100);
    expect(conversationFeedSummaryWindow(CLIENT_FEED_SUMMARY_WINDOW_MAX)).toBe(1500);
    // A cursor the hub signs always fits the wire.
    expect(clientCursorSchema.safeParse("c".repeat(SIGNED_CURSOR_MAX_LENGTH)).success).toBe(true);
    expect(clientCursorSchema.safeParse("c".repeat(SIGNED_CURSOR_MAX_LENGTH + 1)).success).toBe(false);
    expect(CLIENT_FEED_CURSOR_DOMAIN).toBe("agency-hub:client-feed-cursor:v1");
  });

  it("is on the narrow token's list and completes the preview feature as archive-feed-v1", () => {
    expect(CLIENT_TOKEN_PROFILES["chat-extension"].operations).toContain("clientConversationFeed");
    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain("archive-feed-v1");
    expect(SERVED_CLIENT_CAPABILITIES).toContain("archive-feed-v1");
    expect(CLIENT_FEATURE_REQUIREMENTS.preview).toEqual({ platforms: ["onlyfans"], capabilities: ["archive-feed-v1"] });
    const preview = (served: readonly string[]) => evaluateClientFeature({
      settings: { enabled: true, features: { "*": { preview: true } }, hostBindings: {} },
      page: { label: "lora-of", platform: "onlyfans", platformAccountId: "100000001" },
      flag: "preview",
      served,
    });
    expect(preview([])).toEqual({ available: false, reason: "hub_not_ready" });
    expect(preview(SERVED_CLIENT_CAPABILITIES)).toEqual({ available: true });
  });

  it("leaves the older conversation reads to the cookie session: no device token reads messages through them", () => {
    const schemas = routeSchemas as unknown as Record<string, { auth: { kind: string; scope?: string } }>;
    for (const key of ["pageConversationPreview", "pageConversationMessages"]) {
      expect(schemas[key]!.auth, key).toEqual({ kind: "session", scope: "page" });
      expect(CLIENT_TOKEN_PROFILES["chat-extension"].operations, key).not.toContain(key);
    }
  });

  it("re-exports the known values from the generated SDK (the client cannot reach contracts)", () => {
    for (const name of [
      "CLIENT_CURSOR_REFUSAL_REASONS",
      "CLIENT_FEED_DEFAULT_LIMIT",
      "CLIENT_FEED_MAX_LIMIT",
      "CLIENT_FEED_PING_SEGMENTS",
      "CLIENT_FEED_SENDERS",
      "CLIENT_FEED_SOURCES",
      "CLIENT_FEED_SUMMARY_WINDOW_DEFAULT",
      "CLIENT_FEED_SUMMARY_WINDOW_MAX",
      "CLIENT_FEED_SUMMARY_WINDOW_MIN",
    ] as const) {
      expect(sdk[name], name).toBeDefined();
      expect(sdk[name], name).toBe(contracts[name]);
    }
  });
});

describe("archive feed rows on the wire (H-9c)", () => {
  /** A row as the wire carries it: the hub's shape and the client's frozen one. */
  function wire(over: Partial<ConversationFeedRow> = {}) {
    const item = toClientFeedItem(storedRow(over));
    expect(clientFeedItemSchema.parse(item)).toEqual(item);
    expect(frozenFeedItemSchema.parse(item)).toEqual(item);
    return item;
  }

  it("carries a plain message as stored; the stores hold no automation signal", () => {
    expect(wire()).toEqual({
      messageId: "9002",
      at: ISO,
      sender: "fan",
      text: "hey",
      automatic: null,
      deleted: false,
      tipMills: null,
      priceMills: null,
      attachmentLabels: [],
    });
  });

  it("names the sender by the direction flag first, then by the stored role; an unknown role stays unknown", () => {
    const sender = (senderRole: string, isSentByMe: boolean) => wire({ senderRole, isSentByMe }).sender;
    expect(sender("model", true)).toBe("model");
    // A row whose role was never recorded is still the page's own message.
    expect(sender("unknown", true)).toBe("model");
    expect(sender("fan", false)).toBe("fan");
    expect(sender("system", false)).toBe("system");
    expect(sender("unknown", false)).toBe("unknown");
    // Not the page's by the flag: the role alone does not make it the page's.
    expect(sender("model", false)).toBe("unknown");
    expect(sender("moderator", false)).toBe("unknown");
    expect(sender("", false)).toBe("unknown");
  });

  it("keeps a deleted message as a flagged row without its text, whatever the store still has", () => {
    // The stores keep what they captured; the route never hands it on. The
    // client's schema takes an empty string, never null.
    const taken = wire({ deleted: true, textPlain: "said then deleted" });
    expect(taken).toMatchObject({ deleted: true, text: "" });
    expect(JSON.stringify(taken)).not.toContain("said then deleted");
    expect(wire({ deleted: true, textPlain: "" })).toMatchObject({ deleted: true, text: "" });
    // Only the text goes: the row keeps its place, its sender, its money and its captions.
    expect(wire({
      deleted: true,
      textPlain: "look at this",
      isSentByMe: true,
      senderRole: "model",
      priceMills: "15000",
      mediaMetadata: [{ id: 31, type: "photo" }],
    })).toEqual({
      messageId: "9002",
      at: ISO,
      sender: "model",
      text: "",
      automatic: null,
      deleted: true,
      tipMills: null,
      priceMills: 15_000,
      attachmentLabels: ["[Photo]"],
    });
    expect(wire({ deleted: true, textPlain: "for you", isTip: true, tipAmountMills: "5000", priceMills: "5000" }))
      .toMatchObject({ deleted: true, text: "", tipMills: 5000, priceMills: null });
    // A live message keeps its text.
    expect(wire({ deleted: false, textPlain: "said and kept" })).toMatchObject({ deleted: false, text: "said and kept" });
  });

  it("carries money as whole mills: a tip is a tip, a price is a price, nothing is zero", () => {
    // A paid message of the page.
    expect(wire({ isSentByMe: true, senderRole: "model", priceMills: "15000" }))
      .toMatchObject({ tipMills: null, priceMills: 15_000 });
    // A tip: OnlyFans sends one number, stored as the price too. It is the tip.
    expect(wire({ isTip: true, tipAmountMills: "5000", priceMills: "5000" }))
      .toMatchObject({ tipMills: 5000, priceMills: null });
    // A tip whose amount the stores do not hold, a free message, a zero price.
    expect(wire({ isTip: true, tipAmountMills: "0" })).toMatchObject({ tipMills: null, priceMills: null });
    expect(wire({ priceMills: "0" })).toMatchObject({ tipMills: null, priceMills: null });
    // Not a tip by its flag: the stored amount is not reported as one.
    expect(wire({ isTip: false, tipAmountMills: "5000" })).toMatchObject({ tipMills: null });
    // Anything that is not a positive whole number a client can hold reads "none".
    for (const stored of ["-5000", "1.5", "abc", "", "99999999999999999999"]) {
      expect(wire({ priceMills: stored }).priceMills, stored).toBeNull();
      expect(wire({ isTip: true, tipAmountMills: stored }).tipMills, stored).toBeNull();
    }
  });

  it("captions media in a generation's own words, without ids, prices or tips", () => {
    const labels = (mediaMetadata: Array<Record<string, unknown>> | null, over: Partial<ConversationFeedRow> = {}) =>
      wire({ mediaMetadata, ...over }).attachmentLabels;
    expect(labels(null)).toEqual([]);
    expect(labels([])).toEqual([]);
    expect(labels([{ id: 31, type: "photo", canView: true }])).toEqual(["[Photo]"]);
    expect(labels([{ id: 32, type: "video" }])).toEqual(["[Video]"]);
    expect(labels([{ id: 33, type: "audio" }])).toEqual(["[Audio]"]);
    expect(labels([{ id: 34, type: "gif" }])).toEqual(["[GIF]"]);
    expect(labels([{ id: 35, type: "sticker" }])).toEqual(["[Media]"]);
    expect(labels([{ id: 36 }])).toEqual(["[Media]"]);
    expect(labels([{ id: 1, type: "photo" }, { id: 2, type: "photo" }, { id: 3, type: "video" }]))
      .toEqual(["[Media Bundle: 2 Photos, 1 Video]"]);
    expect(labels([{ id: 1, type: "audio" }, { id: 2, type: "gif" }])).toEqual(["[Media Bundle]"]);
    // The price and the tip have fields of their own: the caption does not repeat them.
    expect(labels([{ id: 31, type: "photo" }], { isSentByMe: true, senderRole: "model", priceMills: "15000", isOpened: true }))
      .toEqual(["[Photo]"]);
    expect(labels([{ id: 31, type: "photo" }], { isTip: true, tipAmountMills: "5000", priceMills: "5000" }))
      .toEqual(["[Photo]"]);
    // A large bundle is still one caption within the wire's bounds.
    const bundle = labels(Array.from({ length: 60 }, (_unused, index) => ({ id: index, type: index % 2 ? "photo" : "video" })));
    expect(bundle).toEqual(["[Media Bundle: 30 Photos, 30 Videos]"]);
  });

  it("answers no time rather than a time the client's schema refuses", () => {
    expect(wire({ occurredAt: null }).at).toBeNull();
    expect(wire({ occurredAt: new Date(Number.NaN) }).at).toBeNull();
    // toISOString spells a year past 9999 with six digits and a sign.
    expect(wire({ occurredAt: new Date("+010000-01-01T00:00:00.000Z") }).at).toBeNull();
    expect(wire({ occurredAt: new Date("1970-01-01T00:00:00.000Z") }).at).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("archive feed reader choice (H-9c)", () => {
  it("follows the generation's switch: only serve reads the union", () => {
    expect(conversationFeedSourceOf("serve")).toBe("union");
    // off and shadow serve the archive to a generation; so does a value that cannot be read.
    for (const mode of ["off", "shadow", "unknown", undefined, null, "", "SERVE", 1]) {
      expect(conversationFeedSourceOf(mode), String(mode)).toBe("archive");
    }
  });
});
