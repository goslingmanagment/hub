import { routeSchemas, type ClientSpenderAwaitingReplyResponse } from "@agency_hub_core/contracts";

import { getClientSpenderAwaitingReply } from "../../services/spender-awaiting-reply.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension H-8c: the awaiting-reply queue of one page
 * (`clientSpenderAwaitingReply`). The page is in the PATH: the declared page
 * scope resolves from `:pageLabel` only, never from a query parameter.
 */
export function registerClientSpenderAwaitingReplyRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/spenders/awaiting-reply", {
    schema: routeSchemas.clientSpenderAwaitingReply,
  }, async (request): Promise<ClientSpenderAwaitingReplyResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service
    // refuses a cookie session (403) and runs the hub's own check of the page,
    // the `stats` switch and the extension's version before it reads anything
    // or looks at a cursor.
    const principal = await requirePrincipal(request);
    return getClientSpenderAwaitingReply(appContext, request, principal, {
      pageLabel: request.params.pageLabel,
      query: request.query,
    });
  });
}
