import { narrowWebSessionAllows } from "@agency_hub_core/contracts";

import { isAgentPrincipal, type AuthPrincipal } from "./auth.ts";
import { ForbiddenError } from "./errors.ts";

/** The narrow web session's refusal: a plain 403 with no `reason`, as the narrow token's. */
export const NARROW_WEB_SESSION_REFUSAL_MESSAGE = "This sign-in opens only the team's place";

/**
 * The refusal of a route outside the narrow web session's list
 * (NARROW_WEB_SESSION_OPERATIONS), or null. Pure: the API server's onRequest
 * hook runs it beside the narrow token's check, on every route that takes a
 * principal. Only a session with `narrowDeviceTokenId` is narrowed.
 */
export function narrowWebSessionRefusal(routeKey: string, principal: AuthPrincipal | null): ForbiddenError | null {
  if (principal === null || isAgentPrincipal(principal) || principal.narrowDeviceTokenId === undefined) {
    return null;
  }
  return narrowWebSessionAllows(routeKey) ? null : new ForbiddenError(NARROW_WEB_SESSION_REFUSAL_MESSAGE);
}
