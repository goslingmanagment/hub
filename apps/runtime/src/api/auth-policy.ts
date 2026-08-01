import { routeSchemas, type RouteAuthPolicy } from "@agency_hub_core/contracts";

import { AppError } from "../services/errors.ts";
import {
  isAgentPrincipal,
  requireAgentPrincipal,
  requireApiKeyUser,
  requireDashboardUser,
  requireDeviceTokenUser,
  requireHumanPrincipal,
  requireOwner,
  requireSessionUser,
  type AuthPrincipal,
} from "../services/auth.ts";

// Kernel Stage 19: one declarative policy per route, one middleware verdict per
// request. The verdict is computed by running the SAME legacy guard functions the
// handlers call today (requireDashboardUser/requireOwner/requireApiKeyUser and the
// findPageSummaryByLabel→canAccessPage page-scope shape), so declared decisions
// match in-handler decisions by construction, not by re-implementation.

export type AuthPolicyVerdict =
  | { allow: true }
  | { allow: false; statusCode: 401 | 403 | 404; reason: string };

export interface RoutePolicyEntry {
  key: string;
  auth: RouteAuthPolicy | null;
}

export interface RoutePolicyTableRow {
  method: string;
  url: string;
  routeKey: string;
  auth: RouteAuthPolicy | null;
}

/**
 * Schema-object-identity index: server.ts registers every route with
 * `schema: routeSchemas.X`, so `request.routeOptions.schema` is the exact object
 * stored here (the same identity join `contracts/generate.ts` relies on).
 */
export function buildRoutePolicyIndex(): ReadonlyMap<unknown, RoutePolicyEntry> {
  const index = new Map<unknown, RoutePolicyEntry>();
  for (const [key, schema] of Object.entries(routeSchemas)) {
    const auth = (schema as { auth?: RouteAuthPolicy }).auth ?? null;
    index.set(schema, { key, auth });
  }
  return index;
}

const ALLOW: AuthPolicyVerdict = { allow: true };

function guardVerdict(guard: () => void, reason: string): AuthPolicyVerdict {
  try {
    guard();
    return ALLOW;
  } catch (error) {
    if (error instanceof AppError && (error.statusCode === 401 || error.statusCode === 403)) {
      return { allow: false, statusCode: error.statusCode, reason };
    }
    throw error;
  }
}

export type PageAccessResolution = "ok" | "not-found" | "denied";

export interface AuthPolicyEvaluationInput {
  auth: RouteAuthPolicy;
  /** Memoized upstream (request.auth), so repeated calls are free. */
  resolvePrincipal: () => Promise<AuthPrincipal | null>;
  /** Specialized non-principal check used only by the activation route. */
  resolvePendingDeviceToken: () => Promise<boolean>;
  /** The x-monitoring-token check (timing-safe, config-gated). */
  hasMonitoringToken: () => boolean;
  /** findPageSummaryByLabel + canAccessPage, exactly the handlers' shape. */
  resolvePageAccess: (pageLabel: string) => Promise<PageAccessResolution>;
  /** Raw :pageLabel path param when the matched route declares one. */
  pageLabelParam: string | undefined;
}

export async function computeAuthPolicyVerdict(
  input: AuthPolicyEvaluationInput,
): Promise<AuthPolicyVerdict> {
  const { auth } = input;

  // No-principal kinds first: the webhook authenticates in-handler by HMAC over
  // the raw body; public routes take no principal. Neither resolves a session or
  // bearer key here.
  if (auth.kind === "public" || auth.kind === "hmac") {
    return ALLOW;
  }
  if (auth.kind === "monitoring" && input.hasMonitoringToken()) {
    return ALLOW;
  }
  if (auth.kind === "pending-device-token") {
    return await input.resolvePendingDeviceToken()
      ? ALLOW
      : { allow: false, statusCode: 401, reason: "pending_device_token_required" };
  }

  const principal = await input.resolvePrincipal();
  if (!principal) {
    return { allow: false, statusCode: 401, reason: "no_principal" };
  }

  let kindVerdict: AuthPolicyVerdict;
  switch (auth.kind) {
    case "monitoring":
    case "session":
      kindVerdict = guardVerdict(() => requireDashboardUser(principal), "dashboard_session_required");
      break;
    case "any-session":
      kindVerdict = guardVerdict(() => requireSessionUser(principal), "session_required");
      break;
    case "owner-session":
      kindVerdict = guardVerdict(() => requireOwner(principal), "owner_session_required");
      break;
    case "apiKey":
      kindVerdict = guardVerdict(() => requireApiKeyUser(principal), "api_key_required");
      break;
    case "device-token":
      kindVerdict = guardVerdict(() => requireDeviceTokenUser(principal), "device_token_required");
      break;
    case "agentKey":
      // The agent plane is one-way: this kind admits agent keys and nothing else.
      kindVerdict = guardVerdict(() => requireAgentPrincipal(principal), "agent_key_required");
      break;
    case "any":
      // "any" is an ALLOWLIST of the pre-agent authentication methods, not a
      // wildcard. Every kind above already refuses an agent key by its own
      // authMethod check; this is the one that used to let everything through.
      kindVerdict = guardVerdict(() => requireHumanPrincipal(principal), "agent_key_not_admitted");
      break;
  }
  if (!kindVerdict.allow) {
    return kindVerdict;
  }

  // `roles` names HUMAN roles; an agent key has none and can never satisfy one.
  // (Unreachable while `agentKey` is the only kind an agent passes and carries no
  // roles — the check is written so that adding roles there cannot open a hole.)
  if (auth.roles && (isAgentPrincipal(principal) || !auth.roles.includes(principal.user.role))) {
    return { allow: false, statusCode: 403, reason: "role_not_allowed" };
  }

  if (auth.scope === "page" && typeof input.pageLabelParam === "string") {
    const access = await input.resolvePageAccess(input.pageLabelParam);
    // Existence-oracle law (spec §5.6): for an AGENT principal, "this page is not
    // yours" and "there is no such page" must be the same answer. A 403 here would
    // let a key enumerate the agency's page labels through the middleware, before
    // any handler runs. Human principals keep today's 403/404 distinction — the
    // dashboard's own error messages depend on it.
    if (access === "not-found" || (access === "denied" && isAgentPrincipal(principal))) {
      return { allow: false, statusCode: 404, reason: "page_not_found" };
    }
    if (access === "denied") {
      return { allow: false, statusCode: 403, reason: "page_access_denied" };
    }
  }

  return ALLOW;
}

/**
 * Log-window classifier: the middleware verdict against what the legacy guards
 * actually answered. Divergence in either direction is reviewed during the 48 h
 * observation window before AUTH_POLICY_ENFORCEMENT flips to enforce.
 */
export function classifyAuthPolicyDivergence(
  verdict: AuthPolicyVerdict,
  responseStatusCode: number,
): "would-deny" | "would-allow" | null {
  if (!verdict.allow && responseStatusCode < 400) {
    return "would-deny";
  }
  if (verdict.allow && (responseStatusCode === 401 || responseStatusCode === 403)) {
    return "would-allow";
  }
  return null;
}
