import { routeSchemas } from "@agency_hub_core/contracts";

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
  setShiftReportComment,
  setShiftReportLine,
  submitShiftReport,
  withdrawShiftReportOffPlatform,
} from "../../services/shift-handins.ts";
import { beginAgentRequest, writeAgentAudit } from "../agent-read/index.ts";
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
    return handinActorOf(principal);
  }

  // --- The person's doors: Workboard and the extension ---------------------

  server.get("/api/v1/shift-reports", { schema: routeSchemas.shiftReportsList }, async (request) => {
    return listShiftReports(appContext, await person(request), request.query);
  });

  server.get("/api/v1/shift-reports/:shiftId", { schema: routeSchemas.shiftReport }, async (request) => {
    return readShiftReport(appContext, await person(request), request.params.shiftId);
  });

  server.get("/api/v1/shift-reports/:shiftId/claimable", { schema: routeSchemas.shiftReportClaimable }, async (request) => {
    return readShiftReportClaimable(appContext, await person(request), request.params.shiftId);
  });

  server.put("/api/v1/shift-reports/:shiftId/lines/:transactionId", { schema: routeSchemas.shiftReportLineSet }, async (request) => {
    return setShiftReportLine(appContext, await person(request), {
      shiftId: request.params.shiftId, transactionId: request.params.transactionId, body: request.body,
    });
  });

  server.put("/api/v1/shift-reports/:shiftId/comment", { schema: routeSchemas.shiftReportCommentSet }, async (request) => {
    return setShiftReportComment(appContext, await person(request), { shiftId: request.params.shiftId, comment: request.body.comment });
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
    return submitShiftReport(appContext, await person(request), { shiftId: request.params.shiftId });
  });

  // --- The agent's door: «со слов» (write:shift_reports) ---------------------

  async function agentScope(request: Parameters<typeof requireAgentKeyPrincipal>[0], operation: string, capabilities: Array<"write:shift_reports" | "read:team" | "read:money">) {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation, requiredCapabilities: capabilities });
    return { principal, scope, pageIds: scope.pages.map((page) => page.id) };
  }

  async function settled<T>(scope: { finish(rows: number): Promise<void> }, body: () => Promise<T>) {
    let delivered = 0;
    try {
      const result = await body();
      delivered = 1;
      return result;
    } finally {
      await scope.finish(delivered);
    }
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

  server.post("/api/v1/agent/shift-reports/comment", { schema: routeSchemas.agentShiftReportCommentSet }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReportCommentSet", ["write:shift_reports"]);
    return settled(scope, async () => {
      const saved = await setShiftReportComment(appContext, handinAgentActorOf(principal, pageIds, request.body), {
        shiftId: request.body.shiftId, comment: request.body.comment,
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

  // --- The ledger's feed (read:team and read:money) --------------------------

  server.get("/api/v1/agent/shift-reports", { schema: routeSchemas.agentShiftReportsFeed }, async (request) => {
    const { principal, scope, pageIds } = await agentScope(request, "agentShiftReportsFeed", ["read:team", "read:money"]);
    let delivered = 0;
    try {
      const feed = await readShiftReportsFeed(appContext, { pageIds, since: request.query.since, limit: request.query.limit });
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
