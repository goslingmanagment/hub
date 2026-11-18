import { microUsdFromDbInt, type AI_SETTINGS_MODELS, type MicroUsd } from "@agency_hub_core/shared";
export interface AiGatewayCostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
}

export interface AiGatewayCostEstimate {
  provider: "anthropic" | "openrouter";
  providerModelId: string;
  costMicroUsd: MicroUsd;
  costApproximate: boolean;
}

interface AnthropicGatewayPricing {
  providerModelId: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheWrite5mUsdPerMillion: number;
  cacheWrite1hUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
}

// The models the owner's settings offer (AI_SETTINGS_MODELS) are exactly the
// ones priced here: `satisfies` fails the typecheck on a model missing either way.
const ANTHROPIC_PRICING: Record<string, AnthropicGatewayPricing> = {
  // https://platform.claude.com/docs/en/models/opus-5-5/overview
  "anthropic:claude-opus-5-5": {
    providerModelId: "claude-opus-5-5",
    inputUsdPerMillion: 4,
    cacheWrite5mUsdPerMillion: 5,
    cacheWrite1hUsdPerMillion: 8,
    cacheReadUsdPerMillion: 0.2,
    outputUsdPerMillion: 20,
  },
  // Retained for explicit model choices. Sonnet 5's list price, but a cache
  // hit is 0.05x input (as on Opus 5.5), not Sonnet 5's 0.1x.
  // https://platform.claude.com/docs/en/about-claude/pricing
  "anthropic:claude-sonnet-5-5": {
    providerModelId: "claude-sonnet-5-5",
    inputUsdPerMillion: 2,
    cacheWrite5mUsdPerMillion: 2.5,
    cacheWrite1hUsdPerMillion: 4,
    cacheReadUsdPerMillion: 0.1,
    outputUsdPerMillion: 10,
  },
  // The judged reply-feature default until 2026-09-28; still
  // the media describer's default. List price 2026-09.
  "anthropic:claude-sonnet-5": {
    providerModelId: "claude-sonnet-5",
    inputUsdPerMillion: 2,
    cacheWrite5mUsdPerMillion: 2.5,
    cacheWrite1hUsdPerMillion: 4,
    cacheReadUsdPerMillion: 0.2,
    outputUsdPerMillion: 10,
  },
  "anthropic:claude-sonnet-4-6": {
    providerModelId: "claude-sonnet-4-6",
    inputUsdPerMillion: 3,
    cacheWrite5mUsdPerMillion: 3.75,
    cacheWrite1hUsdPerMillion: 6,
    cacheReadUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
  },
  "anthropic:claude-sonnet-4-5": {
    providerModelId: "claude-sonnet-4-5",
    inputUsdPerMillion: 3,
    cacheWrite5mUsdPerMillion: 3.75,
    cacheWrite1hUsdPerMillion: 6,
    cacheReadUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
  },
  "anthropic:claude-opus-4-8": {
    providerModelId: "claude-opus-4-8",
    inputUsdPerMillion: 5,
    cacheWrite5mUsdPerMillion: 6.25,
    cacheWrite1hUsdPerMillion: 10,
    cacheReadUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
  },
  "anthropic:claude-opus-4-6": {
    providerModelId: "claude-opus-4-6",
    inputUsdPerMillion: 5,
    cacheWrite5mUsdPerMillion: 6.25,
    cacheWrite1hUsdPerMillion: 10,
    cacheReadUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
  },
  "anthropic:claude-opus-4-5": {
    providerModelId: "claude-opus-4-5",
    inputUsdPerMillion: 5,
    cacheWrite5mUsdPerMillion: 6.25,
    cacheWrite1hUsdPerMillion: 10,
    cacheReadUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
  },
  "anthropic:claude-haiku-4-5": {
    providerModelId: "claude-haiku-4-5",
    inputUsdPerMillion: 1,
    cacheWrite5mUsdPerMillion: 1.25,
    cacheWrite1hUsdPerMillion: 2,
    cacheReadUsdPerMillion: 0.1,
    outputUsdPerMillion: 5,
  },
} satisfies Record<(typeof AI_SETTINGS_MODELS)[number], AnthropicGatewayPricing>;

