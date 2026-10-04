import { routeSchemas, type AdminClientHealthResponse } from "@agency_hub_core/contracts";

import { requireOwner } from "../../services/auth.ts";
import { getClientHealthView } from "../../services/client-health-view.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * The owner's view of the chat extension's health (chat-extension hub-pr-plan
 * H-11c). A dashboard route: the owner's cookie session and nothing else, so no
 * device token reaches it, the extension's own least of all.
 */
export function registerClientHealthViewRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/admin/client-health", {
    schema: routeSchemas.adminClientHealth,
  }, async (request): Promise<AdminClientHealthResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return getClientHealthView(appContext, request.query);
  });
}
