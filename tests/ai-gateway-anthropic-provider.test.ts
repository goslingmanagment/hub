import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { AiGatewayStreamBody } from "@agency_hub_core/contracts";

import type { AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import {
  createAnthropicAiGatewayProvider,
  createAnthropicGatewayProxyFetch,
  createPageProxyAnthropicClientResolver,
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
      authMethod: "device_token",
      user: {
        id: 7,
        username: "chatter",
        role: "chatter",
      mustChangePassword: false,
        assignedPages: [],
      },
      assignedPageIds: [11],
    },
    page: {
      id: 11,
      label: "lora-of",
      platform: "onlyfans",
      proxy: {
        url: "socks5://proxy.example:1080",
        username: "proxy-user",
        password: "proxy-pass",
      },
      egressKey: "socks5://proxy.example:1080",
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
        // W7.1 (B1): the REAL wire shape — the delta carries scalars only;
        // the 5m/1h breakdown exists solely on message_start. The old
        // fixture put cache_creation here too, masking the overwrite bug.
        usage: {
          input_tokens: 100,
          output_tokens: 8,
          cache_creation_input_tokens: 15,
          cache_read_input_tokens: 20,
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

  it("lets a refusal fallback finish an Opus 5.5 answer and bills every attempt at its own model's price", async () => {
    let capturedBody: unknown = null;
    async function* events() {
      yield { type: "message_start", message: { id: "msg_fb", model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 1 } } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Досье: " } };
      yield {
        type: "content_block_start",
        content_block: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" }, trigger: { type: "refusal", category: "cyber" } },
      };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "дальше." } };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: 1100,
          output_tokens: 200,
          iterations: [
            { type: "message", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1100, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          ],
        },
      };
      yield { type: "message_stop" };
    }
    const provider = createAnthropicAiGatewayProvider({
      client: { messages: { create(body) { capturedBody = body; return events(); } } },
    });
    const onProviderStop = vi.fn();

    const frames = await collect(provider.stream(providerInput({
      body: gatewayBody({ feature: "fan-summary", model: "anthropic:claude-opus-5-5", reasoningEffort: "high" }),
      onProviderStop,
    })));

    expect(capturedBody).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default" });
    expect(frames.filter((frame) => frame.type === "content_delta").map((frame) => frame.text).join("")).toBe("Досье: дальше.");
    // Opus 5.5 1000 in + 100 out at $4/$20, then Opus 4.8 1100 in + 200 out at $5/$25.
    expect(frames.find((frame) => frame.type === "usage")).toMatchObject({
      usage: { inputTokens: 2100, outputTokens: 300, costMicroUsd: 6000 + 10500, costApproximate: false },
    });
    expect(frames.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    expect(onProviderStop).toHaveBeenCalledWith({ fallbackModel: "claude-opus-4-8", refusalCategory: "cyber" });
  });

  it.each([
    ["cyber", 0],
    [null, 0],
    ["bio", 4000],
  ] as const)("bills a decline before any output only in the categories Anthropic bills (%s)", async (category, declinedCost) => {
    async function* events() {
      yield { type: "message_start", message: { id: "msg_pre", model: "claude-opus-4-8", usage: { input_tokens: 1000, output_tokens: 1 } } };
      yield {
        type: "content_block_start",
        content_block: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" }, trigger: { type: "refusal", category } },
      };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Ответ." } };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          iterations: [
            { type: "message", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 0 },
            { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000, output_tokens: 200 },
          ],
        },
      };
    }
    const provider = createAnthropicAiGatewayProvider({ client: { messages: { create: () => events() } } });

    const frames = await collect(provider.stream(providerInput({
      body: gatewayBody({ feature: "fan-summary", model: "anthropic:claude-opus-5-5", reasoningEffort: "high" }),
    })));

    // The fallback: Opus 4.8 1000 in + 200 out at $5/$25. The decline: Opus 5.5 1000 in at $4.
    expect(frames.find((frame) => frame.type === "usage")).toMatchObject({
      usage: { inputTokens: 2000, outputTokens: 200, costMicroUsd: 10000 + declinedCost },
    });
  });

  it("bills a stream cancelled mid-answer for its input and the output it had sent", async () => {
    const abort = new AbortController();
    async function* events() {
      yield {
        type: "message_start",
        message: {
          id: "msg_cut",
          model: "claude-opus-5-5",
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 300,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 300 },
            output_tokens: 1,
          },
        },
      };
      yield { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "x".repeat(300) } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "y".repeat(150) } };
      abort.abort();
      throw new Error("Request was aborted.");
    }
    const provider = createAnthropicAiGatewayProvider({ client: { messages: { create: () => events() } } });
    const onProviderCacheWrites = vi.fn();

    const frames: unknown[] = [];
    await expect((async () => {
      for await (const frame of provider.stream(providerInput({
        body: gatewayBody({ model: "anthropic:claude-opus-5-5", reasoningEffort: "low" }),
        signal: abort.signal,
        onProviderCacheWrites,
      }))) {
        frames.push(frame);
      }
    })()).rejects.toThrow();

    // 450 streamed characters ≈ 150 output tokens; 1000 in at $4, 5000 cache
    // read at $0.2, 300 1h writes at $8, 150 out at $20.
    expect(frames.at(-1)).toMatchObject({
      type: "usage",
      providerResponseId: "msg_cut",
      usage: {
        inputTokens: 1000,
        cacheReadTokens: 5000,
        cacheWriteTokens: 300,
        outputTokens: 150,
        costMicroUsd: 4000 + 1000 + 2400 + 3000,
        costApproximate: true,
      },
    });
    expect(onProviderCacheWrites).toHaveBeenCalledWith({ cacheWrite5mTokens: 0, cacheWrite1hTokens: 300 });
  });

  it("reports the cache writes by TTL, and none when the provider gives no split", async () => {
    async function* events(split: boolean) {
      yield {
        type: "message_start",
        message: {
          id: "msg_split",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 30,
            ...(split ? { cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } } : {}),
            output_tokens: 1,
          },
        },
      };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, cache_creation_input_tokens: 30, output_tokens: 5 } };
    }
    for (const split of [true, false]) {
      const provider = createAnthropicAiGatewayProvider({ client: { messages: { create: () => events(split) } } });
      const onProviderCacheWrites = vi.fn();
      await collect(provider.stream(providerInput({ onProviderCacheWrites })));
      expect(onProviderCacheWrites).toHaveBeenCalledOnce();
      expect(onProviderCacheWrites).toHaveBeenCalledWith(split ? { cacheWrite5mTokens: 10, cacheWrite1hTokens: 20 } : null);
    }
  });

  it.each([undefined, false, true])("disables SDK retries only when requested (disableRetries: %s)", async (disableRetries) => {
    const create = vi.fn<AnthropicGatewayClient["messages"]["create"]>(async function* () {
      yield { type: "message_stop" };
    });
    const provider = createAnthropicAiGatewayProvider({ client: { messages: { create } } });
    const input = providerInput(disableRetries === undefined ? {} : { disableRetries });

    await collect(provider.stream(input));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.anything(), {
      signal: input.signal,
      ...(disableRetries ? { maxRetries: 0 } : {}),
    });
  });

  it("fails unsupported models before creating a provider stream", async () => {
    let createCalls = 0;
    const client: AnthropicGatewayClient = {
      messages: {
        async *create() {
          createCalls += 1;
          yield* [];
        },
      },
    };
    const provider = createAnthropicAiGatewayProvider({ client });

    await expect(collect(provider.stream(providerInput({
      body: gatewayBody({ model: "openrouter:x-ai/grok-4.3" }),
    })))).rejects.toThrow("Unsupported Anthropic gateway model");
    expect(createCalls).toBe(0);
  });

  it("requires a page proxy when constructed from an API key", async () => {
    const provider = createAnthropicAiGatewayProvider({ apiKey: "sk-ant-test" });

    await expect(collect(provider.stream(providerInput({
      page: {
        id: 11,
        label: "lora-of",
        platform: "onlyfans",
        proxy: null,
        egressKey: "direct",
      },
    })))).rejects.toThrow("Anthropic AI gateway requires a configured page proxy");
  });

  it("attaches the page proxy dispatcher to Anthropic SDK fetch calls", async () => {
    const originalFetch = globalThis.fetch;
    const dispatcher = { close: async () => undefined };
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const proxiedFetch = createAnthropicGatewayProxyFetch(
        dispatcher as unknown as Parameters<typeof createAnthropicGatewayProxyFetch>[0],
      );
      await proxiedFetch("https://api.anthropic.test/v1/messages", { method: "POST" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.anthropic.test/v1/messages",
        expect.objectContaining({
          method: "POST",
          dispatcher,
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dials a dead page proxy once per generation — SDK retries hit the sticky failure", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      // The SOCKS handshake failure shape of the lora-2 incident (2026-07-15).
      const socks = new Error("Proxy connection timed out");
      socks.name = "SocksClientError";
      throw socks;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const resolve = createPageProxyAnthropicClientResolver("test-key");
      const resolution = await resolve(providerInput());

      await expect(resolution.client.messages.create(
        {
          model: "claude-sonnet-4-6",
          max_tokens: 16,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        } as unknown as Parameters<typeof resolution.client.messages.create>[0],
        {},
      )).rejects.toThrow();
      // Without the sticky wrapper the SDK re-dials the dead proxy on every
      // retry, each burning a full connect timeout (the 31s hangs).
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await resolution.release?.();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 15_000);
});
