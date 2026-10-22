import { getVoiceProfile, listVoiceProfiles, type VoiceProfileRow } from "@agency_hub_core/db";
import { isPageAllowlisted, type AppConfig, type Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";

export interface VoiceLanePage {
  id: number;
  label: string;
  platform: Platform;
}

// The platforms the voice-notes lane renders for: Fansly (both extensions) and
// OnlyFans (the chat extension over ChatSpace). The one list behind the lane's
// hint, the voice-script gate and the voice profiles, so the three never
// disagree.
const VOICE_LANE_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["fansly", "onlyfans"]);

/** Whether the voice-notes lane renders voice notes for pages of this platform. */
export function isVoiceLanePlatform(platform: Platform): boolean {
  return VOICE_LANE_PLATFORMS.has(platform);
}

/**
 * The one rule for "does the voice-notes lane serve this page": the lane
 * serves a page that fails none of its checks, each named for its refusal.
 *
 * - `platform`: the page is not of a platform the lane renders for;
 * - `disabled`: the live `voiceNotesEnabled` switch is off;
 * - `provider`: no synthesis provider was built at boot (ELEVENLABS_API_KEY
 *   and the complete service proxy);
 * - `not_allowlisted`: the page's RESOLVED label is not in the fail-closed
 *   `voiceNotesPageAllowlist`;
 * - `no_profile`: the page has no voice profile.
 *
 * Three paths ask it: the clients' hint (`loadVoiceLane`), the voice-script
 * gate and the render's admission (`checkVoiceLanePage`). Each answers a
 * refusal with its own error, in its own order of the checks.
 */
export type VoiceLaneRefusal = "platform" | "disabled" | "provider" | "not_allowlisted" | "no_profile";

/** The checks a caller orders. The profile is never among them: it is always
 *  the last check, the one that costs a query, made only for a page every
 *  other check admits. */
export type VoiceLaneSwitchCheck = Exclude<VoiceLaneRefusal, "no_profile">;

/** The live config the rule reads: the effective config, never the boot one. */
export type VoiceLaneConfig = Pick<AppConfig, "voiceNotesEnabled" | "voiceNotesPageAllowlist">;

const EVERY_SWITCH_CHECK: readonly VoiceLaneSwitchCheck[] = ["platform", "disabled", "provider", "not_allowlisted"];

function failsCheck(
  check: VoiceLaneSwitchCheck,
  app: Pick<AppContext, "voiceTtsProvider">,
  effective: VoiceLaneConfig,
  page: VoiceLanePage,
): boolean {
  switch (check) {
    case "platform":
      return !isVoiceLanePlatform(page.platform);
    case "disabled":
      return effective.voiceNotesEnabled !== true;
    case "provider":
      return app.voiceTtsProvider == null;
    case "not_allowlisted":
      return !isPageAllowlisted(effective.voiceNotesPageAllowlist, page.label);
  }
}

/** The first check of `order` the page fails, or null. */
function firstFailedCheck<C extends VoiceLaneSwitchCheck>(
  app: Pick<AppContext, "voiceTtsProvider">,
  effective: VoiceLaneConfig,
  page: VoiceLanePage,
  order: readonly C[],
): C | null {
  return order.find((check) => failsCheck(check, app, effective, page)) ?? null;
}

/** The rule's answer for one page: the first check it fails, or the profile
 *  the lane renders it with. */
export type VoiceLaneVerdict<C extends VoiceLaneSwitchCheck> =
  | { refusal: C | "no_profile"; profile: null }
  | { refusal: null; profile: VoiceProfileRow };

/**
 * The rule for one page, for the paths that act on it (the voice-script gate,
 * the render's admission): names the first check the page fails, walking the
 * caller's `order` and then the profile, or hands back the profile when the
 * lane serves the page. The profile is read only when every check of `order`
 * passed. Reads the database only (one profile); never a platform or the
 * provider.
 */
export async function checkVoiceLanePage<C extends VoiceLaneSwitchCheck>(
  app: Pick<AppContext, "db" | "voiceTtsProvider">,
  effective: VoiceLaneConfig,
  page: VoiceLanePage,
  order: readonly C[],
): Promise<VoiceLaneVerdict<C>> {
  const refusal = firstFailedCheck(app, effective, page, order);
  if (refusal !== null) {
    return { refusal, profile: null };
  }
  const profile = await getVoiceProfile(app.db, page.id);
  return profile ? { refusal: null, profile } : { refusal: "no_profile", profile: null };
}

const SERVES_NO_PAGE = (): boolean => false;

/**
 * Whether the voice-notes lane serves a page right now, as a test of a page:
 * the one rule above behind the released clients' `capabilities.voiceNotes`
 * hint on GET /api/v1/pages and the chat extension's `voice` in its bootstrap
 * (R20 HF-4б), so the two never disagree. The synthesis provider counts so
 * that no client offers a button that would answer 503
 * voice_provider_unavailable.
 *
 * A hint for the client only: `POST …/voice-notes` stays the authoritative
 * admission and re-checks the rule live. Reads the database only (the
 * effective config, then the voice profiles, those once for every page and
 * only when the lane can serve some page at all); never a platform or the
 * provider.
 */
export async function loadVoiceLane(
  app: Pick<AppContext, "db" | "config" | "voiceTtsProvider">,
): Promise<(page: VoiceLanePage) => boolean> {
  const effective = await loadEffectiveConfig(app.db, app.config);
  // A shortcut, not the rule: with the switch off, no provider or an empty
  // allowlist no page can pass, so no profile is read.
  if (
    effective.voiceNotesEnabled !== true
    || app.voiceTtsProvider == null
    || !effective.voiceNotesPageAllowlist?.split(",").some((entry) => entry.trim().length > 0)
  ) {
    return SERVES_NO_PAGE;
  }
  const profiled = new Set((await listVoiceProfiles(app.db)).map((profile) => profile.platformAccountId));
  return (page) => firstFailedCheck(app, effective, page, EVERY_SWITCH_CHECK) === null
    && profiled.has(page.id);
}
