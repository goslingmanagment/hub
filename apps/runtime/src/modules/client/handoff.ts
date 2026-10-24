import { routeSchemas, type ClientHandoffResponse } from "@agency_hub_core/contracts";

import { readClientHandoff } from "../../services/client-handoff.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/** Chat Memory week 3: the shift handoff of a page (`clientHandoff`). The rules are services/client-handoff.ts. */
export function registerClientHandoffRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/handoff", {
    schema: routeSchemas.clientHandoff,
  }, async (request): Promise<ClientHandoffResponse> => {
    const principal = await requirePrincipal(request);
    return readClientHandoff(appContext, principal, { pageLabel: request.params.pageLabel });
  });
}
