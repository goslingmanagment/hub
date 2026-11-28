import { routeSchemas, type AccountPotsResponse } from "@agency_hub_core/contracts";

import { readAccountPots } from "../../services/pots-mine.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * «Из общака» on «Сегодня»: the caller's own share of the Workboard pots (services/pots-mine.ts). Any cookie session,
 * the extension's narrow one too; the person is the session user's, found through the people registry, never one named
 * in the request. Nothing is written anywhere.
 */
export function registerAccountPotsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/account/pots", {
    schema: routeSchemas.accountPots,
  }, async (request): Promise<AccountPotsResponse> => {
    const principal = await requirePrincipal(request);
    return readAccountPots(appContext, principal, request.query);
  });
}
