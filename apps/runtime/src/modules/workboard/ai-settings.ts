// Effective L2-classifier settings = per-page override (DB) over env defaults,
// plus a model→price lookup for cost estimates. Pure + framework-free so the
// worker, the API handlers, and tests all resolve settings the same way.

import { anthropicListPriceUsdPerMillion } from "../../services/ai-gateway-pricing.ts";

export interface ClosingConfigLike {
  anthropicApiKey?: string | null;
  wbClosingLlmEnabled?: boolean; // env flag (already key-gated in config.ts)
  wbClosingLlmModel?: string;
  wbClosingLlmDailyCapMin?: number;
  wbClosingLlmDailyCapMax?: number;
}

export interface ClosingSettingsOverride {
  enabled: boolean | null;
  dailyCapMax: number | null;
  model: string | null;
}

export interface EffectiveClosingSettings {
  /** The feature actually runs for this page (requires an API key). */
  enabled: boolean;
  capMin: number;
  capMax: number;
  model: string;
  hasApiKey: boolean;
  /** Whether each effective value came from a per-page override vs the env default. */
  source: { enabled: "override" | "env"; dailyCapMax: "override" | "env"; model: "override" | "env" };
}

export const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_CAP_MIN = 50;
const DEFAULT_CAP_MAX = 400;

export function resolveClosingSettings(
  config: ClosingConfigLike,
  override: ClosingSettingsOverride | null,
): EffectiveClosingSettings {
  const hasApiKey = Boolean(config.anthropicApiKey);
  const envEnabled = config.wbClosingLlmEnabled ?? false;
  const enabledOverridden = override?.enabled != null;
  const capOverridden = override?.dailyCapMax != null;
  const modelOverridden = Boolean(override?.model);

  return {
    enabled: hasApiKey && (enabledOverridden ? override!.enabled! : envEnabled),
    capMin: config.wbClosingLlmDailyCapMin ?? DEFAULT_CAP_MIN,
    capMax: capOverridden ? override!.dailyCapMax! : (config.wbClosingLlmDailyCapMax ?? DEFAULT_CAP_MAX),
    model: modelOverridden ? override!.model! : (config.wbClosingLlmModel ?? DEFAULT_MODEL),
    hasApiKey,
    source: {
      enabled: enabledOverridden ? "override" : "env",
      dailyCapMax: capOverridden ? "override" : "env",
      model: modelOverridden ? "override" : "env",
    },
  };
}

// USD per 1M tokens from the gateway catalog (the single price table). Prompt
// caching discounts are not modelled here, so this is a conservative upper
// bound. A model outside the catalog falls back to the default model's price.
export function modelPricing(model: string): { input: number; output: number } {
  return anthropicListPriceUsdPerMillion(model) ?? anthropicListPriceUsdPerMillion(DEFAULT_MODEL)!;
}

/** Estimated USD cost for a token count under a model's list price. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = modelPricing(model);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}
