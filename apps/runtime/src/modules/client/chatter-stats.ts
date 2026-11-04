import { routeSchemas, type ChatterStats, type TeamChatterStatsResponse, type TeamShiftSalesResponse } from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import { readAccountChatterStats, readTeamChatterStats } from "../../services/chatter-stats.ts";
import { readTeamShiftSales } from "../../services/team-shift-sales.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * A chatter's statistics: their own in the cabinet (any cookie session) and a
 * chatter's for the owner and team leads, and the whole team's shifts with their
 * money. The rules are services/chatter-stats.ts and team-shift-sales.ts.
 */
export function registerChatterStatsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/account/stats", {
    schema: routeSchemas.accountChatterStats,
  }, async (request): Promise<ChatterStats> => {
    const principal = await requirePrincipal(request);
    return readAccountChatterStats(appContext, principal, { days: request.query.days });
  });

  server.get("/api/v1/team/chatter-stats", {
    schema: routeSchemas.teamChatterStats,
  }, async (request): Promise<TeamChatterStatsResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamChatterStats(appContext, principal, { query: request.query, pageScope: pageScopeFor(principal) });
  });

  server.get("/api/v1/team/shift-sales", {
    schema: routeSchemas.teamShiftSales,
  }, async (request): Promise<TeamShiftSalesResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamShiftSales(appContext, principal, { query: request.query, pageScope: pageScopeFor(principal) });
  });
}
