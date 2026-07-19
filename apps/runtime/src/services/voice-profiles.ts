import {
  clearVoiceProfile,
  findPageByLabel,
  getVoiceProfile,
  upsertVoiceProfile,
  type VoiceProfileRow,
  type VoiceProfileSettings,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";

// The page voice profile carries the DB defaults; the CLI/service apply the
// same fallbacks so an omitted flag lands the documented default instead of
// undefined. Kept in one place so set() and any future caller agree.
const DEFAULT_VOICE_MODEL = "eleven_v3";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

/**
 * ElevenLabs `voice_settings.stability` is a NUMBER in [0, 1] (per the official
 * voice-settings schema); the CLI/UX speaks in named presets. Map the presets to
 * their numeric value here — in the service layer, so EVERY caller stores the
 * number and the provider never ships a string ElevenLabs would 422. Matched
 * case-insensitively.
 */
const STABILITY_PRESETS: Record<string, number> = {
  natural: 0.5,
  creative: 0.3,
  robust: 0.8,
};

/**
 * Resolve a caller-supplied stability (a preset name or a numeric string) to the
 * stored NUMBER. A numeric string is parsed and range-checked to [0, 1]; a preset
 * is looked up case-insensitively; anything else is rejected with a clear message.
 */
function resolveStability(raw: string): number {
  // Own-property guard: STABILITY_PRESETS is a plain object, so a bare lookup
  // walks the prototype chain — "constructor"/"toString" would return inherited
  // functions and "__proto__" the prototype object, each `!== undefined`, so the
  // value would be accepted (and later serialized to a broken `{}` /
  // `{"stability":{}}`) instead of the BadRequest this function promises.
  const key = raw.toLowerCase();
  const preset = Object.hasOwn(STABILITY_PRESETS, key) ? STABILITY_PRESETS[key] : undefined;
  if (preset !== undefined) {
    return preset;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 1) {
    return numeric;
  }
  throw new BadRequestError(
    `stability "${raw}" is invalid; use a preset (`
      + `${Object.keys(STABILITY_PRESETS).join(", ")}) or a number between 0 and 1`,
  );
}

/**
 * The ONLY output formats a profile may pin. The audio download route serves a
 * hardcoded `audio/mpeg` content-type with `nosniff`, so a non-MP3 ElevenLabs
 * format (pcm_*, ulaw_*, opus_*) would be mislabelled and fail to decode. This
 * allowlist is what makes that constant honest — reject anything else at set
 * time. Kept next to the default so callers and the route agree on one list.
 */
export const VOICE_OUTPUT_FORMAT_ALLOWLIST = [
  "mp3_22050_32",
  "mp3_24000_48",
  "mp3_44100_32",
  "mp3_44100_64",
  "mp3_44100_96",
  "mp3_44100_128",
  "mp3_44100_192",
] as const;

export interface SetVoiceProfileInput {
  voiceId: string;
  model?: string;
  /**
   * ElevenLabs stability as a named preset ("natural"/"creative"/"robust") or a
   * numeric string in [0, 1]; resolved to a NUMBER and stored under
   * `settings.stability`. Omitted (or empty) → an empty settings blob.
   */
  stability?: string;
  outputFormat?: string;
}

/**
 * Voice notes are Fansly-only, so every voice-profile operation resolves the
 * page through the label and refuses anything that is not an active Fansly
 * page. Returns the resolved page row (id + platform) for the caller.
 */
async function resolveFanslyPage(app: Pick<AppContext, "db">, pageLabel: string) {
  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored) {
    throw new NotFoundError(`Page "${pageLabel}" not found`);
  }
  if (stored.page.platform !== "fansly") {
    throw new BadRequestError(
      `Page "${stored.page.label}" is not a Fansly page: voice notes are Fansly-only`,
    );
  }
  return stored.page;
}

/**
 * Upserts the page's ElevenLabs voice binding and returns the resulting
 * version (which auto-increments on every subsequent set). No provider call is
 * made here — this only records config the render lane later pins against.
 */
export async function setVoiceProfile(
  app: Pick<AppContext, "db">,
  pageLabel: string,
  input: SetVoiceProfileInput,
): Promise<{ version: number }> {
  const page = await resolveFanslyPage(app, pageLabel);

  const voiceId = input.voiceId?.trim();
  if (!voiceId) {
    throw new BadRequestError("voice-id must be a non-empty value");
  }

  const stabilityRaw = input.stability?.trim();
  const settings: VoiceProfileSettings = stabilityRaw
    ? { stability: resolveStability(stabilityRaw) }
    : {};

  const outputFormat = input.outputFormat?.trim() || DEFAULT_OUTPUT_FORMAT;
  if (!(VOICE_OUTPUT_FORMAT_ALLOWLIST as readonly string[]).includes(outputFormat)) {
    throw new BadRequestError(
      `output-format "${outputFormat}" is not supported; voice notes are served as `
        + `audio/mpeg, so only MP3 formats are allowed: `
        + VOICE_OUTPUT_FORMAT_ALLOWLIST.join(", "),
    );
  }

  const { version } = await upsertVoiceProfile(app.db, {
    platformAccountId: page.id,
    voiceId,
    model: input.model?.trim() || DEFAULT_VOICE_MODEL,
    settings,
    outputFormat,
  });

  return { version };
}

/**
 * Returns the page's voice binding, or null when none is configured. The row is
 * pure config (voice id, model, output format, settings, version) — it carries
 * no credential, so it is safe to display in full.
 */
export async function showVoiceProfile(
  app: Pick<AppContext, "db">,
  pageLabel: string,
): Promise<VoiceProfileRow | null> {
  const page = await resolveFanslyPage(app, pageLabel);
  return getVoiceProfile(app.db, page.id);
}

/** Removes the page's voice binding; a no-op when none exists. */
export async function removeVoiceProfile(
  app: Pick<AppContext, "db">,
  pageLabel: string,
): Promise<void> {
  const page = await resolveFanslyPage(app, pageLabel);
  await clearVoiceProfile(app.db, page.id);
}
