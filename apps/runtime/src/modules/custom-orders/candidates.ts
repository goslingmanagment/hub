import { routeSchemas } from "@agency_hub_core/contracts";

import { agentCustomCandidates } from "../../services/custom-orders/candidates.ts";
import { beginAgentRequest, settleAgentRequest as settled, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Заказ кастома, the reader's candidates of a custom with no order (customs facts spec §8): an agent key that writes the
 * customs and reads money and messages (`write:customs` + `read:money` + `read:messages`), of its pages only. A key that
 * only writes the shooting gains nothing here. Database only.
 */
export function registerCustomCandidateRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requireAgentKeyPrincipal } = ctx.auth;

  server.get("/api/v1/agent/custom-candidates", { schema: routeSchemas.agentCustomCandidates }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, {
      operation: "agentCustomCandidates", requiredCapabilities: ["write:customs", "read:money", "read:messages"],
    });
    return settled(scope, async () => {
      const answer = await agentCustomCandidates(appContext, { pageIds: scope.pages.map((page) => page.id) });
      await writeAgentAudit(appContext.db, {
        agentKeyId: principal.agentKeyId, operation: "agentCustomCandidates", pageIds: scope.pageIds, verbatimText: true,
        requestSummary: { returned: answer.tips.length + answer.tiers.length },
      });
      return answer;
    }, (answer) => answer.tips.length + answer.tiers.length);
  });
}
