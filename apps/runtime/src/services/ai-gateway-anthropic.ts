import type {
  AiGatewayPromptBlock,
  AiGatewayReasoningEffort,
  AiGatewayStreamBody,
} from "@agency_hub_core/contracts";
import type { AiGatewayFeature } from "@agency_hub_core/shared";

import type { AiGatewayCostEstimate, AiGatewayCostUsage } from "./ai-gateway-pricing.ts";
import { estimateAiGatewayUsageCost, resolveAnthropicGatewayModel } from "./ai-gateway-pricing.ts";

type GatewayOperationFeature = AiGatewayFeature;

export interface AnthropicGatewayTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
}

export interface AnthropicGatewayStreamRequest {
  model: string;
  stream: true;
  max_tokens: number;
  system: AnthropicGatewayTextBlock[];
  messages: [{
    role: "user";
    content: Array<AnthropicGatewayTextBlock | { type: "image"; source: { type: "url"; url: string } }>;
  }];
  temperature?: number;
  thinking?: { type: "adaptive"; display: "summarized" } | { type: "disabled" };
  output_config?: {
    effort?: Exclude<AiGatewayReasoningEffort, "off">;
    format?: AnthropicGatewayOutputFormat;
  };
}

/** Structured-outputs schema (`output_config.format`) for a request whose
 * consumer parses JSON. Off the wire: only the internal lane sets it. */
export interface AnthropicGatewayOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

export interface AnthropicGatewayRequestTuning {
  maxTokens: number;
  temperature?: number;
  thinking?: AnthropicGatewayStreamRequest["thinking"];
  outputConfig?: AnthropicGatewayStreamRequest["output_config"];
}

export interface AnthropicGatewayUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

export interface NormalizedAnthropicGatewayUsage {
  usage: AiGatewayCostUsage;
  cacheHit: boolean;
}

export const FEATURE_MAX_TOKENS: Record<GatewayOperationFeature, number> = {
  "fast-reply": 800,
  "improve-draft": 800,
  "help-me": 1200,
  "fan-summary": 8192,
  "chat-review": 1600,
  "scan": 8192,
  "ping": 800,
  "hi-greeting": 800,
  "coach-chat": 2500,
  // Voice notes: a spoken-message script is a single short line.
  "voice-script": 400,
};

const FEATURE_TEMPERATURES: Record<GatewayOperationFeature, number> = {
  "fast-reply": 0.65,
  "improve-draft": 0.65,
  "help-me": 0.45,
  "fan-summary": 0.4,
  "chat-review": 0.25,
  "scan": 0.4,
  "ping": 0.65,
  "hi-greeting": 0.7,
  "coach-chat": 0.5,
  "voice-script": 0.4,
};

// Pre-4.6 request surface: no adaptive thinking, sampling params accepted.
// Every model NOT listed here is treated as adaptive-only, so adding a model
// to the pricing catalog needs no edit here unless it is a legacy one.
const ANTHROPIC_LEGACY_SAMPLING_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
]);

// 4.6 family: adaptive thinking available, `temperature` still accepted while
// thinking is off. Opus 4.7+, Opus 5 and Sonnet 5 return 400 on any sampling
// parameter, so the default for an unlisted adaptive model is "omit".
const ANTHROPIC_SAMPLING_TOLERANT_MODELS = new Set(["claude-sonnet-4-6", "claude-opus-4-6"]);

// Omitting `thinking` means thinking ON here, so "off" needs an explicit
// disable; otherwise thinking spends the non-adaptive max_tokens cap and the
// answer truncates (stopReason 'max_tokens').
const ANTHROPIC_THINKING_ON_BY_DEFAULT_MODELS = new Set(["claude-opus-5", "claude-sonnet-5"]);

