import { routeSchemas, type TeamSalesPpvResponse, type TeamSalesRepliesResponse } from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import { readTeamSalesPpv, readTeamSalesReplies } from "../../services/team-sales.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Chat Memory week 6 «Продажи»: PPV conversion by page, chatter and price
 * (`teamSalesPpv`) and reply time against purchases (`teamSalesReplies`).
 * The owner's and a team lead's cookie session, scoped to the pages they
 * reach. The rules are services/team-sales.ts.
 */
export function registerTeamSalesRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/team/sales/ppv", {
    schema: routeSchemas.teamSalesPpv,
  }, async (request): Promise<TeamSalesPpvResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamSalesPpv(appContext, principal, { query: request.query, pageScope: pageScopeFor(principal) });
  });

  server.get("/api/v1/team/sales/replies", {
    schema: routeSchemas.teamSalesReplies,
  }, async (request): Promise<TeamSalesRepliesResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamSalesReplies(appContext, principal, { query: request.query, pageScope: pageScopeFor(principal) });
  });
}
