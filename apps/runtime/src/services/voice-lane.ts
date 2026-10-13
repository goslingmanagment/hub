import { listVoiceProfiles } from "@agency_hub_core/db";
import { isPageAllowlisted, type Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";

export interface VoiceLanePage {
  id: number;
  label: string;
  platform: Platform;
}

// Capability membership, not a new platform branch: voice is Fansly-only for
// this pilot, and the platform-branch ratchet keeps dispatch logic centralized.
const VOICE_LANE_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["fansly"]);

const SERVES_NO_PAGE = (): boolean => false;

/**
 * Whether the voice-notes lane serves a page right now, as a test of a page:
 * the one rule behind the released clients' `capabilities.voiceNotes` hint on
 * GET /api/v1/pages and the chat extension's `voice` in its bootstrap (R20
 * HF-4б), so the two never disagree.
 *
 * All five hold: the live `voiceNotesEnabled` switch is on; the synthesis
 * provider was built at boot (ELEVENLABS_API_KEY and the complete service
 * proxy), so no client offers a button that would answer 503
 * voice_provider_unavailable; the page is in the fail-closed
 * `voiceNotesPageAllowlist`; the page has a voice profile; and the page is of a
 * platform the lane renders for.
 *
 * A hint for the client only: `POST …/voice-notes` stays the authoritative
 * admission and re-checks each of them live. Reads the database only (the
 * effective config, then the voice profiles, those only when the lane can
 * serve some page at all); never a platform or the provider.
 */
export async function loadVoiceLane(
  app: Pick<AppContext, "db" | "config" | "voiceTtsProvider">,
): Promise<(page: VoiceLanePage) => boolean> {
  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.voiceNotesEnabled !== true || app.voiceTtsProvider == null) {
    return SERVES_NO_PAGE;
  }
  const allowlist = effective.voiceNotesPageAllowlist;
  if (!allowlist?.split(",").some((entry) => entry.trim().length > 0)) {
    return SERVES_NO_PAGE;
  }
  const profiled = new Set((await listVoiceProfiles(app.db)).map((profile) => profile.platformAccountId));
  return (page) => VOICE_LANE_PLATFORMS.has(page.platform)
    && isPageAllowlisted(allowlist, page.label)
    && profiled.has(page.id);
}
