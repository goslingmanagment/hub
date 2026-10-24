import {
  routeSchemas,
  type ClientWinBackAttemptResponse,
  type ClientWinBackResponse,
  type TeamWinBackApproachesResponse,
  type TeamWinBackResultsResponse,
} from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import {
  readClientWinBack,
  readTeamWinBackApproaches,
  readTeamWinBackResults,
  recordClientWinBackAttempt,
  saveTeamWinBackApproach,
} from "../../services/win-back.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Chat Memory week 3: win back — the extension's list and pick, the team's
 * results and the owner's approaches. The rules are services/win-back.ts.
 */
export function registerClientWinBackRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/win-back", {
    schema: routeSchemas.clientWinBack,
  }, async (request): Promise<ClientWinBackResponse> => {
    const principal = await requirePrincipal(request);
    return readClientWinBack(appContext, principal, { pageLabel: request.params.pageLabel });
  });

  server.post("/api/v1/client/pages/:pageLabel/win-back/attempts", {
    schema: routeSchemas.clientWinBackAttempt,
  }, async (request): Promise<ClientWinBackAttemptResponse> => {
    const principal = await requirePrincipal(request);
    return recordClientWinBackAttempt(appContext, request, principal, { pageLabel: request.params.pageLabel, body: request.body });
  });

  server.get("/api/v1/team/win-back/results", {
    schema: routeSchemas.teamWinBackResults,
  }, async (request): Promise<TeamWinBackResultsResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamWinBackResults(appContext, principal, { query: request.query, pageScope: pageScopeFor(principal) });
  });

  server.get("/api/v1/team/win-back/approaches", {
    schema: routeSchemas.teamWinBackApproaches,
  }, async (request): Promise<TeamWinBackApproachesResponse> => {
    const principal = await requirePrincipal(request);
    return readTeamWinBackApproaches(appContext, principal);
  });

  server.post("/api/v1/team/win-back/approaches", {
    schema: routeSchemas.teamWinBackApproachSave,
  }, async (request): Promise<TeamWinBackApproachesResponse> => {
    const principal = await requirePrincipal(request);
    return saveTeamWinBackApproach(appContext, principal, request.body);
  });
}
