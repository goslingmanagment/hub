import { routeSchemas, type ClientInConversationResponse } from "@agency_hub_core/contracts";

import { readClientInConversation } from "../../services/client-in-conversation.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Chat Memory: «в разговоре» (`clientInConversation`). The page is in the PATH:
 * the declared page scope resolves from `:pageLabel` only. The rules are
 * services/client-in-conversation.ts.
 */
export function registerClientInConversationRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/in-conversation", {
    schema: routeSchemas.clientInConversation,
  }, async (request): Promise<ClientInConversationResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service refuses a cookie session (403).
    const principal = await requirePrincipal(request);
    return readClientInConversation(appContext, principal, { pageLabel: request.params.pageLabel });
  });
}
