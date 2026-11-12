import { routeSchemas } from "@agency_hub_core/contracts";

import { requireHumanPrincipal, requireOwner } from "../../services/auth.ts";
import {
  answerSaleClaim,
  decideOffPlatformLine,
  decideSaleDispute,
  keepSalesNobody,
  linkUnlinkedDecision,
  readAgentSaleClaims,
  readOffPlatformPending,
  readSaleDispute,
  readSaleDisputeOfClaim,
  readSaleNobody,
  readUnlinkedDecisions,
} from "../../services/sale-claims.ts";
import {
  answerSaleQuestion,
  askSaleQuestion,
  cancelSaleDecisionSaid,
  closeSaleQuestion,
  listSaleDecisionsSaid,
  listSaleQuestionsSaid,
  markSaleDecisionTaken,
  recordSaleDecision,
  type DoorActor,
} from "../../services/sale-decisions-door.ts";
import { handinActorOf, handinAgentActorOf } from "../../services/shift-handins.ts";
import { beginAgentRequest, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Заявки и договорённости (ecosystem plan 2026-11-12, package G): one service
 * (services/sale-claims.ts) behind its doors. The other side answers a claim by
 * the person's session or the extension's device token (both allow-lists), or
 * an agent key «со слов» (write:shift_reports; the sender checked against the
 * person, the message required); the owner reads a dispute and decides it,
 * confirms or rejects «мимо площадки», leaves the week's unclaimed sales
 * nobody's and ties a decision carried over from the ledger to its sale; an
 * agent key reads the decisions and claims of a person or a sale on its pages.
 * Database only.
 */
export function registerSaleClaimRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;
  const db = appContext.db;

  async function owner(request: Parameters<typeof requirePrincipal>[0]) {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return principal;
  }

  // --- The other side: the person's doors ----------------------------------

  server.post("/api/v1/sale-claims/:claimId/answer", { schema: routeSchemas.saleClaimAnswer }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return answerSaleClaim(appContext, handinActorOf(principal), {
      claimId: request.params.claimId, answer: request.body.answer, note: request.body.note ?? null,
    });
  });

  // --- The owner ---------------------------------------------------------------

  server.get("/api/v1/sale-disputes/:transactionId", { schema: routeSchemas.saleDispute }, async (request) => {
    return readSaleDispute(appContext, await owner(request), request.params.transactionId);
  });

  server.get("/api/v1/sale-disputes/claim/:claimId", { schema: routeSchemas.saleDisputeOfClaim }, async (request) => {
    return readSaleDisputeOfClaim(appContext, await owner(request), request.params.claimId);
  });

  server.post("/api/v1/sale-disputes/decide", { schema: routeSchemas.saleDisputeDecide }, async (request) => {
    return decideSaleDispute(appContext, await owner(request), {
      transactionId: request.body.transactionId, claimId: request.body.claimId, outcome: request.body.outcome, note: request.body.note ?? null,
    });
  });

  server.get("/api/v1/off-platform", { schema: routeSchemas.offPlatformPending }, async (request) => {
    return readOffPlatformPending(appContext, await owner(request), request.query);
  });

  server.post("/api/v1/off-platform/:offPlatformId/decide", { schema: routeSchemas.offPlatformDecide }, async (request) => {
    return decideOffPlatformLine(appContext, await owner(request), {
      offPlatformId: request.params.offPlatformId, decision: request.body.decision, pageLabel: request.body.pageLabel, note: request.body.note ?? null,
    });
  });

  server.get("/api/v1/sale-nobody", { schema: routeSchemas.saleNobody }, async (request) => {
    return readSaleNobody(appContext, await owner(request), request.query);
  });

  server.post("/api/v1/sale-nobody/keep", { schema: routeSchemas.saleNobodyKeep }, async (request) => {
    return keepSalesNobody(appContext, await owner(request), request.body);
  });

  server.get("/api/v1/sale-decisions/unlinked", { schema: routeSchemas.saleDecisionsUnlinked }, async (request) => {
    return readUnlinkedDecisions(appContext, await owner(request));
  });

  server.post("/api/v1/sale-decisions/:decisionId/link", { schema: routeSchemas.saleDecisionLink }, async (request) => {
    return linkUnlinkedDecision(appContext, await owner(request), { decisionId: request.params.decisionId, transactionId: request.body.transactionId });
  });

  // --- The agent's door -----------------------------------------------------

  server.get("/api/v1/agent/sale-claims", { schema: routeSchemas.agentSaleClaims }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    // Gengar's key writes reports «со слов»; a reading key of the team reads the same.
    const capability = principal.capabilities.includes("write:shift_reports") ? "write:shift_reports" as const : "read:team" as const;
    const scope = await beginAgentRequest(appContext, principal, { operation: "agentSaleClaims", requiredCapabilities: [capability] });
    const pageIds = scope.pages.map((page) => page.id);
    let delivered = 0;
    try {
      const answer = await readAgentSaleClaims(appContext, { pageIds, ...request.query });
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId, operation: "agentSaleClaims", pageIds, verbatimText: false,
        requestSummary: { returned: answer.decisions.length + answer.claims.length },
      });
      delivered = answer.decisions.length + answer.claims.length;
      return answer;
    } finally {
      await scope.finish(delivered);
    }
  });

  server.post("/api/v1/agent/sale-claims/answer", { schema: routeSchemas.agentSaleClaimAnswer }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation: "agentSaleClaimAnswer", requiredCapabilities: ["write:shift_reports"] });
    const pageIds = scope.pages.map((page) => page.id);
    let delivered = 0;
    try {
      const answer = await answerSaleClaim(appContext, handinAgentActorOf(principal, pageIds, request.body), {
        claimId: request.body.claimId, answer: request.body.answer, note: request.body.note ?? null,
      });
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId, operation: "agentSaleClaimAnswer", pageIds: [], verbatimText: false,
        requestSummary: { claimId: request.body.claimId, outcome: request.body.answer },
      });
      delivered = 1;
      return answer;
    } finally {
      await scope.finish(delivered);
    }
  });

  // «Чья продажа» «со слов» (review R2b-3): Gengar's decisions and questions, written in Hub — write:shift_reports.
  async function said<T>(
    request: Parameters<typeof requireAgentKeyPrincipal>[0],
    operation: "agentSaleDecisionAdd" | "agentSaleDecisionCancel" | "agentSaleDecisionApplied" | "agentSaleQuestionAsk" | "agentSaleQuestionAnswer" | "agentSaleQuestionClose",
    words: { telegramUserId?: number; sourceRef?: string },
    write: (actor: DoorActor) => Promise<T>,
    summary: (answer: T) => Record<string, number | string>,
  ): Promise<T> {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation, requiredCapabilities: ["write:shift_reports"] });
    const pageIds = scope.pages.map((page) => page.id);
    let delivered = 0;
    try {
      const answer = await write({ agentKeyId: principal.agentKeyId, pageIds, telegramUserId: words.telegramUserId ?? 0, sourceRef: words.sourceRef ?? "" });
      await writeAgentAudit(db, { agentKeyId: principal.agentKeyId, operation, pageIds: [], verbatimText: false, requestSummary: summary(answer) });
      delivered = 1;
      return answer;
    } finally {
      await scope.finish(delivered);
    }
  }

  async function readSaid<T>(
    request: Parameters<typeof requireAgentKeyPrincipal>[0],
    operation: "agentSaleDecisions" | "agentSaleQuestions",
    read: (pageIds: number[]) => Promise<T>,
    count: (answer: T) => number,
  ): Promise<T> {
    const principal = await requireAgentKeyPrincipal(request);
    const capability = principal.capabilities.includes("write:shift_reports") ? "write:shift_reports" as const : "read:team" as const;
    const scope = await beginAgentRequest(appContext, principal, { operation, requiredCapabilities: [capability] });
    const pageIds = scope.pages.map((page) => page.id);
    let delivered = 0;
    try {
      const answer = await read(pageIds);
      delivered = count(answer);
      await writeAgentAudit(db, { agentKeyId: principal.agentKeyId, operation, pageIds, verbatimText: false, requestSummary: { returned: delivered } });
      return answer;
    } finally {
      await scope.finish(delivered);
    }
  }

  server.post("/api/v1/agent/sale-decisions", { schema: routeSchemas.agentSaleDecisionAdd }, async (request) =>
    said(request, "agentSaleDecisionAdd", request.body, (actor) => recordSaleDecision(appContext, actor, request.body),
      (answer) => ({ decisionId: answer.decision.id, outcome: request.body.kind })));
  server.post("/api/v1/agent/sale-decisions/cancel", { schema: routeSchemas.agentSaleDecisionCancel }, async (request) =>
    said(request, "agentSaleDecisionCancel", request.body, (actor) => cancelSaleDecisionSaid(appContext, actor, request.body),
      (answer) => ({ decisionId: answer.decision.id, outcome: "cancelled" })));
  server.post("/api/v1/agent/sale-decisions/applied", { schema: routeSchemas.agentSaleDecisionApplied }, async (request) =>
    said(request, "agentSaleDecisionApplied", {}, (actor) => markSaleDecisionTaken(appContext, actor, request.body),
      (answer) => ({ decisionId: answer.decision.id, outcome: "applied" })));
  server.get("/api/v1/agent/sale-decisions", { schema: routeSchemas.agentSaleDecisions }, async (request) =>
    readSaid(request, "agentSaleDecisions", (pageIds) => listSaleDecisionsSaid(appContext, { pageIds, ...request.query }), (answer) => answer.decisions.length));
  server.post("/api/v1/agent/sale-questions", { schema: routeSchemas.agentSaleQuestionAsk }, async (request) =>
    said(request, "agentSaleQuestionAsk", request.body, (actor) => askSaleQuestion(appContext, actor, request.body),
      (answer) => ({ questionId: answer.question.id, outcome: request.body.askedOf })));
  server.post("/api/v1/agent/sale-questions/answer", { schema: routeSchemas.agentSaleQuestionAnswer }, async (request) =>
    said(request, "agentSaleQuestionAnswer", request.body, (actor) => answerSaleQuestion(appContext, actor, request.body),
      (answer) => ({ questionId: answer.question.id, outcome: "answered" })));
  server.post("/api/v1/agent/sale-questions/close", { schema: routeSchemas.agentSaleQuestionClose }, async (request) =>
    said(request, "agentSaleQuestionClose", request.body, (actor) => closeSaleQuestion(appContext, actor, request.body),
      (answer) => ({ questionId: answer.question.id, outcome: "closed" })));
  server.get("/api/v1/agent/sale-questions", { schema: routeSchemas.agentSaleQuestions }, async (request) =>
    readSaid(request, "agentSaleQuestions", (pageIds) => listSaleQuestionsSaid(appContext, { pageIds, ...request.query }), (answer) => answer.questions.length));
}
