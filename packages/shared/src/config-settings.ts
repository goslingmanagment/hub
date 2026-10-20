// Authoritative, framework-free overlay logic for the editable config surface
// (Stage B). `validateConfigOverride` is the single server-side gate every write
// passes through: it consults the descriptor registry so an override can never be
// accepted for a non-editable key, a wrong type, an out-of-bounds number, or a
// value outside an enum. `resolveEffectiveConfig` layers the (validated) overrides
// over the env-loaded AppConfig and tags each value's source. Both are pure so
// the worker, the API handlers, and tests resolve the effective config
// identically.

import { configStringFormatError } from "./chat-extension-settings.ts";
import type { AppConfig } from "./config.ts";
import type { ConfigOverrideValue, SkippedOverride } from "./config-registry.ts";
import { CONFIG_DESCRIPTORS, getDescriptor, RETIRED_CONFIG_KEYS } from "./config-registry.ts";

export type ValidateConfigOverrideResult =
  | { ok: true; value: ConfigOverrideValue }
  | { ok: false; error: string };

/** PURE server-side validation of a single override. The registry is the only
 *  source of truth for which keys are editable and their bounds. Numbers are
 *  CLAMPED to min/max (the returned value is the clamped one) rather than rejected,
 *  unless the descriptor opts into `outOfRange: 'reject'` (a bound that is a rule,
 *  e.g. the Fansly pause floor), which rejects with the descriptor's message;
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
      if (descriptor.outOfRange === "reject") {
        if (descriptor.min != null && value < descriptor.min) {
          return { ok: false, error: descriptor.belowMinError ?? `${key} must be at least ${descriptor.min}` };
        }
        if (descriptor.max != null && value > descriptor.max) {
          return { ok: false, error: descriptor.aboveMaxError ?? `${key} must be at most ${descriptor.max}` };
        }
        return { ok: true, value };
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
      // VOICE_NOTES_PAGE_ALLOWLIST is z.string().trim()). Validate/compare the
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
      // A value with inner structure (JSON, a version) is rejected when it does
      // not parse — never trimmed into shape (chat-extension-settings.ts).
      const formatError = descriptor.format ? configStringFormatError(descriptor.format, trimmed) : null;
      if (formatError !== null) {
        return { ok: false, error: `${key}: ${formatError}` };
      }
      return { ok: true, value: trimmed };
    }
    default:
      // url/secret/derived/complex are never marked editable in the registry
      // (a parity test enforces this); guard anyway so a future mistake fails closed.
      return { ok: false, error: `Config key is not editable: ${key}` };
  }
}

/** The descriptor `costWarning` for each of `keys` that carries one, keyed by config key.
 *  Folded into the audit note server-side at write time so the cost warning that applied is
 *  durable evidence derived from the registry — never trusting (or depending on) the UI to
 *  send it. The live edit path has no ack gate, so this is its only durable cost record. */
export function collectCostWarnings(keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const descriptor = getDescriptor(key);
    if (descriptor?.costWarning) out[key] = descriptor.costWarning;
  }
  return out;
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
    // and other never values (and their raw env values) out of this result —
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

/** Minimal shape of a stored override map entry, declared locally so this module
 *  never imports @agency_hub_core/db (which would create a db↔shared cycle). The db
 *  ConfigOverrideRecord is assignable to this. */
export interface BootOverrideInput {
  value: unknown;
  version?: number;
}

export interface ApplyBootOverridesResult {
  config: AppConfig;
  skipped: SkippedOverride[];
}

/** PURE boot-time apply of the boot-wired (`runtimeApply === 'boot'`) overrides onto
 *  the env-loaded config, called once in createAppContext. For each boot descriptor with
 *  an override it validates the value (validateConfigOverride) and writes it onto a
 *  clone; an invalid value is skipped with a reason and never throws. Returns the
 *  original `config` object (unchanged identity) when nothing changed.
 *
 *  No @agency_hub_core/db import: the override map is the local {@link BootOverrideInput}
 *  shape, so this stays in the cycle-free shared layer. */
export function applyBootOverrides(
  config: AppConfig,
  overrides: Map<string, BootOverrideInput>,
): ApplyBootOverridesResult {
  const skipped: SkippedOverride[] = [];
  const merged: AppConfig = { ...config };
  const envSource = config as unknown as Record<string, unknown>;
  let mutated = false;

  for (const descriptor of CONFIG_DESCRIPTORS) {
    if (descriptor.runtimeApply !== "boot") continue;
    const override = overrides.get(descriptor.key);
    if (override === undefined) continue;

    const validated = validateConfigOverride(descriptor.key, override.value);
    if (!validated.ok) {
      skipped.push({ key: descriptor.key, reason: validated.error });
      continue;
    }
    if (descriptor.configField == null) {
      skipped.push({ key: descriptor.key, reason: `Config key has no field: ${descriptor.key}` });
      continue;
    }

    const field = descriptor.configField as string;
    (merged as unknown as Record<string, unknown>)[field] = validated.value;
    if (validated.value !== envSource[field]) mutated = true;
  }

  // Flag only genuinely non-applicable override rows so the operator sees a row that was
  // ignored at boot. A LIVE override is applied via the runtime overlay (loadEffectiveConfig),
  // not at boot — it is NOT "rejected", so it must NOT be reported here (else every live edit
  // shows a false "Override rejected at boot" after a restart). Boot keys are handled above;
  // that leaves only unknown keys (a retired key's leftover row aside) and runtimeApply:'none'
  // rows (which the API cannot create — a genuinely stray, hand-inserted row worth surfacing).
  for (const key of overrides.keys()) {
    if (RETIRED_CONFIG_KEYS.has(key)) continue;
    const descriptor = getDescriptor(key);
    if (descriptor && descriptor.runtimeApply !== "none") continue;
    skipped.push({ key, reason: `Config key is not overridable via the DB overlay: ${key}` });
  }

  return { config: mutated ? merged : config, skipped };
}
