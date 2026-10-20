import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AiGatewayStreamBody } from "@agency_hub_core/contracts";

import {
  buildAnthropicGatewayStreamRequest,
  estimateAnthropicGatewayRequestCost,
  normalizeAnthropicGatewayUsage,
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

  it("uses low effort for a short Opus 5.5 recap and prices the whole thinking-plus-text cap", () => {
    const input = body({
      model: "anthropic:claude-opus-5-5",
      feature: "fan-summary",
      reasoningEffort: "medium",
      maxTokens: 4096,
    });
    const request = buildAnthropicGatewayStreamRequest(input, { disableAdaptiveThinking: true });
    expect(request).toMatchObject({
      max_tokens: 4096,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
    });
    expect(request).not.toHaveProperty("temperature");
    const estimate = estimateAnthropicGatewayRequestCost(input);
    const withoutOutput = estimateAnthropicGatewayRequestCost({ ...input, maxTokens: 1 });
    expect(estimate.costMicroUsd - withoutOutput.costMicroUsd).toBe((4096 - 1) * 20);
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
