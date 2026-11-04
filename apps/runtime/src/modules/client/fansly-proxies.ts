import { routeSchemas, type ClientFanslyProxiesResponse } from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import { readClientFanslyProxies } from "../../services/client-fansly-proxies.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * fansly-proxies-v1: the proxies of the caller's Fansly pages, with their logins (`clientFanslyProxies`). The rules are
 * services/client-fansly-proxies.ts.
 */
export function registerClientFanslyProxyRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/fansly-proxies", {
    schema: routeSchemas.clientFanslyProxies,
  }, async (request, reply): Promise<ClientFanslyProxiesResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service refuses a cookie session (403).
    const principal = await requirePrincipal(request);
    // Credentials: nothing between the hub and the extension keeps a copy.
    void reply.header("cache-control", "no-store");
    return readClientFanslyProxies(appContext, principal, pageScopeFor(principal) ?? null);
  });
}
