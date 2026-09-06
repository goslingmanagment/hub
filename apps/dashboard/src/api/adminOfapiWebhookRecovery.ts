import { useQuery } from "@tanstack/react-query";
import { kernel } from "./sdk.js";

export function useOfapiWebhookRecovery() {
  return useQuery({ queryKey: ["admin", "ofapi-webhook-recovery"],
    queryFn: async () => {
      const [policy, history] = await Promise.all([
        kernel.adminOfapiWebhookCollectionPolicy(),
        kernel.adminOfapiWebhookDeliveries({ query: { limit: 25, offset: 0 } }),
      ]);
      return { policy, history };
    }, refetchInterval: 30_000 });
}
export const ofapiWebhookRecoveryActions = {
  save: kernel.adminOfapiWebhookCollectionPolicySave,
  apply: kernel.adminOfapiWebhookCollectionPolicyApply,
  scan: kernel.adminOfapiWebhookDeliverySync,
  redeliver: kernel.adminOfapiWebhookRedeliver,
  replay: kernel.adminOfapiWebhookReplay,
};
