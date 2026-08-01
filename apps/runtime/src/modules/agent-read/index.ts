import { routeSchemas } from "@agency_hub_core/contracts";

import { requireOwner } from "../../services/auth.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";
import { AGENT_ROUTE_RPM } from "./budget.ts";
import { agentRateLimitErrorBuilder } from "./errors.ts";
import {
  handleAgentCapabilities,
  handleAgentPerson,
  handleAgentResolve,
} from "./handlers-core.ts";
import {
  handleAgentCoverage,
  handleAgentPersonTimeline,
  handleAgentSearchMessages,
  handleAgentThreadMessages,
  handleAgentThreads,
} from "./handlers-threads.ts";
import {
  handleAgentDatasetQuery,
  handleAgentObservationPayload,
  handleAgentObservations,
} from "./handlers-journal.ts";

/**
 * The Agent Read Plane registrar: operations #1..#10 under `/api/v1/agent/*`.
 *
 * THREE THINGS THIS FUNCTION IS RESPONSIBLE FOR, beyond wiring:
 *
 * 1. **`Cache-Control: no-store` on EVERY response**, including errors. It is an
 *    `onSend` hook rather than a per-handler header for exactly that reason: a
 *    404 or a 429 from this plane must not sit in an intermediary either.
 * 2. **The plane's own rate-limit error builder.** `@fastify/rate-limit` THROWS
 *    whatever the builder returns; the shared one is hard-coded to "Too many
 *    login attempts", and a non-AppError return becomes a static 500 — the bug
 *    that answered 500 to three days of rate-limited logins.
 * 3. **The in-handler principal guard.** The declarative middleware may run in
 *    `log` mode, so every handler resolves through `requireAgentKeyPrincipal`
 *    (never `requirePrincipal`, which narrows to a HUMAN principal and would
 *    refuse the agent outright).
 *
 * NO SSE HERE, and none is coming: an agent key gets no event stream (owner
 * ruling). The isolation suite pins that an agent token on the stream routes is
 * refused.
 */
export function registerAgentReadRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requireAgentKeyPrincipal, requirePrincipal } = ctx.auth;

  // Applies to errors too, which is the point: a static 404 from the existence
  // oracle must be as uncacheable as a transcript.
  server.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/v1/agent/")) {
      reply.header("cache-control", "no-store");
    }
  });

  const rateLimit = (operation: keyof typeof AGENT_ROUTE_RPM) => ({
    rateLimit: {
      max: AGENT_ROUTE_RPM[operation],
      timeWindow: "1 minute",
      errorResponseBuilder: agentRateLimitErrorBuilder,
    },
  });

  // #1 — the bootstrap operation. No capability: a key must be able to discover
  // what it may do without already knowing.
  server.get("/api/v1/agent/capabilities", {
    schema: routeSchemas.agentCapabilities,
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentCapabilities(appContext, principal);
  });

  // #2 — POST because the resolver takes typed inputs, and because a slug that
  // identifies a person should not land in an access log.
  server.post("/api/v1/agent/resolve", {
    schema: routeSchemas.agentResolve,
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentResolve(appContext, principal, request.body);
  });

  // #3 / #4 — globally addressable by (platform, platformUserId). They NEVER 404:
  // see the schema summary and spec 5.6.
  server.get("/api/v1/agent/people/:platform/:platformUserId", {
    schema: routeSchemas.agentPerson,
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentPerson(appContext, principal, request.params, request.query);
  });

  server.get("/api/v1/agent/people/:platform/:platformUserId/timeline", {
    schema: routeSchemas.agentPersonTimeline,
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentPersonTimeline(appContext, principal, request.params, request.query);
  });

  server.get("/api/v1/agent/threads", {
    schema: routeSchemas.agentThreads,
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentThreads(appContext, principal, request.query);
  });

  // #6 — the ONLY operation that serves a full transcript. Page-scoped, rate
  // limited, and audited on every call.
  server.get("/api/v1/agent/pages/:pageLabel/threads/:conversationRef/messages", {
    schema: routeSchemas.agentThreadMessages,
    config: rateLimit("agentThreadMessages"),
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentThreadMessages(appContext, principal, request.params, request.query);
  });

  server.post("/api/v1/agent/search/messages", {
    schema: routeSchemas.agentSearchMessages,
    config: rateLimit("agentSearchMessages"),
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentSearchMessages(appContext, principal, request.body);
  });

  server.get("/api/v1/agent/coverage", {
    schema: routeSchemas.agentCoverage,
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentCoverage(appContext, principal, request.query);
  });

  server.get("/api/v1/agent/observations", {
    schema: routeSchemas.agentObservations,
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentObservations(appContext, principal, request.query);
  });

  // 9b — OWNER SESSION, not an agent key. The split exists because a route
  // carries one auth policy and the middleware decides before the handler:
  // "envelope to the agent, body to the owner" is two operations or nothing.
  server.get("/api/v1/agent/observations/:observationRef/payload", {
    schema: routeSchemas.agentObservationPayload,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return handleAgentObservationPayload(
      appContext,
      principal,
      request.params,
      request.query,
    );
  });

  server.post("/api/v1/agent/pages/:pageLabel/datasets/:dataset/query", {
    schema: routeSchemas.agentDatasetQuery,
    config: rateLimit("agentDatasetQuery"),
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentDatasetQuery(appContext, principal, request.params, request.body);
  });
}
