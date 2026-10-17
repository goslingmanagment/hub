import { describe, expect, it } from "vitest";

import {
  AI_LIVE_PPV_MAX_ITEMS,
  AI_LIVE_PPV_PRICE_MAX_USD,
  aiLivePpvContextSchema,
  routeSchemas,
} from "@agency_hub_core/contracts";

import {
  AI_LIVE_TEXT_FEATURES,
  OPERATION_FEATURES,
  applyLivePpv,
  assertLivePpvRequestShape,
  type AiLivePpvItem,
  type TranscriptMessage,
} from "../apps/runtime/src/modules/ai/index.ts";
import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { BadRequestError } from "../apps/runtime/src/services/errors.ts";

// chat-extension X51: the PPV state of the open OnlyFans chat, read by the
// client from OnlyMonster's API (`livePpvContext`), and how it changes the
// transcript of one generation (context/live-ppv.ts). The wire shape is the
// client's (chat-extension contracts, decision X51).

const T0 = Date.parse("2026-10-17T06:00:00.000Z");

function message(id: string, sender: "Fan" | "Model", labels: string[] = [], text = "hey"): TranscriptMessage {
  return { id, createdAtMs: T0 + Number(id) * 1000, sender, text, labels };
}

const ppv = (id: string, priceUsd: number, purchased: boolean): AiLivePpvItem => ({ platformMessageId: id, priceUsd, purchased });

describe("livePpvContext: the wire shape", () => {
  it("takes ids, prices and purchase flags, at most 100, every id once", () => {
    const valid = { capturedAt: "2026-10-17T06:00:00.000Z", items: [ppv("9002", 25, true), ppv("9003", 9.99, false)] };
    expect(aiLivePpvContextSchema.safeParse(valid).success).toBe(true);
    for (const items of [
      [],
      [ppv("9002", 25, true), ppv("9002", 25, false)],
      [ppv("9002", 0, true)],
      [ppv("9002", AI_LIVE_PPV_PRICE_MAX_USD + 1, true)],
      [{ ...ppv("9002", 25, true), text: "no text rides here" }],
      [ppv("m9002", 25, true)],
      Array.from({ length: AI_LIVE_PPV_MAX_ITEMS + 1 }, (_, i) => ppv(String(9000 + i), 5, true)),
    ]) {
      expect(aiLivePpvContextSchema.safeParse({ ...valid, items }).success, JSON.stringify(items).slice(0, 80)).toBe(false);
    }
    // The stream's body takes it beside the rest; an unknown key stays refused.
    const body = routeSchemas.aiFeatureStream.body;
    const base = { clientRequestId: "6f8e3a0e-5c55-4e65-9f86-2f6a3c2b6c11", pageLabel: "lora-of", platform: "onlyfans", conversationRef: "12345" };
    expect(body.safeParse({ ...base, livePpvContext: valid }).success).toBe(true);
    expect(body.safeParse({ ...base, livePpv: valid }).success).toBe(false);
  });

  it("is served: the bootstrap lists live-ppv-v1", () => {
    expect(SERVED_CLIENT_CAPABILITIES).toContain("live-ppv-v1");
  });

  it("is refused where it can never be used: other features, beside clientContext, on a Fansly page", () => {
    for (const feature of OPERATION_FEATURES) {
      const shape = () => assertLivePpvRequestShape({ feature, isFanslyPage: false, hasClientContext: false });
      if ((AI_LIVE_TEXT_FEATURES as readonly string[]).includes(feature)) {
        expect(shape).not.toThrow();
      } else {
        expect(shape, feature).toThrow(BadRequestError);
      }
    }
    expect(() => assertLivePpvRequestShape({ feature: "fast-reply", isFanslyPage: false, hasClientContext: true })).toThrow(/clientContext/);
    expect(() => assertLivePpvRequestShape({ feature: "fast-reply", isFanslyPage: true, hasClientContext: false })).toThrow(/OnlyFans/);
    let refused: unknown;
    try {
      assertLivePpvRequestShape({ feature: "chat-review", isFanslyPage: false, hasClientContext: false });
    } catch (error) {
      refused = error;
    }
    expect((refused as BadRequestError).reason).toBe("live_text_not_allowed");
  });
});

