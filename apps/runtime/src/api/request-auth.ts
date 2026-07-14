import { timingSafeEqual } from "node:crypto";

import type { AppContext } from "../bootstrap.ts";
import {
  SESSION_COOKIE_NAME,
  authenticateBearerToken,
  authenticatePendingDeviceTokenForActivation,
  authenticateSessionToken,
  requireDashboardUser,
  type AuthPrincipal,
  type PendingDeviceTokenActivationCredential,
} from "../services/auth.ts";
import { UnauthorizedError } from "../services/errors.ts";

// Kernel Stage 19 module extraction: the request-level principal helpers that
// every API module shares, factored out of the buildApiServer closure verbatim.
// One instance per server; request.auth memoizes resolution per request.

export interface PrincipalRequest {
  auth?: AuthPrincipal | null;
  pendingDeviceTokenAuth?: PendingDeviceTokenActivationCredential | null;
  headers: Record<string, string | string[] | undefined>;
  cookies: Record<string, string | undefined>;
}

function bearerToken(request: PrincipalRequest): string | null {
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string"
    ? /^bearer\s+(.+)$/i.exec(authorization)
    : null;
  const token = match?.[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
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

    const token = bearerToken(request);
    if (token !== null) {
      // Stage 22: prefix-discriminated — agency_hub_core_ api keys and
      // agency_hub_device_ device tokens are both first-class bearers.
      request.auth = await authenticateBearerToken(appContext, token);
      return request.auth;
    }

    const sessionToken = request.cookies[SESSION_COOKIE_NAME];
    request.auth = sessionToken
      ? await authenticateSessionToken(appContext, sessionToken)
      : null;
    return request.auth;
  }

  async function resolvePendingDeviceToken(request: PrincipalRequest) {
    if (request.pendingDeviceTokenAuth !== undefined) {
      return request.pendingDeviceTokenAuth;
    }
    const token = bearerToken(request);
    request.pendingDeviceTokenAuth = token === null
      ? null
      : await authenticatePendingDeviceTokenForActivation(appContext, token);
    return request.pendingDeviceTokenAuth;
  }

  async function requirePendingDeviceToken(request: PrincipalRequest) {
    const credential = await resolvePendingDeviceToken(request);
    if (credential === null) {
      throw new UnauthorizedError("Pending device-token bearer required");
    }
    return credential;
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
    resolvePendingDeviceToken,
    requirePrincipal,
    requirePendingDeviceToken,
    hasValidSyncHealthMonitoringToken,
    requireSyncHealthAccess,
    pageScopeFor,
  };
}

export type RequestAuth = ReturnType<typeof createRequestAuth>;
