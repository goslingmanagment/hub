// Authoritative, framework-free overlay logic for the editable config surface
// (Stage B). `validateConfigOverride` is the single server-side gate every write
// passes through: it consults the descriptor registry so an override can never be
// accepted for a non-editable key, a wrong type, an out-of-bounds number, or a
// value outside an enum. `resolveEffectiveConfig` layers the (validated) overrides
// over the env-loaded AppConfig and tags each value's source, mirroring the
// per-page overlay pattern in workboard-v2/ai-settings.ts. Both are pure so the
// worker, the API handlers, and tests resolve the effective config identically.

import type { AppConfig } from "./config.ts";
import type { ConfigOverrideValue } from "./config-registry.ts";
import { CONFIG_DESCRIPTORS, getDescriptor } from "./config-registry.ts";

export type ValidateConfigOverrideResult =
  | { ok: true; value: ConfigOverrideValue }
  | { ok: false; error: string };

/** PURE server-side validation of a single override. The registry is the only
 *  source of truth for which keys are editable and their bounds. Numbers are
 *  CLAMPED to min/max (the returned value is the clamped one) rather than rejected;
 *  everything else (unknown/non-editable key, type mismatch, NaN/Infinity, enum
 *  miss) is rejected with a clear message. */
export function validateConfigOverride(
  key: string,
  value: unknown,
): ValidateConfigOverrideResult {
  const descriptor = getDescriptor(key);
  if (!descriptor) {
    return { ok: false, error: `Unknown config key: ${key}` };
  }
  if (descriptor.editability !== "editable") {
    return { ok: false, error: `Config key is not editable: ${key}` };
  }

  switch (descriptor.kind) {
    case "boolean": {
      if (typeof value !== "boolean") {
        return { ok: false, error: `${key} expects a boolean` };
      }
      return { ok: true, value };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: `${key} expects a finite number` };
      }
      // Every numeric config knob is an integer in the env schema (.int()).
      if (!Number.isInteger(value)) {
        return { ok: false, error: `${key} expects an integer` };
      }
      let next = value;
      if (descriptor.min != null && next < descriptor.min) {
        next = descriptor.min;
      }
      if (descriptor.max != null && next > descriptor.max) {
        next = descriptor.max;
      }
      return { ok: true, value: next };
    }
    case "string": {
      if (typeof value !== "string") {
        return { ok: false, error: `${key} expects a string` };
      }
      // Mirror the env schema, which trims and requires non-empty (e.g.
      // WB_CLOSING_LLM_MODEL is z.string().trim().min(1)). Validate/compare the
      // trimmed value and store that.
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return { ok: false, error: `${key} must be a non-empty string` };
      }
      if (descriptor.enumValues && !descriptor.enumValues.includes(trimmed)) {
        return {
          ok: false,
          error: `${key} must be one of: ${descriptor.enumValues.join(", ")}`,
        };
      }
      return { ok: true, value: trimmed };
    }
    default:
      // url/secret/derived/alias/complex are never marked editable in the registry
      // (a parity test enforces this); guard anyway so a future mistake fails closed.
      return { ok: false, error: `Config key is not editable: ${key}` };
  }
}

export interface EffectiveConfigValue {
  value: string | number | boolean | null;
  source: "env" | "override";
}

export interface ResolvedEffectiveConfig {
  values: Record<string, EffectiveConfigValue>;
}

function overrideEntry(
  overrides: Map<string, { value: ConfigOverrideValue }> | Record<string, ConfigOverrideValue>,
  key: string,
): ConfigOverrideValue | undefined {
  if (overrides instanceof Map) {
    return overrides.get(key)?.value;
  }
  return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : undefined;
}

function toScalar(raw: unknown): string | number | boolean | null {
  if (raw == null) return null;
  if (typeof raw === "boolean" || typeof raw === "number" || typeof raw === "string") {
    return raw;
  }
  return String(raw);
}

/** Layer validated overrides over the env-loaded config and tag each value's
 *  source. For every descriptor: when an editable override exists AND validates,
 *  the effective value is the (clamped) override tagged 'override'; otherwise the
 *  env value from config[configField] tagged 'env'. Pure + framework-free. */
export function resolveEffectiveConfig(
  config: AppConfig,
  overrides: Map<string, { value: ConfigOverrideValue }> | Record<string, ConfigOverrideValue>,
): ResolvedEffectiveConfig {
  const source = config as unknown as Record<string, unknown>;
  const values: Record<string, EffectiveConfigValue> = {};

  for (const descriptor of CONFIG_DESCRIPTORS) {
    // Only editable keys can ever carry an override, so the effective config differs
    // from env only for them. Restricting the map to editable keys also keeps secrets
    // and other never/staged values (and their raw env values) out of this result —
    // it must never become a channel that serializes a databaseUrl or an API key.
    if (descriptor.editability !== "editable") continue;

    const envValue = descriptor.configField ? toScalar(source[descriptor.configField as string]) : null;
    const raw = overrideEntry(overrides, descriptor.key);

    if (raw !== undefined) {
      const validated = validateConfigOverride(descriptor.key, raw);
      if (validated.ok) {
        values[descriptor.key] = { value: validated.value, source: "override" };
        continue;
      }
    }

    values[descriptor.key] = { value: envValue, source: "env" };
  }

  return { values };
}
