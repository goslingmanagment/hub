import { useQuery } from "@tanstack/react-query";
import type { SpenderListResponse } from "@agency_hub_core/contracts";
import { kernel } from "@/api/sdk";

const PAGE = 200;
const MAX_REQUESTS = 10;

export type PayerRow = SpenderListResponse["items"][number];

export interface AllPayers {
  items: PayerRow[];
  total: number;
  /** More payers than the walk reads: «Показаны первые 2 000 платящих». */
  capped: boolean;
}

export function allPayersKey(pageLabel: string) {
  return ["allPayers", pageLabel] as const;
}

/**
 * Every payer of one page, the most money first: «Ждут ответа» and «Не видны странице»
 * are looked for over all of them, not over the first screen. One request at a time,
 * a failed one fails the whole walk: a partial count is never shown.
 */
export function useAllPayers(pageLabel: string, options: { enabled?: boolean } = {}) {
  return useQuery<AllPayers>({
    queryKey: allPayersKey(pageLabel),
    queryFn: async () => {
      const items: PayerRow[] = [];
      let total = 0;
      for (let request = 0; request < MAX_REQUESTS; request += 1) {
        const answer = await kernel.spenders({
          query: {
            scope: "page",
            pageLabel,
            period: "lifetime",
            limit: PAGE,
            offset: items.length,
            sortBy: "lifetimeCreatorNetAmountMills",
            sortDir: "desc",
          } as Parameters<typeof kernel.spenders>[0]["query"],
        });
        total = answer.total;
        items.push(...answer.items);
        if (items.length >= total || answer.items.length === 0) break;
      }
      return { items, total, capped: items.length < total };
    },
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
    staleTime: 60_000,
    retry: false,
    meta: { suppressGlobalError: true },
  });
}