describe("applyLivePpv: the transcript of one generation", () => {
  it("turns an unknown or not-purchased mark into what the platform says now, on the hub's price", () => {
    const messages = [
      message("1", "Model", ["[Video - PPV $25.00, unknown]"]),
      message("2", "Model", ["[Media Bundle: 2 Photos, 1 Video - PPV $40.00, not purchased]"]),
      message("3", "Model", ["[PPV $9.99, unknown]"]),
      message("4", "Fan", [], "bought it"),
    ];
    const applied = applyLivePpv(messages, [ppv("1", 30, true), ppv("2", 40, true), ppv("3", 9.99, false)]);
    expect(applied.messages.map((m) => m.labels)).toEqual([
      ["[Video - PPV $25.00, purchased]"],
      ["[Media Bundle: 2 Photos, 1 Video - PPV $40.00, purchased]"],
      ["[PPV $9.99, not purchased]"],
      [],
    ]);
    expect(applied.changed).toEqual(["1", "2", "3"]);
    expect(applied.matched).toEqual([]);
    expect(applied.ignored).toEqual([]);
    // Untouched messages are the same objects; touched ones are new.
    expect(applied.messages[3]).toBe(messages[3]);
    expect(applied.messages[0]).not.toBe(messages[0]);
    expect(messages[0]!.labels).toEqual(["[Video - PPV $25.00, unknown]"]);
  });

  it("a purchase does not come undone: the hub's `purchased` stands against a client's `false`", () => {
    const messages = [message("1", "Model", ["[Photo - PPV $10.00, purchased]"]), message("2", "Model", ["[Photo - PPV $10.00, not purchased]"])];
    const applied = applyLivePpv(messages, [ppv("1", 10, false), ppv("2", 10, false)]);
    expect(applied.messages.map((m) => m.labels)).toEqual([["[Photo - PPV $10.00, purchased]"], ["[Photo - PPV $10.00, not purchased]"]]);
    expect(applied.changed).toEqual([]);
    expect(applied.matched).toEqual(["1", "2"]);
    expect(applied.messages[0]).toBe(messages[0]);
  });

  it("a message without any label gets the client's price; one the hub holds with media and no price stays its free media", () => {
    const messages = [
      message("1", "Model", ["[Video]"]),
      message("2", "Model", [], "fresh, the archive has not caught it"),
      message("3", "Model", ["[GIF]", "[Tip: $5.00]"]),
    ];
    const applied = applyLivePpv(messages, [ppv("1", 15, false), ppv("2", 25, true), ppv("3", 7.5, true)]);
    // The image notes read `[Video]` as written and may describe it: the hub's free media is never relabelled.
    expect(applied.messages.map((m) => m.labels)).toEqual([["[Video]"], ["[PPV $25.00, purchased]"], ["[GIF]", "[Tip: $5.00]"]]);
    expect(applied.messages[0]).toBe(messages[0]);
    expect(applied.changed).toEqual(["2"]);
    expect(applied.ignored).toEqual([{ id: "1", reason: "unpriced" }, { id: "3", reason: "unpriced" }]);
  });

  it("what it cannot place is ignored, never guessed: an id outside the window, a fan's message, a repeat", () => {
    const messages = [message("1", "Fan", ["[Photo]"]), message("2", "Model", ["[Photo - PPV $5.00, unknown]"])];
    const applied = applyLivePpv(messages, [ppv("1", 5, true), ppv("7", 5, true), ppv("2", 5, true), ppv("2", 5, false)]);
    expect(applied.messages.map((m) => m.labels)).toEqual([["[Photo]"], ["[Photo - PPV $5.00, purchased]"]]);
    expect(applied.ignored).toEqual([
      { id: "2", reason: "duplicate" },
      { id: "1", reason: "fan" },
      { id: "7", reason: "absent" },
    ]);
    expect(applied.changed).toEqual(["2"]);
  });
});
