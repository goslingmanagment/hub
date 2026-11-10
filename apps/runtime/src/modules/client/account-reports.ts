import { routeSchemas, type AccountReportsResponse } from "@agency_hub_core/contracts";

import { readAccountReports } from "../../services/ledger-reports.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * The cabinet's «Отчёт смены»: the caller's own shift reports from the agency
 * ledger (services/ledger-reports.ts). Any cookie session; the user is the
 * session's, never one named in the request. Nothing is written anywhere.
 */
export function registerAccountReportsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/account/reports", {
    schema: routeSchemas.accountReports,
  }, async (request): Promise<AccountReportsResponse> => {
    const principal = await requirePrincipal(request);
    return readAccountReports(appContext, principal, request.query);
  });
}
