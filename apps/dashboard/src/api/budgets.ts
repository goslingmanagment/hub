import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/** The owner's «Бюджеты»: every month of the agency as the agency ledger counts it. */
export function useAdminBudgets() {
  return useQuery({
    queryKey: ["admin", "budgets"] as const,
    queryFn: () => kernel.adminBudgets(),
    meta: { suppressGlobalError: true },
  });
}
