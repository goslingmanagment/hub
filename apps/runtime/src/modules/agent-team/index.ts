import { routeSchemas } from "@agency_hub_core/contracts";

import { readAgentTeamSales } from "../../services/agent-team-sales.ts";
import { beginAgentRequest, withAgentTimeout, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * The team's sale facts for the agency ledger (`agentTeamSales`, ledger
 * release 2): an agent key with read:team and read:money reads the team's
 * work and every sale on its pages in a window, with the facts the ledger's
 * split rules read. No text of anyone's messages, no shift report's money:
 * facts only. Database only, read-only.
 */

/** A month of the team's work and sales is read in one statement budget. */
const AGENT_TEAM_TIMEOUT_MS = 60_000;

export function registerAgentTeamRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requireAgentKeyPrincipal } = ctx.auth;

  server.post("/api/v1/agent/team/sales", { schema: routeSchemas.agentTeamSales }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation: "agentTeamSales", requiredCapabilities: ["read:team", "read:money"] });
    let delivered = 0;
    try {
      const pages = scope.pages.map((page) => ({ id: page.id, label: page.pageLabel }));
      const from = new Date(request.body.from);
      const to = new Date(request.body.to);
      const result = await withAgentTimeout(appContext.db, AGENT_TEAM_TIMEOUT_MS, (tx) => readAgentTeamSales(tx, { from, to, now: new Date(), pages }), "agent_team_sales");
      await writeAgentAudit(appContext.db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentTeamSales",
        pageIds: pages.map((page) => page.id),
        verbatimText: false,
        // The audit's closed vocabulary (agent-read-audit.ts): the window and how many sales went out.
        requestSummary: { windowFrom: result.from, windowTo: result.to, returned: result.sales.length },
      });
      delivered = result.sales.length;
      return result;
    } finally {
      await scope.finish(delivered);
    }
  });
}
