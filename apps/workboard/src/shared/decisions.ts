import { queryOptions, useQueries } from "@tanstack/react-query";
import { kernel } from "./hub.js";
import { useMe } from "./useMe.js";

/**
 * What waits for the owner's decision (spec §4.6), from the operations Hub has
 * today. One set of query keys for the sidebar's count, the «Ждут решения» line
 * on Смены and the Решения screen itself: a decision made there moves the count
 * at once. Read at most once a minute and only while the tab is visible.
 */

const MINUTE = 60_000;

/** The longest window `teamShiftDisputes` takes (the console says «за 31 день»). */
export const DISPUTE_DAYS = 31;

/** Disputed sales of the shift reports (`teamShiftDisputes`); the owner's only. */
export const disputesQuery = queryOptions({
  queryKey: ["decisions", "disputes", DISPUTE_DAYS] as const,
  queryFn: () => kernel.teamShiftDisputes({ query: { days: DISPUTE_DAYS } }),
  staleTime: MINUTE,
});

/** Open customs of the viewer's pages (`teamCustoms`). */
export const customsQuery = queryOptions({
  queryKey: ["decisions", "customs"] as const,
  queryFn: () => kernel.teamCustoms(),
  staleTime: MINUTE,
});

/** Held sends of the chat extension (`clientSendCustodyList`, state `held`). */
export function heldSendsQuery(params: { limit: number; offset: number; pageLabel?: string } = { limit: 1, offset: 0 }) {
  return queryOptions({
    queryKey: ["decisions", "held", params] as const,
    queryFn: () => kernel.clientSendCustodyList({ query: { state: "held", ...params } }),
    staleTime: 30_000,
  });
}

export interface DecisionCounts {
  /** Disputes without a resolution; null: not read (failed, or not the owner's to see). */
  disputes: number | null;
  /** Customs paid and not delivered. */
  customs: number | null;
  /** Sends waiting for a manual resolve. */
  held: number | null;
  /** The sum of what answered: the sidebar's number. */
  total: number;
  loading: boolean;
}

export function useDecisionCounts(): DecisionCounts {
  const { isOwner, user } = useMe();
  const signedIn = user !== undefined;
  const [disputes, customs, held] = useQueries({
    queries: [
      { ...disputesQuery, enabled: isOwner, refetchInterval: MINUTE },
      { ...customsQuery, enabled: signedIn, refetchInterval: MINUTE },
      { ...heldSendsQuery(), enabled: signedIn, refetchInterval: MINUTE },
    ],
  });
  const counts = {
    disputes: disputes.data ? disputes.data.disputes.filter((dispute) => dispute.resolution === null).length : null,
    customs: customs.data ? customs.data.customs.filter((custom) => custom.state === "paid").length : null,
    held: held.data ? held.data.total : null,
  };
  return {
    ...counts,
    total: (counts.disputes ?? 0) + (counts.customs ?? 0) + (counts.held ?? 0),
    loading: disputes.isLoading || customs.isLoading || held.isLoading,
  };
}
