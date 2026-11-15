import { useQuery } from "@tanstack/react-query";
import { pagePromoQuery } from "@agency_hub_core/ui/console/pagePromo";

import { kernel } from "./sdk.js";

/** The page's promo (packages/ui console/pagePromo.ts). */
export function usePagePromo(pageLabel: string) {
  return useQuery(pagePromoQuery(kernel, pageLabel));
}
