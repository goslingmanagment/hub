import Anthropic from "@anthropic-ai/sdk";
import type { Dispatcher } from "undici";

import type { AiGatewayStreamFrame } from "@agency_hub_core/contracts";
import {
  AiProviderFailureError,
  microUsdFromDbInt,
  classifyAiProviderAccountFailure,
  classifyTransportFailure,
  createProxyRequestDispatcher,
  createStickyConnectFailureFetch,
  type AiProviderAccountFailure,
  type ProxyConfig,
} from "@agency_hub_core/shared";

import type { AiGatewayProvider, AiGatewayProviderInput } from "./ai-gateway.ts";
import type { AnthropicAccountPool } from "./ai-provider-account-pool.ts";
import {
  SERVER_SIDE_FALLBACK_BETA,
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
      options: { signal?: AbortSignal; maxRetries?: number },
    ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
  };
}

export interface CreateAnthropicAiGatewayProviderOptions {
  apiKey?: string;
  client?: AnthropicGatewayClient;
  resolveClient?: AnthropicGatewayClientResolver;
  /** Production: the accounts of ANTHROPIC_API_KEYS, tried in order. */
  accountPool?: AnthropicAccountPool;
  /** Tests: the SDK client of one account's key (default: the real SDK). */
  createAccountClient?: (apiKey: string, fetchImpl: typeof fetch) => AnthropicGatewayClient;
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

/** `stop_details.category` of a refusal (on the delta, or beside it). */
function extractRefusalCategory(event: Record<string, unknown>) {
  const delta = isRecord(event.delta) ? event.delta : null;
  const details = isRecord(delta?.stop_details) ? delta.stop_details : isRecord(event.stop_details) ? event.stop_details : null;
  return typeof details?.category === "string" ? details.category : null;
}

/** A `fallback` content block: a refusal fallback took over here. Its
 * `to.model` continues; `trigger.category` is why the model before declined. */
function extractFallback(event: Record<string, unknown>) {
  const block = event.content_block;
  if (!isRecord(block) || block.type !== "fallback") {
    return null;
  }
  return {
    model: isRecord(block.to) && typeof block.to.model === "string" ? block.to.model : "unknown",
    category: isRecord(block.trigger) && typeof block.trigger.category === "string" ? block.trigger.category : null,
  };
}

/** Refusal categories Anthropic bills even when the model declined before any
 * output; a decline before output in any other category, or in none, is not
 * billed. https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback#how-refusals-are-billed */
const BILLED_PRE_OUTPUT_REFUSAL_CATEGORIES = new Set(["bio", "frontier_llm", "reasoning_extraction"]);

/** Visible and thinking text a broken stream had sent, in output tokens: a
 * floor for what the provider billed, since summarized thinking is shorter
 * than the thinking it stands for. Three characters a token: the chats mix
 * Cyrillic (shorter tokens) and English. */
const STREAMED_CHARS_PER_OUTPUT_TOKEN = 3;

export interface AnthropicUsageFrameOptions {
  /** `trigger.category` of each `fallback` block, in stream order: the reason
   * the hop before it declined. */
  declineCategories?: readonly (string | null)[];
  /** A stream that broke before its final usage: the usage is message_start's
   * (the whole input, output 1) and the output is what had streamed. */
  streamedChars?: number;
}

export function anthropicUsageFrame(
  input: Pick<AiGatewayProviderInput, "body" | "onProviderCacheWrites">,
  usageLike: AnthropicGatewayUsageLike,
  providerResponseId: string | null,
  options: AnthropicUsageFrameOptions = {},
): AiGatewayStreamFrame {
  const iterations = Array.isArray(usageLike.iterations) ? usageLike.iterations.filter(isRecord) : [];
  const attempts: { usage: AnthropicGatewayUsageLike; model: string; declined: boolean }[] = iterations.length > 0
    ? iterations.map((attempt, index) => ({
      usage: attempt,
      model: typeof attempt.model === "string" ? `anthropic:${attempt.model}` : input.body.model,
      // A hop that declined and handed over; the last entry served (or is
      // the last refusal of the chain).
      declined: attempt.type === "message" && index < iterations.length - 1,
    }))
    : [{ usage: usageLike, model: input.body.model, declined: false }];
  const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costMicroUsd: 0, costApproximate: false };
  const cacheWrites = { cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
  let cacheWritesKnown = true;
  let cacheHit = false;
  let declineIndex = 0;
  for (const attempt of attempts) {
    const normalized = normalizeAnthropicGatewayUsage(attempt.usage);
    if (options.streamedChars !== undefined) {
      normalized.usage.outputTokens = Math.max(
        normalized.usage.outputTokens,
        Math.ceil(options.streamedChars / STREAMED_CHARS_PER_OUTPUT_TOKEN),
      );
    }
    // Each attempt at its own model's price; one the catalog lacks at the
    // requested model's, marked approximate.
    let cost;
    try {
      cost = estimateAiGatewayUsageCost(attempt.model, normalized.usage);
    } catch {
      cost = { ...estimateAiGatewayUsageCost(input.body.model, normalized.usage), costApproximate: true };
    }
    if (attempt.declined) {
      const category = options.declineCategories?.[declineIndex] ?? null;
      declineIndex += 1;
      if (normalized.usage.outputTokens === 0 && (category === null || !BILLED_PRE_OUTPUT_REFUSAL_CATEGORIES.has(category))) {
        cost = { ...cost, costMicroUsd: microUsdFromDbInt(0) };
      }
    }
    usage.inputTokens += normalized.usage.inputTokens;
    usage.outputTokens += normalized.usage.outputTokens;
    usage.cacheWriteTokens += normalized.usage.cacheWriteTokens;
    usage.cacheReadTokens += normalized.usage.cacheReadTokens;
    usage.costMicroUsd += cost.costMicroUsd;
    usage.costApproximate ||= cost.costApproximate;
    cacheHit ||= normalized.cacheHit;
    if (normalized.usage.cacheWrite5mTokens === undefined && normalized.usage.cacheWrite1hTokens === undefined) {
      cacheWritesKnown &&= normalized.usage.cacheWriteTokens === 0;
    } else {
      cacheWrites.cacheWrite5mTokens += normalized.usage.cacheWrite5mTokens ?? 0;
      cacheWrites.cacheWrite1hTokens += normalized.usage.cacheWrite1hTokens ?? 0;
    }
  }
  if (options.streamedChars !== undefined) {
    usage.costApproximate = true;
  }
  input.onProviderCacheWrites?.(cacheWritesKnown ? cacheWrites : null);
  return {
    type: "usage",
    providerResponseId,
    cacheHit,
    usage: { ...usage, costMicroUsd: microUsdFromDbInt(usage.costMicroUsd) },
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
          body.fallbacks ? { ...options, headers: { "anthropic-beta": SERVER_SIDE_FALLBACK_BETA } } : options,
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

/** Which account-level refusal (no credit, unknown key) a raw SDK error is,
 * for callers outside this file (they may not import the SDK). */
export function classifyAnthropicAccountFailure(error: unknown): AiProviderAccountFailure | null {
  return classifyAiProviderAccountFailure(normalizeAnthropicProviderFailure(error, "provider_response"));
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

interface OpenedAnthropicStream {
  events: AsyncIterable<unknown>;
  release?: () => Promise<void> | void;
}

/**
 * One call over the pool: each account in order until one accepts. Only an
 * account-level refusal before any output (no credit, unknown key) moves on
 * — it bills nothing and the model never ran. Any other failure ends the
 * call as before: a 429/5xx is retried by the SDK on the same account, and
 * a request that may have run is never sent again.
 */
async function openPooledAnthropicStream(
  pool: AnthropicAccountPool,
  input: AiGatewayProviderInput,
  request: AnthropicGatewayStreamRequest,
  createAccountClient: (apiKey: string, fetchImpl: typeof fetch) => AnthropicGatewayClient,
): Promise<OpenedAnthropicStream> {
  const proxy = input.page.proxy;
  if (!proxy) {
    throw new Error("Anthropic AI gateway requires a configured page proxy");
  }
  const dispatcher = createProxyRequestDispatcher(proxy);
  const release = async () => {
    await dispatcher.close().catch(() => undefined);
  };
  try {
    // Sticky connect failure, as for a single key: a dead page proxy is the
    // same dead proxy for every account.
    const fetchImpl = createStickyConnectFailureFetch(createAnthropicGatewayProxyFetch(dispatcher));
    const accounts = await pool.candidates();
    if (accounts.length === 0) {
      throw new AiProviderFailureError({
        provider: "anthropic",
        failurePhase: "provider_response",
        providerErrorType: "no_enabled_account",
        providerErrorMessage: "No Anthropic account is enabled",
      });
    }
    for (const [index, account] of accounts.entries()) {
      try {
        const events = await createAccountClient(account.apiKey, fetchImpl).messages.create(request, {
          signal: input.signal,
          ...(input.disableRetries ? { maxRetries: 0 } : {}),
        });
        input.onProviderAccount?.(account.id);
        void pool.reportServed(account);
        return { events, release };
      } catch (error) {
        const failure = normalizeAnthropicProviderFailure(error, "provider_response");
        const refusal = classifyAiProviderAccountFailure(failure);
        if (refusal === null) {
          throw failure;
        }
        await pool.reportRefusal(account, refusal, { providerHttpStatus: failure.providerHttpStatus });
        if (index === accounts.length - 1 || input.signal.aborted) {
          throw failure;
        }
      }
    }
    throw new Error("Anthropic account pool returned no outcome");
  } catch (error) {
    await release();
    throw error;
  }
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
  const accountPool = options.accountPool ?? null;
  if (!resolveClient && !accountPool) {
    throw new Error("Anthropic AI gateway provider requires an API key, an account pool or an injected client");
  }
  const createAccountClient = options.createAccountClient ?? createSdkClient;

  async function open(
    input: AiGatewayProviderInput,
    request: AnthropicGatewayStreamRequest,
  ): Promise<OpenedAnthropicStream> {
    if (accountPool) {
      return openPooledAnthropicStream(accountPool, input, request, createAccountClient);
    }
    const clientResolution = await resolveClient!(input);
    try {
      const events = await clientResolution.client.messages.create(request, {
        signal: input.signal,
        ...(input.disableRetries ? { maxRetries: 0 } : {}),
      });
      return { events, ...(clientResolution.release ? { release: clientResolution.release } : {}) };
    } catch (error) {
      await clientResolution.release?.();
      throw normalizeAnthropicProviderFailure(error, "provider_response");
    }
  }

  return {
    provider: "anthropic",
    async *stream(input) {
      const request = buildAnthropicGatewayStreamRequest(input.body, {
        disableAdaptiveThinking: input.disableAdaptiveThinking,
        outputFormat: input.outputFormat,
      });
      const opened = await open(input, request);
      const events = opened.events;
      let providerResponseId: string | null = null;
      let stopReason: string | null = null;
      let refusalCategory: string | null = null;
      let fallbackModel: string | null = null;
      let lastUsage: AnthropicGatewayUsageLike | null = null;
      let usageEmitted = false;
      const declineCategories: (string | null)[] = [];
      let streamedChars = 0;

      try {

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
              // A fallback that ran before any output (or a sticky one, for
              // an hour after) names its model here and sends no block.
              if (isRecord(message) && typeof message.model === "string" && message.model !== request.model) {
                fallbackModel = message.model;
              }
              continue;
            }

            if (rawEvent.type === "content_block_start") {
              // A refusal fallback: the text so far stays, the next model
              // continues it on this same stream.
              const fallback = extractFallback(rawEvent);
              if (fallback !== null) {
                fallbackModel = fallback.model;
                refusalCategory = fallback.category ?? refusalCategory;
                declineCategories.push(fallback.category);
              }
              continue;
            }

            if (rawEvent.type === "content_block_delta") {
              const text = extractTextDelta(rawEvent);
              if (text) {
                streamedChars += text.length;
                yield { type: "content_delta", text };
              }
              const reasoning = extractReasoningDelta(rawEvent);
              if (reasoning) {
                streamedChars += reasoning.length;
                yield { type: "reasoning_delta", text: reasoning };
              }
              continue;
            }

            if (rawEvent.type === "message_delta") {
              stopReason = extractStopReason(rawEvent) ?? stopReason;
              refusalCategory = extractRefusalCategory(rawEvent) ?? refusalCategory;
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
                yield anthropicUsageFrame(input, merged, providerResponseId, { declineCategories });
              }
            }
          }
        } catch (error) {
          // A stream that broke or was cancelled after message_start was
          // billed for its whole input and the output it had sent: its usage
          // goes out before the failure, never zero.
          if (lastUsage && !usageEmitted) {
            usageEmitted = true;
            yield anthropicUsageFrame(input, lastUsage, providerResponseId, { declineCategories, streamedChars });
          }
          throw normalizeAnthropicProviderFailure(error, "stream");
        }

        if (lastUsage && !usageEmitted) {
          yield anthropicUsageFrame(input, lastUsage, providerResponseId, { declineCategories, streamedChars });
        }
        if (fallbackModel !== null || refusalCategory !== null) {
          input.onProviderStop?.({ fallbackModel, refusalCategory });
        }
        yield { type: "done", stopReason };
      } finally {
        await opened.release?.();
      }
    },
  };
}
