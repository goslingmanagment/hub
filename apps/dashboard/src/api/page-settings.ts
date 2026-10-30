import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/**
 * The page's Fansly settings and standing (`GET /pages/:label/settings`, 0338):
 * each setting's current answer and its earlier ones, read once a day.
 */
export function usePageSettings(pageLabel: string) {
  return useQuery({
    meta: { suppressGlobalError: true },
    queryKey: ["pageSettings", pageLabel],
    queryFn: () => kernel.pageSettings({ params: { pageLabel } }),
    enabled: pageLabel.length > 0,
    staleTime: 5 * 60_000,
  });
}
