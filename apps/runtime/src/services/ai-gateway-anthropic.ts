import type {
  AiGatewayPromptBlock,
  AiGatewayReasoningEffort,
  AiGatewayStreamBody,
} from "@agency_hub_core/contracts";
import type { AiUsageFeature } from "@agency_hub_core/shared";

import type { AiGatewayCostEstimate, AiGatewayCostUsage } from "./ai-gateway-pricing.ts";
import { estimateAiGatewayUsageCost, resolveAnthropicGatewayModel } from "./ai-gateway-pricing.ts";

type GatewayOperationFeature = AiUsageFeature;

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
    content: AnthropicGatewayTextBlock[];
  }];
  temperature?: number;
  thinking?: { type: "adaptive"; display: "summarized" };
  output_config?: { effort: Exclude<AiGatewayReasoningEffort, "off"> };
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
  // Stage 29: the closing classifier's gateway lane (classification, not
  // generation — its own direct-SDK constants carried over).
  "workboard-closing": 1536,
  "coach-chat": 2500,
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
  "workboard-closing": 0,
  "coach-chat": 0.5,
};

const ANTHROPIC_ADAPTIVE_THINKING_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-8",
]);

const ANTHROPIC_SAMPLING_PARAMS_REMOVED_MODELS = new Set(["claude-opus-4-8"]);

const ANTHROPIC_ADAPTIVE_MAX_TOKENS: Record<GatewayOperationFeature, number> = {
  "fast-reply": 8000,
  "improve-draft": 8000,
  "help-me": 16000,
  "fan-summary": 24000,
  "chat-review": 16000,
  "scan": 24000,
  "ping": 8000,
  "hi-greeting": 8000,
  "workboard-closing": 8000,
  "coach-chat": 16000,
};

const APPROX_CHARS_PER_TOKEN = 4;

function isAdaptiveAnthropicModel(providerModelId: string) {
  return ANTHROPIC_ADAPTIVE_THINKING_MODELS.has(providerModelId);
}

function hasRemovedSamplingParams(providerModelId: string) {
  return ANTHROPIC_SAMPLING_PARAMS_REMOVED_MODELS.has(providerModelId);
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
}): AnthropicGatewayRequestTuning {
  const adaptive = isAdaptiveAnthropicModel(input.providerModelId);
  const maxTokens = adaptive
    ? ANTHROPIC_ADAPTIVE_MAX_TOKENS[input.feature]
    : FEATURE_MAX_TOKENS[input.feature];
  if (!adaptive || input.reasoningEffort === "off") {
    if (hasRemovedSamplingParams(input.providerModelId)) {
      return { maxTokens };
    }
    return { maxTokens, temperature: input.temperature };
  }

  return {
    maxTokens,
    thinking: { type: "adaptive", display: "summarized" },
    outputConfig: { effort: input.reasoningEffort },
  };
}

export function buildAnthropicGatewayStreamRequest(
  input: AiGatewayStreamBody,
): AnthropicGatewayStreamRequest {
  const model = resolveAnthropicGatewayModel(input.model);
  const temperature = input.temperature ?? getAnthropicGatewayFeatureTemperature(input.feature);
  const tuning = resolveAnthropicGatewayRequestTuning({
    providerModelId: model.providerModelId,
    feature: input.feature,
    temperature,
    reasoningEffort: input.reasoningEffort,
  });

  return {
    model: model.providerModelId,
    stream: true,
    max_tokens: input.maxTokens ?? tuning.maxTokens,
    system: toAnthropicGatewayTextBlocks(input.prompt.systemBlocks),
    messages: [{
      role: "user",
      content: toAnthropicGatewayTextBlocks(input.prompt.userBlocks),
    }],
    ...(tuning.thinking ? { thinking: tuning.thinking } : {}),
    ...(tuning.outputConfig ? { output_config: tuning.outputConfig } : {}),
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
    inputTokens: systemTokens.inputTokens + userTokens.inputTokens,
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
