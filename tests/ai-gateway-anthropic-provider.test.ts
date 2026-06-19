import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AiGatewayStreamBody } from "@agency_hub_core/contracts";

import type { AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import {
  createAnthropicAiGatewayProvider,
  type AnthropicGatewayClient,
} from "../apps/runtime/src/services/ai-gateway-anthropic-provider.ts";

function gatewayBody(overrides: Partial<AiGatewayStreamBody> = {}): AiGatewayStreamBody {
  return {
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
      systemBlocks: [{ text: "system", cache: "1h" }],
      userBlocks: [{ text: "user", cache: "5m" }],
    },
    ...overrides,
  };
}

function providerInput(
  overrides: Partial<AiGatewayProviderInput> & { body?: AiGatewayStreamBody } = {},
): AiGatewayProviderInput {
  return {
    requestId: randomUUID(),
    principal: {
      authMethod: "api_key",
      user: {
        id: 7,
        username: "chatter",
        role: "chatter",
        assignedPages: [],
      },
      assignedPageIds: [11],
    },
    page: {
      id: 11,
      label: "lora-of",
      platform: "onlyfans",
    },
    body: gatewayBody(),
    quota: {
      accepted: true,
      remainingRequestsToday: 200,
      remainingMicroUsdToday: 5_000_000,
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect<T>(items: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const item of items) {
    out.push(item);
  }
  return out;
}

describe("Anthropic AI gateway provider", () => {
  it("streams Anthropic events into gateway frames and passes through the abort signal", async () => {
    let capturedBody: unknown = null;
    let capturedSignal: AbortSignal | undefined;
    async function* events() {
      yield {
        type: "message_start",
        message: {
          id: "msg_123",
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_creation_input_tokens: 15,
            cache_read_input_tokens: 20,
            cache_creation: {
              ephemeral_5m_input_tokens: 10,
              ephemeral_1h_input_tokens: 5,
            },
          },
        },
      };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } };
      yield {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "reasoning" },
      };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: 100,
          output_tokens: 8,
          cache_creation_input_tokens: 15,
          cache_read_input_tokens: 20,
          cache_creation: {
            ephemeral_5m_input_tokens: 10,
            ephemeral_1h_input_tokens: 5,
          },
        },
      };
      yield { type: "message_stop" };
    }
    const client: AnthropicGatewayClient = {
      messages: {
        create(body, options) {
          capturedBody = body;
          capturedSignal = options.signal;
          return events();
        },
      },
    };
    const provider = createAnthropicAiGatewayProvider({ client });
    const input = providerInput();

    const frames = await collect(provider.stream(input));

    expect(capturedSignal).toBe(input.signal);
    expect(capturedBody).toMatchObject({
      model: "claude-sonnet-4-6",
      stream: true,
      max_tokens: 8000,
      temperature: 0.65,
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{
        role: "user",
        content: [{ type: "text", text: "user", cache_control: { type: "ephemeral" } }],
      }],
    });
    expect(frames).toEqual([
      { type: "content_delta", text: "hello" },
      { type: "reasoning_delta", text: "reasoning" },
      {
        type: "usage",
        providerResponseId: "msg_123",
        cacheHit: true,
        usage: {
          inputTokens: 100,
          outputTokens: 8,
          cacheWriteTokens: 15,
          cacheReadTokens: 20,
          costMicroUsd: 494,
          costApproximate: false,
        },
      },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("fails unsupported models before creating a provider stream", async () => {
    let createCalls = 0;
    const client: AnthropicGatewayClient = {
      messages: {
        async *create() {
          createCalls += 1;
        },
      },
    };
    const provider = createAnthropicAiGatewayProvider({ client });

    await expect(collect(provider.stream(providerInput({
      body: gatewayBody({ model: "openrouter:x-ai/grok-4.3" }),
    })))).rejects.toThrow("Unsupported Anthropic gateway model");
    expect(createCalls).toBe(0);
  });
});
