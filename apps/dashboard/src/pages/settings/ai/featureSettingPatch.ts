import type { ConfigUpdateBody } from "@agency_hub_core/contracts";
import {
  parseAiFeatureEfforts,
  parseAiFeatureModels,
  parseAiFeatureWindows,
  type AiSettingsFeature,
} from "@agency_hub_core/shared";
import type { ConfigSnapshot } from "../ConfigurationEditors.js";

/**
 * The write of one feature's model, effort or window (design/screens/settings.md §4.4).
 * The three parameters are JSON objects keyed by the feature: a change of one
 * feature keeps every other feature's value, «По умолчанию» deletes only this
 * feature's key, and the version is the one the window was opened with. One key,
 * one patch, the same `adminConfigUpdate` the full list sends.
 */
export type TuningKind = "model" | "effort" | "window";

export const TUNING_KEYS: Readonly<Record<TuningKind, string>> = {
  model: "aiFeatureModels",
  effort: "aiFeatureEfforts",
  window: "aiFeatureWindows",
};

const PARSERS = {
  model: parseAiFeatureModels,
  effort: parseAiFeatureEfforts,
  window: parseAiFeatureWindows,
} as const;

/** The stored object, or null when it does not parse: then nothing may be written. */
export function parseTuning(kind: TuningKind, text: string): Partial<Record<AiSettingsFeature, string | number>> | null {
  const parsed = PARSERS[kind](text);
  return parsed.ok ? parsed.value : null;
}

export function featureSettingPatch(
  snapshot: ConfigSnapshot,
  kind: TuningKind,
  feature: AiSettingsFeature,
  value: string | number | null,
): ConfigUpdateBody | null {
  const parsed = parseTuning(kind, snapshot.value);
  if (parsed === null) return null;
  const next: Partial<Record<AiSettingsFeature, string | number>> = { ...parsed };
  if (value === null) delete next[feature];
  else next[feature] = value;
  return { patches: [{ key: snapshot.key, value: JSON.stringify(next), expectedVersion: snapshot.version }] };
}
