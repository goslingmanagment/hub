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

describe("OFAPI command contract", () => {
  it("accepts the versioned text-only command", () => {
    const body = validBody();
    expect(createOfapiCommandBodySchema.parse(body)).toEqual(body);
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
      kind: "send_text_message_v1" as const,
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
