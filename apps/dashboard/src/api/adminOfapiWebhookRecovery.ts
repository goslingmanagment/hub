import { useQuery } from "@tanstack/react-query";
import { kernel } from "./sdk.js";

export function useOfapiWebhookRecovery(options: { offset?: number; failedOnly?: boolean } = {}) {
  const localRead = { refetchInterval: 30_000, meta: { suppressGlobalError: true } };
  const policy = useQuery({ queryKey: ["admin", "ofapi-webhook-recovery", "policy"], queryFn: () => kernel.adminOfapiWebhookCollectionPolicy(), ...localRead });
  const catalog = useQuery({ queryKey: ["admin", "ofapi-webhook-recovery", "catalog"], queryFn: () => kernel.adminOfapiWebhookEventCatalog(), ...localRead });
  const history = useQuery({ queryKey: ["admin", "ofapi-webhook-recovery", "history", options], queryFn: () => kernel.adminOfapiWebhookDeliveries({ query: { limit: 25, offset: options.offset ?? 0, ...(options.failedOnly ? { failedOnly: "true" as const } : {}) } }), ...localRead });
  return { policy, catalog, history, isFetching: policy.isFetching || catalog.isFetching || history.isFetching,
    refetch: () => Promise.all([policy.refetch(), catalog.refetch(), history.refetch()]) };
}
export const ofapiWebhookRecoveryActions = {
  refreshCatalog: kernel.adminOfapiWebhookEventCatalogRefresh,
  save: kernel.adminOfapiWebhookCollectionPolicySave,
  apply: kernel.adminOfapiWebhookCollectionPolicyApply,
  scan: kernel.adminOfapiWebhookDeliverySync,
  redeliver: kernel.adminOfapiWebhookRedeliver,
  replay: kernel.adminOfapiWebhookReplay,
};
