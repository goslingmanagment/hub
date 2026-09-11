import { Link, useSearchParams } from "react-router";
import type { NotificationsIncidentItem } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import { useNotificationIncidents, useResolveIncident } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { formatRelativeTime } from "@/lib/format";

const LIMIT = 50;

type IncidentKind = NotificationsIncidentItem["kind"];

const INCIDENT_KIND_LABELS = {
  auth_blocked: "Auth Blocked",
  proxy_failed: "Proxy Failed",
  proxy_missing: "Proxy Missing",
  stream_failed_threshold: "Stream Failed 3x",
  ofapi_auth: "OFAPI Auth",
  ofapi_binding_conflict: "OFAPI Binding Conflict",
  ofapi_low_credit: "OFAPI Low Credit",
  ofapi_webhook_silence: "OFAPI Webhook Silence",
  ofapi_burn_rate: "OFAPI Burn Rate",
  db_disk_usage: "Database Disk Usage",
  observations_partitions: "Observations Partitions",
  wrong_transactions_writer: "Wrong Transactions Writer",
  read_gateway_capture: "Read Gateway Capture",
  golden_signal_lag: "Golden Signal Lag",
  scheduler_silent: "Scheduler Silent",
  ops_sampler_silent: "Ops Sampler Silent",
  ofapi_chargebacks_reconcile_failed: "OFAPI Chargebacks Reconcile",
  ofapi_link_stats_reconcile_failed: "OFAPI Link Stats Reconcile",
  ai_provider_billing: "AI Provider Billing",
  ai_provider_failed: "AI Provider Failed",
  capture_payload_parity: "Capture Payload Parity",
} satisfies Record<IncidentKind, string>;

function deliveryState(item: NotificationsIncidentItem): {
  label: string;
  className: string;
  title?: string;
} {
  switch (item.outboxState) {
    case null:
      return {
        label: String(item.notificationCount),
        className: "text-text-muted",
      };
    case "pending":
      return {
        label: `Queued (${item.outboxAttemptCount ?? 0})`,
        className: "text-warning",
        title: item.outboxLastError ?? "Waiting for the notification worker",
      };
    case "leased":
      return {
        label: `Sending (${item.outboxAttemptCount ?? 0})`,
        className: "text-warning",
        title: item.outboxLastError ?? "Notification delivery is leased",
      };
    case "delivered":
      return {
        label: `Delivered (${item.outboxAttemptCount ?? 0})`,
        className: "text-green",
      };
    case "suppressed":
      return {
        label: "Suppressed",
        className: "text-warning",
        title: item.outboxSuppressionReason === "ai_critical_alerts_disabled"
          ? "AI critical paging was off when this transition was recorded"
          : item.outboxSuppressionReason === "sync_failure_alerts_disabled"
            ? "Sync failure paging was off when this transition was recorded"
            : "Notifications were off when this transition was recorded",
      };
    case "exhausted":
      return {
        label: `Exhausted (${item.outboxAttemptCount ?? 0})`,
        className: "text-danger",
        ...(item.outboxLastError ? { title: item.outboxLastError } : {}),
      };
  }
}

