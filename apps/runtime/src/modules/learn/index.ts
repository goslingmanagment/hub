import { routeSchemas } from "@agency_hub_core/contracts";

import { requireHumanPrincipal } from "../../services/auth.ts";
import { approveLearnPage, readLearnPage, readLearnPages } from "../../services/learn-pages.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/** «Обучение» (products plan §2.3): the reader of the agent's `learn` pages and the owner's approval (services/learn-pages.ts). */
export function registerLearnRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/learn", { schema: routeSchemas.learnPages }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return readLearnPages(appContext, principal);
  });

  server.get("/api/v1/learn/:slug", { schema: routeSchemas.learnPage }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return readLearnPage(appContext, principal, request.params.slug);
  });

  server.post("/api/v1/learn/:slug/approval", { schema: routeSchemas.learnPageApprove }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return approveLearnPage(appContext, principal, request.params.slug, request.body.approved);
  });
}
