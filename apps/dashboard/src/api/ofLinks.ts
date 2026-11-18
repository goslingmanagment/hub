import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

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

/** Link totals by channel (source) over Moscow days `from`…`to` (both left out:
 * all the series has), with every segment's days when `days` is set. */
export function useOfLinkChannels(range: { from?: string; to?: string; days?: boolean }) {
  const query = {
    ...(range.from === undefined ? {} : { from: range.from }),
    ...(range.to === undefined ? {} : { to: range.to }),
    ...(range.days ? { days: true } : {}),
  };
  return useQuery({
    queryKey: ["admin", "of-links", "channels", query],
    queryFn: () => kernel.ofLinksChannelsGet({ query }),
    refetchInterval: OF_LINKS_REFRESH_MS,
    placeholderData: keepPreviousData,
    meta: { suppressGlobalError: true },
  });
}

/** One link's business days over Moscow days `from`…`to` (the page of one link). */
export function useOfLinkHistory(query: { pageId: number; linkKind: "tracking" | "trial"; linkRef: string; from: string; to: string }, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "of-links", "history", query],
    queryFn: () => kernel.ofLinksHistoryGet({ query }),
    enabled: options.enabled ?? true,
    refetchInterval: OF_LINKS_REFRESH_MS,
    placeholderData: keepPreviousData,
    meta: { suppressGlobalError: true },
  });
}
