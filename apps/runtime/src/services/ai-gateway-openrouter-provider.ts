import type { Dispatcher } from "undici";

import type {
  AiGatewayPromptBlock,
  AiGatewayStreamBody,
  AiGatewayStreamFrame,
} from "@agency_hub_core/contracts";
import {
  AiProviderFailureError,
  classifyTransportFailure,
  createProxyRequestDispatcher,
} from "@agency_hub_core/shared";

import type { AiGatewayProvider, AiGatewayProviderInput } from "./ai-gateway.ts";
import { createAnthropicGatewayProxyFetch } from "./ai-gateway-anthropic-provider.ts";
import { FEATURE_MAX_TOKENS, getAnthropicGatewayFeatureTemperature } from "./ai-gateway-anthropic.ts";
import {
  estimateAiGatewayUsageCost,
  resolveOpenrouterGatewayModel,
  type AiGatewayCostEstimate,
} from "./ai-gateway-pricing.ts";

// Kernel Stage 29 Task 1 — the second gateway provider. OpenRouter speaks
// the OpenAI-compatible chat/completions SSE protocol; no vendor SDK — a
// plain fetch through the page's proxy dispatcher, mirroring the Anthropic
// provider's egress discipline. cache_control blocks have no OpenRouter
// equivalent and flatten into plain text.

const OPENROUTER_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

interface OpenrouterStreamRequest {
  model: string;
  stream: true;
  max_tokens: number;
  temperature?: number;
  messages: Array<{ role: "system" | "user"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }>;
  usage: { include: true };
}

function joinBlocks(blocks: readonly AiGatewayPromptBlock[]): string {
  return blocks.map((block) => block.text).join("\n\n");
}

export function buildOpenrouterGatewayStreamRequest(
  input: AiGatewayStreamBody,
): OpenrouterStreamRequest {
  const model = resolveOpenrouterGatewayModel(input.model);
  return {
    model: model.providerModelId,
    stream: true,
    max_tokens: input.maxTokens ?? FEATURE_MAX_TOKENS[input.feature],
    temperature: input.temperature ?? getAnthropicGatewayFeatureTemperature(input.feature),
    messages: [
      { role: "system", content: joinBlocks(input.prompt.systemBlocks) },
      { role: "user", content: input.prompt.images?.length ? [
        { type: "text", text: joinBlocks(input.prompt.userBlocks) },
        ...input.prompt.images.map(({ url }) => ({ type: "image_url" as const, image_url: { url } })),
      ] : joinBlocks(input.prompt.userBlocks) },
    ],
    usage: { include: true },
  };
}

const APPROX_CHARS_PER_TOKEN = 4;

export function estimateOpenrouterGatewayRequestCost(
  input: AiGatewayStreamBody,
): AiGatewayCostEstimate {
  const chars = [...input.prompt.systemBlocks, ...input.prompt.userBlocks]
    .reduce((sum, block) => sum + block.text.length, 0);
  const estimate = estimateAiGatewayUsageCost(input.model, {
    inputTokens: Math.max(1, Math.ceil(chars / APPROX_CHARS_PER_TOKEN)) + (input.prompt.images?.length ?? 0) * 4096,
    outputTokens: input.maxTokens ?? FEATURE_MAX_TOKENS[input.feature],
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  });
  return { ...estimate, costApproximate: true };
}

