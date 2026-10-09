import { useQuery } from "@tanstack/react-query";
import { kernel } from "./sdk.js";

export type MarketingDashboard = Awaited<ReturnType<typeof kernel.ofapiMarketingGet>>;
export type MarketingIntent = Awaited<ReturnType<typeof kernel.ofapiMarketingPrepare>>;
export const marketingActions = {
  rebuild: () => kernel.ofapiMarketingRebuild({ body: {} }),
  prepare: (body: Parameters<typeof kernel.ofapiMarketingPrepare>[0]["body"]) => kernel.ofapiMarketingPrepare({ body }),
  dispatch: (id: string, body: Parameters<typeof kernel.ofapiMarketingDispatch>[0]["body"]) => kernel.ofapiMarketingDispatch({ params: { id }, body }),
  postbacks: (body: Parameters<typeof kernel.ofapiMarketingPostbacksRefresh>[0]["body"]) => kernel.ofapiMarketingPostbacksRefresh({ body }),
  collect: (body: Parameters<typeof kernel.ofapiCollectionJobCreate>[0]["body"]) => kernel.ofapiCollectionJobCreate({ body }),
};

/** An action whose outcome the server is still settling: sent and not yet
 * answered, or confirmed with its accounting or projection still pending. */
export function marketingActionInFlight(intents: MarketingDashboard["intents"] | undefined): boolean {
  return (intents ?? []).some((intent) =>
    intent.state === "dispatching"
    || (intent.state === "succeeded" && (intent.accountingState === "pending" || intent.projectionState === "pending")));
}

export const MARKETING_POLL_MS = 15_000;

/** The marketing read's refetch interval for the latest data: 15 s while
 * `poll` holds of it, else none. */
export function marketingRefetchInterval(poll: ((data: MarketingDashboard | undefined) => boolean) | undefined) {
  return (query: { state: { data: MarketingDashboard | undefined } }) =>
    (poll?.(query.state.data) === true ? MARKETING_POLL_MS : false);
}

/** All refreshes of this view are local reads; provider actions are separate
 * buttons. Read once; polled every 15 s only while `poll` says so of the
 * latest data — the screen asks for it while the Smart Links block is open
 * and an action is in flight. */
export function useOfapiMarketing(options: { poll?: (data: MarketingDashboard | undefined) => boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "ofapi-marketing"],
    queryFn: () => kernel.ofapiMarketingGet(),
    refetchInterval: marketingRefetchInterval(options.poll),
    meta: { suppressGlobalError: true },
  });
}
