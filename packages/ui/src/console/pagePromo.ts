import type { KernelClient } from "@kernel/sdk";

/**
 * What the page sells and how (`GET /pages/:label/promo`): tiers and their promotions, gift and tracking links,
 * «Top X%» per month, Recap, polls and the automated messages — projections the daily Fansly lanes have written since
 * 2026-08. Read-only. One query for the console's «Продвижение» and Workboard's «Рассылки».
 */
export function pagePromoQuery(kernel: KernelClient, pageLabel: string) {
  return {
    meta: { suppressGlobalError: true },
    queryKey: ["pagePromo", pageLabel],
    queryFn: () => kernel.pagePromo({ params: { pageLabel } }),
    enabled: pageLabel.length > 0,
    staleTime: 5 * 60_000,
  };
}