export function NotificationsIncidentsTab() {
  const [search, setSearch] = useSearchParams();
  const status = ["open", "resolved"].includes(search.get("status") ?? "") ? search.get("status")! : undefined;
  const kind = Object.hasOwn(INCIDENT_KIND_LABELS, search.get("kind") ?? "") ? search.get("kind")! : undefined;
  const pageLabel = search.get("page") || undefined;
  const requestedOffset = Number(search.get("offset") ?? 0);
  const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  function setFilter(key: string, value: string, replace = false) {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value); else next.delete(key);
    next.delete("offset");
    setSearch(next, { replace });
  }
  function setOffset(value: number) {
    const next = new URLSearchParams(search);
    if (value) next.set("offset", String(value)); else next.delete("offset");
    setSearch(next);
  }
  function clearFilters() {
    const next = new URLSearchParams(search);
    for (const key of ["page", "kind", "status", "offset"]) next.delete(key);
    setSearch(next);
  }

  const { data, isLoading, isError, refetch } = useNotificationIncidents({
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(pageLabel ? { pageLabel } : {}),
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
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={status ?? ""}
          aria-label="Статус инцидента"
          onChange={(event) => setFilter("status", event.target.value)}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-primary"
        >
          <option value="">Все статусы</option>
          <option value="open">Открытые</option>
          <option value="resolved">Закрытые</option>
        </select>

        <select
          value={kind ?? ""}
          aria-label="Тип инцидента"
          onChange={(event) => setFilter("kind", event.target.value)}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-primary"
        >
          <option value="">Все типы</option>
          {(Object.entries(INCIDENT_KIND_LABELS) as Array<[IncidentKind, string]>)
            .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>

        <input
          type="text"
          placeholder="Название страницы…"
          value={pageLabel ?? ""}
          aria-label="Страница инцидента"
          onChange={(event) => setFilter("page", event.target.value, true)}
          className="w-48 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted"
        />
      </div>

      <QueryNotice error={isError} stale={data !== undefined} retry={refetch} />
      {isLoading && !data ? (
        <StatusPanel title="Загружаем инциденты…" description="Получаем сохранённые инциденты уведомлений." />
      ) : !data ? (
        <StatusPanel
          title="Не удалось загрузить инциденты"
          description="Повторите запрос с помощью кнопки выше."
          tone="error"
        />
      ) : data.items.length === 0 ? (
        <StatusPanel
          title={status || kind || pageLabel || offset > 0 ? "Инцидентов с такими фильтрами нет" : "Инцидентов пока нет"}
          description="Инциденты появляются при выявлении операционной проблемы."
          action={status || kind || pageLabel || offset > 0 ? <button type="button" className="text-accent underline" onClick={clearFilters}>Сбросить фильтры</button> : undefined}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Статус</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Страница</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Тип</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Поток</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Открыт</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Причина</th>
                  <th className="px-4 py-2.5 text-right text-[12px] font-semibold uppercase text-text-muted tracking-wider">Доставка</th>
                  <th className="px-4 py-2.5 text-[12px] font-semibold uppercase text-text-muted tracking-wider" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id} className="border-t border-border hover:bg-hover">
                    <td className="px-4 py-2.5">
                      <div className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${
                        item.status === "open" ? "text-danger" : "text-green"
                      }`}>
                        <div className={`h-2 w-2 rounded-full ${item.status === "open" ? "bg-danger" : "bg-green"}`} />
                        {item.status === "open" ? "Открыт" : "Закрыт"}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-[13px] font-medium text-text-primary">{item.pageLabel ? <Link className="text-accent underline" to={`/pages/${encodeURIComponent(item.pageLabel)}`}>{item.pageLabel}</Link> : "Общий"}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-secondary">
                      {INCIDENT_KIND_LABELS[item.kind]}
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-text-muted">{item.stream ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-muted">{formatRelativeTime(item.openedAt)}</td>
                    <td className="min-w-48 max-w-xs px-4 py-2.5 text-[12px] text-text-muted">{item.errorSummary ? <details><summary className="cursor-pointer">Показать причину</summary><p className="mt-2 break-words">{item.errorSummary}</p></details> : "—"}</td>
                    <td
                      className={`px-4 py-2.5 text-right text-[12px] tabular-nums ${
                        deliveryState(item).className
                      }`}
                      title={deliveryState(item).title}
                    >
                      {deliveryState(item).label}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {item.status === "open" && (
                        <button
                          onClick={() => handleResolve(item.id)}
                          disabled={resolveIncident.isPending}
                          className="rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-text-secondary hover:bg-hover disabled:opacity-40"
                        >
                          Закрыть
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.total > LIMIT && (
            <div className="mt-3 flex items-center justify-between text-[12px] text-text-muted">
              <span>{offset + 1}–{Math.min(offset + LIMIT, data.total)} из {data.total}</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setOffset(Math.max(0, offset - LIMIT))}
                  disabled={offset === 0}
                  className="rounded border border-border px-2.5 py-1 disabled:opacity-40"
                >
                  Назад
                </button>
                <button
                  onClick={() => setOffset(offset + LIMIT)}
                  disabled={offset + LIMIT >= data.total}
                  className="rounded border border-border px-2.5 py-1 disabled:opacity-40"
                >
                  Далее
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
