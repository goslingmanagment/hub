import { describe, expect, it } from "vitest";

import type { AiGatewayStreamBody } from "@agency_hub_core/contracts";
import {
  buildOpenrouterGatewayStreamRequest,
  createOpenrouterAiGatewayProvider,
  estimateOpenrouterGatewayRequestCost,
} from "../apps/runtime/src/services/ai-gateway-openrouter-provider.ts";
import {
  aiGatewayProviderForModel,
  estimateAiGatewayUsageCost,
} from "../apps/runtime/src/services/ai-gateway-pricing.ts";
import { selectAiGatewayProvider } from "../apps/runtime/src/services/ai-gateway.ts";

// Stage 29 Task 1 — the second provider: OpenAI-compatible SSE over fetch,
// no vendor SDK, page-proxy egress in production (fetch injected here).

function body(overrides: Partial<AiGatewayStreamBody> = {}): AiGatewayStreamBody {
  return {
    clientRequestId: "11111111-1111-4111-8111-111111111111",
    feature: "fast-reply",
    pageLabel: "lora-of",
    platform: "onlyfans",
    platformUserId: "1",
    model: "openrouter:openai/gpt-4o-mini",
    reasoningEffort: "off",
    isRegeneration: false,
    prompt: {
      systemBlocks: [{ text: "sys", cache: "none" }],
      userBlocks: [{ text: "user", cache: "none" }],
    },
    ...overrides,
  } as AiGatewayStreamBody;
}

describe("OpenRouter gateway provider (Stage 29)", () => {
  it("routes by model prefix", () => {
    expect(aiGatewayProviderForModel("openrouter:openai/gpt-4o-mini")).toBe("openrouter");
    expect(aiGatewayProviderForModel("anthropic:claude-haiku-4-5")).toBe("anthropic");

    const anthropic = { provider: "anthropic" } as never;
    const openrouter = { provider: "openrouter" } as never;
    const app = { aiGatewayProvider: anthropic, aiGatewayOpenrouterProvider: openrouter };
    expect(selectAiGatewayProvider(app, "openrouter:openai/gpt-4o-mini")).toBe(openrouter);
    expect(selectAiGatewayProvider(app, "anthropic:claude-haiku-4-5")).toBe(anthropic);
    expect(selectAiGatewayProvider({ aiGatewayProvider: anthropic }, "openrouter:x")).toBeUndefined();
  });

  it("builds the OpenAI-compatible request (cache blocks flatten)", () => {
    const request = buildOpenrouterGatewayStreamRequest(body({
      prompt: {
        systemBlocks: [
          { text: "a", cache: "1h" },
          { text: "b", cache: "none" },
        ],
        userBlocks: [{ text: "hello", cache: "5m" }],
      },
    }));
    expect(request).toMatchObject({
      model: "openai/gpt-4o-mini",
      stream: true,
      max_tokens: 800,
      temperature: 0.65,
      usage: { include: true },
    });
    expect(request.messages).toEqual([
      { role: "system", content: "a\n\nb" },
      { role: "user", content: "hello" },
    ]);
  });

  it("prices usage from the catalog", () => {
    const estimate = estimateAiGatewayUsageCost("openrouter:openai/gpt-4o-mini", {
      inputTokens: 100,
      outputTokens: 10,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    // 100 × $0.15/M + 10 × $0.60/M = 15 + 6 = 21 micro-USD.
    expect(estimate).toMatchObject({
      provider: "openrouter",
      providerModelId: "openai/gpt-4o-mini",
      costMicroUsd: 21,
    });

    const preflight = estimateOpenrouterGatewayRequestCost(body());
    expect(preflight.costApproximate).toBe(true);
    expect(preflight.costMicroUsd).toBeGreaterThan(0);
  });

  it("streams SSE into gateway frames with usage and stop reason", async () => {
    const sse = [
      'data: {"id":"gen-1","choices":[{"delta":{"content":"Hel"}}]}',
      "",
      'data: {"id":"gen-1","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const provider = createOpenrouterAiGatewayProvider({
      fetchImpl: async () => new Response(sse, { status: 200 }),
    });

    const frames = [];
    for await (const frame of provider.stream({
      requestId: "r1",
      principal: null as never,
      page: { id: 1, label: "lora-of", platform: "onlyfans", proxy: null, egressKey: "k" },
      body: body(),
      quota: { accepted: true, remainingRequestsToday: 1, remainingMicroUsdToday: 1 },
      signal: new AbortController().signal,
    })) {
      frames.push(frame);
    }

    expect(frames[0]).toEqual({ type: "content_delta", text: "Hel" });
    expect(frames[1]).toEqual({ type: "content_delta", text: "lo" });
    const usage = frames.find((frame) => frame.type === "usage");
    expect(usage).toMatchObject({
      providerResponseId: "gen-1",
      usage: { inputTokens: 100, outputTokens: 10, costMicroUsd: 21 },
    });
    expect(frames[frames.length - 1]).toEqual({ type: "done", stopReason: "stop" });
  });

  it("fails loudly on a non-2xx response", async () => {
    const provider = createOpenrouterAiGatewayProvider({
      fetchImpl: async () => new Response("nope", { status: 402 }),
    });
    const iterate = async () => {
      for await (const frame of provider.stream({
        requestId: "r2",
        principal: null as never,
        page: { id: 1, label: "lora-of", platform: "onlyfans", proxy: null, egressKey: "k" },
        body: body(),
        quota: { accepted: true, remainingRequestsToday: 1, remainingMicroUsdToday: 1 },
        signal: new AbortController().signal,
      })) {
        void frame;
      }
    };
    await expect(iterate()).rejects.toThrow("HTTP 402");
  });
});
