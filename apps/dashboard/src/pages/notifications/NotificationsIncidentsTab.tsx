import { useState } from "react";
import type { NotificationsIncidentItem } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import { useNotificationIncidents, useResolveIncident } from "@/api/queries";
import { Pagination } from "@/components/shared/Pagination";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { syncStreamLabel } from "../settings/sync/syncVocabulary.js";

const LIMIT = 50;

type IncidentKind = NotificationsIncidentItem["kind"];

/** Short Russian names; the engineering kinds keep a technical name, in Russian. */
const INCIDENT_KIND_LABELS = {
  auth_blocked: "Вход заблокирован",
  proxy_failed: "Прокси не работает",
  proxy_missing: "Нет прокси",
  stream_failed_threshold: "Сбор падает 3 раза подряд",
  ofapi_auth: "OnlyFans API: доступ отклонён",
  ofapi_binding_conflict: "OnlyFans API: конфликт привязки",
  ofapi_low_credit: "Мало кредитов OnlyFans API",
  ofapi_webhook_silence: "Вебхуки замолчали",
  ofapi_burn_rate: "Кредиты сгорают необычно быстро",
  db_disk_usage: "База данных: мало места",
  observations_partitions: "База данных: разделы журнала",
  wrong_transactions_writer: "Операции пишет не тот процесс",
  read_gateway_capture: "Шлюз чтения: сбор данных",
  golden_signal_lag: "Отставание ключевых метрик",
  scheduler_silent: "Планировщик молчит",
  ops_sampler_silent: "Сбор метрик молчит",
  sync_silent: "Сбор Fansly молчит",
  fansly_sync_engine: "Сбор Fansly: сбой",
  ofapi_chargebacks_reconcile_failed: "Сверка возвратов OnlyFans",
  ofapi_link_stats_reconcile_failed: "Сверка статистики ссылок OnlyFans",
  ai_provider_billing: "AI: проблема с оплатой",
  ai_provider_failed: "AI-провайдер не отвечает",
  capture_payload_parity: "Расхождение сохранённых данных",
  publishing_stopped: "Публикация постов остановлена",
  publication_not_published: "Пост не вышел",
  ofapi_platform_notice: "OnlyFans написал странице",
  chatspace_tab: "Серверная вкладка ChatSpace",
} satisfies Record<IncidentKind, string>;

/** The type filter, grouped so the business kinds come first. */
const KIND_GROUPS: ReadonlyArray<{ label: string; kinds: readonly IncidentKind[] }> = [
  { label: "Страницы и сбор данных", kinds: ["auth_blocked", "proxy_failed", "proxy_missing", "stream_failed_threshold", "sync_silent", "fansly_sync_engine", "publishing_stopped", "publication_not_published", "ofapi_platform_notice", "chatspace_tab"] },
  { label: "OnlyFans API", kinds: ["ofapi_auth", "ofapi_binding_conflict", "ofapi_low_credit", "ofapi_burn_rate", "ofapi_webhook_silence", "ofapi_chargebacks_reconcile_failed", "ofapi_link_stats_reconcile_failed"] },
  { label: "AI", kinds: ["ai_provider_billing", "ai_provider_failed"] },
  { label: "Система", kinds: ["db_disk_usage", "observations_partitions", "wrong_transactions_writer", "read_gateway_capture", "golden_signal_lag", "scheduler_silent", "ops_sampler_silent", "capture_payload_parity"] },
];

const STATUS_FILTERS: ReadonlyArray<{ value: string | undefined; label: string }> = [
  { value: undefined, label: "Все" },
  { value: "open", label: "Открытые" },
  { value: "resolved", label: "Закрытые" },
];

function attempts(item: NotificationsIncidentItem): string {
  return `Попыток: ${item.outboxAttemptCount ?? 0}.`;
}

/** The Telegram alert of an incident, as one small badge; the detail is in its tooltip. */
function deliveryState(item: NotificationsIncidentItem): {
  label: string;
  className: string;
  title: string;
} {
  switch (item.outboxState) {
    case null:
      return {
        label: item.notificationCount > 0 ? `отправлено: ${item.notificationCount}` : "—",
        className: "text-[13px] text-text-secondary",
        title: "Сколько оповещений об этом инциденте отправлено в Telegram",
      };
    case "pending":
      return {
        label: "в очереди",
        className: "badge badge-warning",
        title: `${item.outboxLastError ?? "Оповещение ждёт отправки."} ${attempts(item)}`,
      };
    case "leased":
      return {
        label: "отправляется",
        className: "badge badge-warning",
        title: `${item.outboxLastError ?? "Оповещение сейчас отправляется."} ${attempts(item)}`,
      };
    case "delivered":
      return {
        label: "доставлено",
        className: "badge badge-success",
        title: `Оповещение доставлено в Telegram. ${attempts(item)}`,
      };
    case "suppressed":
      return {
        label: "не отправлялось",
        className: "badge",
        title: item.outboxSuppressionReason === "ai_critical_alerts_disabled"
          ? "Критичные оповещения AI были выключены, когда инцидент изменился"
          : item.outboxSuppressionReason === "sync_failure_alerts_disabled"
            ? "Оповещения о сбоях сбора были выключены, когда инцидент изменился"
            : "Уведомления были выключены, когда инцидент изменился",
      };
    case "exhausted":
      return {
        label: "не доставлено",
        className: "badge badge-danger",
        title: `${item.outboxLastError ?? "Все попытки отправки исчерпаны."} ${attempts(item)}`,
      };
  }
}

