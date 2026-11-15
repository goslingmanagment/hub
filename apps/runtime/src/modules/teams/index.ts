import { routeSchemas } from "@agency_hub_core/contracts";

import { requireHumanPrincipal } from "../../services/auth.ts";
import { addReviewNote, readReviewNotes, readTeamRoles, setTeamRole } from "../../services/team-roles.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Teams (products package T): the team records and a lead's notes on a shift review. The rules are
 * services/team-roles.ts over services/teams.ts. Database only.
 */
export function registerTeamRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/team/roles", { schema: routeSchemas.teamRoles }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return readTeamRoles(appContext, principal);
  });

  server.post("/api/v1/team/roles", { schema: routeSchemas.teamRoleSet }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return setTeamRole(appContext, principal, request.body);
  });

  server.get("/api/v1/team/review-notes", { schema: routeSchemas.reviewNotes }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return readReviewNotes(appContext, principal, request.query);
  });

  server.post("/api/v1/team/review-notes", { schema: routeSchemas.reviewNoteAdd }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return addReviewNote(appContext, principal, request.body);
  });
}
