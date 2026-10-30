import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/**
 * What the page sells and how (`GET /pages/:label/promo`): tiers and their
 * promotions, gift and tracking links, «Top X%» per month, Recap, polls and the
 * automated messages — projections the daily Fansly lanes have written since
 * 2026-08. Read-only.
 */
export function usePagePromo(pageLabel: string) {
  return useQuery({
    meta: { suppressGlobalError: true },
    queryKey: ["pagePromo", pageLabel],
    queryFn: () => kernel.pagePromo({ params: { pageLabel } }),
    enabled: pageLabel.length > 0,
    staleTime: 5 * 60_000,
  });
}

export type MassMessageList = "all" | "live" | "scheduled" | "deleted";

/** The page's mass messages with delivery, reads and sales (`GET /pages/:label/mass-messages`). */
export function usePageMassMessages(pageLabel: string, list: MassMessageList, limit: number, offset: number) {
  return useQuery({
    meta: { suppressGlobalError: true },
    queryKey: ["pageMassMessages", pageLabel, list, limit, offset],
    queryFn: () => kernel.pageMassMessages({ params: { pageLabel }, query: { list, limit, offset } }),
    enabled: pageLabel.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}
