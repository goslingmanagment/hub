import { routeSchemas, type ClientAudienceNewResponse } from "@agency_hub_core/contracts";

import { getClientAudienceNew } from "../../services/client-audience-new.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension H-7c: who subscribed to one OnlyFans page or came back, inside
 * a window of hours (`clientAudienceNew`). The page is in the PATH: the
 * declared page scope resolves from `:pageLabel` only.
 */
export function registerClientAudienceNewRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/audience-new", {
    schema: routeSchemas.clientAudienceNew,
  }, async (request): Promise<ClientAudienceNewResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service
    // refuses a cookie session (403) and runs the hub's own check of the page,
    // the `newcomers` switch and the extension's version before it reads anything.
    const principal = await requirePrincipal(request);
    return getClientAudienceNew(appContext, request, principal, {
      pageLabel: request.params.pageLabel,
      query: request.query,
    });
  });
}
