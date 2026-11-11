import { routeSchemas, type ClientFanBadgesResponse } from "@agency_hub_core/contracts";

import { recordClientFanBadges } from "../../services/client-fan-badges.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension's fan badges: FBuddy's spending tier and Fansly's «Recent
 * Spender» mark of the page's fans, as a chatter's browser read them. The
 * rules are services/client-fan-badges.ts.
 */
export function registerClientFanBadgesRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.post("/api/v1/client/pages/:pageLabel/fan-badges", {
    schema: routeSchemas.clientFanBadges,
  }, async (request): Promise<ClientFanBadgesResponse> => {
    const principal = await requirePrincipal(request);
    return recordClientFanBadges(appContext, request, principal, { pageLabel: request.params.pageLabel, body: request.body });
  });
}
