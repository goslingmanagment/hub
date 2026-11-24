import { routeSchemas } from "@agency_hub_core/contracts";
import type { FastifyReply } from "fastify";

import { requireHumanPrincipal, type AgentAuthPrincipal } from "../../services/auth.ts";
import {
  addShiftReportOffPlatform,
  handinActorOf,
  handinAgentActorOf,
  listShiftReports,
  readAgentShiftReport,
  readShiftReport,
  readShiftReportClaimable,
  readShiftReportsFeed,
  reportSaleToOwner,
  setShiftReportComment,
  setShiftReportLine,
  withdrawShiftReportOffPlatform,
} from "../../services/shift-handins.ts";
import {
  addShiftReportSighting,
  answerShiftReportCheck,
  answerShiftReportProposal,
  askShiftReport,
  cancelShiftReportFix,
  confirmShiftReport,
  readCurrentShiftReport,
  markShiftReportPostCopied,
  PhaseConflictError,
  readShiftReportBoard,
  readShiftReportChecks,
  reopenShiftReport,
  resendShiftReport,
  submitShiftReport,
  withdrawShiftReportAsk,
} from "../../services/shift-report-board.ts";
import { recordSaleSightings } from "../../services/shift-handin-check.ts";
import { realmOf, requireShiftOfRealm } from "../../services/sandbox/realm.ts";
import { beginAgentRequest, settleAgentRequest as settled, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Отчёт смены (ecosystem plan 2026-11-12, package F): the shift and its report,
 * three doors to one service (services/shift-handins.ts). The person's session
 * (Workboard; the narrow one the extension opens too) and the extension's
 * device token call the same routes (`/api/v1/shift-reports…`, both on their
 * allow-lists); an agent key with write:shift_reports writes «со слов»
 * (`/api/v1/agent/shift-reports…`), every write checked against the sender's
 * Telegram id; the ledger's key reads the handed-in versions (read:team and
 * read:money). Database only, and the ledger's payouts read at a hand-in.
 */
