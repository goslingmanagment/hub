import { routeSchemas, type ClientActivityResponse, type TeamShiftsResponse } from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import { listTeamShifts, recordClientActivity } from "../../services/chatter-shifts.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Chat Memory: the extension's beat (`clientActivity`, a device token's) and
 * the team's actual shifts computed from it (`teamShifts`, the owner's and a
 * team lead's cabinet). The rules are services/chatter-shifts.ts.
 */
export function registerClientActivityRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.post("/api/v1/client/activity", {
    schema: routeSchemas.clientActivity,
  }, async (request): Promise<ClientActivityResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service refuses a cookie session (403).
    const principal = await requirePrincipal(request);
    return recordClientActivity(appContext, principal, request.body);
  });

  server.get("/api/v1/team/shifts", {
    schema: routeSchemas.teamShifts,
  }, async (request): Promise<TeamShiftsResponse> => {
    const principal = await requirePrincipal(request);
    return listTeamShifts(appContext, principal, { query: request.query, pageScope: pageScopeFor(principal) });
  });
}
