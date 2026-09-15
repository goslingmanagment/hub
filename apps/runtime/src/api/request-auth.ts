import { timingSafeEqual } from "node:crypto";

import type { AppContext } from "../bootstrap.ts";
import {
  SESSION_COOKIE_NAME,
  authenticateBearerCredential,
  authenticatePendingDeviceTokenForActivation,
  authenticateSessionToken,
  isAgentPrincipal,
  normalizeClientVersionHeader,
  requireAgentPrincipal,
  requireDashboardUser,
  requireHumanPrincipal,
  type AgentAuthPrincipal,
  type AuthFailure,
  type AuthPrincipal,
  type HumanAuthPrincipal,
  type PendingDeviceTokenActivationCredential,
} from "../services/auth.ts";
import { UnauthorizedError } from "../services/errors.ts";

// Kernel Stage 19 module extraction: the request-level principal helpers that
// every API module shares, factored out of the buildApiServer closure verbatim.
// One instance per server; request.auth memoizes resolution per request.

export interface PrincipalRequest {
  auth?: AuthPrincipal | null;
  /** Decision 347 §4.5: why the presented device token was refused, kept
   * BESIDE the memoized null principal so the 401 can carry a reason. */
  authFailure?: AuthFailure | null;
  pendingDeviceTokenAuth?: PendingDeviceTokenActivationCredential | null;
  headers: Record<string, string | string[] | undefined>;
  cookies: Record<string, string | undefined>;
}

/** The 401 for a request whose principal did not resolve, with the structured
 * reason when the device-token lane recorded one. */
export function unauthorizedFor(request: Pick<PrincipalRequest, "authFailure">) {
  return new UnauthorizedError(undefined, { reason: request.authFailure?.reason ?? null });
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
  // `undefined` means "no filter at all" (owner-everything), so the agent branch
  // comes first and always returns a LIST: an agent key sees its grant, and a key
  // granted nothing sees nothing — never everything.
  if (isAgentPrincipal(principal)) {
    return principal.pageIds;
  }
  return principal.user.role === "owner" ? undefined : principal.assignedPageIds;
}

/**
 * The page filter for an AGENT request: what the request asked for, intersected
 * with what the key was granted.
 *
 * `platformRollupScopeFor` deliberately returns `requestedPageIds` bare — it is
 * safe today only because page-scoped handlers pass `[page.id]` AFTER
 * `canAccessPage` has already approved that page. Agent operations take page
 * lists straight from the request, so they intersect HERE. An empty intersection
 * is returned as an empty list and the caller must treat it as "no rows": handing
 * `[]` to a repository that reads "no ids" as "no filter" is exactly how a scope
 * clamp turns into an unfiltered read.
 */
export function agentScopeFor(
  principal: AgentAuthPrincipal,
  requestedPageIds: readonly number[] | undefined,
): number[] {
  const granted = new Set(principal.pageIds);
  if (requestedPageIds === undefined) {
    return [...granted];
  }
  return requestedPageIds.filter((pageId) => granted.has(pageId));
}

/**
 * Page filter for CROSS-PAGE rollups served on a page-scoped route.
 *
 * `pageScopeFor` answers "which pages may this principal see at all", and for an
 * owner that is `undefined` — no filter at all. That is right for a dashboard
 * session and wrong for a bearer: an owner-role device token asking about ONE
 * page still got platform-wide money in the response body, because the rollup
 * query was handed `undefined`. The scope check guards the request shape; this
 * guards the response body.
 *
 * Cookie sessions keep the full visible-platform view; every bearer is clamped
 * to the pages the request actually named.
 *
 * HUMAN principals only, by type. The behavior is unchanged, but an agent key
 * would land in the bare `requestedPageIds` branch — no intersection with its
 * grant and no compile error to warn whoever wrote the handler. Agent-plane
 * operations take `agentScopeFor` instead, and the compiler now says so.
 */
export function platformRollupScopeFor(principal: HumanAuthPrincipal, requestedPageIds: number[]) {
  return principal.authMethod === "session" ? pageScopeFor(principal) : requestedPageIds;
}

/**
 * Audit attribution for admin mutations issued through the API.
 *
 * An agent key has no row in `users`, so it attributes to its key id under its
 * own source instead of borrowing the owner who issued it. (No mutation route
 * admits an agent principal today; the variant exists so that adding one cannot
 * silently file the agent's action under a human.)
 */
export const auditCtx = (principal: AuthPrincipal) => (
  isAgentPrincipal(principal)
    ? {
      source: "agent_key" as const,
      actorUserId: null,
      actorAgentKeyId: principal.agentKeyId,
    }
    : {
      source: "api" as const,
      actorUserId: principal.user.id,
    }
);

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
      // agency_hub_device_ device tokens are both first-class bearers. The
      // client version rides along so the device-token lane can stamp it (Р7).
      const result = await authenticateBearerCredential(appContext, token, {
        clientVersion: normalizeClientVersionHeader(request.headers["x-client-version"]),
      });
      request.auth = result.principal;
      request.authFailure = result.failure;
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

  /**
   * The handler-facing principal of every route that predates the agent plane.
   *
   * It refuses an agent key HERE, at the boundary, rather than route by route:
   * the declarative policy denies agent keys too, but only in `enforce` mode,
   * and the dual-layer law (#143) requires the isolation property to hold with
   * the middleware in `log` mode as well. The narrowed return type is the other
   * half — a handler cannot read `.user` off a principal that might be an agent.
   */
  async function requirePrincipal(request: PrincipalRequest): Promise<HumanAuthPrincipal> {
    const principal = await resolvePrincipal(request);
    if (!principal) {
      throw unauthorizedFor(request);
    }
    requireHumanPrincipal(principal);
    return principal;
  }

  /** The agent-plane counterpart: slice A's operations resolve through this one. */
  async function requireAgentKeyPrincipal(request: PrincipalRequest): Promise<AgentAuthPrincipal> {
    const principal = await resolvePrincipal(request);
    if (!principal) {
      throw unauthorizedFor(request);
    }
    requireAgentPrincipal(principal);
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
    requireAgentKeyPrincipal,
    requirePendingDeviceToken,
    hasValidSyncHealthMonitoringToken,
    requireSyncHealthAccess,
    pageScopeFor,
  };
}

export type RequestAuth = ReturnType<typeof createRequestAuth>;
