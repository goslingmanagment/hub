import { routeSchemas } from "@agency_hub_core/contracts";

import {
  actOnCustomOrder,
  createCustomOrderOnBoard,
  dismissCustomLookalike,
  readCustomOrder,
  readCustomOrdersBoard,
} from "../../services/custom-orders/index.ts";
import {
  agentCreateCustomOrder,
  agentListCustomOrders,
  agentReportCustomCards,
  agentUpdateCustomOrder,
  type AgentCustomScope,
} from "../../services/custom-orders/agent.ts";
import { beginAgentRequest, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Заказ кастома (ecosystem plan 2026-11-12, package I): the board «Кастомы» of
 * Workboard by any session (`/api/v1/custom-orders…`), and the agent key's door
 * (`/api/v1/agent/custom-orders…`, write:customs). The extension's own routes
 * stay in modules/client (fan-card.ts, handoff.ts). The routes' auth blocks
 * decide who calls; the services decide what each sees and may do. Nothing here
 * talks to a platform.
 */
export function registerCustomOrderRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;
  const db = appContext.db;

  server.get("/api/v1/custom-orders", { schema: routeSchemas.customOrdersBoard }, async (request) => {
    const principal = await requirePrincipal(request);
    return readCustomOrdersBoard(appContext, principal, request.query);
  });

  server.post("/api/v1/custom-orders", { schema: routeSchemas.customOrderCreate }, async (request) => {
    const principal = await requirePrincipal(request);
    return createCustomOrderOnBoard(appContext, principal, request.body);
  });

  server.get("/api/v1/custom-orders/:code", { schema: routeSchemas.customOrder }, async (request) => {
    const principal = await requirePrincipal(request);
    return readCustomOrder(appContext, principal, request.params.code);
  });

  server.post("/api/v1/custom-orders/:code", { schema: routeSchemas.customOrderAct }, async (request) => {
    const principal = await requirePrincipal(request);
    return actOnCustomOrder(appContext, principal, { code: request.params.code, body: request.body });
  });

  server.post("/api/v1/custom-orders/sales/:transactionRef/dismiss", { schema: routeSchemas.customSaleDismiss }, async (request) => {
    const principal = await requirePrincipal(request);
    return dismissCustomLookalike(appContext, principal, request.params.transactionRef);
  });

  // --- Agent keys (write:customs) -------------------------------------------

  async function agentScope(request: Parameters<typeof requireAgentKeyPrincipal>[0], operation: string) {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation, requiredCapabilities: ["write:customs"] });
    const customScope: AgentCustomScope = {
      principal, pages: scope.pages.map((page) => ({ id: page.id, pageLabel: page.pageLabel, platform: page.platform })),
    };
    return { principal, scope, customScope };
  }

  async function settled<T>(scope: { finish(rows: number): Promise<void> }, body: () => Promise<T>, rows: (result: T) => number = () => 1) {
    let delivered = 0;
    try {
      const result = await body();
      delivered = rows(result);
      return result;
    } finally {
      await scope.finish(delivered);
    }
  }

  server.get("/api/v1/agent/custom-orders", { schema: routeSchemas.agentCustomOrders }, async (request) => {
    const { principal, scope, customScope } = await agentScope(request, "agentCustomOrders");
    return settled(scope, async () => {
      const answer = await agentListCustomOrders(appContext, customScope, request.query);
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId, operation: "agentCustomOrders", pageIds: scope.pageIds, verbatimText: true,
        requestSummary: { returned: answer.orders.length },
      });
      return answer;
    }, (answer) => answer.orders.length);
  });

  server.post("/api/v1/agent/custom-orders", { schema: routeSchemas.agentCustomOrderCreate }, async (request) => {
    const { principal, scope, customScope } = await agentScope(request, "agentCustomOrderCreate");
    return settled(scope, async () => {
      const answer = await agentCreateCustomOrder(appContext, customScope, request.body);
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId, operation: "agentCustomOrderCreate",
        pageIds: customScope.pages.filter((page) => page.pageLabel === request.body.pageLabel).map((page) => page.id),
        verbatimText: false, requestSummary: { customOrderId: answer.order.id, outcome: answer.outcome },
      });
      return answer;
    });
  });

  server.post("/api/v1/agent/custom-orders/:code", { schema: routeSchemas.agentCustomOrderUpdate }, async (request) => {
    const { principal, scope, customScope } = await agentScope(request, "agentCustomOrderUpdate");
    return settled(scope, async () => {
      const answer = await agentUpdateCustomOrder(appContext, customScope, request.params.code, request.body);
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId, operation: "agentCustomOrderUpdate",
        pageIds: customScope.pages.filter((page) => page.pageLabel === answer.order.pageLabel).map((page) => page.id),
        verbatimText: false, requestSummary: { customOrderId: answer.order.id, outcome: answer.outcome, reasonCode: request.body.action },
      });
      return answer;
    });
  });

  server.post("/api/v1/agent/custom-orders/cards", { schema: routeSchemas.agentCustomCards }, async (request) => {
    const { principal, scope, customScope } = await agentScope(request, "agentCustomCards");
    return settled(scope, async () => {
      const answer = await agentReportCustomCards(appContext, customScope, request.body);
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId, operation: "agentCustomCards", pageIds: [], verbatimText: false,
        requestSummary: { returned: request.body.cards.length, outcome: `opened:${answer.opened}.closed:${answer.closed}` },
      });
      return answer;
    });
  });
}
