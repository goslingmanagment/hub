import { useAdminOfapiWebhookStatus } from "@/api/queries";
import { Disclosure } from "@/components/ui/Disclosure";
import { KeyValue } from "@/components/ui/KeyValue";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatCount, formatDateTime } from "@/lib/format";
import type { OfapiStatus } from "@/lib/statusWords";
import { webhookOperationLabel, webhookStateLabel } from "./rules/collectionCopyRu.js";
import { groupWebhookEvents, maskWebhookId, utcDateTime } from "./rules/collectionModel.js";

/** The registration's word, by the switch: while the API is off, «stable» only means the registration is kept. */
function stateWord(state: string | null, ofapi: OfapiStatus): { text: string; className: string } {
  const word = webhookStateLabel(state).replace("у провайдера", "у OnlyFans API");
  const text = word.charAt(0).toUpperCase() + word.slice(1);
  if (ofapi !== "on") return { text: state === "stable" ? "Регистрация сохранена" : text, className: "badge badge-off" };
  if (state === "stable") return { text: "Работает", className: "badge badge-bare badge-success" };
  if (state === null) return { text, className: "badge badge-off" };
  return { text, className: /failed|indeterminate/.test(state) ? "badge badge-danger" : "badge badge-warning" };
}

/**
 * «Приём событий» (was «Вебхук»): the one OnlyFans API registration through which
 * events come to Hub by themselves. Read-only.
 */
export function WebhookCard({ ofapi }: { ofapi: OfapiStatus }) {
  const query = useAdminOfapiWebhookStatus();
  const status = query.data;
  const groups = status ? groupWebhookEvents(status.events) : [];
  const word = status ? stateWord(status.registrationState, ofapi) : null;
  const off = ofapi !== "on";
  return (
    <section className="card" aria-labelledby="webhook-heading">
      <div className="card-header">
        <div className="sys-head">
          <h2 id="webhook-heading" className="card-title">Приём событий</h2>
          <p className="card-description">Одна регистрация на все страницы OnlyFans: через неё события приходят в Hub сами, без платных запросов.</p>
        </div>
        {word && <span className={word.className} title={status?.registrationState ?? undefined}>{word.text}</span>}
      </div>
      <div className="card-body sys-stack-16">
        {query.isLoading && !status ? (
          <Skeleton width={280} />
        ) : !status ? (
          <div className="sys-pause-missing">
            <span>Hub не ответил.</span>
            <button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>
          </div>
        ) : (
          <>
            <KeyValue
              rows={[
                { label: "Групп событий", value: formatCount(groups.length) },
                { label: "Последняя проверка", value: status.updatedAt ? formatDateTime(status.updatedAt, { yearUnlessCurrent: true }) : null },
              ]}
            />
            {status.registrationError && (
              <Notice tone={off ? "off" : "danger"}>Ошибка регистрации: <span lang="en">{status.registrationError}</span></Notice>
            )}
            {status.pendingRegistration && (
              <Notice tone={off ? "off" : "warning"}>
                Ждёт подтверждения: {webhookOperationLabel(status.pendingRegistration.operation)} регистрации, подготовлено{" "}
                {formatDateTime(status.pendingRegistration.preparedAt, { yearUnlessCurrent: true })}.
              </Notice>
            )}
            <Disclosure label="Подробнее">
              {groups.length === 0 ? (
                <p>{status.configured ? "Типы событий не перечислены в регистрации." : "Приём событий не зарегистрирован."}</p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Группа</th>
                        <th>Типы событий</th>
                        <th>Подписка</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((group) => (
                        <tr key={group.group}>
                          <td>{group.label}</td>
                          <td className="muted"><span className="sys-code">{group.events.join(" · ")}</span></td>
                          <td className="muted">в текущем наборе</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <KeyValue
                rows={[
                  { label: "ID регистрации", value: <span className="sys-code">{maskWebhookId(status.externalWebhookId)}</span> },
                  { label: "Адрес доставки", value: status.endpointUrl ? <span className="sys-code">{status.endpointUrl}</span> : null },
                  { label: "Область", value: status.accountScope ? <span className="sys-code">{status.accountScope}</span> : null },
                  { label: "Проверена (UTC)", value: status.updatedAt ? utcDateTime(status.updatedAt) : null },
                ]}
              />
            </Disclosure>
          </>
        )}
      </div>
    </section>
  );
}
