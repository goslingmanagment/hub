import { routeSchemas, type ClientConversationRecapsResponse } from "@agency_hub_core/contracts";

import { getClientConversationRecaps } from "../../services/client-recaps.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension H-13: the shared full and short recap of one fan on one page,
 * with their text (`clientConversationRecaps`). The page is in the PATH: the
 * declared page scope resolves from `:pageLabel` only.
 */
export function registerClientRecapRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/conversations/:fanRef/recaps", {
    schema: routeSchemas.clientConversationRecaps,
  }, async (request): Promise<ClientConversationRecapsResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service
    // refuses a cookie session (403) and runs the hub's own check of the page,
    // the `recap` switch and the extension's version before it reads anything.
    const principal = await requirePrincipal(request);
    return getClientConversationRecaps(appContext, request, principal, {
      pageLabel: request.params.pageLabel,
      fanRef: request.params.fanRef,
      personaDefinitionId: request.query.personaDefinitionId,
    });
  });
}
