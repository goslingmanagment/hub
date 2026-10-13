import { describe, expect, it } from "vitest";

import * as contracts from "@agency_hub_core/contracts";
import { AI_CONTEXT_PAIR_STATES, aiFeatureContextFrameSchema } from "@agency_hub_core/contracts";

import {
  buildAiContextFrameBody,
  checkAiConversationPair,
  classifyAiConversationPair,
} from "../apps/runtime/src/modules/ai/index.ts";
import { AppError, ConversationFanMismatchError } from "../apps/runtime/src/services/errors.ts";
import * as sdk from "../packages/sdk/src/index.ts";

// chat-extension R20 HF-9: the pair `groupId ↔ fanRef` of a Fansly AI request
// whose transcript the hub loads itself. The route, the database read and the
// released client's forms are in client-ai-conversation-pair.integration.test.ts.

const FAN = "700000000000000001";
// One double with FAN: only an exact string comparison tells them apart.
const OTHER_FAN = "700000000000000002";

describe("classifyAiConversationPair", () => {
  it("vouches for the pair only when the page's thread of the group has this fan", () => {
    expect(classifyAiConversationPair({ thread: { partnerPlatformUserId: FAN }, fanRef: FAN })).toBe("verified");
  });

  it("calls another fan's thread a mismatch, comparing ids as exact strings", () => {
    expect(Number(FAN)).toBe(Number(OTHER_FAN));
    expect(classifyAiConversationPair({ thread: { partnerPlatformUserId: OTHER_FAN }, fanRef: FAN })).toBe("mismatch");
    expect(classifyAiConversationPair({ thread: { partnerPlatformUserId: "42" }, fanRef: "042" })).toBe("mismatch");
    expect(classifyAiConversationPair({ thread: { partnerPlatformUserId: "42" }, fanRef: " 42" })).toBe("mismatch");
  });

  it("cannot vouch for a group the page holds no thread of, or whose fan it does not know", () => {
    expect(classifyAiConversationPair({ thread: null, fanRef: FAN })).toBe("unverified");
    expect(classifyAiConversationPair({ thread: { partnerPlatformUserId: null }, fanRef: FAN })).toBe("unverified");
    expect(classifyAiConversationPair({ thread: { partnerPlatformUserId: "" }, fanRef: FAN })).toBe("unverified");
  });
});

describe("checkAiConversationPair", () => {
  it("checks nothing and reads nothing when the request names no fan", async () => {
    const app = {
      get db(): never {
        throw new Error("no read without a fanRef");
      },
    };
    for (const fanRef of [undefined, null, "", "   "]) {
      await expect(checkAiConversationPair(app, { pageId: 1, conversationRef: "650000000000000001", fanRef }))
        .resolves.toBeNull();
    }
  });
});

describe("conversation_fan_mismatch", () => {
  it("is a 409 that names neither id", () => {
    const error = new ConversationFanMismatchError();
    expect(error).toBeInstanceOf(AppError);
    expect([error.statusCode, error.code]).toEqual([409, "conversation_fan_mismatch"]);
    expect(error.message).not.toMatch(/\d/);
  });
});

describe("the context_v1 frame's pair", () => {
  const frame = {
    type: "context_v1",
    generationRef: "5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f",
    source: "archive",
    servedHead: null,
    window: { requested: 25, served: 0 },
    coverage: "unknown",
    live: { status: "not_sent", accepted: 0, rejected: 0 },
  };

  it("names its known values, re-exported from the generated SDK", () => {
    expect(AI_CONTEXT_PAIR_STATES).toEqual(["verified", "unverified"]);
    expect(sdk.AI_CONTEXT_PAIR_STATES).toBe(contracts.AI_CONTEXT_PAIR_STATES);
  });

  it("is optional and an open token on the wire", () => {
    expect(aiFeatureContextFrameSchema.parse(frame)).not.toHaveProperty("pair");
    for (const pair of [...AI_CONTEXT_PAIR_STATES, "a-later-state"]) {
      expect(aiFeatureContextFrameSchema.parse({ ...frame, pair }).pair).toBe(pair);
    }
    expect(aiFeatureContextFrameSchema.safeParse({ ...frame, pair: "" }).success).toBe(false);
  });

  it("rides the frame body only when a pair was checked", () => {
    const base = {
      served: { source: "archive" as const, window: [], archiveHead: null },
      requestedCount: 25,
      coverage: "unknown" as const,
      fanLanguageEvidence: "unknown" as const,
    };
    expect(buildAiContextFrameBody(base)).not.toHaveProperty("pair");
    expect(buildAiContextFrameBody({ ...base, pair: "unverified" })).toMatchObject({ pair: "unverified" });
    expect(buildAiContextFrameBody({ ...base, pair: "verified" })).toMatchObject({ pair: "verified" });
  });
});
