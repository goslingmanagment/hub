import { describe, expect, it } from "vitest";

import {
  estimateAiGatewayUsageCost,
  resolveAnthropicGatewayModel,
} from "../apps/runtime/src/services/ai-gateway-pricing.ts";

describe("AI gateway pricing", () => {
  it("prices Opus 5.5 input, output and both cache TTLs at its published rates", () => {
    expect(estimateAiGatewayUsageCost("anthropic:claude-opus-5-5", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheWriteTokens: 2000,
      cacheWrite5mTokens: 1000,
      cacheWrite1hTokens: 1000,
      cacheReadTokens: 1000,
    })).toMatchObject({
      provider: "anthropic",
      providerModelId: "claude-opus-5-5",
      costMicroUsd: 37200,
      costApproximate: false,
    });
  });
  it("prices Anthropic prompt-cache usage in integer micro-USD", () => {
    const estimate = estimateAiGatewayUsageCost("anthropic:claude-sonnet-4-6", {
      inputTokens: 100,
      cacheWriteTokens: 15,
      cacheWrite5mTokens: 10,
      cacheWrite1hTokens: 5,
      cacheReadTokens: 20,
      outputTokens: 8,
    });

    expect(estimate).toEqual({
      provider: "anthropic",
      providerModelId: "claude-sonnet-4-6",
      costMicroUsd: 494,
      costApproximate: false,
    });
  });

  it("prices Sonnet 5.5 (the reply-feature default) at Sonnet 5 list rates", () => {
    const estimate = estimateAiGatewayUsageCost("anthropic:claude-sonnet-5-5", {
      inputTokens: 100,
      cacheWriteTokens: 15,
      cacheWrite5mTokens: 10,
      cacheWrite1hTokens: 5,
      cacheReadTokens: 20,
      outputTokens: 8,
    });

    expect(estimate).toEqual({
      provider: "anthropic",
      providerModelId: "claude-sonnet-5-5",
      costMicroUsd: 329,
      costApproximate: false,
    });
  });

  it("prices Sonnet 5 (the media describer default) at its own list rates", () => {
    const estimate = estimateAiGatewayUsageCost("anthropic:claude-sonnet-5", {
      inputTokens: 100,
      cacheWriteTokens: 15,
      cacheWrite5mTokens: 10,
      cacheWrite1hTokens: 5,
      cacheReadTokens: 20,
      outputTokens: 8,
    });

    expect(estimate).toEqual({
      provider: "anthropic",
      providerModelId: "claude-sonnet-5",
      costMicroUsd: 329,
      costApproximate: false,
    });
  });

  it("marks aggregate cache writes as approximate until provider usage gives a ttl breakdown", () => {
    const estimate = estimateAiGatewayUsageCost("anthropic:claude-haiku-4-5", {
      inputTokens: 100,
      cacheWriteTokens: 7,
      cacheReadTokens: 10,
      outputTokens: 20,
    });

    expect(estimate).toEqual({
      provider: "anthropic",
      providerModelId: "claude-haiku-4-5",
      costMicroUsd: 210,
      costApproximate: true,
    });
  });

  it("rejects unsupported models instead of silently underpricing them", () => {
    expect(() => resolveAnthropicGatewayModel("openrouter:some-model")).toThrow(
      "Unsupported Anthropic gateway model",
    );
    expect(() =>
      estimateAiGatewayUsageCost("anthropic:unknown", {
        inputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 1,
      })
    ).toThrow("Unsupported Anthropic gateway model");
  });
});
