import { useQuery } from "@tanstack/react-query";
import { kernel } from "@/api/sdk";
import type { PayerRow } from "../useAllPayers.js";

/**
 * One fan's row of the payers' list: his chat, «the page does not see him», his
 * last purchase. `spenders` finds by an occurrence of the number, so only the exact
 * row counts. Without a page: the platform's list over every page.
 */
export function useFanRow(input: { pageLabel: string | null; platform: string; platformUserId: string }, options: { enabled?: boolean } = {}) {
  const { pageLabel, platform, platformUserId } = input;
  return useQuery<PayerRow | null>({
    queryKey: ["fanRow", pageLabel, platform, platformUserId],
    queryFn: async () => {
      const answer = await kernel.spenders({
        query: (pageLabel
          ? { scope: "page", pageLabel, period: "lifetime", query: platformUserId, limit: 20 }
          : { scope: "agency", platform, period: "lifetime", query: platformUserId, limit: 20 }) as Parameters<typeof kernel.spenders>[0]["query"],
      });
      return answer.items.find((item) => item.fan.platformUserId === platformUserId) ?? null;
    },
    enabled: (options.enabled ?? true) && platformUserId.length > 0,
    staleTime: 60_000,
    meta: { suppressGlobalError: true },
  });
}

/** A Fansly fan who never paid: his chat from the followers' list. */
export function useFollowerChat(pageLabel: string, platformUserId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["followerChat", pageLabel, platformUserId],
    queryFn: async () => {
      const answer = await kernel.pageFollowers({ params: { pageLabel }, query: { query: platformUserId, limit: 5 } });
      return answer.items.find((item) => item.platformUserId === platformUserId) ?? null;
    },
    enabled,
    staleTime: 60_000,
    meta: { suppressGlobalError: true },
  });
}
