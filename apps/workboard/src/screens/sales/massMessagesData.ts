import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { pagePromoQuery } from "@agency_hub_core/ui/console/pagePromo";
import { kernel } from "@/shared/hub";

/** The page's promo: the automated messages beside its mass messages (owner's read). */
export function usePagePromo(pageLabel: string) {
  return useQuery(pagePromoQuery(kernel, pageLabel));
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
