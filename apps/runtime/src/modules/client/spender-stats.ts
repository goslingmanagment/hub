import { routeSchemas, type ClientSpenderStatsResponse } from "@agency_hub_core/contracts";

import { getClientSpenderStats } from "../../services/spender-stats.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension H-8b: the Spenders statistics of one page
 * (`clientSpenderStats`). The page is in the PATH: the declared page scope
 * resolves from `:pageLabel` only.
 */
export function registerClientSpenderStatsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/spenders/stats", {
    schema: routeSchemas.clientSpenderStats,
  }, async (request): Promise<ClientSpenderStatsResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service
    // refuses a cookie session (403) and runs the hub's own check of the page,
    // the `stats` switch and the extension's version before it reads anything,
    // its cache included.
    const principal = await requirePrincipal(request);
    return getClientSpenderStats(appContext, request, principal, {
      pageLabel: request.params.pageLabel,
      query: request.query,
    });
  });
}
