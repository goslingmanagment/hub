import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OfLinkSourcePutBody } from "@agency_hub_core/contracts";

import { OF_LINKS_REFRESH_MS } from "./ofLinks.js";
import { kernel } from "./sdk.js";

// The page of one OnlyFans link: its fans (the walks of its lists, read
// locally) and its source when it has none. No request reaches OnlyFans.

export const OF_LINK_FANS_PAGE = 20;

type LinkKey = { pageId: number; linkKind: "tracking" | "trial"; linkRef: string };

/** One link's fans, 20 at a time: each next page is the next 20 («Показать ещё»). */
export function useOfLinkFans(link: LinkKey, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: ["admin", "of-links", "fans", link],
    queryFn: ({ pageParam }) => kernel.ofLinkFansGet({ query: { ...link, limit: OF_LINK_FANS_PAGE, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.offset + last.fans.length < last.total ? last.offset + last.fans.length : undefined),
    enabled: options.enabled ?? true,
    refetchInterval: OF_LINKS_REFRESH_MS,
    meta: { suppressGlobalError: true },
  });
}

/** Whether the link ever had a source, the proposal, and every source to choose from. */
export function useOfLinkSource(link: LinkKey, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "of-links", "source", link],
    queryFn: () => kernel.ofLinkSourceGet({ query: link }),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    meta: { suppressGlobalError: true },
  });
}

/** The link's first source: then every read of the links refreshes (the page's facts, the sources screen). */
export function useSetOfLinkSource() {
  const client = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: OfLinkSourcePutBody) => kernel.ofLinkSourcePut({ body }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin", "of-links"] }),
  });
}
