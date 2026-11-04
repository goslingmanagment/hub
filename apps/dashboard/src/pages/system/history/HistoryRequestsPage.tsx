import { useSearchParams } from "react-router";
import { useAgentHydrationRequests } from "@/api/queries";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { freshOf, OfapiOffBanner, OfapiUnknownNotice, useOfapi } from "../shared.js";
import { AgentRequestsCard, HYDRATION_STATE_FILTERS } from "./AgentRequestsCard.js";
import { EngineRequestsCard } from "./EngineRequestsCard.js";

/** «Заявки на историю»: what waits for a decision and what already was (design/screens/system.md §5). */
export function HistoryRequestsPage() {
  const [search, setSearch] = useSearchParams();
  const filter = usePageFilter();
  const ofapi = useOfapi();
  const raw = search.get("state");
  const state = HYDRATION_STATE_FILTERS.some((entry) => entry.value === raw) ? raw! : "requested";
  // The same read the card makes: the header's freshness and refresh.
  const list = useAgentHydrationRequests({ ...(state === "all" ? {} : { state }), limit: filter.page ? 200 : 50 });

  return (
    <div className="space-y-6 sys-screen">
      <PageHeader fresh={freshOf(list)} />
      {ofapi.status === "off" && (
        <OfapiOffBanner>Заявки OnlyFans одобрить нельзя: чтение идёт через него. Отклонить можно.</OfapiOffBanner>
      )}
      <OfapiUnknownNotice ofapi={ofapi} />

      <div className="space-y-3">
        <div className="table-toolbar sys-toolbar">
          <label className="sys-inline-field">
            <span className="text-text-secondary">Состояние</span>
            <select
              className="select sys-select"
              value={state}
              onChange={(event) => {
                const next = new URLSearchParams(search);
                if (event.target.value === "requested") next.delete("state");
                else next.set("state", event.target.value);
                setSearch(next);
              }}
            >
              {HYDRATION_STATE_FILTERS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </select>
          </label>
        </div>
        {filter.page && (
          <p className="table-toolbar-note">
            Показаны заявки {filter.page}.{" "}
            <button type="button" className="link" onClick={() => filter.select(null)}>Показать все страницы</button>
          </p>
        )}
      </div>

      <AgentRequestsCard state={state} pageLabel={filter.page} ofapi={ofapi} onShowAllPages={() => filter.select(null)} />
      <EngineRequestsCard pageLabel={filter.page ?? undefined} />

      <Disclosure label="Как это считается">
        <p>
          Заявку подаёт ИИ-агент. На OnlyFans чтение стоит кредиты и может пометить чат прочитанным, поэтому нужно ваше решение
          или автоматическая политика. На Fansly историю читает сбор данных в своём темпе. Причину заявки Hub хранит только отпечатком.
        </p>
      </Disclosure>
    </div>
  );
}
