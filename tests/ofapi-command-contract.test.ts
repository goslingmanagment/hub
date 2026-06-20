import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createOfapiCommandBodySchema,
  ofapiCommandResponseSchema,
} from "../packages/contracts/src/routes.ts";

function validBody() {
  return {
    clientCommandId: randomUUID(),
    kind: "send_text_message_v1" as const,
    accountId: "acct_11000000000000000000000000000000",
    conversationId: "123456789",
    payload: { text: "hello" },
  };
}

function validTypingBody() {
  return {
    clientCommandId: randomUUID(),
    kind: "typing_active_v1" as const,
    accountId: "acct_11000000000000000000000000000000",
    conversationId: "123456789",
    payload: {},
  };
}

function validUnsendBody() {
  return {
    clientCommandId: randomUUID(),
    kind: "unsend_message_v1" as const,
    accountId: "acct_11000000000000000000000000000000",
    conversationId: "123456789",
    payload: { messageId: "987654321" },
  };
}

describe("OFAPI command contract", () => {
  it("accepts the versioned text-only command", () => {
    const body = validBody();
    expect(createOfapiCommandBodySchema.parse(body)).toEqual(body);
  });

  it("accepts the versioned typing command with an empty payload only", () => {
    const body = validTypingBody();
    expect(createOfapiCommandBodySchema.parse(body)).toEqual(body);
    expect(createOfapiCommandBodySchema.safeParse({
      ...body,
      payload: { text: "must not be accepted" },
    }).success).toBe(false);
    expect(createOfapiCommandBodySchema.safeParse({
      ...body,
      retryOfCommandId: randomUUID(),
    }).success).toBe(false);
  });

  it("accepts the versioned unsend command with a numeric message id only", () => {
    const body = validUnsendBody();
    expect(createOfapiCommandBodySchema.parse(body)).toEqual(body);
    expect(createOfapiCommandBodySchema.safeParse({
      ...body,
      payload: { messageId: "../987654321" },
    }).success).toBe(false);
    expect(createOfapiCommandBodySchema.safeParse({
      ...body,
      payload: { messageId: "987654321", text: "must not be accepted" },
    }).success).toBe(false);
    expect(createOfapiCommandBodySchema.safeParse({
      ...body,
      retryOfCommandId: randomUUID(),
    }).success).toBe(false);
  });

  it("rejects blank text, media fields, unknown top-level fields, and malformed ids", () => {
    expect(createOfapiCommandBodySchema.safeParse({
      ...validBody(),
      payload: { text: "   " },
    }).success).toBe(false);
    expect(createOfapiCommandBodySchema.safeParse({
      ...validBody(),
      payload: { text: "hello", mediaFiles: ["vault_1"] },
    }).success).toBe(false);
    expect(createOfapiCommandBodySchema.safeParse({
      ...validBody(),
      vendorPath: "/anything",
    }).success).toBe(false);
    expect(createOfapiCommandBodySchema.safeParse({
      ...validBody(),
      accountId: "not-an-account",
    }).success).toBe(false);
    expect(createOfapiCommandBodySchema.safeParse({
      ...validBody(),
      conversationId: "../messages",
    }).success).toBe(false);
  });

  it("status responses expose audit metadata but cannot echo command payload", () => {
    const response = {
      commandId: randomUUID(),
      clientCommandId: randomUUID(),
      kind: "unsend_message_v1" as const,
      accountId: "acct_11000000000000000000000000000000",
      conversationId: "123456789",
      state: "queued" as const,
      payloadHash: "a".repeat(64),
      retryOfCommandId: null,
      attemptCount: 0,
      lastErrorCode: null,
      lastErrorClass: null,
      verifierResult: null,
      platformMessageId: null,
      attemptStartedAt: null,
      attemptFinishedAt: null,
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      deduplicated: false,
    };
    expect(ofapiCommandResponseSchema.parse(response)).toEqual(response);
    expect(ofapiCommandResponseSchema.safeParse({
      ...response,
      payload: { text: "must not cross API" },
    }).success).toBe(true);
    expect(Object.keys(ofapiCommandResponseSchema.parse({
      ...response,
      payload: { text: "must not cross API" },
    }))).not.toContain("payload");
  });
});
