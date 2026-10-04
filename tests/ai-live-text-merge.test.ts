import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import * as contracts from "@agency_hub_core/contracts";
import {
  AI_LIVE_TEXT_MAX_CHARS,
  AI_LIVE_TEXT_MAX_ITEMS,
  aiLiveTextContextSchema,
  routeSchemas,
  type AiStreamCapability,
} from "@agency_hub_core/contracts";
import type { AiLiveTextStoreState } from "@agency_hub_core/db";
import { getDescriptor, validateAiLiveTextContextModeTransition, validateConfigOverride } from "@agency_hub_core/shared";

import {
  AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT,
  AI_LIVE_TEXT_FEATURES,
  OPERATION_FEATURES,
  assertLiveTextRequestShape,
  formatTranscript,
  liveTextManifest,
  mergeLiveText,
  mergeLiveTextSafely,
  type AiContextMessageRef,
  type AiLiveTextItem,
  type TranscriptMessage,
} from "../apps/runtime/src/modules/ai/index.ts";
import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { CLIENT_FEATURE_REQUIREMENTS } from "../apps/runtime/src/services/client-features.ts";
import { CLIENT_BOOTSTRAP_LIMITS } from "../apps/runtime/src/services/client-limits.ts";
import { BadRequestError, ContextConflictError } from "../apps/runtime/src/services/errors.ts";
import * as sdk from "../packages/sdk/src/index.ts";

// chat-extension H-4c: the fresh text of the open OnlyFans chat
// (`liveTextContext`) and its merge into the transcript the hub loaded. The
// wire shape is the one the client froze (chat-extension
// packages/contracts/src/hub/ai.ts, LiveTextContextSchema).

