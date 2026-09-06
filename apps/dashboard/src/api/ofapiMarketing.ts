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
/** All refreshes of this view are local reads; provider actions are separate buttons. */
export function useOfapiMarketing() {
  return useQuery({ queryKey: ["admin", "ofapi-marketing"], queryFn: () => kernel.ofapiMarketingGet(), refetchInterval: 15000, meta: { suppressGlobalError: true } });
}
