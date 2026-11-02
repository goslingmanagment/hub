import { routeSchemas, type ClientMessageAuthorsResponse, type ClientSendAttributionsResponse } from "@agency_hub_core/contracts";

import { applyClientSendAttributions, readClientMessageAuthors } from "../../services/client-send-attributions.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * send-attribution-v1: who sent each outgoing message (`clientSendAttributions`), and message-authors-v1: the same
 * record read back for one fan's chat (`clientMessageAuthors`). The page is in the PATH: the declared page scope
 * resolves from `:pageLabel` only. The rules are services/client-send-attributions.ts.
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

  server.get("/api/v1/client/pages/:pageLabel/fans/:fanRef/message-authors", {
    schema: routeSchemas.clientMessageAuthors,
  }, async (request): Promise<ClientMessageAuthorsResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service refuses a cookie session (403).
    const principal = await requirePrincipal(request);
    return readClientMessageAuthors(appContext, principal, {
      pageLabel: request.params.pageLabel,
      fanRef: request.params.fanRef,
    });
  });
}
