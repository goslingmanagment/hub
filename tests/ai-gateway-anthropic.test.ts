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

  it("turns a tight cap into a pure output budget when adaptive thinking is disabled", () => {
    // fan-summary short recap: the default model is adaptive (opus-4-6), but the
    // 2048 cap must be pure OUTPUT — Anthropic counts summarized thinking inside
    // max_tokens, so the thinking block has to be dropped or the recap truncates.
    const request = buildAnthropicGatewayStreamRequest(
      body({
        model: "anthropic:claude-opus-4-6",
        feature: "fan-summary",
        reasoningEffort: "medium",
        maxTokens: 2048,
      }),
      { disableAdaptiveThinking: true },
    );

    expect(request.model).toBe("claude-opus-4-6");
    expect(request.max_tokens).toBe(2048);
    expect(request).not.toHaveProperty("thinking");
    expect(request).not.toHaveProperty("output_config");
  });

  it("keeps adaptive thinking for the default (unflagged) fan-summary path", () => {
    // Same adaptive model + cap, but no flag: the default path is unchanged —
    // proving it is the flag, not the tight maxTokens, that drops thinking.
    const request = buildAnthropicGatewayStreamRequest(
      body({
        model: "anthropic:claude-opus-4-6",
        feature: "fan-summary",
        reasoningEffort: "medium",
        maxTokens: 2048,
      }),
    );

    expect(request).toHaveProperty("thinking", { type: "adaptive", display: "summarized" });
    expect(request).toHaveProperty("output_config", { effort: "medium" });
  });

  it("keeps adaptive 16k thinking for the default coach-chat path", () => {
    // Option "c": the coach is NOT output-token-capped. It keeps its full
    // adaptive budget (16k) and the summarized thinking block — no
    // disableAdaptiveThinking flag is ever set for coach-chat. Serializability
    // is enforced by the live stream ceiling, not by shrinking max_tokens.
    const request = buildAnthropicGatewayStreamRequest(
      body({
        model: "anthropic:claude-sonnet-4-6",
        feature: "coach-chat",
        reasoningEffort: "medium",
      }),
    );

    expect(request.max_tokens).toBe(16000);
    expect(request).toHaveProperty("thinking", { type: "adaptive", display: "summarized" });
    expect(request).toHaveProperty("output_config", { effort: "medium" });
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

  // The model lists are allowlists of the LEGACY surface, not of the current
  // one: a model the catalog gains later must default to adaptive-only and
  // no sampling params (400 on Opus 4.7+, Opus 5, Sonnet 5), and the two
  // thinking-on-by-default models must get an explicit disable when reasoning
  // is off (otherwise thinking eats the non-adaptive cap and truncates).
  it("treats an unlisted newer model as adaptive-only with no sampling params", () => {
    expect(resolveAnthropicGatewayRequestTuning({
      providerModelId: "claude-opus-4-7",
      feature: "fast-reply",
      temperature: 0.65,
      reasoningEffort: "off",
    })).toEqual({ maxTokens: 8000 });
    expect(resolveAnthropicGatewayRequestTuning({
      providerModelId: "claude-opus-4-7",
      feature: "fast-reply",
      temperature: 0.65,
      reasoningEffort: "medium",
    })).toEqual({
      maxTokens: 8000,
      thinking: { type: "adaptive", display: "summarized" },
      outputConfig: { effort: "medium" },
    });
  });

  it.each(["claude-opus-5", "claude-sonnet-5"])(
    "sends an explicit thinking disable for %s when reasoning is off",
    (providerModelId) => {
      expect(resolveAnthropicGatewayRequestTuning({
        providerModelId,
        feature: "fan-summary",
        temperature: 0.4,
        reasoningEffort: "off",
      })).toEqual({ maxTokens: 24000, thinking: { type: "disabled" } });
      expect(resolveAnthropicGatewayRequestTuning({
        providerModelId,
        feature: "fan-summary",
        temperature: 0.4,
        reasoningEffort: "medium",
        disableAdaptiveThinking: true,
      })).toEqual({ maxTokens: 8192, thinking: { type: "disabled" } });
    },
  );

  it("keeps temperature on the 4.6 family when reasoning is off", () => {
    expect(resolveAnthropicGatewayRequestTuning({
      providerModelId: "claude-opus-4-6",
      feature: "fast-reply",
      temperature: 0.65,
      reasoningEffort: "off",
    })).toEqual({ maxTokens: 8000, temperature: 0.65 });
  });

  it("nests a structured-output format under output_config next to the effort", () => {
    const format = { type: "json_schema" as const, schema: { type: "object" } };
    const adaptive = buildAnthropicGatewayStreamRequest(
      body({ reasoningEffort: "medium" }),
      { outputFormat: format },
    );
    expect(adaptive.output_config).toEqual({ effort: "medium", format });

    const off = buildAnthropicGatewayStreamRequest(
      body({ reasoningEffort: "off" }),
      { outputFormat: format },
    );
    expect(off.output_config).toEqual({ format });
    expect(off.temperature).toBe(0.65);
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

describe("voice-script adaptive max_tokens headroom", () => {
  // Pins the 800→8000 headroom fix (ANTHROPIC_ADAPTIVE_MAX_TOKENS["voice-script"]).
  // On an adaptive-thinking model the thinking budget counts against max_tokens,
  // so voice-script needs the same ~10x room its peers get, or the script itself
  // truncates (stopReason 'max_tokens') and the voice-notes admission guard
  // rejects the source unrecoverably. A NON-adaptive model must keep the tight
  // FEATURE_MAX_TOKENS=400 line-length cap. Reverting either constant flips a
  // row here — the feature-integration tests use capturingProvider and never
  // reach the Anthropic request builder, so this is the only guard on the value.
  it.each([
    { providerModelId: "claude-sonnet-4-6", reasoningEffort: "max" as const, expected: 8000 },
    { providerModelId: "claude-opus-4-8", reasoningEffort: "off" as const, expected: 8000 },
    { providerModelId: "claude-haiku-4-5", reasoningEffort: "off" as const, expected: 400 },
    { providerModelId: "claude-sonnet-4-5", reasoningEffort: "max" as const, expected: 400 },
  ])(
    "voice-script on $providerModelId (effort $reasoningEffort) → max_tokens $expected",
    ({ providerModelId, reasoningEffort, expected }) => {
      const tuning = resolveAnthropicGatewayRequestTuning({
        providerModelId,
        feature: "voice-script",
        temperature: 0.4,
        reasoningEffort,
      });
      expect(tuning.maxTokens).toBe(expected);
    },
  );

  it("ships the adaptive headroom as the built request's max_tokens for voice-script", () => {
    const request = buildAnthropicGatewayStreamRequest(body({
      feature: "voice-script",
      model: "anthropic:claude-sonnet-4-6",
      reasoningEffort: "max",
    }));
    expect(request.max_tokens).toBe(8000);
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
