import {
  routeSchemas,
  type AccountShiftReportChangeResponse,
  type AccountShiftReportResponse,
  type TeamShiftDisputesResponse,
  type TeamShiftExportResponse,
} from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import {
  confirmAccountShiftReport,
  markAccountShiftSale,
  readAccountShiftReport,
  readTeamShiftDisputes,
  readTeamShiftExport,
  resolveTeamShiftDispute,
} from "../../services/shift-report.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Chat Memory week 4: the draft shift report — the chatter's cabinet (draft,
 * marks, confirmation) and the owner's disputes and payout export. The rules
 * are services/shift-report.ts.
 */
export function registerShiftReportRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/account/shift-report", {
    schema: routeSchemas.accountShiftReport,
  }, async (request): Promise<AccountShiftReportResponse> => {
    const principal = await requirePrincipal(request);
    return readAccountShiftReport(appContext, principal, { days: request.query.days });
  });

  server.post("/api/v1/account/shift-report/marks", {
    schema: routeSchemas.accountShiftReportMark,
  }, async (request): Promise<AccountShiftReportChangeResponse> => {
    const principal = await requirePrincipal(request);
    return markAccountShiftSale(appContext, principal, request.body);
  });

  server.post("/api/v1/account/shift-report/confirm", {
    schema: routeSchemas.accountShiftReportConfirm,
  }, async (request): Promise<AccountShiftReportChangeResponse> => {
    const principal = await requirePrincipal(request);
    return confirmAccountShiftReport(appContext, principal, request.body);
  });

  server.get("/api/v1/team/shift-reports/disputes", {
    schema: routeSchemas.teamShiftDisputes,
  }, async (request): Promise<TeamShiftDisputesResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamShiftDisputes(appContext, principal, { days: request.query.days, pageScope: pageScopeFor(principal) });
  });

  server.post("/api/v1/team/shift-reports/disputes/:saleRef", {
    schema: routeSchemas.teamShiftResolve,
  }, async (request): Promise<AccountShiftReportChangeResponse> => {
    const principal = await requirePrincipal(request);
    return resolveTeamShiftDispute(appContext, principal, { saleRef: request.params.saleRef, body: request.body });
  });

  server.get("/api/v1/team/shift-reports/export", {
    schema: routeSchemas.teamShiftExport,
  }, async (request): Promise<TeamShiftExportResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamShiftExport(appContext, principal, { from: request.query.from, to: request.query.to, pageScope: pageScopeFor(principal) });
  });
}
