import { routeSchemas, type ClientFanCardResponse, type ClientFanLinkDecideResponse } from "@agency_hub_core/contracts";

import { decideClientFanLink, readClientFanCard } from "../../services/fan-card.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Chat Memory week 2: the fan's card across pages (`clientFanCard`) and the
 * «same person» decision (`clientFanLinkDecide`). The page is in the PATH: the
 * declared page scope resolves from `:pageLabel` only. The rules are
 * services/fan-card.ts.
 */
export function registerClientFanCardRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/fans/:fanRef/card", {
    schema: routeSchemas.clientFanCard,
  }, async (request): Promise<ClientFanCardResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service refuses a cookie session (403).
    const principal = await requirePrincipal(request);
    return readClientFanCard(appContext, principal, { pageLabel: request.params.pageLabel, fanRef: request.params.fanRef });
  });

  server.post("/api/v1/client/pages/:pageLabel/fans/:fanRef/links", {
    schema: routeSchemas.clientFanLinkDecide,
  }, async (request): Promise<ClientFanLinkDecideResponse> => {
    const principal = await requirePrincipal(request);
    return decideClientFanLink(appContext, principal, {
      pageLabel: request.params.pageLabel,
      fanRef: request.params.fanRef,
      body: request.body,
    });
  });
}