const T0 = Date.parse("2026-10-04T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** One hub message: the transcript's form and the ref its store keeps. */
function hub(ref: string, sender: "Fan" | "Model", text: string, minutes: number) {
  const message: TranscriptMessage = { id: Number(ref), createdAtMs: T0 + minutes * 60_000, sender, text, labels: [] };
  const window: AiContextMessageRef = {
    messageRef: ref,
    occurredAt: new Date(message.createdAtMs),
    isFromFan: sender === "Fan",
  };
  return { message, window };
}

function item(id: string, direction: "fan" | "model", text: string, minutes: number): AiLiveTextItem {
  return { platformMessageId: id, direction, occurredAt: at(minutes), text };
}

const HUB = [
  hub("9001", "Fan", "hey babe", 0),
  hub("9002", "Model", "hey you", 5),
  hub("9003", "Fan", "sent you something", 10),
];

function merge(items: AiLiveTextItem[], overrides: {
  hubRows?: typeof HUB;
  stores?: Record<string, Partial<AiLiveTextStoreState>> | null;
  limit?: number;
} = {}) {
  const rows = overrides.hubRows ?? HUB;
  const stores = overrides.stores === null
    ? null
    : new Map(Object.entries(overrides.stores ?? {}).map(([id, state]) => [
      id,
      { foreign: false, deleted: false, isSentByMe: null, occurredAt: null, ...state },
    ]));
  return mergeLiveText({
    messages: rows.map((row) => row.message),
    window: rows.map((row) => row.window),
    items,
    stores,
    limit: overrides.limit ?? 100,
  });
}

const refs = (result: { window: AiContextMessageRef[] }) => result.window.map((message) => message.messageRef);

describe("mergeLiveText", () => {
  it("adds a message the hub does not hold yet, in the transcript's own form", () => {
    const result = merge([item("9004", "fan", "are you there?", 15)]);
    expect(refs(result)).toEqual(["9001", "9002", "9003", "9004"]);
    expect(result.messages[3]).toEqual({
      id: 9004, createdAtMs: T0 + 15 * 60_000, sender: "Fan", text: "are you there?", labels: [],
    });
    expect(result.window[3]).toEqual({ messageRef: "9004", occurredAt: new Date(T0 + 15 * 60_000), isFromFan: true });
    expect(result).toMatchObject({
      accepted: ["9004"], rejected: [], conflicts: [], matched: 0, outsideWindow: 0, headRef: "9004", hubSawHead: false,
    });
    // The model's own fresh message takes the model's side of the transcript.
    expect(merge([item("9005", "model", "miss me?", 16)]).messages[3]).toMatchObject({ sender: "Model" });
  });

  it("the hub's row wins for an id it already holds", () => {
    const result = merge([
      item("9003", "fan", "a different text of the same message", 10),
      // Even a different time: the hub's row is not touched.
      item("9002", "model", "hey you!!", 500),
    ]);
    expect(result.messages).toEqual(HUB.map((row) => row.message));
    expect(result.window).toEqual(HUB.map((row) => row.window));
    expect(result).toMatchObject({ accepted: [], rejected: [], conflicts: [], matched: 2 });
    // The client's newest message (by its own clock) is one the hub holds.
    expect(result).toMatchObject({ headRef: "9002", hubSawHead: true });
  });

  it("the page's HTML against the archive's plain text is not a disagreement", () => {
    const held = merge([item("9003", "fan", "<p>sent you <b>something</b></p>", 10)]);
    expect(held).toMatchObject({ conflicts: [], matched: 1, accepted: [] });
    expect(held.messages[2]!.text).toBe("sent you something");

    // A fresh item goes through the archive's own text normalization: tags and
    // entities out, line breaks kept (critic item 16).
    const fresh = merge([
      item("9004", "fan", "<p>look &amp; tell me</p><p>ok?<br>see <a href=\"https://x.example/a\">this</a></p>", 15),
    ]);
    expect(fresh.messages[3]!.text).toBe("look & tell me\nok?\nsee this");
    expect(formatTranscript(fresh.messages)).not.toMatch(/<|&amp;|href/);
  });

  it("an id the hub holds as sent by the other side is a conflict", () => {
    // In the served window.
    expect(merge([item("9003", "model", "sent you something", 10)])).toMatchObject({
      conflicts: [{ id: "9003", reason: "direction" }], accepted: [], matched: 0,
    });
    // Held for this conversation outside the window (a store row).
    const outside = merge([item("8000", "fan", "old one", -500)], { stores: { "8000": { isSentByMe: true } } });
    expect(outside).toMatchObject({ conflicts: [{ id: "8000", reason: "direction" }], accepted: [] });
    expect(refs(outside)).toEqual(["9001", "9002", "9003"]);
    // The same sender in the store is no conflict: the item joins.
    expect(merge([item("8000", "model", "old one", -500)], { stores: { "8000": { isSentByMe: true } } }))
      .toMatchObject({ conflicts: [], accepted: ["8000"] });
    // A store that holds no content for the id says nothing about its sender.
    expect(merge([item("8000", "fan", "old one", -500)], { stores: { "8000": { isSentByMe: null } } }))
      .toMatchObject({ conflicts: [], accepted: ["8000"] });
  });

  it("a message the hub can place keeps the hub's time, whatever the client's clock says", () => {
    // The archive holds 8000 for this conversation, ninety minutes before the
    // window; the client sends it as the newest message of the chat.
    const held = { "8000": { isSentByMe: false, occurredAt: new Date(T0 - 90 * 60_000) } };
    const moved = merge([item("8000", "fan", "CLIENT COPY", 15)], { stores: held, limit: 3 });
    // Ordered by the hub's time it lies before the window, and the cap drops it.
    expect(refs(moved)).toEqual(["9001", "9002", "9003"]);
    expect(moved.messages).toEqual(HUB.map((row) => row.message));
    expect(moved).toMatchObject({ accepted: [], rejected: [], conflicts: [], matched: 0, outsideWindow: 1 });
    expect(formatTranscript(moved.messages)).not.toContain("CLIENT COPY");
    // The head is still the client's newest message by its own clock, which the hub's transcript did not hold.
    expect(moved).toMatchObject({ headRef: "8000", hubSawHead: false });
    // An honest time gives the same answer.
    expect(merge([item("8000", "fan", "CLIENT COPY", -90)], { stores: held, limit: 3 }))
      .toMatchObject({ accepted: [], outsideWindow: 1 });
    // Beside a message the hub has not seen, only that one joins.
    const beside = merge([item("8000", "fan", "CLIENT COPY", 15), item("9004", "fan", "new", 16)], { stores: held, limit: 3 });
    expect(refs(beside)).toEqual(["9002", "9003", "9004"]);
    expect(beside).toMatchObject({ accepted: ["9004"], outsideWindow: 1 });

    // Held inside the window's time by a store the serving reader did not read
    // (the webhook archive, with the union off): it joins at the hub's place.
    const unread = merge(
      [item("9500", "model", "from the webhook store", 500)],
      { stores: { "9500": { isSentByMe: true, occurredAt: new Date(T0 + 7 * 60_000) } } },
    );
    expect(refs(unread)).toEqual(["9001", "9002", "9500", "9003"]);
    expect(unread.messages[2]).toMatchObject({ id: 9500, createdAtMs: T0 + 7 * 60_000, sender: "Model" });
    expect(unread.window[2]).toEqual({ messageRef: "9500", occurredAt: new Date(T0 + 7 * 60_000), isFromFan: false });
    expect(unread).toMatchObject({ accepted: ["9500"], outsideWindow: 0 });
    // The hub's time stands even where the client's names no instant.
    expect(merge(
      [{ platformMessageId: "9500", direction: "model", occurredAt: "2026-13-45T10:19:30Z", text: "x" }],
      { stores: { "9500": { isSentByMe: true, occurredAt: new Date(T0 + 7 * 60_000) } } },
    )).toMatchObject({ accepted: ["9500"], rejected: [] });

    // A message no store can place has the client's time, and only then.
    const unseen = merge([item("8000", "fan", "CLIENT COPY", 15)], { limit: 3 });
    expect(refs(unseen)).toEqual(["9002", "9003", "8000"]);
    expect(unseen).toMatchObject({ accepted: ["8000"], outsideWindow: 0 });
  });

  it("an id of another conversation is a conflict, whatever else is true of it", () => {
    const result = merge(
      [item("7001", "fan", "this is another fan's chat", 15), item("9004", "fan", "mine", 16)],
      { stores: { "7001": { foreign: true, deleted: true, isSentByMe: false } } },
    );
    expect(result.conflicts).toEqual([{ id: "7001", reason: "foreign_chat" }]);
    expect(result.rejected).toEqual([]);
    // The rest of the snapshot is still judged, but the caller must not serve it.
    expect(result.accepted).toEqual(["9004"]);
  });

  it("never restores a message the hub holds a tombstone for", () => {
    const result = merge(
      [item("9004", "fan", "deleted since", 15), item("9005", "fan", "still here", 16)],
      { stores: { "9004": { deleted: true, isSentByMe: false } } },
    );
    expect(result.rejected).toEqual([{ id: "9004", reason: "deleted" }]);
    expect(result.conflicts).toEqual([]);
    expect(refs(result)).toEqual(["9001", "9002", "9003", "9005"]);
    expect(formatTranscript(result.messages)).not.toContain("deleted since");
  });

  it("keeps the newest messages up to the window, the hub's and the client's alike", () => {
    const result = merge(
      [item("8000", "fan", "older than the window", -60), item("9004", "fan", "four", 15), item("9005", "model", "five", 16)],
      { limit: 4 },
    );
    expect(refs(result)).toEqual(["9002", "9003", "9004", "9005"]);
    // The old item merged, and the cap dropped it with the hub's oldest row.
    expect(result).toMatchObject({ accepted: ["9004", "9005"], outsideWindow: 1, rejected: [] });
    // No window, no messages (`slice(-0)` would keep them all).
    expect(merge([item("9004", "fan", "four", 15)], { limit: 0 })).toMatchObject({ messages: [], accepted: [], outsideWindow: 1 });
    // Merging never shrinks the transcript: a gate that counts messages can only tighten.
    for (const limit of [1, 3, 4, 100]) {
      const capped = merge([item("9004", "fan", "four", 15)], { limit });
      expect(capped.messages.length, String(limit)).toBeGreaterThanOrEqual(Math.min(limit, HUB.length));
      expect(capped.messages.length, String(limit)).toBeLessThanOrEqual(limit);
    }
  });

  it("orders by time, then by id, wherever an item arrived in the snapshot", () => {
    const result = merge([
      item("9010", "fan", "last", 30),
      item("9000", "fan", "before everything", -1),
      // The same instant as the hub's 9002: the id decides.
      item("9006", "fan", "tie after", 5),
      item("8999", "fan", "tie before", 5),
    ]);
    expect(refs(result)).toEqual(["9000", "9001", "8999", "9002", "9006", "9003", "9010"]);
    expect(result.accepted).toEqual(["9000", "8999", "9006", "9010"]);
    expect(result).toMatchObject({ headRef: "9010", hubSawHead: false });
    // An offset timestamp is the same instant.
    const offset = merge([{ platformMessageId: "9004", direction: "fan", occurredAt: "2026-10-04T13:15:00+03:00", text: "x" }]);
    expect(offset.messages[3]!.createdAtMs).toBe(T0 + 15 * 60_000);
  });

  it("rejects what it cannot use, and counts each reason", () => {
    const result = merge([
      item("9004", "fan", "first", 15),
      item("9004", "fan", "the same id again", 16),
      item("9005", "fan", "<p> </p><br>", 17),
      // Not a safe integer: the transcript keys a message by Number(id).
      item("9007199254740993", "fan", "too large an id", 18),
      { platformMessageId: "9006", direction: "fan", occurredAt: "not a time", text: "no time" },
    ]);
    expect(result.accepted).toEqual(["9004"]);
    expect(result.rejected).toEqual([
      { id: "9004", reason: "duplicate" },
      { id: "9005", reason: "empty" },
      { id: "9007199254740993", reason: "unusable" },
      { id: "9006", reason: "unusable" },
    ]);
    expect(result.messages.find((message) => message.id === 9004)!.text).toBe("first");
  });

  it("rejects an item whose time names no instant, though the wire takes its form", () => {
    // The client's frozen pattern checks the form only, and the hub's schema is
    // that pattern: a leap second, a thirteenth month and an offset of a whole
    // day all pass it. None can be placed in a transcript.
    const timeless = ["2026-10-04T23:59:60Z", "2026-13-45T10:19:30Z", "2026-10-04T10:19:30+24:00"]
      .map((occurredAt, index): AiLiveTextItem => (
        { platformMessageId: String(9004 + index), direction: "fan", occurredAt, text: "x" }
      ));
    const result = merge([...timeless, item("9010", "fan", "fine", 15)]);
    expect(result.rejected).toEqual([
      { id: "9004", reason: "unusable" }, { id: "9005", reason: "unusable" }, { id: "9006", reason: "unusable" },
    ]);
    expect(result.accepted).toEqual(["9010"]);
    // None of them is the head either.
    expect(result.headRef).toBe("9010");
  });

  it("rejects an item whose text a normalizer fails on, and still judges the rest", () => {
    // The text normalizers run on input the hub does not control. Whatever one
    // of them throws on is one item the transcript cannot use.
    const poisoned: AiLiveTextItem = {
      platformMessageId: "9004",
      direction: "fan",
      occurredAt: at(15),
      get text(): string {
        throw new RangeError("Invalid code point 1114112");
      },
    };
    const result = merge([poisoned, item("9005", "fan", "still here", 16)]);
    expect(result.rejected).toEqual([{ id: "9004", reason: "unusable" }]);
    expect(result.accepted).toEqual(["9005"]);
    expect(refs(result)).toEqual(["9001", "9002", "9003", "9005"]);
    // The text that used to throw: a numeric reference past Unicode's range
    // stays the text it was (tests/dm-text.test.ts).
    const literal = merge([item("9004", "fan", "lol &#1114112; ok &#x110000;", 15)]);
    expect(literal).toMatchObject({ accepted: ["9004"], rejected: [] });
    expect(literal.messages[3]!.text).toBe("lol &#1114112; ok &#x110000;");
  });

  it("without the store lookup nothing the hub cannot vouch for joins", () => {
    const result = merge([item("9003", "fan", "held", 10), item("9004", "fan", "fresh", 15)], { stores: null });
    expect(result).toMatchObject({ matched: 1, accepted: [], rejected: [{ id: "9004", reason: "unverified" }] });
    expect(refs(result)).toEqual(["9001", "9002", "9003"]);
  });

  it("an empty hub transcript takes the snapshot as the whole window", () => {
    const result = merge([item("9002", "model", "hi", 5), item("9001", "fan", "hey", 0)], { hubRows: [] });
    expect(refs(result)).toEqual(["9001", "9002"]);
    expect(result).toMatchObject({ accepted: ["9001", "9002"], headRef: "9002", hubSawHead: false });
  });
});

describe("mergeLiveTextSafely", () => {
  const input = (items: AiLiveTextItem[], limit = 100) => ({
    messages: HUB.map((row) => row.message),
    window: HUB.map((row) => row.window),
    items,
    stores: new Map<string, AiLiveTextStoreState>(),
    limit,
  });

  it("is the merge itself while the merge holds", () => {
    const items = [item("9004", "fan", "four", 15), item("9003", "fan", "held", 10)];
    const failures: unknown[] = [];
    expect(mergeLiveTextSafely(input(items), (error) => failures.push(error))).toEqual(mergeLiveText(input(items)));
    expect(failures).toEqual([]);
  });

  it("whatever the merge throws on, the hub's transcript stands and every item is rejected", () => {
    // Not a text failure (those reject one item): the merge itself breaks.
    const broken = {
      platformMessageId: "9005",
      occurredAt: at(16),
      text: "TEXT-OF-A-BROKEN-SNAPSHOT",
      get direction(): "fan" {
        throw new TypeError("boom");
      },
    } satisfies AiLiveTextItem;
    const items = [item("9004", "fan", "four", 15), broken];
    expect(() => mergeLiveText(input(items))).toThrow("boom");

    const failures: unknown[] = [];
    const result = mergeLiveTextSafely(input(items), (error) => failures.push(error));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(TypeError);
    expect(result).toEqual({
      messages: HUB.map((row) => row.message),
      window: HUB.map((row) => row.window),
      accepted: [],
      // Not even the item judged before the failure joins.
      rejected: [{ id: "9004", reason: "failed" }, { id: "9005", reason: "failed" }],
      conflicts: [],
      matched: 0,
      outsideWindow: 0,
      headRef: null,
      hubSawHead: false,
    });
    // The hub's rows are capped as any merge caps them.
    expect(refs(mergeLiveTextSafely(input(items, 2)))).toEqual(["9002", "9003"]);
    // What is recorded names ids and the reason, never the text.
    const manifest = liveTextManifest({ mode: "serve", status: "rejected", sent: 2, merge: result });
    expect(manifest).toMatchObject({ accepted: 0, rejected: 2, rejectedReasons: { failed: 2 }, acceptedRefs: [] });
    expect(JSON.stringify(manifest)).not.toContain("BROKEN");
  });
});

describe("liveTextManifest", () => {
  it("records ids, counts and switches, never a message's text or time (critic item 13)", () => {
    const secret = "TEXT-THAT-MUST-NOT-BE-RECORDED";
    const result = merge(
      [
        item("9004", "fan", `${secret} fresh`, 15),
        item("9005", "fan", `${secret} deleted`, 16),
        item("7001", "fan", `${secret} foreign`, 17),
        item("9003", "fan", `${secret} held`, 10),
        item("9002", "fan", `${secret} wrong side`, 5),
      ],
      { stores: { "9005": { deleted: true }, "7001": { foreign: true } } },
    );
    const manifest = liveTextManifest({ mode: "shadow", status: "shadow", sent: 5, merge: result });
    expect(manifest).toEqual({
      source: "client-supplied",
      mode: "shadow",
      status: "shadow",
      sent: 5,
      accepted: 1,
      rejected: 1,
      conflicts: 2,
      matched: 1,
      outsideWindow: 0,
      headRef: "7001",
      archiveSawHead: false,
      acceptedRefs: ["9004"],
      rejectedRefs: ["9005"],
      rejectedReasons: { deleted: 1 },
      conflictRefs: ["7001", "9002"],
      conflictReasons: { foreign_chat: 1, direction: 1 },
    });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("2026-10-04");
    // Every value is an id, a count, a flag or a token of this module.
    const scalars = (value: unknown): unknown[] => (
      Array.isArray(value) ? value.flatMap(scalars)
        : typeof value === "object" && value !== null ? Object.values(value).flatMap(scalars)
          : [value]
    );
    for (const value of scalars(manifest)) {
      expect(
        typeof value === "number" || typeof value === "boolean" || /^([1-9]\d{0,29}|[a-z_-]{1,32})$/.test(String(value)),
        String(value),
      ).toBe(true);
    }
  });
});

describe("assertLiveTextRequestShape", () => {
  const withFrame = new Set<AiStreamCapability>(["context-v1"]);
  const shape = (overrides: Partial<Parameters<typeof assertLiveTextRequestShape>[0]> = {}) => () => (
    assertLiveTextRequestShape({
      feature: "fast-reply", isFanslyRequest: false, hasClientContext: false, capabilities: withFrame, ...overrides,
    })
  );
  const refusal = (run: () => void) => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestError);
      const refused = error as BadRequestError;
      return { status: refused.statusCode, code: refused.code, reason: refused.reason };
    }
    return null;
  };

  it("accepts the four features that draft a message to the fan, and no other", () => {
    expect(AI_LIVE_TEXT_FEATURES).toEqual(["fast-reply", "improve-draft", "hi-greeting", "ping"]);
    for (const feature of OPERATION_FEATURES) {
      const allowed = (AI_LIVE_TEXT_FEATURES as readonly string[]).includes(feature);
      expect(refusal(shape({ feature })), feature).toEqual(
        allowed ? null : { status: 400, code: "bad_request", reason: "live_text_not_allowed" },
      );
    }
  });

  it("refuses a Fansly page and a request that brings its own clientContext", () => {
    const notAllowed = { status: 400, code: "bad_request", reason: "live_text_not_allowed" };
    expect(refusal(shape({ isFanslyRequest: true }))).toEqual(notAllowed);
    expect(refusal(shape({ hasClientContext: true }))).toEqual(notAllowed);
  });

  it("requires the capability that carries the answer, and checks it last", () => {
    const required = { status: 400, code: "bad_request", reason: "capability_required" };
    expect(refusal(shape({ capabilities: undefined }))).toEqual(required);
    expect(refusal(shape({ capabilities: new Set<AiStreamCapability>(["debug-input-v1", "split-all-v1"]) }))).toEqual(required);
    // A request wrong in two ways names the one a newer client could not fix.
    for (const wrong of [{ feature: "coach-chat" as const }, { isFanslyRequest: true }, { hasClientContext: true }]) {
      expect(refusal(shape({ ...wrong, capabilities: undefined }))).toMatchObject({ reason: "live_text_not_allowed" });
    }
  });
});

