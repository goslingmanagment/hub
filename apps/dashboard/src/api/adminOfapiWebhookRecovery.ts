import { useQuery } from "@tanstack/react-query";
import { kernel } from "./sdk.js";

export function useOfapiWebhookRecovery() {
  return useQuery({ queryKey: ["admin", "ofapi-webhook-recovery"],
    queryFn: async () => {
      const [policy, catalog, history] = await Promise.all([
        kernel.adminOfapiWebhookCollectionPolicy(),
        kernel.adminOfapiWebhookEventCatalog(),
        kernel.adminOfapiWebhookDeliveries({ query: { limit: 25, offset: 0 } }),
      ]);
      return { policy, history, catalog };
    }, refetchInterval: 30_000 });
}
export const ofapiWebhookRecoveryActions = {
  refreshCatalog: kernel.adminOfapiWebhookEventCatalogRefresh,
  save: kernel.adminOfapiWebhookCollectionPolicySave,
  apply: kernel.adminOfapiWebhookCollectionPolicyApply,
  scan: kernel.adminOfapiWebhookDeliverySync,
  redeliver: kernel.adminOfapiWebhookRedeliver,
  replay: kernel.adminOfapiWebhookReplay,
};
