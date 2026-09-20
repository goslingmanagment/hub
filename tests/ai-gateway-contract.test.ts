import { randomUUID } from "node:crypto";

import { aiGatewayFeatures, legacyAiUsageFeatures } from "@agency_hub_core/shared";
import { describe, expect, it } from "vitest";

import {
  aiFeatureStreamFrameSchema,
  aiGatewayStreamBodySchema,
  aiGatewayStreamFrameSchema,
} from "../packages/contracts/src/routes.ts";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: randomUUID(),
    feature: "fast-reply",
    pageLabel: "lora-of",
    platform: "onlyfans",
    platformUserId: "123456789",
    conversationId: "123456789",
    model: "anthropic:claude-sonnet-4-6",
    reasoningEffort: "low",
    isRegeneration: false,
    prompt: {
      systemBlocks: [{ text: "system instructions", cache: "1h" }],
      userBlocks: [{ text: "conversation context", cache: "5m" }],
    },
    ...overrides,
  };
}

describe("AI gateway contract", () => {
  it("accepts a desktop-built prompt stream request", () => {
    expect(aiGatewayStreamBodySchema.parse(validBody())).toMatchObject({
      feature: "fast-reply",
      pageLabel: "lora-of",
      platform: "onlyfans",
      model: "anthropic:claude-sonnet-4-6",
    });
  });

  it("uses the closed gateway feature enum — every live lane, no retired one", () => {
    for (const feature of aiGatewayFeatures) {
      expect(aiGatewayStreamBodySchema.safeParse(validBody({ feature })).success, feature)
        .toBe(true);
    }

    // Decision 376: a retired lane stays in the LEDGER enum so historical
    // ai_usage_events rows still parse, but the gateway must refuse a new
    // request for it — the budgets and prompts behind it are gone.
    expect(legacyAiUsageFeatures.length).toBeGreaterThan(0);
    for (const feature of legacyAiUsageFeatures) {
      expect(aiGatewayStreamBodySchema.safeParse(validBody({ feature })).success, feature)
        .toBe(false);
    }

    expect(aiGatewayStreamBodySchema.safeParse(validBody({ feature: "compare" })).success)
      .toBe(false);
    expect(aiGatewayStreamBodySchema.safeParse(validBody({ feature: "unknown" })).success)
      .toBe(false);
  });

  it("rejects prompt shape drift and unknown top-level fields", () => {
    expect(aiGatewayStreamBodySchema.safeParse(validBody({
      prompt: {
        systemBlocks: [{ text: "system", cache: "forever" }],
        userBlocks: [{ text: "user", cache: "5m" }],
      },
    })).success).toBe(false);
    expect(aiGatewayStreamBodySchema.safeParse(validBody({
      providerApiKey: "must-not-cross-wire",
    })).success).toBe(false);
  });

  it("defines the SSE frame payloads without raw prompts or provider bodies", () => {
    const requestId = randomUUID();
    const clientRequestId = randomUUID();
    expect(aiGatewayStreamFrameSchema.parse({
      type: "meta",
      requestId,
      clientRequestId,
      feature: "fast-reply",
      pageLabel: "lora-of",
      model: "anthropic:claude-sonnet-4-6",
      provider: "anthropic",
      providerResponseId: null,
      quota: {
        accepted: true,
        remainingRequestsToday: 99,
        remainingMicroUsdToday: 500_000,
      },
    })).toMatchObject({ type: "meta", requestId });
    expect(aiGatewayStreamFrameSchema.parse({
      type: "content_delta",
      text: "hello",
    })).toEqual({ type: "content_delta", text: "hello" });
    expect(aiGatewayStreamFrameSchema.parse({
      type: "usage",
      providerResponseId: "msg_123",
      cacheHit: false,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheWriteTokens: 10,
        cacheReadTokens: 0,
        costMicroUsd: 12,
        costApproximate: false,
      },
    })).toMatchObject({ type: "usage", providerResponseId: "msg_123" });
    expect(aiGatewayStreamFrameSchema.safeParse({
      type: "usage",
      providerResponseId: "msg_123",
      rawProviderBody: { text: "must-not-cross-wire" },
      cacheHit: false,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheWriteTokens: 10,
        cacheReadTokens: 0,
        costMicroUsd: 12,
        costApproximate: false,
      },
    }).success).toBe(false);
  });

  it("strictly contracts optional coach recap provenance on the existing meta frame", () => {
    const base = {
      type: "meta",
      requestId: randomUUID(),
      clientRequestId: randomUUID(),
      feature: "coach-chat",
      pageLabel: "lora-fs",
      model: "anthropic:claude-sonnet-4-6",
      provider: "anthropic",
      providerResponseId: null,
      quota: {
        accepted: true,
        remainingRequestsToday: 99,
        remainingMicroUsdToday: 500_000,
      },
    };
    const attachedRecaps = {
      full: { generatedAt: "2026-07-18T10:00:00.000Z", ageMs: 2_000 },
      short: null,
    };

    expect(aiGatewayStreamFrameSchema.parse({ ...base, attachedRecaps }))
      .toMatchObject({ type: "meta", attachedRecaps });
    const presetQuestion = "Разбери текущую ситуацию";
    expect(aiGatewayStreamFrameSchema.parse({ ...base, presetQuestion }))
      .toMatchObject({ type: "meta", presetQuestion });
    expect(aiGatewayStreamFrameSchema.safeParse({ ...base, presetQuestion: 42 }).success)
      .toBe(false);
    expect(aiGatewayStreamFrameSchema.safeParse({
      ...base,
      attachedRecaps: {
        ...attachedRecaps,
        unexpected: true,
      },
    }).success).toBe(false);
    expect(aiGatewayStreamFrameSchema.safeParse({
      ...base,
      attachedRecaps: {
        full: { ...attachedRecaps.full, rawBody: "must-not-cross-wire" },
        short: null,
      },
    }).success).toBe(false);
  });

  it("accepts debug_input_v1 only on the feature-lane frame union", () => {
    const frame = {
      type: "debug_input_v1",
      systemBlocks: [{ text: "system", cache: "1h" }],
      userBlocks: [{ text: "x".repeat(300_000), cache: "5m" }],
      contextManifest: { fanProfile: { version: 2, ageDays: 1 } },
    };
    expect(aiFeatureStreamFrameSchema.safeParse(frame).success).toBe(true);
    expect(aiGatewayStreamFrameSchema.safeParse(frame).success).toBe(false);
    expect(aiFeatureStreamFrameSchema.safeParse({ ...frame, extra: true }).success).toBe(false);
  });
});