describe("liveTextContext body field", () => {
  const schema = routeSchemas.aiFeatureStream.body;
  const live = (overrides: Record<string, unknown> = {}, itemOverrides: Record<string, unknown> = {}) => ({
    capturedAt: "2026-10-04T10:20:00.000Z",
    items: [{
      platformMessageId: "4301234567890",
      direction: "fan",
      occurredAt: "2026-10-04T10:19:30+00:00",
      text: "hey",
      ...itemOverrides,
    }],
    ...overrides,
  });
  const body = (liveTextContext?: unknown) => ({
    clientRequestId: randomUUID(),
    pageLabel: "lora-of",
    platform: "onlyfans",
    conversationRef: "518588958",
    ...(liveTextContext !== undefined ? { liveTextContext } : {}),
  });

  it("is optional and takes exactly what the client froze", () => {
    expect(schema.safeParse(body()).success).toBe(true);
    expect(schema.safeParse(body(live())).success).toBe(true);
    expect(aiLiveTextContextSchema.safeParse(live()).success).toBe(true);
    // Both directions, an offset, up to nine fractional digits.
    expect(schema.safeParse(body(live({ capturedAt: "2026-10-04T13:20:00.123456789+03:00" }, { direction: "model" }))).success).toBe(true);
    // An instant is checked for its form and nothing more, like the client's
    // IsoTimestampSchema: what that accepts, this accepts. A string of the
    // right form that names no instant (a leap second, a thirteenth month, an
    // offset of a whole day) costs its item in the merge, never the request.
    for (const instant of ["2026-10-04T23:59:60Z", "2026-13-45T10:19:30Z", "2026-10-04T10:19:30+24:00", "2026-02-30T24:00:00Z"]) {
      expect(schema.safeParse(body(live({ capturedAt: instant }))).success, `capturedAt ${instant}`).toBe(true);
      expect(schema.safeParse(body(live({}, { occurredAt: instant }))).success, `occurredAt ${instant}`).toBe(true);
    }
    // The limits the bootstrap announces are the schema's.
    expect([AI_LIVE_TEXT_MAX_ITEMS, AI_LIVE_TEXT_MAX_CHARS]).toEqual([60, 5000]);
    expect(CLIENT_BOOTSTRAP_LIMITS).toMatchObject({ freshTextMaxItems: 60, freshTextMaxChars: 5000 });
    const full = live({ items: Array.from({ length: 60 }, (_, n) => ({ ...live().items[0], platformMessageId: String(n + 1) })) });
    expect(schema.safeParse(body(full)).success).toBe(true);
    expect(schema.safeParse(body(live({}, { text: "x".repeat(5000) }))).success).toBe(true);
  });

  it("refuses everything else", () => {
    const tooMany = live({ items: Array.from({ length: 61 }, (_, n) => ({ ...live().items[0], platformMessageId: String(n + 1) })) });
    const refused: Array<[string, unknown]> = [
      ["no items", live({ items: [] })],
      ["61 items", tooMany],
      ["empty text", live({}, { text: "" })],
      ["5001 chars", live({}, { text: "x".repeat(5001) })],
      ["a leading zero", live({}, { platformMessageId: "0123" })],
      ["a temporary id of an unsent message", live({}, { platformMessageId: "tmp-1" })],
      ["31 digits", live({}, { platformMessageId: "1".repeat(31) })],
      ["a numeric id", live({}, { platformMessageId: 123 })],
      ["an unknown direction", live({}, { direction: "system" })],
      ["a time without an offset", live({}, { occurredAt: "2026-10-04T10:19:30" })],
      ["a time without seconds", live({}, { occurredAt: "2026-10-04T10:19Z" })],
      ["ten fractional digits", live({}, { occurredAt: "2026-10-04T10:19:30.1234567890Z" })],
      ["a date without a time", live({}, { occurredAt: "2026-10-04" })],
      ["a time with a space for the T", live({}, { occurredAt: "2026-10-04 10:19:30Z" })],
      ["an offset without a colon", live({}, { occurredAt: "2026-10-04T10:19:30+0300" })],
      ["a time with something after it", live({}, { occurredAt: "2026-10-04T10:19:30Z\n" })],
      ["no capturedAt", { items: live().items }],
      ["a capturedAt that is not a time", live({ capturedAt: "now" })],
      ["an extra key", live({ source: "page" })],
      ["an extra item key", live({}, { isFromQueue: true })],
      ["money on an item", live({}, { priceMills: 5000 })],
    ];
    for (const [name, value] of refused) {
      expect(schema.safeParse(body(value)).success, name).toBe(false);
    }
  });

  it("re-exports its caps from the generated SDK (the client cannot reach contracts)", () => {
    for (const name of ["AI_LIVE_TEXT_MAX_ITEMS", "AI_LIVE_TEXT_MAX_CHARS"] as const) {
      expect(sdk[name], name).toBe(contracts[name]);
    }
  });
});