// Models Anthropic can bill Hub for that Hub never asks for itself: the
// targets a refusal fallback (`fallbacks: "default"`) may hand an answer to
// (claude-opus-4-8, in the catalog above, and claude-opus-5). Priced, never
// requested: resolveAnthropicGatewayModel does not accept them.
const ANTHROPIC_BILLED_ONLY_PRICING: Record<string, AnthropicGatewayPricing> = {
  "anthropic:claude-opus-5": {
    providerModelId: "claude-opus-5",
    inputUsdPerMillion: 5,
    cacheWrite5mUsdPerMillion: 6.25,
    cacheWrite1hUsdPerMillion: 10,
    cacheReadUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
  },
};

export function aiGatewayProviderForModel(model: string): "anthropic" | "openrouter" {
  return model.startsWith("openrouter:") ? "openrouter" : "anthropic";
}

function nonnegative(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function resolveAnthropicGatewayModel(model: string): AnthropicGatewayPricing {
  const pricing = ANTHROPIC_PRICING[model];
  if (!pricing) {
    throw new Error(`Unsupported Anthropic gateway model: ${model}`);
  }

  return pricing;
}


/** Per-token rates of a model in micro-USD ($/MTok), for splitting a
 * recorded price into its token types; null for a model the catalog lacks. */
export function aiGatewayModelRates(model: string): {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
} | null {
  const pricing = ANTHROPIC_BILLED_ONLY_PRICING[model] ?? ANTHROPIC_PRICING[model];
  if (!pricing) {
    return null;
  }
  return {
    input: pricing.inputUsdPerMillion,
    cacheWrite5m: pricing.cacheWrite5mUsdPerMillion,
    cacheWrite1h: pricing.cacheWrite1hUsdPerMillion,
    cacheRead: pricing.cacheReadUsdPerMillion,
    output: pricing.outputUsdPerMillion,
  };
}

export function estimateAiGatewayUsageCost(
  model: string,
  usage: AiGatewayCostUsage,
): AiGatewayCostEstimate {
  const pricing = ANTHROPIC_BILLED_ONLY_PRICING[model] ?? resolveAnthropicGatewayModel(model);
  const inputTokens = nonnegative(usage.inputTokens);
  const outputTokens = nonnegative(usage.outputTokens);
  const cacheWriteTokens = nonnegative(usage.cacheWriteTokens);
  const cacheReadTokens = nonnegative(usage.cacheReadTokens);
  const raw5mTokens = nonnegative(usage.cacheWrite5mTokens);
  const raw1hTokens = nonnegative(usage.cacheWrite1hTokens);
  const explicitCacheBreakdown = usage.cacheWrite5mTokens !== undefined ||
    usage.cacheWrite1hTokens !== undefined;
  const accountedCacheWriteTokens = raw5mTokens + raw1hTokens;

  let cacheWrite5mTokens = raw5mTokens;
  let cacheWrite1hTokens = raw1hTokens;
  let costApproximate = false;
  if (!explicitCacheBreakdown) {
    cacheWrite5mTokens = cacheWriteTokens;
    cacheWrite1hTokens = 0;
    costApproximate = cacheWriteTokens > 0;
  } else if (accountedCacheWriteTokens !== cacheWriteTokens) {
    cacheWrite5mTokens = Math.max(0, cacheWriteTokens - Math.min(raw1hTokens, cacheWriteTokens));
    cacheWrite1hTokens = Math.min(raw1hTokens, cacheWriteTokens);
    costApproximate = true;
  }

  const rawCostMicroUsd =
    inputTokens * pricing.inputUsdPerMillion +
    cacheWrite5mTokens * pricing.cacheWrite5mUsdPerMillion +
    cacheWrite1hTokens * pricing.cacheWrite1hUsdPerMillion +
    cacheReadTokens * pricing.cacheReadUsdPerMillion +
    outputTokens * pricing.outputUsdPerMillion;

  return {
    provider: "anthropic",
    providerModelId: pricing.providerModelId,
    costMicroUsd: microUsdFromDbInt(Math.round(rawCostMicroUsd)),
    costApproximate,
  };
}
