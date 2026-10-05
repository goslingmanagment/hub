import { routeSchemas, type ClientSendCustodyListResponse } from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import { listClientHeldSendsForStaff } from "../../services/client-held-sends.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension H-7e: the cabinet's list of held sends and of the ones
 * resolved by hand (`clientSendCustodyList`). A dashboard route like the
 * resolve next to it (claim.ts): the owner's or a team lead's cookie session,
 * so no device token reaches it, the extension's own least of all. The page is
 * an optional filter in the query, so the route declares no page scope and the
 * service checks the page itself.
 */
export function registerClientHeldSendsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client-send-custody", {
    schema: routeSchemas.clientSendCustodyList,
  }, async (request): Promise<ClientSendCustodyListResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403.
    const principal = await requirePrincipal(request);
    return listClientHeldSendsForStaff(appContext, principal, {
      query: request.query,
      pageScope: pageScopeFor(principal),
    });
  });
}