describe("fresh text switches", () => {
  it("is served by the hub, and still inert: the mode rests off", () => {
    expect(SERVED_CLIENT_CAPABILITIES).toContain("live-text-v1");
    expect(CLIENT_FEATURE_REQUIREMENTS.freshText).toEqual({ platforms: ["onlyfans"], capabilities: ["live-text-v1"] });
    expect(getDescriptor("aiLiveTextContextMode")).toMatchObject({
      default: "off", runtimeApply: "live", enumValues: ["off", "shadow", "serve"],
    });
    for (const mode of ["off", "shadow", "serve"]) {
      expect(validateConfigOverride("aiLiveTextContextMode", mode)).toEqual({ ok: true, value: mode });
    }
    expect(validateConfigOverride("aiLiveTextContextMode", "on").ok).toBe(false);
  });

  it("reaches serve only through shadow, and rolls back freely", () => {
    const step = validateAiLiveTextContextModeTransition;
    expect(step(null, "shadow")).toBeNull();
    expect(step("shadow", "serve")).toBeNull();
    expect(step(null, "serve")).toMatch(/go through shadow first/);
    expect(step("off", "serve")).toMatch(/go through shadow first/);
    // A stored value the hub no longer knows reads as off.
    expect(step("broken", "serve")).toMatch(/go through shadow first/);
    for (const [from, to] of [["serve", "shadow"], ["serve", "off"], ["shadow", "off"], ["serve", "serve"], ["off", "off"]] as const) {
      expect(step(from, to), `${from} -> ${to}`).toBeNull();
    }
    expect(step("off", "on")).toMatch(/must be one of/);
  });

  it("names the scope shared readers skip", () => {
    expect(AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT).toBe("principal-draft");
  });
});

describe("ContextConflictError", () => {
  it("is a 400 that names message ids only, and a bounded number of them", () => {
    const error = new ContextConflictError(["9003", "7001"]);
    expect(error).toMatchObject({ statusCode: 400, code: "context_conflict", messageIds: ["9003", "7001"] });
    expect(error.message).toBe(
      "liveTextContext conflicts with the hub's transcript of this conversation (message ids: 9003, 7001)",
    );
    const many = new ContextConflictError(Array.from({ length: 60 }, (_, n) => String(1000 + n)));
    expect(many.message).toContain("1000, 1001");
    expect(many.message).toContain("1009 and 50 more");
    expect(many.message).not.toContain("1010");
    expect(many.message.length).toBeLessThan(200);
  });
});
