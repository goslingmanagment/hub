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
    // Another filter or page of the list: the rows on screen stay, dimmed, until the answer.
    placeholderData: (previous) => previous,
    meta: { suppressGlobalError: true },
  });
}
