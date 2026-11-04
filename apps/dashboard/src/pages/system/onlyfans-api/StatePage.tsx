import { Link } from "react-router";
import { useAdminOfapiWebhookStatus } from "@/api/queries";
import { Disclosure } from "@/components/ui/Disclosure";
import { KeyValue } from "@/components/ui/KeyValue";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatDateTime } from "@/lib/format";
import { buildPageRoute } from "@/lib/navigation";
import { OFAPI_FROZEN_NOTE } from "@/lib/statusWords";
import { freshOf, OfapiUnknownNotice, useOfapi } from "../shared.js";
import { CreditsHealthCard } from "./CreditsHealthCard.js";
import { WebhookCard } from "./WebhookCard.js";
import { WhereItLives } from "./WhereItLives.js";

function connectionText(status: string | null, at: string | null): string {
  if (status === null) return "—";
  const when = at ? ` ${formatDateTime(at, { yearUnlessCurrent: true })}` : "";
  return status === "connected" ? `Подключён${when}` : `Отключён${when}`;
}

/** «Страницы OnlyFans»: each page's binding to the API and its last event. */
function PagesCard({ off }: { off: boolean }) {
  const query = useAdminOfapiWebhookStatus();
  const pages = query.data?.pages ?? [];
  const linked = pages.filter((page) => page.ofapiAccountId).length;
  return (
    <section className="card" aria-labelledby="of-pages-heading">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="of-pages-heading" className="card-title">Страницы OnlyFans</h2>
          {query.data && <p className="card-description">Привязано страниц: {linked} из {pages.length}</p>}
        </div>
      </div>
      {query.isLoading && !query.data ? (
        <TableSkeleton rows={2} columns={3} />
      ) : !query.data ? (
        <StatusPanel
          title="Hub не ответил"
          description="Числа не пришли. Это не ноль: данные могут быть, просто экран их не получил."
          action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}
        />
      ) : pages.length === 0 ? (
        <StatusPanel title="Страниц OnlyFans нет." />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Страница</th>
                  <th>Подключение</th>
                  <th>Последнее событие</th>
                </tr>
              </thead>
              <tbody>
                {pages.map((page) => (
                  <tr key={page.pageId}>
                    <td>
                      <Link to={buildPageRoute(page.label)} className="sys-row-link">{page.label}</Link>
                      {page.username && <span className="cell-second">@{page.username}</span>}
                    </td>
                    <td className="muted">{connectionText(page.ofapiAuthStatus, page.ofapiAuthChangedAt)}</td>
                    <td className="muted">
                      {page.lastEventAt ? formatDateTime(page.lastEventAt, { yearUnlessCurrent: true }) : "—"}
                      {off && page.lastEventAt && <span className="cell-second">{OFAPI_FROZEN_NOTE}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-body sys-card-tail">
            <Disclosure label="Подробнее">
              {pages.map((page) => (
                <KeyValue
                  key={page.pageId}
                  rows={[
                    { label: "Страница", value: page.label },
                    { label: "Аккаунт OnlyFans API", value: page.ofapiAccountId ? <span className="sys-code">{page.ofapiAccountId}</span> : null },
                    { label: "Версия привязки", value: String(page.bindingGeneration) },
                    { label: "Состояние у OnlyFans API", value: page.ofapiAuthStatus ? <span className="sys-code">{page.ofapiAuthStatus}</span> : null },
                  ]}
                />
              ))}
            </Disclosure>
          </div>
        </>
      )}
    </section>
  );
}

/** «OnlyFans API → Состояние»: switched off since 1 November, what that means and where everything lies (§8). */
export function StatePage() {
  const ofapi = useOfapi();
  const webhook = useAdminOfapiWebhookStatus();
  return (
    <div className="space-y-6">
      <PageHeader fresh={freshOf(webhook)} />
      {ofapi.status === "off" && (
        <Notice tone="off" detail="Включается ключом в настройках сервера: это делает разработчик.">
          <b className="font-medium">OnlyFans API выключен с 1 ноября.</b> Hub ничего не покупает и не отправляет через него. Настройки и собранные данные сохранены.
        </Notice>
      )}
      {ofapi.status === "on" && <Notice>OnlyFans API подключён. Hub покупает данные по правилам сбора.</Notice>}
      <OfapiUnknownNotice ofapi={ofapi} />
      <WhereItLives ofapi={ofapi.status} />
      <PagesCard off={ofapi.status === "off"} />
      <WebhookCard ofapi={ofapi.status} />
      <CreditsHealthCard ofapi={ofapi.status} />
    </div>
  );
}
