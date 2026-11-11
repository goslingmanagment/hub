import type { ClientFanBadgesBody, ClientFanBadgesResponse } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";

export const FAN_BADGES_FEATURE = "fan-badges";

// PLACEHOLDER: the contract commit only registers the route; the implementation replaces this body.
export async function recordClientFanBadges(
  _app: AppContext,
  _request: { headers: Record<string, string | string[] | undefined> },
  _principal: HumanAuthPrincipal,
  _input: { pageLabel: string; body: ClientFanBadgesBody },
): Promise<ClientFanBadgesResponse> {
  throw new Error("clientFanBadges is not implemented yet");
}
