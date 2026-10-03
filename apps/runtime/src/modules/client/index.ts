import { routeSchemas, type ClientBootstrapResponse } from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import { requireApiKeyUser } from "../../services/auth.ts";
import { buildClientBootstrap } from "../../services/client-bootstrap.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * The chat extension's routes under `/api/v1/client/` (chat-extension
 * architecture §8). Every handler of a client route lives in this module; the
 * schemas live in `packages/contracts/src/routes-client.ts`.
 */
export function registerClientRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/bootstrap", {
    schema: routeSchemas.clientBootstrap,
  }, async (request): Promise<ClientBootstrapResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403 (requireHumanPrincipal).
    const principal = await requirePrincipal(request);
    // A cookie session → 403: the bootstrap is a client's, not the dashboard's.
    requireApiKeyUser(principal);
    return buildClientBootstrap(appContext, {
      user: principal.user,
      pageIds: pageScopeFor(principal) ?? null,
    });
  });
}
