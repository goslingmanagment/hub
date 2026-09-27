import Anthropic from "@anthropic-ai/sdk";
import type { Dispatcher } from "undici";

import type { AiGatewayStreamFrame } from "@agency_hub_core/contracts";
import {
  AiProviderFailureError,
  classifyTransportFailure,
  createProxyRequestDispatcher,
  createStickyConnectFailureFetch,
  type ProxyConfig,
} from "@agency_hub_core/shared";

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
  resolveClient?: AnthropicGatewayClientResolver;
}

export interface AnthropicGatewayClientResolution {
  client: AnthropicGatewayClient;
  release?: () => Promise<void> | void;
}

export type AnthropicGatewayClientResolver = (
  input: AiGatewayProviderInput,
) => AnthropicGatewayClientResolution | Promise<AnthropicGatewayClientResolution>;

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

export function createAnthropicGatewayProxyFetch(dispatcher: Dispatcher): typeof fetch {
  return (input, init) => fetch(input, {
    ...init,
    dispatcher,
  } as RequestInit & { dispatcher: Dispatcher });
}

function createSdkClient(apiKey: string, fetchImpl?: typeof fetch): AnthropicGatewayClient {
  const client = new Anthropic({
    apiKey,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return {
    messages: {
      async create(body, options) {
        return client.messages.create(
          body as unknown as Anthropic.MessageCreateParamsStreaming,
          options,
        ) as unknown as Promise<AsyncIterable<unknown>>;
      },
    },
  };
}

function anthropicSdkFailureKind(error: unknown) {
  if (error instanceof Anthropic.AuthenticationError) {
    return "authentication" as const;
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return "permission" as const;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "rate_limited" as const;
  }
  if (error instanceof Anthropic.InternalServerError) {
    return "unavailable" as const;
  }
  if (error instanceof Anthropic.BadRequestError) {
    return "bad_request" as const;
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return "connection_timeout" as const;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "connection" as const;
  }
  if (error instanceof Anthropic.APIError) {
    return "api" as const;
  }
  return null;
}

function anthropicProviderErrorPayload(error: { error: unknown }) {
  if (!isRecord(error.error)) {
    return null;
  }
  return isRecord(error.error.error) ? error.error.error : error.error;
}

function normalizeAnthropicProviderFailure(
  error: unknown,
  requestedPhase: "provider_response" | "stream",
) {
  if (error instanceof AiProviderFailureError) {
    return error;
  }
  const sdkKind = anthropicSdkFailureKind(error);
  const apiError = error instanceof Anthropic.APIError ? error : null;
  const payload = apiError ? anthropicProviderErrorPayload(apiError) : null;
  const failurePhase = requestedPhase === "stream"
    ? "stream"
    : classifyTransportFailure(error) === "connect"
      ? "connect"
      : "provider_response";

  return new AiProviderFailureError({
    provider: "anthropic",
    failurePhase,
    providerHttpStatus: apiError?.status ?? null,
    providerErrorType: apiError?.type
      ?? (typeof payload?.type === "string" ? payload.type : null),
    providerErrorMessage: typeof payload?.message === "string" ? payload.message : null,
    retryAfterHeader: apiError?.headers?.get("retry-after") ?? null,
    sdkFailureKind: sdkKind,
    cause: error,
  });
}

/** Sanctioned second use of the vendor SDK (the import ban keeps it in this
 * file): the AI media describer's single-shot, non-streaming call. It has its
 * own ledger rows (feature `media-describe`), budget reservation and restricted
 * storage in services/ai-media-describe; SDK auto-retries are OFF because the
 * describer owns a stricter retry policy (never after a possible send). */
export interface AnthropicSingleShotClient {
  create(body: unknown): Promise<unknown>;
  release(): Promise<void>;
}

export function createPageProxyAnthropicSingleShotClient(
  apiKey: string,
  proxy: ProxyConfig,
  options: { timeoutMs: number },
): AnthropicSingleShotClient {
  const dispatcher = createProxyRequestDispatcher(proxy);
  const client = new Anthropic({
    apiKey,
    fetch: createAnthropicGatewayProxyFetch(dispatcher),
    maxRetries: 0,
    timeout: options.timeoutMs,
  });
  return {
    async create(body) {
      return await client.messages.create(body as Anthropic.MessageCreateParamsNonStreaming);
    },
    async release() {
      await dispatcher.close().catch(() => undefined);
    },
  };
}

/** SDK error shape for callers outside this file (they may not import the SDK). */
export function classifyAnthropicSdkFailure(error: unknown): {
  kind: ReturnType<typeof anthropicSdkFailureKind>;
  httpStatus: number | null;
} {
  return {
    kind: anthropicSdkFailureKind(error),
    httpStatus: error instanceof Anthropic.APIError && typeof error.status === "number"
      ? error.status
      : null,
  };
}

export function createPageProxyAnthropicClientResolver(
  apiKey: string,
): AnthropicGatewayClientResolver {
  return (input) => {
    const proxy = input.page.proxy;
    if (!proxy) {
      throw new Error("Anthropic AI gateway requires a configured page proxy");
    }

    const dispatcher = createProxyRequestDispatcher(proxy);
    // Sticky connect failure: the SDK's retry policy re-dials connection
    // errors, and against a dead page proxy every re-dial burns a full
    // connect timeout (3 × 10s ≈ the 31s hangs of the lora-2 incident) for
    // an outcome that cannot change within one generation.
    return {
      client: createSdkClient(
        apiKey,
        createStickyConnectFailureFetch(createAnthropicGatewayProxyFetch(dispatcher)),
      ),
      async release() {
        await dispatcher.close().catch(() => undefined);
      },
    };
  };
}

export function createAnthropicAiGatewayProvider(
  options: CreateAnthropicAiGatewayProviderOptions,
): AiGatewayProvider {
  const resolveClient: AnthropicGatewayClientResolver | null = options.client
    ? () => ({ client: options.client! })
    : options.resolveClient
      ? options.resolveClient
      : options.apiKey
        ? createPageProxyAnthropicClientResolver(options.apiKey)
        : null;
  if (!resolveClient) {
    throw new Error("Anthropic AI gateway provider requires an API key or injected client");
  }

  return {
    provider: "anthropic",
    async *stream(input) {
      const request = buildAnthropicGatewayStreamRequest(input.body, {
        disableAdaptiveThinking: input.disableAdaptiveThinking,
        outputFormat: input.outputFormat,
      });
      const clientResolution = await resolveClient(input);
      let providerResponseId: string | null = null;
      let stopReason: string | null = null;
      let lastUsage: AnthropicGatewayUsageLike | null = null;
      let usageEmitted = false;

      try {
        let events: AsyncIterable<unknown>;
        try {
          events = await clientResolution.client.messages.create(request, { signal: input.signal });
        } catch (error) {
          throw normalizeAnthropicProviderFailure(error, "provider_response");
        }

        try {
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
                // W7.1 (B1): on the real wire the 5m/1h cache-write breakdown
                // (`cache_creation`) arrives ONLY on message_start; the delta
                // carries scalars. A plain overwrite dropped the breakdown, so
                // pricing's no-breakdown branch priced every cache write at the
                // 5m rate (the 1h component under-recorded 37.5%). Delta
                // scalars win; the breakdown is preserved from message_start
                // when the incoming frame lacks it.
                const merged: AnthropicGatewayUsageLike = { ...rawEvent.usage };
                if (
                  merged.cache_creation == null
                  && lastUsage
                  && isRecord(lastUsage.cache_creation)
                ) {
                  merged.cache_creation = lastUsage.cache_creation;
                }
                lastUsage = merged;
                usageEmitted = true;
                yield usageFrame(input, merged, providerResponseId);
              }
            }
          }
        } catch (error) {
          throw normalizeAnthropicProviderFailure(error, "stream");
        }

        if (lastUsage && !usageEmitted) {
          yield usageFrame(input, lastUsage, providerResponseId);
        }
        yield { type: "done", stopReason };
      } finally {
        await clientResolution.release?.();
      }
    },
  };
}
