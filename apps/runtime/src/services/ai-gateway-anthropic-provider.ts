import Anthropic from "@anthropic-ai/sdk";

import type { AiGatewayStreamFrame } from "@agency_hub_core/contracts";

import type { AiGatewayProvider, AiGatewayProviderInput } from "./ai-gateway.ts";
import {
  buildAnthropicGatewayStreamRequest,
  normalizeAnthropicGatewayUsage,
  type AnthropicGatewayStreamRequest,
  type AnthropicGatewayUsageLike,
} from "./ai-gateway-anthropic.ts";
import { estimateAiGatewayUsageCost } from "./ai-gateway-pricing.ts";

export interface AnthropicGatewayClient {
  messages: {
    create(
      body: AnthropicGatewayStreamRequest,
      options: { signal?: AbortSignal },
    ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
  };
}

export interface CreateAnthropicAiGatewayProviderOptions {
  apiKey?: string;
  client?: AnthropicGatewayClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextDelta(event: Record<string, unknown>) {
  const delta = event.delta;
  if (!isRecord(delta)) {
    return null;
  }
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return delta.text;
  }
  return null;
}

function extractReasoningDelta(event: Record<string, unknown>) {
  const delta = event.delta;
  if (!isRecord(delta)) {
    return null;
  }
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    return delta.thinking;
  }
  return null;
}

function extractProviderResponseId(event: Record<string, unknown>) {
  const message = event.message;
  if (!isRecord(message) || typeof message.id !== "string") {
    return null;
  }
  return message.id;
}

function extractStopReason(event: Record<string, unknown>) {
  const delta = event.delta;
  if (!isRecord(delta)) {
    return null;
  }
  return typeof delta.stop_reason === "string" ? delta.stop_reason : null;
}

function usageFrame(
  input: AiGatewayProviderInput,
  usageLike: AnthropicGatewayUsageLike,
  providerResponseId: string | null,
): AiGatewayStreamFrame {
  const normalized = normalizeAnthropicGatewayUsage(usageLike);
  const cost = estimateAiGatewayUsageCost(input.body.model, normalized.usage);
  return {
    type: "usage",
    providerResponseId,
    cacheHit: normalized.cacheHit,
    usage: {
      inputTokens: normalized.usage.inputTokens,
      outputTokens: normalized.usage.outputTokens,
      cacheWriteTokens: normalized.usage.cacheWriteTokens,
      cacheReadTokens: normalized.usage.cacheReadTokens,
      costMicroUsd: cost.costMicroUsd,
      costApproximate: cost.costApproximate,
    },
  };
}

function createSdkClient(apiKey: string): AnthropicGatewayClient {
  const client = new Anthropic({ apiKey });
  return {
    messages: {
      async create(body, options) {
        return client.messages.create(body as any, options) as unknown as Promise<AsyncIterable<unknown>>;
      },
    },
  };
}

export function createAnthropicAiGatewayProvider(
  options: CreateAnthropicAiGatewayProviderOptions,
): AiGatewayProvider {
  const client = options.client ?? (options.apiKey ? createSdkClient(options.apiKey) : null);
  if (!client) {
    throw new Error("Anthropic AI gateway provider requires an API key or injected client");
  }

  return {
    provider: "anthropic",
    async *stream(input) {
      const request = buildAnthropicGatewayStreamRequest(input.body);
      const events = await client.messages.create(request, { signal: input.signal });
      let providerResponseId: string | null = null;
      let stopReason: string | null = null;
      let lastUsage: AnthropicGatewayUsageLike | null = null;
      let usageEmitted = false;

      for await (const rawEvent of events) {
        if (!isRecord(rawEvent) || typeof rawEvent.type !== "string") {
          continue;
        }

        if (rawEvent.type === "message_start") {
          providerResponseId = extractProviderResponseId(rawEvent) ?? providerResponseId;
          const message = rawEvent.message;
          if (isRecord(message) && isRecord(message.usage)) {
            lastUsage = message.usage;
          }
          continue;
        }

        if (rawEvent.type === "content_block_delta") {
          const text = extractTextDelta(rawEvent);
          if (text) {
            yield { type: "content_delta", text };
          }
          const reasoning = extractReasoningDelta(rawEvent);
          if (reasoning) {
            yield { type: "reasoning_delta", text: reasoning };
          }
          continue;
        }

        if (rawEvent.type === "message_delta") {
          stopReason = extractStopReason(rawEvent) ?? stopReason;
          if (isRecord(rawEvent.usage)) {
            lastUsage = rawEvent.usage;
            usageEmitted = true;
            yield usageFrame(input, rawEvent.usage, providerResponseId);
          }
        }
      }

      if (lastUsage && !usageEmitted) {
        yield usageFrame(input, lastUsage, providerResponseId);
      }
      yield { type: "done", stopReason };
    },
  };
}
