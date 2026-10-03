import {
  CLIENT_TOKEN_PROFILES,
  clientTokenProfileAllows,
  type ClientTokenProfile,
} from "@agency_hub_core/contracts";

import { isAgentPrincipal, type AuthPrincipal } from "./auth.ts";
import { ForbiddenError } from "./errors.ts";

/**
 * The narrow device token of a client profile (chat-extension hub-pr-plan
 * H-3): what it may call and how its captures are journaled. The profile is
 * read off the token row into `HumanAuthPrincipal.clientProfile`; the request
 * never names it.
 */

/** The narrow token's refusal: a plain 403 with no `reason`, the same in both
 *  enforcement modes. A 403 never wipes a client's sign-in. */
export const CLIENT_TOKEN_ROUTE_REFUSAL_MESSAGE = "This route is not available to this client";

/**
 * The refusal of a route outside the caller's profile, or null. Pure: the API
 * server's onRequest hook runs it right after the policy verdict, in BOTH
 * `AUTH_POLICY_ENFORCEMENT` modes, since the allowlist is the whole point of
 * the token and log mode must not open it. Only a human principal with a
 * profile is narrowed: a full device token, a cookie session and an agent key
 * pass through untouched.
 */
export function clientTokenRouteRefusal(
  routeKey: string,
  principal: AuthPrincipal | null,
): ForbiddenError | null {
  if (principal === null || isAgentPrincipal(principal) || principal.clientProfile === undefined) {
    return null;
  }
  return clientTokenProfileAllows(principal.clientProfile, routeKey)
    ? null
    : new ForbiddenError(CLIENT_TOKEN_ROUTE_REFUSAL_MESSAGE);
}

/** The capture kinds a token of this profile may send; anything else refuses the whole batch. */
export function clientTokenIngestKinds(profile: ClientTokenProfile): readonly string[] {
  return CLIENT_TOKEN_PROFILES[profile].ingestKinds;
}

// The header a profile's client names its version with, as the capture lane's
// producer rule spells it: H-12a's `ingestProducerForClientVersion` maps the
// same /^chat-extension\/(.+)$/ to `chat-extension@$1` for a full token.
const PROFILE_CLIENT_VERSION: Record<ClientTokenProfile, RegExp> = {
  "chat-extension": /^chat-extension\/(.+)$/,
};

/**
 * The producer a narrow token's captures journal under: decided by the
 * profile, not by the header. `<profile>@<v>` for an `x-client-version` of
 * `<profile>/<v>` (v as sent, any length), otherwise `<profile>@unknown`.
 * On a `chat-extension/<v>` header this is exactly the stamp H-12a gives a full
 * token (branch client/ingest-producer-chat-extension), so one client's facts
 * never split across two producers. tests/client-token-scopes.test.ts holds the
 * two equal as soon as both are on main, in either merge order; the second to
 * land then makes this delegate to that rule, leaving one implementation.
 */
export function clientTokenIngestProducer(profile: ClientTokenProfile, clientVersion: string | null): string {
  const version = clientVersion === null ? undefined : PROFILE_CLIENT_VERSION[profile].exec(clientVersion)?.[1];
  return version === undefined ? `${profile}@unknown` : `${profile}@${version}`;
}
