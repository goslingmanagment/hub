import { routeSchemas, type ClientFanProfileFromGenerationResponse } from "@agency_hub_core/contracts";

import { saveClientFanProfileFromGeneration } from "../../services/client-profile-from-generation.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension H-5: saves a finished full recap as the fan's dossier, from
 * the generation the hub stored (`clientFanProfileFromGeneration`). The page
 * is in the PATH: the declared page scope resolves from `:pageLabel` only.
 */
export function registerClientProfileFromGenerationRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.post("/api/v1/client/pages/:pageLabel/fans/:fanRef/profile/from-generation", {
    schema: routeSchemas.clientFanProfileFromGeneration,
  }, async (request): Promise<ClientFanProfileFromGenerationResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service
    // refuses a cookie session (403) and runs the hub's own check of the page,
    // the `recap` switch and the extension's version before it reads anything.
    const principal = await requirePrincipal(request);
    return saveClientFanProfileFromGeneration(appContext, request, principal, {
      pageLabel: request.params.pageLabel,
      fanRef: request.params.fanRef,
      generationRef: request.body.generationRef,
      clientRequestId: request.body.clientRequestId,
    });
  });
}
