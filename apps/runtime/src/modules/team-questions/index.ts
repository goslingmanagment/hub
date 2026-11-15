import { routeSchemas } from "@agency_hub_core/contracts";

import { requireHumanPrincipal } from "../../services/auth.ts";
import { answerQuestion, askTeamQuestion, closeQuestion, readTeamQuestions, readTeamSwaps, revokeSwap } from "../../services/team-questions.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Вопросы тому, кто решает (products plan §4.6): a person's session asks, reads and closes; the decider answers from a
 * full session. The rules are services/team-questions.ts over services/teams.ts. Database only.
 */
export function registerTeamQuestionRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/team/questions", { schema: routeSchemas.teamQuestions }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return readTeamQuestions(appContext, principal, request.query);
  });

  server.post("/api/v1/team/questions", { schema: routeSchemas.teamQuestionAsk }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return askTeamQuestion(appContext, principal, request.body);
  });

  server.post("/api/v1/team/questions/:id/answer", { schema: routeSchemas.teamQuestionAnswer }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return answerQuestion(appContext, principal, request.params.id, request.body);
  });

  server.post("/api/v1/team/questions/:id/close", { schema: routeSchemas.teamQuestionClose }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return closeQuestion(appContext, principal, request.params.id, request.body);
  });

  // «Подмена» (products package W): the approved swaps on «График», and the decider's take-back before the day.
  server.get("/api/v1/team/swaps", { schema: routeSchemas.teamSwaps }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return readTeamSwaps(appContext, principal);
  });

  server.post("/api/v1/team/questions/:id/swap/revoke", { schema: routeSchemas.teamSwapRevoke }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return revokeSwap(appContext, principal, request.params.id);
  });
}
