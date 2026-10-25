import { routeSchemas, type TeamEmptyHoursResponse, type TeamGreetingsResponse } from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import { readTeamEmptyHours, readTeamGreetings } from "../../services/team-coverage.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Chat Memory week 6, «Команда → Покрытие»: empty hours (`teamEmptyHours`),
 * greetings of new subscribers and replies to broadcasts (`teamGreetings`).
 * The owner's and a team lead's cabinet; the rules are services/team-coverage.ts.
 */
export function registerTeamCoverageRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/team/empty-hours", {
    schema: routeSchemas.teamEmptyHours,
  }, async (request): Promise<TeamEmptyHoursResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamEmptyHours(appContext, principal, { query: request.query, pageScope: pageScopeFor(principal) });
  });

  server.get("/api/v1/team/greetings", {
    schema: routeSchemas.teamGreetings,
  }, async (request): Promise<TeamGreetingsResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamGreetings(appContext, principal, { query: request.query, pageScope: pageScopeFor(principal) });
  });
}
