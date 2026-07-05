import { timingSafeEqual } from "node:crypto";

import type { AppContext } from "../bootstrap.ts";
import {
  SESSION_COOKIE_NAME,
  authenticateBearerToken,
  authenticateSessionToken,
  requireDashboardUser,
  type AuthPrincipal,
} from "../services/auth.ts";
import { UnauthorizedError } from "../services/errors.ts";

// Kernel Stage 19 module extraction: the request-level principal helpers that
// every API module shares, factored out of the buildApiServer closure verbatim.
// One instance per server; request.auth memoizes resolution per request.

export interface PrincipalRequest {
  auth?: AuthPrincipal | null;
  headers: Record<string, string | string[] | undefined>;
  cookies: Record<string, string | undefined>;
}

export function pageScopeFor(principal: AuthPrincipal) {
  return principal.user.role === "owner" ? undefined : principal.assignedPageIds;
}

/** Audit attribution for admin mutations issued through the API. */
export const auditCtx = (principal: AuthPrincipal) => ({
  source: "api" as const,
  actorUserId: principal.user.id,
});

function safeStringEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createRequestAuth(appContext: AppContext) {
  async function resolvePrincipal(request: PrincipalRequest) {
    if (request.auth !== undefined) {
      return request.auth;
    }

    const authorization = request.headers.authorization;
    const bearerMatch = typeof authorization === "string"
      ? /^bearer\s+(.+)$/i.exec(authorization)
      : null;
    if (bearerMatch) {
      const token = bearerMatch[1]?.trim() ?? "";
      // Stage 22: prefix-discriminated — agency_hub_core_ api keys and
      // agency_hub_device_ device tokens are both first-class bearers.
      request.auth = token ? await authenticateBearerToken(appContext, token) : null;
      return request.auth;
    }

    const sessionToken = request.cookies[SESSION_COOKIE_NAME];
    request.auth = sessionToken
      ? await authenticateSessionToken(appContext, sessionToken)
      : null;
    return request.auth;
  }

  async function requirePrincipal(request: PrincipalRequest) {
    const principal = await resolvePrincipal(request);
    if (!principal) {
      throw new UnauthorizedError();
    }
    return principal;
  }

  function hasValidSyncHealthMonitoringToken(request: {
    headers: Record<string, string | string[] | undefined>;
  }) {
    const configuredToken = appContext.config.healthSyncMonitoringToken;
    if (!configuredToken) {
      return false;
    }

    const token = request.headers["x-monitoring-token"];
    return typeof token === "string" && safeStringEquals(token, configuredToken);
  }

  async function requireSyncHealthAccess(request: PrincipalRequest) {
    if (hasValidSyncHealthMonitoringToken(request)) {
      return {};
    }

    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return {
      pageIds: pageScopeFor(principal),
    };
  }

  return {
    resolvePrincipal,
    requirePrincipal,
    hasValidSyncHealthMonitoringToken,
    requireSyncHealthAccess,
    pageScopeFor,
  };
}

export type RequestAuth = ReturnType<typeof createRequestAuth>;
