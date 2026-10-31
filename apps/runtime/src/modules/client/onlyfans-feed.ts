import { routeSchemas, type ClientOnlyfansFeedResponse } from "@agency_hub_core/contracts";

import { applyClientOnlyfansFeed } from "../../services/client-onlyfans-feed.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/** A report of 200 records with long texts stays under it; Fastify's default 1 MiB does not. */
const ONLYFANS_FEED_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * onlyfans-feed-v1: what an OnlyFans page's ChatSpace already received
 * (`clientOnlyfansFeed`). The page is in the PATH: the declared page scope
 * resolves from `:pageLabel` only. The rules are services/client-onlyfans-feed.ts.
 */
export function registerClientOnlyfansFeedRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.post("/api/v1/client/pages/:pageLabel/onlyfans-feed", {
    schema: routeSchemas.clientOnlyfansFeed,
    bodyLimit: ONLYFANS_FEED_BODY_LIMIT_BYTES,
  }, async (request): Promise<ClientOnlyfansFeedResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service
    // refuses a cookie session (403) and checks the page, its switch and its account.
    const principal = await requirePrincipal(request);
    return applyClientOnlyfansFeed(appContext, request, principal, {
      pageLabel: request.params.pageLabel,
      body: request.body,
    });
  });
}
