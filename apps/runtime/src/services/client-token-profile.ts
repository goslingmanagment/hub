import {
  CLIENT_TOKEN_PROFILES,
  clientTokenProfileAllows,
  type ClientTokenProfile,
  type RouteAuthPolicy,
} from "@agency_hub_core/contracts";

import { isAgentPrincipal, type AuthPrincipal } from "./auth.ts";
import { ForbiddenError } from "./errors.ts";

/**
 * The narrow device token of a client profile (chat-extension hub-pr-plan
 * H-3): what it may call and how its captures are journaled. The profile is
 * read off the token row into `HumanAuthPrincipal.clientProfile`; the request
 * never names it.
 */

/** Route kinds that take no principal: a narrow token's allowlist does not apply. */
const NO_PRINCIPAL_KINDS: ReadonlySet<RouteAuthPolicy["kind"]> = new Set(["public", "hmac", "pending-device-token"]);

/** Whether the allowlist is checked on a route of this kind. */
export function clientTokenAllowlistApplies(auth: RouteAuthPolicy): boolean {
  return !NO_PRINCIPAL_KINDS.has(auth.kind);
}

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

const MAX_PRODUCER_VERSION_LENGTH = 64;

/**
 * The producer a narrow token's captures journal under: decided by the
 * profile, not by the header. `<profile>@<version>`, the version taken from an
 * `x-client-version` of `<profile>/<version>`, otherwise `unknown`. (The same
 * stamp the header lane gives `chat-extension/<v>`, so one client's facts never
 * split across two producers.)
 */
export function clientTokenIngestProducer(profile: ClientTokenProfile, clientVersion: string | null): string {
  const prefix = `${profile}/`;
  const version = clientVersion?.startsWith(prefix) ? clientVersion.slice(prefix.length).trim() : "";
  return version.length > 0 && version.length <= MAX_PRODUCER_VERSION_LENGTH
    ? `${profile}@${version}`
    : `${profile}@unknown`;
}
