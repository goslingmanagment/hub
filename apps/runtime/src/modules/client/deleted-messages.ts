import { routeSchemas, type ClientDeletedMessagesResponse } from "@agency_hub_core/contracts";

import { readClientDeletedMessages } from "../../services/client-deleted-messages.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * deleted-messages-v1: the fan's deleted messages of a page, with the text the hub kept (`clientDeletedMessages`). The
 * page is in the PATH: the declared page scope resolves from `:pageLabel` only. The rules are
 * services/client-deleted-messages.ts.
 */
export function registerClientDeletedMessageRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/fans/:fanRef/deleted-messages", {
    schema: routeSchemas.clientDeletedMessages,
  }, async (request): Promise<ClientDeletedMessagesResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service refuses a cookie session (403).
    const principal = await requirePrincipal(request);
    return readClientDeletedMessages(appContext, principal, {
      pageLabel: request.params.pageLabel,
      fanRef: request.params.fanRef,
    });
  });
}
