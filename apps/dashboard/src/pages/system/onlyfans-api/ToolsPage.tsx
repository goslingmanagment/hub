import { useQuery } from "@tanstack/react-query";
import { ofapiCollectionQueryOptions } from "@/api/ofapiCollection";
import { DisclosureCard } from "@/components/ui/DisclosureCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { freshOf, useOfapi } from "../shared.js";
import { KeyScopeCard } from "./KeyScopeCard.js";
import { OfapiBannedWords } from "./OfapiBannedWords.js";
import { OfapiOffBar } from "./OfapiOffBar.js";
import { OfapiStoredReads } from "./OfapiStoredReads.js";
import { OfapiWebhookRecovery } from "./OfapiWebhookRecovery.js";

/** «OnlyFans API → События и ключ»: events and their recovery, the key's rights, the dictionary, stored answers (§10). */
export function ToolsPage() {
  const ofapi = useOfapi();
  const collection = useQuery(ofapiCollectionQueryOptions());
  const pages = collection.data?.pages ?? [];
  return (
    <div className="space-y-6 sys-screen">
      <PageHeader fresh={freshOf(collection, [], ofapi.status === "off")} />
      <OfapiOffBar ofapi={ofapi} />
      <DisclosureCard title="События и восстановление" description="История доставок и повтор пропущенных.">
        <div className="card-body"><OfapiWebhookRecovery blocked={ofapi.block} /></div>
      </DisclosureCard>
      <DisclosureCard title="Права ключа" description="Что разрешено текущему ключу.">
        <div className="card-body"><KeyScopeCard blocked={ofapi.block} /></div>
      </DisclosureCard>
      <section className="card" aria-labelledby="ofapi-banned-words-heading">
        <div className="card-header">
          <div className="min-w-0">
            <h2 id="ofapi-banned-words-heading" className="card-title">Словарь запрещённых слов</h2>
            <p className="card-description sys-measure">
              Подсказки для редактора сообщений: текст не меняется сам. Hub ищет буквальные совпадения, сложные правила проверяет
              OnlyFans API при отправке.
            </p>
          </div>
        </div>
        <div className="card-body"><OfapiBannedWords blocked={ofapi.block} /></div>
      </section>
      <DisclosureCard title="Сохранённые ответы и участники списков" description="Что Hub уже получил от OnlyFans API, только чтение из базы Hub.">
        <div className="card-body"><OfapiStoredReads pages={pages} /></div>
      </DisclosureCard>
    </div>
  );
}
