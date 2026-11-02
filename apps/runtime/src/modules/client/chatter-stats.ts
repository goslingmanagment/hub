import { routeSchemas, type ChatterStats, type TeamChatterStatsResponse } from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import { readAccountChatterStats, readTeamChatterStats } from "../../services/chatter-stats.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * A chatter's statistics: their own in the cabinet (any cookie session) and a
 * chatter's for the owner and team leads. The rules are services/chatter-stats.ts.
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
}
