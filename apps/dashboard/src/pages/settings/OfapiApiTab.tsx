import { useQuery } from "@tanstack/react-query";
import { ofapiCollectionQueryOptions } from "@/api/ofapiCollection";
import { WebhookCard } from "./collection/CollectionTab.js";
import { OfapiBannedWords } from "./OfapiBannedWords.js";
import { OfapiContentEvidence } from "./OfapiContentEvidence.js";
import { OfapiStoredReads } from "./OfapiStoredReads.js";
import { OfapiVendorEvidence } from "./OfapiVendorEvidence.js";
import { OfapiWebhookRecovery } from "./OfapiWebhookRecovery.js";

/**
 * The provider's machinery in one place: the webhook registration and its
 * recovery, the reconciliation with the vendor and the key's declared scope,
 * stored responses and events, and the banned-words dictionary. None of it
 * is a daily task, so it lives in System — not on Costs or Collection.
 */
export function OfapiApiTab() {
  const collection = useQuery(ofapiCollectionQueryOptions());
  const pages = collection.data?.pages ?? [];
  return (
    <div className="space-y-5">
      <WebhookCard />
      <section className="card card-body">
        <OfapiWebhookRecovery />
      </section>
      <OfapiVendorEvidence />
      <OfapiBannedWords />
      <OfapiContentEvidence pages={pages} />
      <OfapiStoredReads pages={pages} />
    </div>
  );
}