interface OpenrouterUsageLike {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function usageFrame(
  input: AiGatewayProviderInput,
  usage: OpenrouterUsageLike,
  providerResponseId: string | null,
): AiGatewayStreamFrame {
  const promptTokens = Math.max(0, Math.floor(usage.prompt_tokens ?? 0));
  const cachedTokens = Math.max(0, Math.floor(usage.prompt_tokens_details?.cached_tokens ?? 0));
  const completionTokens = Math.max(0, Math.floor(usage.completion_tokens ?? 0));
  const cost = estimateAiGatewayUsageCost(input.body.model, {
    inputTokens: Math.max(0, promptTokens - cachedTokens),
    outputTokens: completionTokens,
    cacheWriteTokens: 0,
    cacheReadTokens: cachedTokens,
  });
  return {
    type: "usage",
    providerResponseId,
    cacheHit: cachedTokens > 0,
    usage: {
      inputTokens: Math.max(0, promptTokens - cachedTokens),
      outputTokens: completionTokens,
      cacheWriteTokens: 0,
      cacheReadTokens: cachedTokens,
      costMicroUsd: cost.costMicroUsd,
      costApproximate: cost.costApproximate,
    },
  };
}

/** Parse an SSE byte stream into `data:` payload strings. */
async function* sseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data: ")) {
          yield line.slice("data: ".length);
        }
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface CreateOpenrouterAiGatewayProviderOptions {
  apiKey?: string;
  /** Test seam: replaces fetch entirely (no proxy dispatcher). */
  fetchImpl?: typeof fetch;
}

export function createOpenrouterAiGatewayProvider(
  options: CreateOpenrouterAiGatewayProviderOptions,
): AiGatewayProvider {
  if (!options.apiKey && !options.fetchImpl) {
    throw new Error("OpenRouter AI gateway provider requires an API key or injected fetch");
  }

  return {
    provider: "openrouter",
    async *stream(input) {
      const request = buildOpenrouterGatewayStreamRequest(input.body);
      let dispatcher: Dispatcher | null = null;
      let fetchImpl = options.fetchImpl;
      if (!fetchImpl) {
        const proxy = input.page.proxy;
        if (!proxy) {
          throw new Error("OpenRouter AI gateway requires a configured page proxy");
        }
        dispatcher = createProxyRequestDispatcher(proxy);
        // The Anthropic provider's dispatcher-injecting fetch wrapper is the
        // shared transport choke point (raw-fetch ratchet counts it once).
        fetchImpl = createAnthropicGatewayProxyFetch(dispatcher);
      }

      let providerResponseId: string | null = null;
      let stopReason: string | null = null;
      let lastUsage: OpenrouterUsageLike | null = null;
      let usageEmitted = false;

      try {
        let response: Response;
        try {
          response = await fetchImpl(OPENROUTER_COMPLETIONS_URL, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.apiKey ?? ""}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
            signal: input.signal,
          });
        } catch (error) {
          throw new AiProviderFailureError({
            provider: "openrouter",
            failurePhase: classifyTransportFailure(error) === "connect"
              ? "connect"
              : "provider_response",
            cause: error,
          });
        }
        if (!response.ok || !response.body) {
          throw new AiProviderFailureError({
            provider: "openrouter",
            failurePhase: "provider_response",
            providerHttpStatus: response.status,
            retryAfterHeader: response.headers.get("retry-after"),
          });
        }

        try {
          for await (const data of sseDataLines(response.body)) {
            if (data === "[DONE]") {
              break;
            }
            let event: unknown;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            if (!isRecord(event)) {
              continue;
            }
            if (typeof event.id === "string") {
              providerResponseId = event.id;
            }
            const choice = Array.isArray(event.choices) && isRecord(event.choices[0])
              ? event.choices[0]
              : null;
            if (choice) {
              if (typeof choice.finish_reason === "string") {
                stopReason = choice.finish_reason;
              }
              const delta = isRecord(choice.delta) ? choice.delta : null;
              if (delta && typeof delta.content === "string" && delta.content.length > 0) {
                yield { type: "content_delta", text: delta.content };
              }
              if (delta && typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
                yield { type: "reasoning_delta", text: delta.reasoning };
              }
            }
            if (isRecord(event.usage)) {
              lastUsage = event.usage as OpenrouterUsageLike;
              usageEmitted = true;
              yield usageFrame(input, lastUsage, providerResponseId);
            }
          }
        } catch (error) {
          throw error instanceof AiProviderFailureError
            ? error
            : new AiProviderFailureError({
              provider: "openrouter",
              failurePhase: "stream",
              cause: error,
            });
        }

        if (lastUsage && !usageEmitted) {
          yield usageFrame(input, lastUsage, providerResponseId);
        }
        yield { type: "done", stopReason };
      } finally {
        await dispatcher?.close().catch(() => undefined);
      }
    },
  };
}
