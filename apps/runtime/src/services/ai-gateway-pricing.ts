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

const ANTHROPIC_PRICING: Record<string, AnthropicGatewayPricing> = {
  // Decision #273: the judged reply-feature default (adaptive-only surface,
  // handled generically by ai-gateway-anthropic.ts). List price 2026-09.
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
};

// Stage 29: OpenRouter catalog (second provider). Prices are the vendor's
// published per-million rates at implementation time; the §5 invoice
// reconciliation week trues them up. cache-write is not billed separately.
const OPENROUTER_PRICING: Record<string, AnthropicGatewayPricing> = {
  "openrouter:openai/gpt-4o-mini": {
    providerModelId: "openai/gpt-4o-mini",
    inputUsdPerMillion: 0.15,
    cacheWrite5mUsdPerMillion: 0,
    cacheWrite1hUsdPerMillion: 0,
    cacheReadUsdPerMillion: 0.075,
    outputUsdPerMillion: 0.6,
  },
  "openrouter:openai/gpt-4.1-mini": {
    providerModelId: "openai/gpt-4.1-mini",
    inputUsdPerMillion: 0.4,
    cacheWrite5mUsdPerMillion: 0,
    cacheWrite1hUsdPerMillion: 0,
    cacheReadUsdPerMillion: 0.1,
    outputUsdPerMillion: 1.6,
  },
  "openrouter:meta-llama/llama-3.3-70b-instruct": {
    providerModelId: "meta-llama/llama-3.3-70b-instruct",
    inputUsdPerMillion: 0.12,
    cacheWrite5mUsdPerMillion: 0,
    cacheWrite1hUsdPerMillion: 0,
    cacheReadUsdPerMillion: 0.12,
    outputUsdPerMillion: 0.3,
  },
};

export function aiGatewayProviderForModel(model: string): "anthropic" | "openrouter" {
  return model.startsWith("openrouter:") ? "openrouter" : "anthropic";
}

export function resolveOpenrouterGatewayModel(model: string): AnthropicGatewayPricing {
  const pricing = OPENROUTER_PRICING[model];
  if (!pricing) {
    throw new Error(`Unsupported OpenRouter gateway model: ${model}`);
  }

  return pricing;
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

/** List price (USD per 1M tokens) by bare provider model id, for estimates
 * that never touch the ledger (workboard cost panel); null outside the catalog
 * so the caller decides its own fallback instead of silently underpricing. */
export function anthropicListPriceUsdPerMillion(
  providerModelId: string,
): { input: number; output: number } | null {
  const entry = Object.values(ANTHROPIC_PRICING).find(
    (pricing) => pricing.providerModelId === providerModelId,
  );
  return entry ? { input: entry.inputUsdPerMillion, output: entry.outputUsdPerMillion } : null;
}

export function estimateAiGatewayUsageCost(
  model: string,
  usage: AiGatewayCostUsage,
): AiGatewayCostEstimate {
  const provider = aiGatewayProviderForModel(model);
  const pricing = provider === "openrouter"
    ? resolveOpenrouterGatewayModel(model)
    : resolveAnthropicGatewayModel(model);
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
    provider,
    providerModelId: pricing.providerModelId,
    costMicroUsd: microUsdFromDbInt(Math.round(rawCostMicroUsd)),
    costApproximate,
  };
}
