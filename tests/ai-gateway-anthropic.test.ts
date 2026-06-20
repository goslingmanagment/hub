import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AiGatewayStreamBody } from "@agency_hub_core/contracts";

import {
  buildAnthropicGatewayStreamRequest,
  estimateAnthropicGatewayRequestCost,
  normalizeAnthropicGatewayUsage,
  resolveAnthropicGatewayRequestTuning,
  toAnthropicGatewayTextBlocks,
} from "../apps/runtime/src/services/ai-gateway-anthropic.ts";
import { estimateAiGatewayUsageCost } from "../apps/runtime/src/services/ai-gateway-pricing.ts";

function body(overrides: Partial<AiGatewayStreamBody> = {}): AiGatewayStreamBody {
  const base: AiGatewayStreamBody = {
    clientRequestId: randomUUID(),
    feature: "fast-reply",
    pageLabel: "lora-of",
    platform: "onlyfans",
    platformUserId: "123456789",
    conversationId: "123456789",
    model: "anthropic:claude-sonnet-4-6",
    reasoningEffort: "off",
    isRegeneration: false,
    prompt: {
      systemBlocks: [
        { text: "safety", cache: "none" },
        { text: "personality", cache: "1h" },
      ],
      userBlocks: [
        { text: "transcript", cache: "5m" },
        { text: "task", cache: "none" },
      ],
    },
  };
  return { ...base, ...overrides };
}

describe("Anthropic AI gateway request builder", () => {
  it("maps gateway prompt blocks to Anthropic cache-control text blocks", () => {
    expect(toAnthropicGatewayTextBlocks([
      { text: "plain", cache: "none" },
      { text: "dynamic", cache: "5m" },
      { text: "static", cache: "1h" },
    ])).toEqual([
      { type: "text", text: "plain" },
      { type: "text", text: "dynamic", cache_control: { type: "ephemeral" } },
      { type: "text", text: "static", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });

  it("builds a streaming Anthropic request with desktop-compatible off-reasoning tuning", () => {
    const request = buildAnthropicGatewayStreamRequest(body());

    expect(request).toEqual({
      model: "claude-sonnet-4-6",
      stream: true,
      max_tokens: 8000,
      temperature: 0.65,
      system: [
        { type: "text", text: "safety" },
        { type: "text", text: "personality", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "transcript", cache_control: { type: "ephemeral" } },
          { type: "text", text: "task" },
        ],
      }],
    });
  });

  it("omits temperature when adaptive thinking is active", () => {
    const request = buildAnthropicGatewayStreamRequest(body({
      feature: "fan-summary",
      reasoningEffort: "max",
      temperature: 0.2,
    }));

    expect(request).toMatchObject({
      model: "claude-sonnet-4-6",
      max_tokens: 24000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    });
    expect(request).not.toHaveProperty("temperature");
  });

  it("omits sampling params for Opus 4.8 even when reasoning is off", () => {
    const tuning = resolveAnthropicGatewayRequestTuning({
      providerModelId: "claude-opus-4-8",
      feature: "fast-reply",
      temperature: 0.65,
      reasoningEffort: "off",
    });

    expect(tuning).toEqual({ maxTokens: 8000 });
  });

  it("maps scan to the same deep-analysis cap and temperature as fan-summary", () => {
    const request = buildAnthropicGatewayStreamRequest(body({
      feature: "scan",
      reasoningEffort: "off",
    }));

    expect(request.max_tokens).toBe(24000);
    expect(request.temperature).toBe(0.4);
  });

  it("fails closed for unsupported Anthropic gateway models", () => {
    expect(() =>
      buildAnthropicGatewayStreamRequest(body({
        model: "openrouter:x-ai/grok-4.3",
      }))
    ).toThrow("Unsupported Anthropic gateway model");
  });

  it("estimates worst-case request cost from prompt cache writes and output cap", () => {
    expect(estimateAnthropicGatewayRequestCost(body({
      model: "anthropic:claude-opus-4-8",
      maxTokens: 100_000,
    }))).toMatchObject({
      provider: "anthropic",
      providerModelId: "claude-opus-4-8",
      costMicroUsd: 2_500_064,
      costApproximate: true,
    });
  });
});

describe("Anthropic AI gateway usage normalization", () => {
  it("normalizes provider usage and preserves cache-write TTL breakdown for pricing", () => {
    const normalized = normalizeAnthropicGatewayUsage({
      input_tokens: 100,
      output_tokens: 8,
      cache_creation_input_tokens: 15,
      cache_read_input_tokens: 20,
      cache_creation: {
        ephemeral_5m_input_tokens: 10,
        ephemeral_1h_input_tokens: 5,
      },
    });

    expect(normalized).toEqual({
      cacheHit: true,
      usage: {
        inputTokens: 100,
        outputTokens: 8,
        cacheWriteTokens: 15,
        cacheReadTokens: 20,
        cacheWrite5mTokens: 10,
        cacheWrite1hTokens: 5,
      },
    });
    expect(estimateAiGatewayUsageCost("anthropic:claude-sonnet-4-6", normalized.usage))
      .toMatchObject({
        costMicroUsd: 494,
        costApproximate: false,
      });
  });

  it("keeps missing or malformed usage fields at zero for terminal error rows", () => {
    expect(normalizeAnthropicGatewayUsage({
      input_tokens: null,
      output_tokens: -1,
      cache_creation_input_tokens: Number.NaN,
      cache_read_input_tokens: 0,
    })).toEqual({
      cacheHit: false,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
    });
  });
});
