import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";
import { AI_SETTINGS_EFFORTS, type AiSettingsFeature } from "@agency_hub_core/shared";
import { featureLabel } from "@/pages/account/accountView";
import { seedValue } from "../ConfigurationEditors.js";
import { parseTuning, TUNING_KEYS, type TuningKind } from "./featureSettingPatch.js";

/** The extension's button of each AI feature: the second line of a row. */
export const FEATURE_BUTTONS: Readonly<Record<AiSettingsFeature, string>> = {
  "fast-reply": "Reply",
  "improve-draft": "Fix",
  "help-me": "Help",
  "fan-summary": "Recap",
  "chat-review": "Review",
  "ping": "Ping",
  "hi-greeting": "Hi",
  "coach-chat": "Coach",
  "voice-script": "Voice",
  "fan-notes-fill": "Заполнить из чата",
};

/** Fix, Hi and Voice take the model and the effort of Reply unless named themselves. */
export const FOLLOWS_REPLY: ReadonlySet<AiSettingsFeature> = new Set(["improve-draft", "hi-greeting", "voice-script"]);

export function tuningFeatureName(feature: AiSettingsFeature): string {
  return featureLabel(feature);
}

export const EFFORT_WORDS: Readonly<Record<(typeof AI_SETTINGS_EFFORTS)[number], string>> = {
  off: "Без размышлений",
  low: "Низкое",
  medium: "Среднее",
  high: "Высокое",
  max: "Максимальное",
};

/** `anthropic:claude-opus-5-5` → «Opus 5.5». */
export function modelWord(model: string): string {
  const name = model.replace(/^anthropic:/, "").replace(/^claude-/, "");
  const [family = name, ...version] = name.split("-");
  return `${family.charAt(0).toUpperCase()}${family.slice(1)}${version.length ? ` ${version.join(".")}` : ""}`;
}

export function valueWord(kind: TuningKind, value: string | number): string {
  if (kind === "model") return modelWord(String(value));
  if (kind === "effort") return EFFORT_WORDS[value as keyof typeof EFFORT_WORDS] ?? String(value);
  return String(value);
}

export interface TuningKey {
  item: ConfigItem | undefined;
  /** The parsed object, or null when it does not parse or is missing. */
  values: Partial<Record<AiSettingsFeature, string | number>> | null;
  /** Why it may not be written now; null: it may. */
  blocked: string | null;
}

/**
 * Whether a key may be written from the table (design/screens/settings.md §4.4).
 * Without a value from every part of Hub `seedValue` would give `{}`, and a write
 * built on it would wipe the working values: then nothing is written.
 */
export function tuningKey(data: ConfigViewResponse, kind: TuningKind, stale: boolean): TuningKey {
  const item = data.subsystems.flatMap((group) => group.items).find((entry) => entry.key === TUNING_KEYS[kind]);
  if (!item) return { item, values: null, blocked: "Этой настройки нет в этой версии Hub" };
  const values = parseTuning(kind, seedValue(item));
  if (stale) return { item, values, blocked: "Данные устарели: обновите экран" };
  if (item.running.length === 0) return { item, values, blocked: "Часть Hub не сообщила значение" };
  if (item.drift || item.running.some((entry) => entry.state === "unknown")) return { item, values, blocked: "Части Hub работают с разными значениями" };
  if (values === null) return { item, values, blocked: "Значение на сервере не читается" };
  return { item, values, blocked: null };
}

/** The daily ceiling of a feature, micro-USD, read only. Null: none or unreadable. */
export function featureCeilings(data: ConfigViewResponse): Partial<Record<string, number>> | null {
  const item = data.subsystems.flatMap((group) => group.items).find((entry) => entry.key === "chatMuseAiGatewayFeatureDailyMicroUsdLimits");
  if (!item) return null;
  try {
    const parsed: unknown = JSON.parse(seedValue(item));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Partial<Record<string, number>> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    return out;
  } catch {
    return null;
  }
}
