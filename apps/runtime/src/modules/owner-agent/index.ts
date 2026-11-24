import { createHash } from "node:crypto";

import { OWNER_AGENT_REASON_HEADER, routeSchemas } from "@agency_hub_core/contracts";

import { requireOwnerAgentPrincipal } from "../../services/auth.ts";
import { callOwnerAgent } from "../../services/owner-agent-door.ts";
import { unauthorizedFor } from "../../api/request-auth.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/** Calls of the owner's agent door per key per minute: a person's pace, not a crawler's. */
const OWNER_AGENT_CALLS_PER_MINUTE = 60;

/**
 * The owner's agent door (services/owner-agent-door.ts): one route, its table of operations behind it. The route's kind
 * (`ownerAgentKey`) admits an `act:owner` key and nothing else; the reason, the table, the audit and the arguments are
 * the service's, in that order. Never cached anywhere on the way: the answers are the owner's.
 */
export function registerOwnerAgentRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { resolvePrincipal } = ctx.auth;

  server.post("/api/v1/owner-agent/call", {
    schema: routeSchemas.ownerAgentCall,
    config: {
      rateLimit: {
        max: OWNER_AGENT_CALLS_PER_MINUTE,
        timeWindow: 60_000,
        // Per key: the bearer's digest, never the bearer.
        keyGenerator: (request) => `owner-agent:${createHash("sha256").update(String(request.headers.authorization ?? request.ip)).digest("hex")}`,
      },
    },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const principal = await resolvePrincipal(request);
    if (!principal) throw unauthorizedFor(request);
    requireOwnerAgentPrincipal(principal);
    return callOwnerAgent(appContext, principal, {
      reasonHeader: request.headers[OWNER_AGENT_REASON_HEADER],
      op: request.body.op,
      args: request.body.args,
    });
  });
}
