import { routeSchemas } from "@agency_hub_core/contracts";

import { requireHumanPrincipal } from "../../services/auth.ts";
import { readSaleChain, type ChainViewer } from "../../services/sale-chain.ts";
import { beginAgentRequest, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Цепочка продажи (ecosystem plan 2026-11-12, package T): one read (services/sale-chain.ts) behind two doors — a
 * person's session (the narrow one the extension opens too: the shift screen's lines) and an agent key with read:team
 * and read:money, cut to its pages and never with pay sums. Database and the ledger's reads the payout panel and
 * «Выплаты → Отчёты» already make.
 */
export function registerSaleChainRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;

  server.get("/api/v1/sales/chain", { schema: routeSchemas.saleChain }, async (request) => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    // A narrow session (opened from the extension) reads as a chatter whatever the role.
    const role = principal.narrowDeviceTokenId === undefined ? principal.user.role : "chatter";
    const viewer: ChainViewer = role === "owner"
      ? { kind: "owner" }
      : role === "team_lead"
        ? { kind: "team_lead", pageIds: principal.assignedPageIds }
        : { kind: "chatter", userId: principal.user.id, pageIds: principal.assignedPageIds };
    return readSaleChain(appContext, viewer, request.query);
  });

  server.get("/api/v1/agent/team/sale-chain", { schema: routeSchemas.agentSaleChain }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation: "agentSaleChain", requiredCapabilities: ["read:team", "read:money"] });
    let delivered = 0;
    try {
      const pageIds = scope.pages.map((page) => page.id);
      const chain = await readSaleChain(appContext, { kind: "agent", pageIds }, {
        saleId: request.query.saleRef === undefined ? undefined : Number(request.query.saleRef),
        pageLabel: request.query.pageLabel,
        transactionRef: request.query.transactionRef,
      });
      await writeAgentAudit(appContext.db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentSaleChain",
        pageIds: scope.pages.filter((page) => page.pageLabel === chain.sale.pageLabel).map((page) => page.id),
        verbatimText: false,
        requestSummary: { returned: 1 },
      });
      delivered = 1;
      return chain;
    } finally {
      await scope.finish(delivered);
    }
  });
}
