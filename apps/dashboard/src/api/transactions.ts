import { useQuery } from "@tanstack/react-query";
import type { CrossPageTransactionListQuery } from "@agency_hub_core/contracts";
import { kernel } from "./sdk.js";

export function useRevenueTransactions(
  query: CrossPageTransactionListQuery | undefined,
) {
  return useQuery({
    queryKey: ["revenueTransactions", query],
    queryFn: () => kernel.crossPageTransactions({ query: query! }),
    enabled: query !== undefined,
    meta: { suppressGlobalError: true },
  });
}
