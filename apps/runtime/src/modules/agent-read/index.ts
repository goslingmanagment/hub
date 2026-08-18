import { routeSchemas } from "@agency_hub_core/contracts";

import { auditCtx } from "../../api/request-auth.ts";
import {
  issueAgentKey,
  listAgentKeysDetailed,
  revokeAgentKeyById,
} from "../../services/agent-keys.ts";
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
import {
  handleAgentHydrationRequestCreate,
  handleAgentHydrationRequestDecide,
  handleAgentHydrationRequestGet,
  handleAgentHydrationRequestList,
} from "./handlers-hydration.ts";

/**
 * The Agent Read Plane registrar: operations #1..#13 under `/api/v1/agent/*`.
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

  // --- Slice B: owner administration of the keys themselves ---
  //
  // Registered HERE, not in the identity module, for one reason: the `no-store`
  // hook above keys on the `/api/v1/agent/` prefix, and the issuance response is
  // the single response in this system that carries a live bearer token. Their
  // contracts live in their own module (`routes-agent-keys.ts`) so the read
  // plane's pins keep meaning what they say.

  server.post("/api/v1/agent/keys", {
    schema: routeSchemas.agentKeyCreate,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return issueAgentKey(appContext, request.body, auditCtx(principal));
  });

  server.get("/api/v1/agent/keys", {
    schema: routeSchemas.agentKeyList,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return listAgentKeysDetailed(appContext);
  });

  server.post("/api/v1/agent/keys/:id/revoke", {
    schema: routeSchemas.agentKeyRevoke,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return revokeAgentKeyById(appContext, { id: request.params.id }, auditCtx(principal));
  });

  // #11 — the ONLY write an agent key has, and it writes an INTENT: zero vendor
  // calls, no job, nothing queued. Only an owner decision turns it into work.
  server.post("/api/v1/agent/pages/:pageLabel/threads/:conversationRef/hydration-requests", {
    schema: routeSchemas.agentHydrationRequestCreate,
    config: rateLimit("agentHydrationRequestCreate"),
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentHydrationRequestCreate(
      appContext,
      principal,
      request.params,
      request.body,
    );
  });

  // #12 — no `:pageLabel` in the path, so the declarative page scope cannot
  // apply: the grant check AND the "this key filed it" check are in the handler,
  // and both miss with the same static 404 as an unknown uuid.
  server.get("/api/v1/agent/hydration-requests/:requestRef", {
    schema: routeSchemas.agentHydrationRequestGet,
  }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    return handleAgentHydrationRequestGet(appContext, principal, request.params);
  });

  // The owner approval queue. Owner session, like #13 — an agent key never sees
  // another key's requests, let alone the whole board.
  server.get("/api/v1/agent/hydration-requests", {
    schema: routeSchemas.agentHydrationRequestList,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return handleAgentHydrationRequestList(appContext, principal, request.query);
  });

  // #13 — OWNER SESSION. The `hub` agent CLI carries an agent key and cannot
  // mint a cookie, which is the point: the principal that asks for the work is
  // structurally not the principal that authorizes it.
  server.post("/api/v1/agent/hydration-requests/:requestRef/decision", {
    schema: routeSchemas.agentHydrationRequestDecide,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return handleAgentHydrationRequestDecide(
      appContext,
      principal,
      request.params,
      request.body,
    );
  });
}

/**
 * The module's public surface.
 *
 * Deep imports into `modules/<name>/**` are lint-banned, so anything outside the
 * module (today: the test suite, which pins these properties) comes through
 * here. What is re-exported is exactly what has an assertable invariant, and
 * NOTHING that would let a caller bypass one: `concludeEnvelope` is reachable
 * because its verdict is the thing under test, while the witness constructor
 * that would let a caller fabricate a "read" is not exported by `packages/db`
 * at all.
 */
export {
  buildAgentEvidence,
  concludeEnvelope,
  gapBeforeCaptureFloor,
  type AgentEvidence,
  type AgentEvidenceInput,
  type AgentPlaneMode,
} from "./epistemics.ts";
export {
  agentParamsHash,
  canonicalJson,
  decodeAgentCursor,
  encodeAgentCursor,
  type AgentCursorPayload,
  type AgentCursorSigning,
} from "./cursors.ts";
export {
  AGENT_CONCURRENCY_LIMIT,
  AGENT_ROUTE_RPM,
  acquireAgentSlot,
  agentConcurrencyInUse,
  assertWithinAgentBudget,
  releaseAgentSlot,
  resetAgentConcurrencyForTests,
} from "./budget.ts";
export {
  AGENT_OBSERVATION_PAYLOAD_ALLOWLIST,
  AGENT_OBSERVATION_PAYLOAD_DENYLIST,
  AGENT_OBSERVATION_PAYLOAD_SESSION_CAP,
  agentObservationPayloadAllowed,
  scrubObservationPayload,
} from "./observation-scrub.ts";
export {
  AGENT_COUNT_PROBE_MAX,
  AGENT_PLATFORM_CAPABILITIES,
  AGENT_TIMEOUT_MS,
  computeScopeFieldStates,
  hydrationRemedy,
  operationPlanesFor,
  retentionLimitFor,
} from "./runtime.ts";
export { staticNotFound, toSafeNumber, toSafeNumberOr } from "./errors.ts";
export { normalizeResolveInput } from "./handlers-core.ts";
export {
  AGENT_HYDRATION_REQUEST_TTL_MS,
  applyHydrationDecision,
  hydrationDecisionFingerprint,
  hydrationRequestFingerprint,
  toWireHydrationRequest,
} from "./handlers-hydration.ts";
/**
 * #9b's handler, on the barrel because #223 gave it a REFUSAL that only an
 * integration test against real rows can prove: an observation whose body lives
 * only in the catalog, with that catalog copy made unreadable, must answer 503
 * rather than report the body withheld for its restriction class. The route
 * above is owner-session-authenticated, so reaching it through HTTP would test
 * the login flow; what is under test is the seam.
 */
export { handleAgentObservationPayload } from "./handlers-journal.ts";