export function registerShiftHandinRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;
  const db = appContext.db;

  async function person(request: Parameters<typeof requirePrincipal>[0]) {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    // The wall (sandbox/realm.ts): a shift of the other realm is not found.
    const shiftId = (request as { params?: { shiftId?: number } }).params?.shiftId;
    if (shiftId !== undefined) await requireShiftOfRealm(appContext, principal, Number(shiftId));
    return handinActorOf(principal);
  }

  /**
   * A change of ticks or «чья» the phase does not take (`PhaseConflictError`): 409 with the fresh board, so the screen
   * redraws what is true now. Any other error passes on.
   */
  async function withFreshBoard<T>(reply: FastifyReply, actor: ReturnType<typeof handinActorOf>, shiftId: number, body: () => Promise<T>): Promise<T | FastifyReply> {
    try {
      return await body();
    } catch (error) {
      if (!(error instanceof PhaseConflictError)) throw error;
      const report = await readShiftReport(appContext, actor, shiftId).catch(() => undefined);
      return reply.code(409).send({ error: "Conflict", message: error.message, statusCode: 409, reason: "phase", ...(report === undefined ? {} : { report }) });
    }
  }

  // --- The person's doors: Workboard and the extension ---------------------

  server.get("/api/v1/shift-reports", { schema: routeSchemas.shiftReportsList }, async (request) => {
    return listShiftReports(appContext, await person(request), request.query);
  });

  server.get("/api/v1/shift-reports/:shiftId", { schema: routeSchemas.shiftReport }, async (request) => {
    // The board's read (shift-report-board.ts): a report it moved to «Подтвердите» and the person signed is counted first.
    return readShiftReportBoard(appContext, await person(request), request.params.shiftId);
  });

  server.get("/api/v1/shift-reports/:shiftId/claimable", { schema: routeSchemas.shiftReportClaimable }, async (request) => {
    return readShiftReportClaimable(appContext, await person(request), request.params.shiftId);
  });

  server.put("/api/v1/shift-reports/:shiftId/lines/:transactionId", { schema: routeSchemas.shiftReportLineSet }, async (request, reply) => {
    const actor = await person(request);
    return withFreshBoard(reply, actor, request.params.shiftId, () => setShiftReportLine(appContext, actor, {
      shiftId: request.params.shiftId, transactionId: request.params.transactionId, body: request.body,
    }));
  });

  server.post("/api/v1/shift-reports/:shiftId/report-sale", { schema: routeSchemas.shiftReportReportSale }, async (request, reply) => {
    const actor = await person(request);
    return withFreshBoard(reply, actor, request.params.shiftId, () => reportSaleToOwner(appContext, actor, {
      shiftId: request.params.shiftId,
      transactionRef: request.body.transactionRef,
      fan: request.body.fan,
      amountMills: request.body.amountMills,
      note: request.body.note,
    }));
  });

  server.put("/api/v1/shift-reports/:shiftId/comment", { schema: routeSchemas.shiftReportCommentSet }, async (request) => {
    return setShiftReportComment(appContext, await person(request), { shiftId: request.params.shiftId, comment: request.body.comment, modelSlug: request.body.modelSlug });
  });

  server.post("/api/v1/shift-reports/:shiftId/off-platform", { schema: routeSchemas.shiftReportOffPlatformAdd }, async (request) => {
    return addShiftReportOffPlatform(appContext, await person(request), { shiftId: request.params.shiftId, body: request.body });
  });

  server.delete("/api/v1/shift-reports/:shiftId/off-platform/:offPlatformId", { schema: routeSchemas.shiftReportOffPlatformWithdraw }, async (request) => {
    return withdrawShiftReportOffPlatform(appContext, await person(request), {
      shiftId: request.params.shiftId, offPlatformId: request.params.offPlatformId,
    });
  });

  server.post("/api/v1/shift-reports/:shiftId/submit", { schema: routeSchemas.shiftReportSubmit }, async (request) => {
    // What the person saw on the bar: equal to the candidate, the hand-in is their signature (an older client sends none).
    return submitShiftReport(appContext, await person(request), {
      shiftId: request.params.shiftId, seenTotalMills: request.body?.seenTotalMills, seenCount: request.body?.seenCount,
    });
  });

  // --- The «Отчёт» board (package R): shift-report-board.ts --------------------

  server.get("/api/v1/shift-reports/current", { schema: routeSchemas.shiftReportCurrent }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return readCurrentShiftReport(appContext, principal);
  });

  server.post("/api/v1/shift-reports/:shiftId/confirm", { schema: routeSchemas.shiftReportConfirm }, async (request) => {
    return confirmShiftReport(appContext, await person(request), {
      shiftId: request.params.shiftId, candidateId: request.body.candidateId, seenTotalMills: request.body.seenTotalMills, seenCount: request.body.seenCount,
    });
  });

  server.post("/api/v1/shift-reports/:shiftId/post-copied", { schema: routeSchemas.shiftReportPostCopied }, async (request) => {
    return markShiftReportPostCopied(appContext, await person(request), { shiftId: request.params.shiftId, model: request.query.model ?? null });
  });

  server.post("/api/v1/shift-reports/:shiftId/reopen", { schema: routeSchemas.shiftReportReopen }, async (request) => {
    return reopenShiftReport(appContext, await person(request), { shiftId: request.params.shiftId });
  });

  server.post("/api/v1/shift-reports/:shiftId/reopen/cancel", { schema: routeSchemas.shiftReportReopenCancel }, async (request) => {
    return cancelShiftReportFix(appContext, await person(request), { shiftId: request.params.shiftId });
  });

  server.post("/api/v1/shift-reports/:shiftId/resend", { schema: routeSchemas.shiftReportResend }, async (request) => {
    return resendShiftReport(appContext, await person(request), { shiftId: request.params.shiftId, transactionIds: request.body.transactionIds });
  });

  server.post("/api/v1/shift-reports/:shiftId/asks", { schema: routeSchemas.shiftReportAsk }, async (request, reply) => {
    const actor = await person(request);
    return withFreshBoard(reply, actor, request.params.shiftId, () => askShiftReport(appContext, actor, { shiftId: request.params.shiftId, body: request.body }));
  });

  server.delete("/api/v1/shift-reports/:shiftId/asks/:transactionId", { schema: routeSchemas.shiftReportAskWithdraw }, async (request, reply) => {
    const actor = await person(request);
    return withFreshBoard(reply, actor, request.params.shiftId, () => withdrawShiftReportAsk(appContext, actor, { shiftId: request.params.shiftId, transactionId: request.params.transactionId }));
  });

  server.post("/api/v1/shift-reports/:shiftId/proposals/:proposalId/answer", { schema: routeSchemas.shiftReportProposalAnswer }, async (request) => {
    return answerShiftReportProposal(appContext, await person(request), {
      shiftId: request.params.shiftId, proposalId: request.params.proposalId, answer: request.body.answer, note: request.body.note ?? null,
    });
  });

  server.post("/api/v1/shift-reports/:shiftId/sightings/:sightingId/add", { schema: routeSchemas.shiftReportSightingAdd }, async (request, reply) => {
    const actor = await person(request);
    return withFreshBoard(reply, actor, request.params.shiftId, () => addShiftReportSighting(appContext, actor, { shiftId: request.params.shiftId, sightingId: request.params.sightingId }));
  });

  server.post("/api/v1/client/sale-sightings", { schema: routeSchemas.clientSaleSightings }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return recordSaleSightings(appContext, principal, request.body);
  });

  // --- The agent's door: «со слов» (write:shift_reports) ---------------------

  async function agentScope(request: Parameters<typeof requireAgentKeyPrincipal>[0], operation: string, capabilities: Array<"write:shift_reports" | "review:shift_reports" | "read:team" | "read:money">) {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation, requiredCapabilities: capabilities });
    return { principal, scope, pageIds: scope.pages.map((page) => page.id) };
  }

  async function audit(principal: AgentAuthPrincipal, operation: string, summary: { shiftId: number; reportVersion?: number; outcome?: string }) {
    await writeAgentAudit(db, { agentKeyId: principal.agentKeyId, operation, pageIds: [], verbatimText: false, requestSummary: summary });
  }

  server.get("/api/v1/agent/shift-reports/draft", { schema: routeSchemas.agentShiftReport }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReport", ["write:shift_reports"]);
    return settled(scope, async () => {
      const report = await readAgentShiftReport(appContext, principal, pageIds, request.query);
      await audit(principal, "agentShiftReport", { shiftId: report.shift.id });
      return report;
    });
  });

  server.get("/api/v1/agent/shift-reports/claimable", { schema: routeSchemas.agentShiftReportClaimable }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReportClaimable", ["write:shift_reports"]);
    return settled(scope, async () => {
      const claimable = await readShiftReportClaimable(appContext, handinAgentActorOf(principal, pageIds, request.query), request.query.shiftId);
      await audit(principal, "agentShiftReportClaimable", { shiftId: request.query.shiftId });
      return claimable;
    });
  });

  server.post("/api/v1/agent/shift-reports/line", { schema: routeSchemas.agentShiftReportLineSet }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReportLineSet", ["write:shift_reports"]);
    return settled(scope, async () => {
      const saved = await setShiftReportLine(appContext, handinAgentActorOf(principal, pageIds, request.body), {
        shiftId: request.body.shiftId, transactionId: request.body.transactionId, body: request.body,
      });
      await audit(principal, "agentShiftReportLineSet", { shiftId: request.body.shiftId });
      return saved;
    });
  });

  server.post("/api/v1/agent/shift-reports/report-sale", { schema: routeSchemas.agentShiftReportReportSale }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReportReportSale", ["write:shift_reports"]);
    return settled(scope, async () => {
      const saved = await reportSaleToOwner(appContext, handinAgentActorOf(principal, pageIds, request.body), {
        shiftId: request.body.shiftId,
        transactionRef: request.body.transactionRef,
        fan: request.body.fan,
        amountMills: request.body.amountMills,
        note: request.body.note,
      });
      await audit(principal, "agentShiftReportReportSale", { shiftId: request.body.shiftId });
      return saved;
    });
  });

  server.post("/api/v1/agent/shift-reports/comment", { schema: routeSchemas.agentShiftReportCommentSet }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReportCommentSet", ["write:shift_reports"]);
    return settled(scope, async () => {
      const saved = await setShiftReportComment(appContext, handinAgentActorOf(principal, pageIds, request.body), {
        shiftId: request.body.shiftId, comment: request.body.comment, modelSlug: request.body.modelSlug,
      });
      await audit(principal, "agentShiftReportCommentSet", { shiftId: request.body.shiftId });
      return saved;
    });
  });

  server.post("/api/v1/agent/shift-reports/off-platform", { schema: routeSchemas.agentShiftReportOffPlatformAdd }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReportOffPlatformAdd", ["write:shift_reports"]);
    return settled(scope, async () => {
      const added = await addShiftReportOffPlatform(appContext, handinAgentActorOf(principal, pageIds, request.body), {
        shiftId: request.body.shiftId,
        body: { amountMills: request.body.amountMills, fromWhom: request.body.fromWhom, whatFor: request.body.whatFor },
      });
      await audit(principal, "agentShiftReportOffPlatformAdd", { shiftId: request.body.shiftId });
      return added;
    });
  });

  server.post("/api/v1/agent/shift-reports/submit", { schema: routeSchemas.agentShiftReportSubmit }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReportSubmit", ["write:shift_reports"]);
    return settled(scope, async () => {
      const report = await submitShiftReport(appContext, handinAgentActorOf(principal, pageIds, request.body), { shiftId: request.body.shiftId });
      await audit(principal, "agentShiftReportSubmit", { shiftId: request.body.shiftId, reportVersion: report.latest?.version ?? 0 });
      return report;
    });
  });

  // --- Gengar's check after the hand-in (review:shift_reports) ---------------

  server.get("/api/v1/agent/shift-reports/checks", { schema: routeSchemas.agentShiftReportChecks }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReportChecks", ["review:shift_reports"]);
    let delivered = 0;
    try {
      const checks = await readShiftReportChecks(appContext, { agentKeyId: principal.agentKeyId, pageIds, limit: request.query.limit, realm: realmOf(principal) });
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId, operation: "agentShiftReportChecks", pageIds, verbatimText: false,
        requestSummary: { returned: checks.checks.length },
      });
      delivered = checks.checks.length;
      return checks;
    } finally {
      await scope.finish(delivered);
    }
  });

  server.post("/api/v1/agent/shift-reports/checks/:candidateId", { schema: routeSchemas.agentShiftReportCheckAnswer }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReportCheckAnswer", ["review:shift_reports"]);
    return settled(scope, async () => {
      const answer = await answerShiftReportCheck(appContext, principal, { candidateId: request.params.candidateId, pageIds, body: request.body });
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId, operation: "agentShiftReportCheckAnswer", pageIds: [], verbatimText: false,
        requestSummary: { candidateId: answer.candidateId, returned: answer.recorded, outcome: answer.superseded ? "superseded" : answer.late ? "late" : answer.recorded === 0 ? "clean" : "proposals" },
      });
      return answer;
    });
  });

  // --- The ledger's feed (read:team and read:money) --------------------------

  server.get("/api/v1/agent/shift-reports", { schema: routeSchemas.agentShiftReportsFeed }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReportsFeed", ["read:team", "read:money"]);
    let delivered = 0;
    try {
      const feed = await readShiftReportsFeed(appContext, { pageIds, since: request.query.since, limit: request.query.limit, agentKeyId: principal.agentKeyId, realm: realmOf(principal) });
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentShiftReportsFeed",
        pageIds,
        verbatimText: false,
        requestSummary: { returned: feed.reports.length },
      });
      delivered = feed.reports.length;
      return feed;
    } finally {
      await scope.finish(delivered);
    }
  });
}
