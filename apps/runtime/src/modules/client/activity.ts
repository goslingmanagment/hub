import {
  routeSchemas,
  type ClientActivityResponse,
  type TeamAuthorshipResponse,
  type TeamChatterNumbersResponse,
  type TeamCustomsResponse,
  type TeamShiftsResponse,
} from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import { listTeamShifts, recordClientActivity } from "../../services/chatter-shifts.ts";
import { readTeamChatterNumbers } from "../../services/chatter-numbers.ts";
import { readTeamAuthorship } from "../../services/team-authorship.ts";
import { readTeamCustoms } from "../../services/team-customs.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Chat Memory: the extension's beat (`clientActivity`, a device token's) and
 * the team's actual shifts computed from it (`teamShifts`, the owner's and a
 * team lead's cabinet). The rules are services/chatter-shifts.ts. Beside them,
 * the share of each page's messages with an author (`teamAuthorship`,
 * services/team-authorship.ts).
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

  server.get("/api/v1/team/authorship", {
    schema: routeSchemas.teamAuthorship,
  }, async (request): Promise<TeamAuthorshipResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamAuthorship(appContext, principal, { query: request.query, pageScope: pageScopeFor(principal) });
  });

  server.get("/api/v1/team/customs", {
    schema: routeSchemas.teamCustoms,
  }, async (request): Promise<TeamCustomsResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamCustoms(appContext, principal, { pageScope: pageScopeFor(principal) });
  });

  server.get("/api/v1/team/chatter-numbers", {
    schema: routeSchemas.teamChatterNumbers,
  }, async (request): Promise<TeamChatterNumbersResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamChatterNumbers(appContext, principal, { from: request.query.from, to: request.query.to, pageScope: pageScopeFor(principal) });
  });
}
