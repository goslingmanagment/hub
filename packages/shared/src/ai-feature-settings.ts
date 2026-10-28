// The owner's live per-feature AI settings (2026-10-28): the model, the effort
// and the chat window of each AI feature, as JSON objects keyed by the feature
// (`aiFeatureModels`, `aiFeatureEfforts`, `aiFeatureWindows`). A feature the
// object does not name keeps the code's default. A value is checked on write
// (config-registry `format`), so a stored one always parses.

export const AI_SETTINGS_FEATURES = [
  "fast-reply",
  "improve-draft",
  "help-me",
  "fan-summary",
  "chat-review",
  "ping",
  "hi-greeting",
  "coach-chat",
  "voice-script",
  "fan-notes-fill",
] as const;
export type AiSettingsFeature = (typeof AI_SETTINGS_FEATURES)[number];

/** Models Hub prices (ai-gateway-pricing.ts). */
export const AI_SETTINGS_MODELS = [
  "anthropic:claude-opus-5-5",
  "anthropic:claude-sonnet-5-5",
  "anthropic:claude-sonnet-5",
  "anthropic:claude-sonnet-4-6",
  "anthropic:claude-sonnet-4-5",
  "anthropic:claude-opus-4-8",
  "anthropic:claude-opus-4-6",
  "anthropic:claude-opus-4-5",
  "anthropic:claude-haiku-4-5",
] as const;

export const AI_SETTINGS_EFFORTS = ["off", "low", "medium", "high", "max"] as const;
export type AiSettingsEffort = (typeof AI_SETTINGS_EFFORTS)[number];

/** A window cap: at most this many latest messages. */
export const AI_SETTINGS_WINDOW_MAX = 3000;

export type AiFeatureSettingsMap<T> = Partial<Record<AiSettingsFeature, T>>;
type Parse<T> = { ok: true; value: AiFeatureSettingsMap<T> } | { ok: false; error: string };

function parseFeatureMap<T>(text: string, example: string, valueOf: (raw: unknown) => T | null, expected: string): Parse<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `is not JSON: an object keyed by feature, e.g. ${example}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `is an object keyed by feature, e.g. ${example}` };
  }
  const value: AiFeatureSettingsMap<T> = {};
  for (const [feature, raw] of Object.entries(parsed)) {
    if (!(AI_SETTINGS_FEATURES as readonly string[]).includes(feature)) {
      return { ok: false, error: `unknown feature "${feature}"; features: ${AI_SETTINGS_FEATURES.join(", ")}` };
    }
    const item = valueOf(raw);
    if (item === null) {
      return { ok: false, error: `"${feature}" must be ${expected}` };
    }
    value[feature as AiSettingsFeature] = item;
  }
  return { ok: true, value };
}

export function parseAiFeatureModels(text: string): Parse<string> {
  return parseFeatureMap(
    text,
    `{"coach-chat": "anthropic:claude-opus-5-5"}`,
    (raw) => (typeof raw === "string" && (AI_SETTINGS_MODELS as readonly string[]).includes(raw) ? raw : null),
    `one of ${AI_SETTINGS_MODELS.join(", ")}`,
  );
}

export function parseAiFeatureEfforts(text: string): Parse<AiSettingsEffort> {
  return parseFeatureMap(
    text,
    `{"fast-reply": "high"}`,
    (raw) => (typeof raw === "string" && (AI_SETTINGS_EFFORTS as readonly string[]).includes(raw) ? (raw as AiSettingsEffort) : null),
    `one of ${AI_SETTINGS_EFFORTS.join(", ")}`,
  );
}

export function parseAiFeatureWindows(text: string): Parse<number> {
  return parseFeatureMap(
    text,
    `{"fast-reply": 25}`,
    (raw) => (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= AI_SETTINGS_WINDOW_MAX ? raw : null),
    `a whole number of messages from 1 to ${AI_SETTINGS_WINDOW_MAX}`,
  );
}

/** The stored value, parsed; an unset or unparsable one reads as no overrides. */
export function aiFeatureSettingsOf<T>(text: string | undefined, parse: (text: string) => Parse<T>): AiFeatureSettingsMap<T> {
  if (text === undefined) return {};
  const parsed = parse(text);
  return parsed.ok ? parsed.value : {};
}
