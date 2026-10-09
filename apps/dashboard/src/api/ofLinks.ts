import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

export type OfLinksSnapshot = Awaited<ReturnType<typeof kernel.ofLinksGet>>;
export type OfLinkRow = OfLinksSnapshot["links"][number];
export type OfLinksPage = OfLinksSnapshot["pages"][number];
export type OfLinksPageKind = OfLinksPage["kinds"][number];

/** «Ссылки OnlyFans»: a local read of the link series (no vendor call). The
 * series is written four times a day, so the table refreshes every five
 * minutes and on the screen's button — never on a short poll. */
export const OF_LINKS_REFRESH_MS = 5 * 60 * 1000;

export function useOfLinks() {
  return useQuery({
    queryKey: ["admin", "of-links"],
    queryFn: () => kernel.ofLinksGet({ query: {} }),
    refetchInterval: OF_LINKS_REFRESH_MS,
    placeholderData: keepPreviousData,
    meta: { suppressGlobalError: true },
  });
}
