import { routeSchemas, type ClientConversationFeedResponse } from "@agency_hub_core/contracts";

import { getClientConversationFeed } from "../../services/conversation-feed.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension H-9c: the archive feed of one conversation
 * (`clientConversationFeed`). The page is in the PATH: the declared page scope
 * resolves from `:pageLabel` only, never from a query parameter.
 */
export function registerClientFeedRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/conversations/:fanRef/feed", {
    schema: routeSchemas.clientConversationFeed,
  }, async (request): Promise<ClientConversationFeedResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service
    // refuses a cookie session (403) and runs the hub's own check of the page,
    // the `preview` switch and the extension's version before it reads anything.
    const principal = await requirePrincipal(request);
    return getClientConversationFeed(appContext, request, principal, {
      pageLabel: request.params.pageLabel,
      fanRef: request.params.fanRef,
      query: request.query,
    });
  });
}
