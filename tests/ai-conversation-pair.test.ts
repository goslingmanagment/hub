import { describe, expect, it } from "vitest";

import {
  checkAiConversationPair,
  classifyAiConversationPair,
} from "../apps/runtime/src/modules/ai/index.ts";
import { AppError, ConversationFanMismatchError } from "../apps/runtime/src/services/errors.ts";

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
