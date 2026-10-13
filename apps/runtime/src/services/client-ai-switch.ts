import type { ClientFeatureFlagName } from "@agency_hub_core/contracts";
import { findPageSummaryByLabel } from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import { clientFeatureExistsOn, clientVersionRefusal } from "./client-features.ts";
import { loadClientSwitches, requireClientFeature, type ClientFeatureRequest } from "./client-switches.ts";
import { ClientFeatureDisabledError } from "./errors.ts";

/**
 * The narrow token's AI switch (chat-extension hub-pr-plan H-3, step 8): the
 * owner's chat-extension switches decide every AI generation a narrow
 * extension token asks for, before any context is loaded or quota reserved.
 *
 * - A feature with a flag of its own runs the full server-side check of that
 *   flag on the request's page (requireClientFeature: granted page, platform,
 *   master switch, flag, binding, served capabilities, minimum version):
 *   Coach, Recap and Review everywhere; on Fansly (R20 HF-12) also Reply, Fix,
 *   Hi and Ping (`drafts`), the voice script (`voice`) and the notes fill
 *   (`notesFill`).
 * - Every other feature needs the master switch on and an extension version at
 *   or above the owner's minimum (critic 6: a bad release is stopped on the
 *   hub, not only in the bootstrap). On OnlyFans that is still Reply, Fix, Hi,
 *   Ping, the voice script and the notes fill: their Fansly flags do not exist
 *   there.
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
  ["fan-notes-fill", "notesFill"],
]);

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
  const flag = clientAiFeatureFlag(input.feature, input.platform);
  if (flag !== null) {
    const page = await findPageSummaryByLabel(app.db, input.pageLabel);
    if (!page) {
      // A missing page answers like one not granted: the refusal reveals nothing.
      throw new ClientFeatureDisabledError(flag, "not_granted");
    }
    await requireClientFeature(app, request, principal, { id: page.id }, flag);
    return;
  }
  const switches = await loadClientSwitches(app);
  if (!switches.settings.enabled) {
    throw new ClientFeatureDisabledError(input.feature, "disabled");
  }
  const outdated = clientVersionRefusal(switches.minVersion, request.headers["x-client-version"]);
  if (outdated !== null) {
    throw new ClientFeatureDisabledError(input.feature, outdated);
  }
}
