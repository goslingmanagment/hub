// Authoritative, framework-free overlay logic for the editable config surface
// (Stage B). `validateConfigOverride` is the single server-side gate every write
// passes through: it consults the descriptor registry so an override can never be
// accepted for a non-editable key, a wrong type, an out-of-bounds number, or a
// value outside an enum. `resolveEffectiveConfig` layers the (validated) overrides
// over the env-loaded AppConfig and tags each value's source, mirroring the
// per-page overlay pattern in workboard-v2/ai-settings.ts. Both are pure so the
// worker, the API handlers, and tests resolve the effective config identically.

import type { AppConfig } from "./config.ts";
import { checkPublicProfileResolutionInvariant, checkSyncConcurrencyInvariant } from "./config.ts";
import type { ConfigOverrideValue, SkippedOverride } from "./config-registry.ts";
import { CONFIG_DESCRIPTORS, getDescriptor, transitiveRequires } from "./config-registry.ts";

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

/** Fast-reply freshness PR3: the aiTranscriptFreshUnionMode transition rule
 *  (v7 amendment 1). Upward moves are stepwise only (off→shadow→serve, one
 *  step at a time — off→serve is rejected so every enable passes through a
 *  shadow verification window); any downward move is an allowed rollback
 *  (serve→shadow, serve→off, shadow→off); re-writing the same value is a
 *  no-op and allowed. `current` is the stored override row's value (null =
 *  no override = the env default, off); an invalid stored value degrades to
 *  off, which forces the stepwise path on the way back up. Clearing an
 *  override (DELETE) needs no transition check — it resolves to off.
 *  Validated INSIDE the locked write transaction (applyConfigPatchesInTx's
 *  validateTransition hook) so the check races nothing. */
