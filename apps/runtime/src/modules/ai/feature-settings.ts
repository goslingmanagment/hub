import {
  aiFeatureSettingsOf,
  parseAiFeatureEfforts,
  parseAiFeatureModels,
  parseAiFeatureWindows,
  type AiFeatureSettingsMap,
  type AiSettingsEffort,
  type AiSettingsFeature,
} from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../../services/effective-config.ts";

/** The owner's live per-feature model, effort and chat window
 * (`aiFeatureModels`, `aiFeatureEfforts`, `aiFeatureWindows`). */
export interface AiFeatureSettings {
  model(feature: string, modelFeature: string): string | undefined;
  effort(feature: string, modelFeature: string): AiSettingsEffort | undefined;
  /** Most latest messages the feature reads; undefined = the client's window. */
  window(feature: string): number | undefined;
}

function settingsOf(
  models: AiFeatureSettingsMap<string>,
  efforts: AiFeatureSettingsMap<AiSettingsEffort>,
  windows: AiFeatureSettingsMap<number>,
): AiFeatureSettings {
  // A feature named itself wins; Fix, Hi and Voice otherwise follow their model feature (fast-reply).
  const pick = <T>(map: AiFeatureSettingsMap<T>, feature: string, modelFeature: string): T | undefined =>
    map[feature as AiSettingsFeature] ?? map[modelFeature as AiSettingsFeature];
  return {
    model: (feature, modelFeature) => pick(models, feature, modelFeature),
    effort: (feature, modelFeature) => pick(efforts, feature, modelFeature),
    window: (feature) => windows[feature as AiSettingsFeature],
  };
}

export async function loadAiFeatureSettings(app: Pick<AppContext, "db" | "config" | "logger">): Promise<AiFeatureSettings> {
  try {
    const effective = await loadEffectiveConfig(app.db, app.config);
    return settingsOf(
      aiFeatureSettingsOf(effective.aiFeatureModels, parseAiFeatureModels),
      aiFeatureSettingsOf(effective.aiFeatureEfforts, parseAiFeatureEfforts),
      aiFeatureSettingsOf(effective.aiFeatureWindows, parseAiFeatureWindows),
    );
  } catch (error) {
    app.logger.warn({ err: error }, "ai feature settings lookup failed; the code defaults serve");
    return settingsOf({}, {}, {});
  }
}
