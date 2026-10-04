import type { ClientFeatureFlagName } from "@agency_hub_core/contracts";
import { findPageSummaryByLabel } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import { clientVersionRefusal } from "./client-features.ts";
import { loadClientSwitches, requireClientFeature, type ClientFeatureRequest } from "./client-switches.ts";
import { ClientFeatureDisabledError } from "./errors.ts";

/**
 * The narrow token's AI switch (chat-extension hub-pr-plan H-3, step 8): the
 * owner's chat-extension switches decide every AI generation a narrow
 * extension token asks for, before any context is loaded or quota reserved.
 *
 * - A feature with a flag of its own (Coach, Recap, Review) runs the full
 *   server-side check of that flag on the request's page (requireClientFeature:
 *   granted page, platform, master switch, flag, binding, served capabilities,
 *   minimum version).
 * - Every other feature needs the master switch on and an extension version at
 *   or above the owner's minimum (critic 6: a bad release is stopped on the
 *   hub, not only in the bootstrap).
 *
 * Refuses with 409 `client_feature_disabled` and the reason. A full device
 * token and a cookie session pass through untouched: old clients are not
 * affected.
 */

/** The AI features behind a chat-extension flag of their own. */
const CLIENT_AI_FEATURE_FLAGS: ReadonlyMap<string, ClientFeatureFlagName> = new Map([
  ["coach-chat", "coach"],
  ["fan-summary", "recap"],
  ["chat-review", "review"],
]);

export function clientAiFeatureFlag(feature: string): ClientFeatureFlagName | null {
  return CLIENT_AI_FEATURE_FLAGS.get(feature) ?? null;
}

export async function requireClientTokenAiFeature(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { feature: string; pageLabel: string },
): Promise<void> {
  if (principal.clientProfile === undefined) {
    return;
  }
  const flag = clientAiFeatureFlag(input.feature);
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
