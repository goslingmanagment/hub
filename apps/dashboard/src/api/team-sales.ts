import { queryOptions, useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/**
 * Chat Memory week 6 «Продажи»: PPV conversion by page, chatter and price
 * (`teamSalesPpv`). The owner's and a team lead's cookie session; the hub
 * scopes it to the pages the viewer reaches.
 */
export function useTeamSalesPpv(days: number) {
  return useQuery(queryOptions({
    queryKey: ["team-sales-ppv", days] as const,
    queryFn: () => kernel.teamSalesPpv({ query: { days } }),
    meta: { suppressGlobalError: true },
    placeholderData: (previous) => previous,
  }));
}