export function NotificationsIncidentsTab() {
  const [status, setStatus] = useState<string | undefined>();
  const [kind, setKind] = useState<string | undefined>();
  const [pageLabel, setPageLabel] = useState<string | undefined>();
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isError, error } = useNotificationIncidents({
    ...(status === undefined ? {} : { status }),
    ...(kind === undefined ? {} : { kind }),
    ...(pageLabel === undefined ? {} : { pageLabel }),
    limit: LIMIT,
    offset,
  });
  const resolveIncident = useResolveIncident();

  function handleResolve(incidentId: number) {
    resolveIncident.mutate(incidentId, {
      onSuccess: () => toast.success("Инцидент закрыт"),
      onError: () => toast.error("Не удалось закрыть инцидент"),
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        Сбои сбора данных, OnlyFans API, AI и сервера. Инцидент можно закрыть вручную, когда причина устранена.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="segmented" role="group" aria-label="Статус инцидента">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value ?? "all"}
              type="button"
              aria-pressed={status === filter.value}
              onClick={() => { setStatus(filter.value); setOffset(0); }}
              className="segment"
            >
              {filter.label}
            </button>
          ))}
        </div>

        <select
          aria-label="Тип инцидента"
          value={kind ?? ""}
          onChange={(event) => { setKind(event.target.value || undefined); setOffset(0); }}
          className="select w-auto min-h-[36px] py-1.5"
        >
          <option value="">Все типы</option>
          {KIND_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.kinds.map((value) => <option key={value} value={value}>{INCIDENT_KIND_LABELS[value]}</option>)}
            </optgroup>
          ))}
        </select>

        <input
          aria-label="Страница инцидента"
          type="search"
          placeholder="Страница…"
          value={pageLabel ?? ""}
          onChange={(event) => { setPageLabel(event.target.value || undefined); setOffset(0); }}
          className="input w-48 min-h-[36px] py-1.5"
        />
      </div>

      {isError && data && <StaleDataNotice error={error} />}
      {isLoading && !data ? (
        <StatusPanel title="Загружаем инциденты…" />
      ) : !data ? (
        <StatusPanel
          title="Инциденты не загрузились"
          description="Сервер не ответил. Попробуйте обновить страницу."
          tone="error"
        />
      ) : data.items.length === 0 ? (
        <StatusPanel
          title="Под эти фильтры инцидентов нет"
          description="Попробуйте другой статус, тип или страницу. Пустой отфильтрованный список ничего не говорит о системе в целом."
          action={offset > 0 ? <button type="button" onClick={() => setOffset(0)} className="btn btn-sm">К первой странице</button> : undefined}
        />
      ) : (
        <div className="card">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Статус</th>
                  <th>Тип</th>
                  <th>Страница</th>
                  <th>Открыт</th>
                  <th>Ошибка</th>
                  <th title="Оповещение в Telegram">Telegram</th>
                  <th className="relative"><span className="sr-only">Действие</span></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => {
                  const delivery = deliveryState(item);
                  return (
                    <tr key={item.id}>
                      <td>
                        <span className={item.status === "open" ? "badge badge-danger" : "badge badge-success"}>
                          <span className={`status-dot ${item.status === "open" ? "status-dot-error" : "status-dot-ok"}`} aria-hidden="true" />
                          {item.status === "open" ? "Открыт" : "Закрыт"}
                        </span>
                      </td>
                      <td>
                        <span title={item.kind}>{INCIDENT_KIND_LABELS[item.kind] ?? item.kind}</span>
                        {item.stream && <div className="mt-0.5 text-xs text-text-secondary">поток: {syncStreamLabel(item.stream)}</div>}
                      </td>
                      <td className="font-medium">{item.pageLabel ?? <span className="font-normal text-text-secondary">Вся система</span>}</td>
                      <td className="muted whitespace-nowrap" title={formatDateTime(item.openedAt)}>{formatRelativeTime(item.openedAt)}</td>
                      <td title={item.errorSummary ?? undefined} className="muted max-w-[280px] truncate text-[13px]">{item.errorSummary ?? "—"}</td>
                      <td>
                        <span className={delivery.className} title={delivery.title}>{delivery.label}</span>
                      </td>
                      <td className="text-right">
                        {item.status === "open" && (
                          <button
                            type="button"
                            onClick={() => handleResolve(item.id)}
                            disabled={resolveIncident.isPending || isError}
                            className="btn btn-sm"
                            title="Отметить инцидент решённым"
                          >
                            Закрыть
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.total > LIMIT && (
            <Pagination offset={offset} limit={LIMIT} total={data.total} onPageChange={setOffset} />
          )}
        </div>
      )}
    </div>
  );
}
