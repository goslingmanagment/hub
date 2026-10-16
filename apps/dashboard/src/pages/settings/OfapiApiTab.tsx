import { useQuery } from "@tanstack/react-query";
import { ofapiCollectionQueryOptions } from "@/api/ofapiCollection";
import { WebhookCard } from "./collection/CollectionTab.js";
import { DisclosureCard } from "./collection/DisclosureCard.js";
import { OfapiBannedWords } from "./OfapiBannedWords.js";
import { OfapiContentEvidence } from "./OfapiContentEvidence.js";
import { OfapiStoredReads } from "./OfapiStoredReads.js";
import { OfapiVendorEvidence } from "./OfapiVendorEvidence.js";
import { OfapiWebhookRecovery } from "./OfapiWebhookRecovery.js";

/**
 * The provider's machinery in one place: the webhook registration and its
 * recovery, the reconciliation with the vendor and the key's declared scope,
 * stored responses and events, and the banned-words dictionary. None of it
 * is a daily task, so it lives in System — not on Costs or Collection. The
 * registration's state leads; every heavier tool waits behind its header.
 */
export function OfapiApiTab() {
  const collection = useQuery(ofapiCollectionQueryOptions());
  const pages = collection.data?.pages ?? [];
  return (
    <div className="space-y-5">
      <WebhookCard />
      <DisclosureCard
        title="События и восстановление"
        description="Дополнительные события вебхука, история доставок и повтор пропущенных."
      >
        <div className="card-body"><OfapiWebhookRecovery /></div>
      </DisclosureCard>
      <DisclosureCard
        title="Сверка с провайдером и права ключа"
        description="Бесплатная сверка расходов за закрытые дни и ограничения текущего ключа."
      >
        <div className="card-body"><OfapiVendorEvidence /></div>
      </DisclosureCard>
      <section className="card" aria-labelledby="ofapi-banned-words-heading">
        <div className="card-header">
          <div className="min-w-0">
            <h3 id="ofapi-banned-words-heading" className="card-title">Словарь запрещённых слов</h3>
            <p className="card-description">
              Подсказки для редактора сообщений: текст не меняется сам. Hub ищет буквальные совпадения, сложные правила
              проверяет провайдер при отправке.
            </p>
          </div>
        </div>
        <div className="card-body"><OfapiBannedWords /></div>
      </section>
      <DisclosureCard
        title="Очередь рассылок и лайки постов"
        description="Сохранённые события по странице — без запросов к провайдеру."
      >
        <div className="card-body"><OfapiContentEvidence pages={pages} /></div>
      </DisclosureCard>
      <DisclosureCard
        title="Сохранённые ответы и участники списков"
        description="Что Hub уже получил от OnlyFans API — только чтение из базы Hub."
      >
        <div className="card-body"><OfapiStoredReads pages={pages} /></div>
      </DisclosureCard>
    </div>
  );
}
