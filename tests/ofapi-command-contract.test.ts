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

function validMediaBody() {
  return {
    clientCommandId: randomUUID(),
    kind: "send_media_message_v1" as const,
    accountId: "acct_11000000000000000000000000000000",
    conversationId: "123456789",
    payload: {
      text: "",
      price: 25,
      mediaFiles: ["3866342509", "ofapi_media_abc123"],
      previews: ["3866342509"],
    },
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

function validMarkReadBody() {
  return {
    clientCommandId: randomUUID(),
    kind: "mark_chat_read_v1" as const,
    accountId: "acct_11000000000000000000000000000000",
    conversationId: "123456789",
    payload: {},
  };
}

describe("OFAPI command contract", () => {
  it("accepts the versioned text-only command", () => {
    const body = validBody();
    expect(createOfapiCommandBodySchema.parse(body)).toEqual(body);
  });

  it("accepts the versioned media/PPV command without URLs or file bytes", () => {
    const body = validMediaBody();
    expect(createOfapiCommandBodySchema.parse(body)).toEqual(body);
    expect(createOfapiCommandBodySchema.parse({
      ...body,
      payload: {
        text: "free preview",
        price: 0,
        mediaFiles: ["ofapi_media_uploaded"],
        previews: [],
      },
    })).toMatchObject({
      kind: "send_media_message_v1",
      payload: { price: 0 },
    });
  });

  it("rejects malformed media command payloads", () => {
    const body = validMediaBody();
    const cases = [
      { payload: { ...body.payload, mediaFiles: [] } },
      { payload: { ...body.payload, mediaFiles: ["https://cdn.example/media.jpg"] } },
      { payload: { ...body.payload, mediaFiles: ["123", "123"] } },
      { payload: { ...body.payload, previews: ["999"] } },
      { payload: { ...body.payload, previews: ["123", "123"], mediaFiles: ["123"] } },
      { payload: { ...body.payload, price: 2 } },
      { payload: { ...body.payload, price: 25.5 } },
      { payload: { ...body.payload, text: "x".repeat(10_001) } },
      { payload: { ...body.payload, mediaUrl: "https://cdn.example/media.jpg" } },
    ];
    for (const broken of cases) {
      expect(createOfapiCommandBodySchema.safeParse({
        ...body,
        ...broken,
      }).success).toBe(false);
    }
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

  it("accepts the versioned mark-read command with an empty payload only", () => {
    const body = validMarkReadBody();
    expect(createOfapiCommandBodySchema.parse(body)).toEqual(body);
    expect(createOfapiCommandBodySchema.safeParse({
      ...body,
      payload: { messageId: "987654321" },
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
