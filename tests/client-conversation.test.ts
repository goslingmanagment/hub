import { describe, expect, it } from "vitest";

import { errorResponseSchema } from "@agency_hub_core/contracts";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { resolveClientConversation } from "../apps/runtime/src/services/client-conversation.ts";
import { clientConversationsHaveOwnIds } from "../apps/runtime/src/services/client-features.ts";
import { BadRequestError, ConversationFanMismatchError } from "../apps/runtime/src/services/errors.ts";

// chat-extension R20 HF-10: the conversation a client read names
// (client-conversation.ts). The page's capture decides a Fansly pair: that half
// runs over real rows in tests/client-conversation-reads.integration.test.ts.
// Here: every answer the hub gives without reading anything.

const FAN = "777000777";
const OTHER_FAN = "777000888";
const GROUP = "650000000000000001";

/** A database that must not be asked: every answer below is given before any read. */
const untouched = {
  db: new Proxy({}, {
    get(_target, key) {
      throw new Error(`the database was read (${String(key)})`);
    },
  }),
} as unknown as Pick<AppContext, "db">;

const onlyFans = { id: 1, platform: "onlyfans" } as const;
const fansly = { id: 2, platform: "fansly" } as const;

describe("[R20 HF-10] the conversation of a client read", () => {
  it("a Fansly chat has an id of its own; an OnlyFans chat is its fan", () => {
    expect(clientConversationsHaveOwnIds("fansly")).toBe(true);
    expect(clientConversationsHaveOwnIds("onlyfans")).toBe(false);
  });

  it("on OnlyFans the fan names the conversation: left out or named again, it is the same read as before", async () => {
    for (const conversationRef of [undefined, FAN]) {
      await expect(resolveClientConversation(untouched, onlyFans, { fanRef: FAN, conversationRef }))
        .resolves.toEqual({ kind: "fan", conversationRef: FAN, fanRef: FAN });
    }
  });

  it("on OnlyFans any other conversation is another fan's chat: 409 conversation_fan_mismatch, naming no id", async () => {
    for (const conversationRef of [OTHER_FAN, GROUP]) {
      const refusal = resolveClientConversation(untouched, onlyFans, { fanRef: FAN, conversationRef });
      await expect(refusal).rejects.toBeInstanceOf(ConversationFanMismatchError);
      const error = (await refusal.catch((caught: unknown) => caught)) as ConversationFanMismatchError;
      expect([error.statusCode, error.code]).toEqual([409, "conversation_fan_mismatch"]);
      expect(error.message).not.toContain(FAN);
      expect(error.message).not.toContain(conversationRef);
      expect(errorResponseSchema.safeParse({ error: error.code, message: error.message, statusCode: 409 }).success)
        .toBe(true);
    }
  });

  it("on Fansly the fan's id names no chat: a read without the conversation is 400, before anything is read", async () => {
    const refusal = resolveClientConversation(untouched, fansly, { fanRef: FAN, conversationRef: undefined });
    await expect(refusal).rejects.toBeInstanceOf(BadRequestError);
    const error = (await refusal.catch((caught: unknown) => caught)) as BadRequestError;
    expect([error.statusCode, error.code, error.reason]).toEqual([400, "bad_request", null]);
  });
});
