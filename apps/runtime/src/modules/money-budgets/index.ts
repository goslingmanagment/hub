import { routeSchemas } from "@agency_hub_core/contracts";

import { readMoneyBudgets, setMoneyBudgetPlans } from "../../services/ledger-budgets.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Деньги → Бюджеты from the agency ledger (`adminMoneyBudgets`): the budget by
 * month — in and out by item, the plans, the pages' turnover — read with Hub's
 * budgets key; and the owner's plans of the items (`adminMoneyBudgetPlansSet`),
 * written to the ledger with the same key. Owner session only (the routes' auth).
 */
export function registerMoneyBudgetsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;

  server.get("/api/v1/admin/money/budgets", { schema: routeSchemas.adminMoneyBudgets }, async () => {
    return readMoneyBudgets(appContext);
  });

  server.post("/api/v1/admin/money/budgets/plans", { schema: routeSchemas.adminMoneyBudgetPlansSet }, async (request) => {
    return setMoneyBudgetPlans(appContext, request.body);
  });
}