const ANTHROPIC_ADAPTIVE_MAX_TOKENS: Record<GatewayOperationFeature, number> = {
  "fast-reply": 8000,
  "improve-draft": 8000,
  "help-me": 16000,
  "fan-summary": 24000,
  "chat-review": 16000,
  "scan": 24000,
  "ping": 8000,
  "hi-greeting": 8000,
  "coach-chat": 16000,
  // Adaptive thinking counts against max_tokens, so voice-script needs the same
  // ~10x headroom every peer on this model+effort gets (fast-reply 800→8000):
  // at 800 the thinking budget alone truncates the script → stopReason
  // 'max_tokens' → the voice-notes admission guard rejects the source
  // unrecoverably. The non-adaptive FEATURE_MAX_TOKENS cap stays 400.
  "voice-script": 8000,
};

const APPROX_CHARS_PER_TOKEN = 4;

function isAdaptiveAnthropicModel(providerModelId: string) {
  return !ANTHROPIC_LEGACY_SAMPLING_MODELS.has(providerModelId);
}

function hasRemovedSamplingParams(providerModelId: string) {
  return isAdaptiveAnthropicModel(providerModelId)
    && !ANTHROPIC_SAMPLING_TOLERANT_MODELS.has(providerModelId);
}

function thinkingOffSwitch(providerModelId: string) {
  return ANTHROPIC_THINKING_ON_BY_DEFAULT_MODELS.has(providerModelId)
    ? { thinking: { type: "disabled" as const } }
    : {};
}

function nonnegativeInt(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function estimateTextTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / APPROX_CHARS_PER_TOKEN));
}

function estimatePromptCostTokens(blocks: readonly AiGatewayPromptBlock[]) {
  let inputTokens = 0;
  let cacheWrite5mTokens = 0;
  let cacheWrite1hTokens = 0;

  for (const block of blocks) {
    const tokens = estimateTextTokens(block.text);
    if (block.cache === "5m") {
      cacheWrite5mTokens += tokens;
    } else if (block.cache === "1h") {
      cacheWrite1hTokens += tokens;
    } else {
      inputTokens += tokens;
    }
  }

  return { inputTokens, cacheWrite5mTokens, cacheWrite1hTokens };
}

export function toAnthropicGatewayTextBlocks(
  blocks: readonly AiGatewayPromptBlock[],
): AnthropicGatewayTextBlock[] {
  return blocks.map((block) => {
    if (block.cache === "1h") {
      return {
        type: "text" as const,
        text: block.text,
        cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
      };
    }
    if (block.cache === "5m") {
      return {
        type: "text" as const,
        text: block.text,
        cache_control: { type: "ephemeral" as const },
      };
    }
    return { type: "text" as const, text: block.text };
  });
}

export function getAnthropicGatewayFeatureTemperature(feature: GatewayOperationFeature) {
  return FEATURE_TEMPERATURES[feature];
}

export function resolveAnthropicGatewayRequestTuning(input: {
  providerModelId: string;
  feature: GatewayOperationFeature;
  temperature: number;
  reasoningEffort: AiGatewayReasoningEffort;
  /** Per-request off-switch for adaptive summarized thinking. Anthropic counts
   * thinking tokens inside `max_tokens`, so a caller enforcing a tight output
   * budget (fan-summary short recap: 2048) sets this to keep the cap a PURE
   * output budget — otherwise summarized thinking eats the budget and truncates
   * the answer (stopReason: 'max_tokens'). */
  disableAdaptiveThinking?: boolean | undefined;
}): AnthropicGatewayRequestTuning {
  const adaptive = isAdaptiveAnthropicModel(input.providerModelId) && !input.disableAdaptiveThinking;
  const maxTokens = adaptive
    ? ANTHROPIC_ADAPTIVE_MAX_TOKENS[input.feature]
    : FEATURE_MAX_TOKENS[input.feature];
  if (!adaptive || input.reasoningEffort === "off") {
    const thinkingOff = thinkingOffSwitch(input.providerModelId);
    if (hasRemovedSamplingParams(input.providerModelId)) {
      return { maxTokens, ...thinkingOff };
    }
    return { maxTokens, temperature: input.temperature, ...thinkingOff };
  }

  return {
    maxTokens,
    thinking: { type: "adaptive", display: "summarized" },
    outputConfig: { effort: input.reasoningEffort },
  };
}

