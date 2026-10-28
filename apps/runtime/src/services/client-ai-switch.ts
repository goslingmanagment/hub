import type { ClientFeatureFlagName } from "@agency_hub_core/contracts";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { aiFeatureRunsOnPlatform } from "./ai-platform-features.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import { clientFeatureExistsOn, clientVersionRefusal } from "./client-features.ts";
import { loadClientSwitches, requireClientFeatureOnLabel, type ClientFeatureRequest } from "./client-switches.ts";
import { ClientFeatureDisabledError } from "./errors.ts";

/**
 * The narrow token's AI switch (chat-extension hub-pr-plan H-3, step 8): the
 * owner's chat-extension switches decide every AI generation a narrow
 * extension token asks for, before any context is loaded or quota reserved.
 *
 * - A feature with a flag of its own runs the full server-side check of that
 *   flag on the request's page (requireClientFeature: granted page, master
 *   switch, platform, flag, binding, served capabilities, minimum version):
 *   Coach, Recap, Review and the notes fill (`notesFill`) everywhere; on
 *   Fansly (R20 HF-12) also Reply, Fix, Hi and Ping (`drafts`) and the voice
 *   script (`voice`).
 * - Every other feature needs the master switch on and an extension version at
 *   or above the owner's minimum (critic 6: a bad release is stopped on the
 *   hub, not only in the bootstrap). On OnlyFans that is still Reply, Fix, Hi,
 *   Ping and the voice script: their Fansly flags do not exist there; and Help.
 * - A feature the extension does not have on the platform is refused
 *   `platform_unsupported` after the master switch: Help on Fansly
 *   (R20 HF-2; the owner removed it from the extension's Fansly site).
 * - A feature the platform's pages do not run at all is refused
 *   `platform_unsupported` before anything else (ai-platform-features.ts):
 *   on Telegram everything but Reply, Fix and Coach.
 *
 * Which of the two a feature takes depends on the platform the request names
 * (`body.platform`): the feature route refuses, before any context load, a
 * body whose platform is not the page's own (features/index.ts, the access
 * check; the gateway checks it again), so naming the other platform gets a
 * Fansly page nothing.
 *
 * Checked once, when the generation is asked for: an owner's change while it
 * streams holds from the next request, and the generation already under way
 * finishes as admitted.
 *
 * Refuses with 409 `client_feature_disabled` and the reason. A full device
 * token and a cookie session pass through untouched: old clients are not
 * affected.
 */

/** The AI features behind a chat-extension flag of their own, on every platform. */
const CLIENT_AI_FEATURE_FLAGS: ReadonlyMap<string, ClientFeatureFlagName> = new Map([
  ["coach-chat", "coach"],
  ["fan-summary", "recap"],
  ["chat-review", "review"],
  // On OnlyFans since 2026-10-28, with the notes the extension keeps in OnlyMonster.
  ["fan-notes-fill", "notesFill"],
]);

/**
 * The AI features behind a flag of their own only on the platforms where that
 * flag exists (CLIENT_FEATURE_REQUIREMENTS): Fansly (R20 HF-12). Elsewhere they
 * keep the master switch and the version.
 */
const CLIENT_AI_PLATFORM_FEATURE_FLAGS: ReadonlyMap<string, ClientFeatureFlagName> = new Map([
  ["fast-reply", "drafts"],
  ["improve-draft", "drafts"],
  ["hi-greeting", "drafts"],
  ["ping", "drafts"],
  ["voice-script", "voice"],
]);

/**
 * The narrow token's AI features with no flag of their own, by the platforms
 * the extension has them on; a feature not listed is on every platform. Help
 * is the extension's on OnlyFans only: the owner removed it from the Fansly
 * site (chat-extension R20 spec «Help — убран владельцем», HF-2). A full
 * device token (the released Fansly extension, the desktop) keeps it: this
 * switch never asks one.
 */
const CLIENT_AI_UNFLAGGED_FEATURE_PLATFORMS: ReadonlyMap<string, readonly Platform[]> = new Map([
  ["help-me", ["onlyfans"]],
]);

/** Whether the extension has this AI feature on this platform at all (asked after the master switch). */
export function clientAiFeatureExistsOn(feature: string, platform: Platform): boolean {
  return CLIENT_AI_UNFLAGGED_FEATURE_PLATFORMS.get(feature)?.includes(platform) ?? true;
}

/** The flag that decides a narrow token's generation of this feature on this
 *  platform; null when only the master switch and the version do. */
export function clientAiFeatureFlag(feature: string, platform: Platform): ClientFeatureFlagName | null {
  const flag = CLIENT_AI_FEATURE_FLAGS.get(feature);
  if (flag !== undefined) {
    return flag;
  }
  const platformFlag = CLIENT_AI_PLATFORM_FEATURE_FLAGS.get(feature);
  return platformFlag !== undefined && clientFeatureExistsOn(platformFlag, platform) ? platformFlag : null;
}

export async function requireClientTokenAiFeature(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { feature: string; pageLabel: string; platform: Platform },
): Promise<void> {
  if (principal.clientProfile === undefined) {
    return;
  }
  if (!aiFeatureRunsOnPlatform(input.feature, input.platform)) {
    throw new ClientFeatureDisabledError(input.feature, "platform_unsupported");
  }
  const flag = clientAiFeatureFlag(input.feature, input.platform);
  if (flag !== null) {
    // A missing page answers like one not granted: the refusal reveals nothing.
    await requireClientFeatureOnLabel(app, request, principal, input.pageLabel, flag);
    return;
  }
  const switches = await loadClientSwitches(app);
  if (!switches.settings.enabled) {
    throw new ClientFeatureDisabledError(input.feature, "disabled");
  }
  if (!clientAiFeatureExistsOn(input.feature, input.platform)) {
    throw new ClientFeatureDisabledError(input.feature, "platform_unsupported");
  }
  const outdated = clientVersionRefusal(switches.minVersion, request.headers["x-client-version"]);
  if (outdated !== null) {
    throw new ClientFeatureDisabledError(input.feature, outdated);
  }
}
