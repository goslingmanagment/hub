import { routeSchemas, type ClientSendAttributionsResponse } from "@agency_hub_core/contracts";

import { applyClientSendAttributions } from "../../services/client-send-attributions.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * send-attribution-v1: who sent each outgoing message (`clientSendAttributions`).
 * The page is in the PATH: the declared page scope resolves from `:pageLabel`
 * only. The rules are services/client-send-attributions.ts.
 */
export function registerClientSendAttributionRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.post("/api/v1/client/pages/:pageLabel/send-attributions", {
    schema: routeSchemas.clientSendAttributions,
  }, async (request): Promise<ClientSendAttributionsResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service
    // refuses a cookie session (403) and checks the page grant.
    const principal = await requirePrincipal(request);
    return applyClientSendAttributions(appContext, request, principal, {
      pageLabel: request.params.pageLabel,
      body: request.body,
    });
  });
}