export function buildAnthropicGatewayStreamRequest(
  input: AiGatewayStreamBody,
  options?: {
    disableAdaptiveThinking?: boolean | undefined;
    outputFormat?: AnthropicGatewayOutputFormat | undefined;
  },
): AnthropicGatewayStreamRequest {
  const model = resolveAnthropicGatewayModel(input.model);
  const temperature = input.temperature ?? getAnthropicGatewayFeatureTemperature(input.feature);
  const tuning = resolveAnthropicGatewayRequestTuning({
    providerModelId: model.providerModelId,
    feature: input.feature,
    temperature,
    reasoningEffort: input.reasoningEffort,
    disableAdaptiveThinking: options?.disableAdaptiveThinking,
  });

  return {
    model: model.providerModelId,
    stream: true,
    max_tokens: input.maxTokens ?? tuning.maxTokens,
    system: toAnthropicGatewayTextBlocks(input.prompt.systemBlocks),
    messages: [{
      role: "user",
      content: [
        ...toAnthropicGatewayTextBlocks(input.prompt.userBlocks),
        // Fan-specific images must remain after every cached text prefix.
        ...(input.prompt.images ?? []).map(({ url }) => ({ type: "image" as const, source: { type: "url" as const, url } })),
      ],
    }],
    ...(tuning.thinking ? { thinking: tuning.thinking } : {}),
    ...(tuning.outputConfig || options?.outputFormat
      ? {
          output_config: {
            ...(tuning.outputConfig ?? {}),
            ...(options?.outputFormat ? { format: options.outputFormat } : {}),
          },
        }
      : {}),
    ...(tuning.temperature !== undefined ? { temperature: tuning.temperature } : {}),
  };
}

export function estimateAnthropicGatewayRequestCost(
  input: AiGatewayStreamBody,
): AiGatewayCostEstimate {
  const model = resolveAnthropicGatewayModel(input.model);
  const temperature = input.temperature ?? getAnthropicGatewayFeatureTemperature(input.feature);
  const tuning = resolveAnthropicGatewayRequestTuning({
    providerModelId: model.providerModelId,
    feature: input.feature,
    temperature,
    reasoningEffort: input.reasoningEffort,
  });
  const systemTokens = estimatePromptCostTokens(input.prompt.systemBlocks);
  const userTokens = estimatePromptCostTokens(input.prompt.userBlocks);
  const cacheWrite5mTokens = systemTokens.cacheWrite5mTokens + userTokens.cacheWrite5mTokens;
  const cacheWrite1hTokens = systemTokens.cacheWrite1hTokens + userTokens.cacheWrite1hTokens;
  const estimate = estimateAiGatewayUsageCost(input.model, {
    inputTokens: systemTokens.inputTokens + userTokens.inputTokens + (input.prompt.images?.length ?? 0) * 4096,
    outputTokens: input.maxTokens ?? tuning.maxTokens,
    cacheWriteTokens: cacheWrite5mTokens + cacheWrite1hTokens,
    cacheReadTokens: 0,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
  });

  return {
    ...estimate,
    costApproximate: true,
  };
}

export function normalizeAnthropicGatewayUsage(
  usage: AnthropicGatewayUsageLike | null | undefined,
): NormalizedAnthropicGatewayUsage {
  const inputTokens = nonnegativeInt(usage?.input_tokens);
  const outputTokens = nonnegativeInt(usage?.output_tokens);
  const cacheWriteTokens = nonnegativeInt(usage?.cache_creation_input_tokens);
  const cacheReadTokens = nonnegativeInt(usage?.cache_read_input_tokens);
  const cacheWrite5mTokens = usage?.cache_creation
    ? nonnegativeInt(usage.cache_creation.ephemeral_5m_input_tokens)
    : undefined;
  const cacheWrite1hTokens = usage?.cache_creation
    ? nonnegativeInt(usage.cache_creation.ephemeral_1h_input_tokens)
    : undefined;

  return {
    usage: {
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      ...(cacheWrite5mTokens !== undefined ? { cacheWrite5mTokens } : {}),
      ...(cacheWrite1hTokens !== undefined ? { cacheWrite1hTokens } : {}),
    },
    cacheHit: cacheReadTokens > 0,
  };
}
