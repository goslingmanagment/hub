import { routeSchemas, type ClientAiUsageResponse } from "@agency_hub_core/contracts";

import { getClientAiUsageReport } from "../../services/ai-usage.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension H-15: the caller's own AI spend on one page, by day
 * (`clientAiUsageDaily`). The page is in the PATH: the declared page scope
 * resolves from `:pageLabel` only, never from a query parameter.
 */
export function registerClientAiUsageRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/ai-usage", {
    schema: routeSchemas.clientAiUsageDaily,
  }, async (request): Promise<ClientAiUsageResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service
    // refuses a cookie session (403) and runs the hub's own check of the page,
    // the master switch and the extension's version before it reads anything.
    const principal = await requirePrincipal(request);
    return getClientAiUsageReport(appContext, request, principal, {
      pageLabel: request.params.pageLabel,
      query: request.query,
    });
  });
}
