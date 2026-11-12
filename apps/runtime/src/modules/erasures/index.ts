import { routeSchemas } from "@agency_hub_core/contracts";

import { readErasuresFeed } from "../../services/erasure/feed.ts";
import { beginAgentRequest, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Стирание фана, the ledger's door (services/erasure/feed.ts): the fan erasures Hub completed, after a cursor, read by
 * the ledger's key with the capabilities of its shift reports' feed (read:team and read:money), cut to its pages. The
 * erasure itself stays the owner's CLI act (`erasure:run`); no door here starts, plans or changes one.
 */
export function registerErasureRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requireAgentKeyPrincipal } = ctx.auth;

  server.get("/api/v1/agent/erasures", { schema: routeSchemas.agentErasuresFeed }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation: "agentErasuresFeed", requiredCapabilities: ["read:team", "read:money"] });
    let delivered = 0;
    try {
      const pageIds = scope.pages.map((page) => page.id);
      const feed = await readErasuresFeed(appContext, { pageIds, since: request.query.since, limit: request.query.limit });
      await writeAgentAudit(appContext.db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentErasuresFeed",
        pageIds,
        verbatimText: false,
        requestSummary: { returned: feed.erasures.length },
      });
      delivered = feed.erasures.length;
      return feed;
    } finally {
      await scope.finish(delivered);
    }
  });
}
