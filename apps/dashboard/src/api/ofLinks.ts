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

/** Every page's links, or one page's (`pageId`): the page's card asks for its own. */
export function useOfLinks(pageId?: number | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: pageId === undefined ? ["admin", "of-links"] : ["admin", "of-links", pageId],
    queryFn: () => kernel.ofLinksGet({ query: pageId === undefined ? {} : { pageId } }),
    enabled: options.enabled ?? true,
    refetchInterval: OF_LINKS_REFRESH_MS,
    placeholderData: keepPreviousData,
    meta: { suppressGlobalError: true },
  });
}
