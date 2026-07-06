import { microUsdFromDbInt, type MicroUsd } from "@agency_hub_core/shared";
export interface AiGatewayCostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
}

export interface AiGatewayCostEstimate {
  provider: "anthropic";
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

const ANTHROPIC_PRICING: Record<string, AnthropicGatewayPricing> = {
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
};

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

export function estimateAiGatewayUsageCost(
  model: string,
  usage: AiGatewayCostUsage,
): AiGatewayCostEstimate {
  const pricing = resolveAnthropicGatewayModel(model);
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
