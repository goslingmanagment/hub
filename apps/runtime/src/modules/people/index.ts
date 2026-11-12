import { routeSchemas } from "@agency_hub_core/contracts";

import {
  agentProposalView,
  createAgentPersonProposal,
  createPerson,
  decidePersonProposal,
  listAgentPersonProposals,
  listPeopleProposalsForOwner,
  readAgentPeople,
  readPersonForOwner,
  readTeamPeople,
  setPersonPayTerm,
  updatePerson,
} from "../../services/people/index.ts";
import { auditCtx } from "../../api/request-auth.ts";
import { beginAgentRequest, withAgentTimeout, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * The people registry (ecosystem plan 2026-11-12, package A), in shadow. Twin
 * doors to one service: the team's list for a session (owner and team lead, no
 * money), the owner's card and every write for the owner's session, and for
 * an agent key the feed (read:team; pay terms only with read:pay_terms) and
 * proposals (propose:people) that wait for the owner. Database only.
 */

const AGENT_PEOPLE_TIMEOUT_MS = 10_000;

export function registerPeopleRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;
  const db = appContext.db;

  // --- Sessions ------------------------------------------------------------

  server.get("/api/v1/team/people", { schema: routeSchemas.teamPeople }, async (request) => {
    const principal = await requirePrincipal(request);
    return readTeamPeople(appContext, principal);
  });

  server.get("/api/v1/admin/people/:code", { schema: routeSchemas.adminPerson }, async (request) => {
    return readPersonForOwner(appContext, request.params.code);
  });

  server.post("/api/v1/admin/people", { schema: routeSchemas.adminPersonCreate }, async (request) => {
    const principal = await requirePrincipal(request);
    return createPerson(appContext, request.body, auditCtx(principal));
  });

  server.patch("/api/v1/admin/people/:code", { schema: routeSchemas.adminPersonUpdate }, async (request) => {
    const principal = await requirePrincipal(request);
    return updatePerson(appContext, request.params.code, request.body, auditCtx(principal));
  });

  server.put("/api/v1/admin/people/:code/pay-terms", { schema: routeSchemas.adminPersonPayTermSet }, async (request) => {
    const principal = await requirePrincipal(request);
    return setPersonPayTerm(appContext, request.params.code, request.body, auditCtx(principal));
  });

  server.get("/api/v1/admin/people-proposals", { schema: routeSchemas.adminPeopleProposals }, async (request) => {
    return listPeopleProposalsForOwner(appContext, request.query.state === undefined ? {} : { state: request.query.state });
  });

  server.post("/api/v1/admin/people-proposals/:proposalId/decide", { schema: routeSchemas.adminPersonProposalDecide }, async (request) => {
    const principal = await requirePrincipal(request);
    return decidePersonProposal(appContext, request.params.proposalId, request.body, auditCtx(principal));
  });

  // --- Agent keys ----------------------------------------------------------

  server.get("/api/v1/agent/people", { schema: routeSchemas.agentPeople }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation: "agentPeople", requiredCapabilities: ["read:team"] });
    let delivered = 0;
    try {
      const since = request.query.since === undefined ? undefined : new Date(request.query.since);
      const result = await withAgentTimeout(db, AGENT_PEOPLE_TIMEOUT_MS, (tx) => readAgentPeople({ db: tx }, {
        ...(since === undefined ? {} : { since }),
        grantedPageIds: scope.pages.map((page) => page.id),
        keyGrantExcludedPages: scope.scopeNarrowing.keyGrantExcludedPages,
        includeTerms: scope.has("read:pay_terms"),
      }), "agent_people");
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentPeople",
        pageIds: scope.pageIds,
        verbatimText: false,
        requestSummary: {
          returned: result.people.length,
          ...(since === undefined ? {} : { windowFrom: since.toISOString() }),
          payTerms: result.payTermsIncluded,
        },
      });
      delivered = result.people.length;
      return result;
    } finally {
      await scope.finish(delivered);
    }
  });

  server.post("/api/v1/agent/people/proposals", { schema: routeSchemas.agentPersonProposalCreate }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, {
      operation: "agentPersonProposalCreate", requiredCapabilities: ["propose:people"],
    });
    let delivered = 0;
    try {
      const row = await createAgentPersonProposal(appContext, { agentKeyId: principal.agentKeyId, body: request.body });
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentPersonProposalCreate",
        pageIds: [],
        verbatimText: false,
        requestSummary: { proposalId: row.id, created: true },
      });
      delivered = 1;
      return { proposal: agentProposalView(row) };
    } finally {
      await scope.finish(delivered);
    }
  });

  server.get("/api/v1/agent/people/proposals", { schema: routeSchemas.agentPersonProposals }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, {
      operation: "agentPersonProposals", requiredCapabilities: ["propose:people"],
    });
    let delivered = 0;
    try {
      const since = request.query.since === undefined ? undefined : new Date(request.query.since);
      const proposals = await listAgentPersonProposals(appContext, {
        agentKeyId: principal.agentKeyId, ...(since === undefined ? {} : { since }),
      });
      delivered = proposals.length;
      return { proposals };
    } finally {
      await scope.finish(delivered);
    }
  });
}
