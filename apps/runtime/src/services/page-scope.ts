import {
  isAgentPrincipal,
  type AgentAuthPrincipal,
  type AuthPrincipal,
  type HumanAuthPrincipal,
} from "./auth.ts";
import { ownerPageScope } from "./sandbox/realm.ts";

// The pages a principal reaches, and the scopes built on them: one home for the
// API modules (api/request-auth.ts re-exports these) and the services alike, so
// no service keeps a copy of the rule or reaches up into the HTTP layer for it.

export function pageScopeFor(principal: AuthPrincipal) {
  // `undefined` means "no filter at all" (owner-everything), so the agent branch
  // comes first and always returns a LIST: an agent key sees its grant, and a key
  // granted nothing sees nothing — never everything.
  if (isAgentPrincipal(principal)) {
    return principal.pageIds;
  }
  // The owner's agent door reaches no page itself: its operations run as the owner's principal (owner-agent-door.ts).
  if (principal.kind === "owner_agent") {
    return [];
  }
  // The test realm (services/sandbox/realm.ts): a test owner sees the test pages only; a live owner every page but
  // those (no filter at all while there is no test page).
  return principal.user.role === "owner" ? ownerPageScope(principal) : principal.assignedPageIds;
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
    : principal.kind === "owner_agent"
      // The owner's agent door: the owner it acts as, and the key beside him (owner-agent-door.ts names both).
      ? {
        source: "owner_agent" as const,
        actorUserId: principal.ownerUserId,
        actorAgentKeyId: principal.agentKeyId,
      }
    : {
      source: "api" as const,
      actorUserId: principal.user.id,
    }
);