export function validateAiTranscriptFreshUnionModeTransition(
  current: ConfigOverrideValue | null,
  next: string,
): string | null {
  const order: Record<string, number> = { off: 0, shadow: 1, serve: 2 };
  const currentMode = current === "shadow" || current === "serve" ? (current as string) : "off";
  if (!(next in order)) {
    return "aiTranscriptFreshUnionMode must be one of: off, shadow, serve";
  }
  if (order[next]! - order[currentMode]! > 1) {
    return `aiTranscriptFreshUnionMode may only step upward one mode at a time (${currentMode} → ${next}); go through shadow first`;
  }
  return null;
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

export type ValidateStagedOverrideResult =
  | { ok: true; value: boolean }
  | { ok: false; error: string };

/** PURE server-side validation of a single STAGED (boot-applied) override. A staged
 *  flag flip is only legal for a key whose wiring is `runtimeApply === 'boot'` and
 *  whose value is a boolean. Fail-closed for unknown keys, non-boot keys (live/none),
 *  and non-boolean values. The later staged-rollout endpoint runs every flip through
 *  this gate before persisting it; applyBootOverrides reuses it at process start. */
export function validateStagedOverride(key: string, value: unknown): ValidateStagedOverrideResult {
  const descriptor = getDescriptor(key);
  if (!descriptor) {
    return { ok: false, error: `Unknown config key: ${key}` };
  }
  if (descriptor.runtimeApply !== "boot") {
    return { ok: false, error: `Config key is not staged (boot-applied): ${key}` };
  }
  if (typeof value !== "boolean") {
    return { ok: false, error: `${key} expects a boolean` };
  }
  return { ok: true, value };
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

/** Read the boot-applied invariants off a (candidate) merged config and return the
 *  first violation message, or null. Generic/defensive: none of today's 8 boot keys
 *  participate, but a future boot flag that feeds one of these fields would. */
function checkBootInvariants(config: AppConfig): string | null {
  const publicProfileError = checkPublicProfileResolutionInvariant({
    resolutionEnabled: config.onlyFansPublicProfileResolutionEnabled === true,
    allowDirect: config.onlyFansPublicProfileAllowDirect === true,
    hasProxy: config.onlyFansPublicProfileProxy != null,
  });
  if (publicProfileError) return publicProfileError;

  return checkSyncConcurrencyInvariant({
    pageExecutorConcurrency: config.syncPageExecutorConcurrency,
    sharedRateLimitEnabled: config.syncSharedRateLimitEnabled,
  });
}

/** PURE boot-time apply of the staged (`runtimeApply === 'boot'`) overrides onto the
 *  env-loaded config, called once in createAppContext. For each boot descriptor with
 *  an override it validates the value (boolean) and tentatively writes it onto a clone;
 *  an invalid value (or a stray override for a key that is not a boot key) is skipped
 *  with a reason and never throws. It then ALWAYS (even with zero overrides) (1) normalizes
 *  the staged REQUIRES GRAPH on the merged config — any boot flag left ON while a transitive
 *  prerequisite is OFF is forced to FALSE (NOT reverted to env, since the env value can
 *  itself be the invalid `true`) and recorded as skipped (fail-safe: boot never starts a
 *  dependent=on/prereq=off graph, however that state arose — a stale override, a hand-edited
 *  row, OR the env config itself) — then (2) re-checks the boot invariants on the FINAL
 *  merged config; if an APPLIED override broke one, the offending keys are reverted to env
 *  (recorded as skipped) and the invariants re-checked. This invariant-revert pass only fires
 *  when there are applied overrides (`applied.length > 0`): with zero overrides it is a no-op,
 *  which is sound because loadConfig already validated the env invariants before this runs AND
 *  no current boot key feeds checkBootInvariants (the boot set and the invariant-input fields
 *  are disjoint — pinned by the config-registry integrity test). So the env can't reach this
 *  point violating an invariant it didn't already reject at load. (If a future boot key is
 *  wired into checkBootInvariants, drop the `applied.length > 0` guard and re-normalize the
 *  requires graph after reverting.) Returns the original `config` object (unchanged identity)
 *  when nothing changed (zero overrides over an already-valid env graph).
 *
 *  No @agency_hub_core/db import: the override map is the local {@link BootOverrideInput}
 *  shape, so this stays in the cycle-free shared layer. */
export function applyBootOverrides(
  config: AppConfig,
  overrides: Map<string, BootOverrideInput>,
): ApplyBootOverridesResult {
  const skipped: SkippedOverride[] = [];

  // Candidate (key, validated boolean, configField) tuples that passed value validation.
  // Tracked only so a later invariant revert names the overridden keys it backs out.
  const applied: Array<{ key: string; value: boolean; field: string }> = [];
  // We ALWAYS materialize a working clone and run the requires-graph normalization over
  // it, even with zero overrides: the env config itself can be an invalid staged graph
  // (e.g. OFAPI_DM_SYNC_ENABLED=true while OFAPI_DM_PROJECTION_ENABLED=false), and boot
  // must never start a dependent=on/prereq=off combination. The NET change (the final
  // merged value vs the original env value, per field) is computed at the end, so a key
  // that was flipped on then forced back off to its env value counts as no change and we
  // return the original `config` identity unchanged (matching the zero-override case).
  const merged: AppConfig = { ...config };

  for (const descriptor of CONFIG_DESCRIPTORS) {
    if (descriptor.runtimeApply !== "boot") continue;
    const override = overrides.get(descriptor.key);
    if (override === undefined) continue;

    const validated = validateStagedOverride(descriptor.key, override.value);
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
    applied.push({ key: descriptor.key, value: validated.value, field });
  }

  // Flag only genuinely non-applicable override rows so the operator sees a row that was
  // ignored at boot. A LIVE override is applied via the runtime overlay (loadEffectiveConfig),
  // not at boot — it is NOT "rejected", so it must NOT be reported here (else every live edit
  // shows a false "Override rejected at boot" after a restart). Boot keys are handled above;
  // that leaves only unknown keys and runtimeApply:'none' rows (which the API cannot create —
  // a genuinely stray, hand-inserted row worth surfacing).
  for (const key of overrides.keys()) {
    const descriptor = getDescriptor(key);
    if (descriptor && descriptor.runtimeApply !== "none") continue;
    skipped.push({ key, reason: `Config key is not overridable via the DB overlay: ${key}` });
  }

  // Fail-safe ordered-requires normalization on the MERGED graph: boot never applies an
  // invalid dependent=on / prerequisite=off combination regardless of how that state got
  // there — a stale override, a hand-edited row, a bad import, OR the env config itself.
  // For every boot key that is ON in merged, every key in its transitive `requires` must
  // also be ON in merged. A dependent that is ON while a prerequisite is OFF is forced to
  // FALSE (NOT its env value — env may itself be the invalid `true`), the reason recorded,
  // then we re-check until the graph is consistent. The loop is bounded by the boot-
  // descriptor count: each pass forces ≥1 ON dependent off and never turns a key back on,
  // so it converges. Pure walk over CONFIG_DESCRIPTORS — no runtime imports.
  const bootDescriptors = CONFIG_DESCRIPTORS.filter((d) => d.runtimeApply === "boot" && d.configField != null);
  const mergedBootOn = (key: string): boolean => {
    const descriptor = getDescriptor(key);
    const field = descriptor?.configField as string | undefined;
    if (field == null) return false;
    return (merged as unknown as Record<string, unknown>)[field] === true;
  };

  for (let pass = 0; pass < bootDescriptors.length + 1; pass += 1) {
    let forcedThisPass = false;
    for (const descriptor of bootDescriptors) {
      const field = descriptor.configField as string;
      if (!mergedBootOn(descriptor.key)) continue;
      const offPrereq = transitiveRequires(descriptor.key).find((prereq) => !mergedBootOn(prereq));
      if (offPrereq === undefined) continue;
      // Dependent is on while a prerequisite is off — force the dependent OFF (not env,
      // which can itself be the invalid `true`).
      (merged as unknown as Record<string, unknown>)[field] = false;
      skipped.push({ key: descriptor.key, reason: `prerequisite ${offPrereq} is off` });
      // Drop it from the applied set so the identity/invariant bookkeeping stays accurate.
      const idx = applied.findIndex((candidate) => candidate.key === descriptor.key);
      if (idx !== -1) applied.splice(idx, 1);
      forcedThisPass = true;
    }
    if (!forcedThisPass) break;
  }

  const envSource = config as unknown as Record<string, unknown>;

  // Validate the merged invariants; revert the involved overridden keys to env and
  // re-check until clean. Because the current boot keys touch independent boolean
  // fields, one pass per offending key converges; the loop is bounded by `applied`.
  // The `applied.length > 0` guard is intentional: with no applied overrides there is
  // nothing to revert, and the env was already invariant-validated by loadConfig (and no
  // boot key feeds checkBootInvariants — see the docstring), so `merged` cannot violate an
  // invariant here. A future boot key wired into an invariant would need this guard dropped
  // plus a re-normalization of the requires graph after the revert.
  let invariantError = checkBootInvariants(merged);
  while (invariantError != null && applied.length > 0) {
    // Revert every candidate that participated in this apply pass: defensive and
    // simple — re-applying them would re-trigger the same violation.
    for (const candidate of applied) {
      (merged as unknown as Record<string, unknown>)[candidate.field] = envSource[candidate.field];
      skipped.push({ key: candidate.key, reason: invariantError });
    }
    applied.length = 0;
    invariantError = checkBootInvariants(merged);
  }

  // Net change: did any boot field end up DIFFERENT from its original env value? A key that
  // was flipped on then forced/reverted back to its env value is not a net change. When
  // nothing changed (zero overrides over an already-valid env graph, or every applied
  // candidate was undone), hand back the original `config` identity unchanged.
  const mutated = bootDescriptors.some((descriptor) => {
    const field = descriptor.configField as string;
    return (merged as unknown as Record<string, unknown>)[field] !== envSource[field];
  });
  if (!mutated) {
    return { config, skipped };
  }

  return { config: merged, skipped };
}
