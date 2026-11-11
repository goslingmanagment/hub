import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MoneyBudgetPlansBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

const BUDGETS_QUERY_KEY = ["admin", "money-budgets"] as const;

/** Деньги → Бюджеты: every month of the agency's budget from the ledger, with each page's turnover. */
export function useMoneyBudgets() {
  return useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: () => kernel.adminMoneyBudgets(),
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalError: true },
  });
}

/** The owner's plans of budget items, written to the ledger; the budget is read again after. */
export function useSetBudgetPlans() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: MoneyBudgetPlansBody) => kernel.adminMoneyBudgetPlansSet({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY }),
  });
}
