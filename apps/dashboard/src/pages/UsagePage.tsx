import { Fragment, useState } from "react";
import type { AdminChatterUsageResponse } from "@agency_hub_core/contracts";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import { useAdminChatterUsage } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { UsageDateNav } from "@/components/shared/UsageDateNav";
import { type UsagePeriod, usageRange, shiftAnchor, usageDateLabel } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
// The chatter cabinet names the AI features; the owner reads the same names.
import { featureLabel } from "./account/accountView.js";

type UsageRow = AdminChatterUsageResponse["rows"][number];

function formatCompact(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return m >= 10 ? `${Math.round(m)} млн` : `${m.toFixed(1)} млн`;
  }
  if (value >= 1_000) {
    const k = value / 1_000;
    return k >= 10 ? `${Math.round(k)} тыс.` : `${k.toFixed(1)} тыс.`;
  }
  return String(value);
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatMicroUsd(value: number, approximate = false): string {
  if (value <= 0) {
    return "$0";
  }
  const usd = value / 1_000_000;
  const prefix = approximate ? "~" : "";
  if (usd < 0.01) {
    return `${prefix}< $0.01`;
  }
  return `${prefix}$${usd.toFixed(2)}`;
}

function requestsWord(value: number): string {
  return ruPlural(value, "запрос", "запроса", "запросов");
}

function todayISO(): string {
  return toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
}

const PERIOD_INTRO: Record<UsagePeriod, string> = {
  day: "Запросы к AI и их стоимость по сотрудникам за день.",
  week: "Запросы к AI и их стоимость по сотрудникам за неделю.",
  month: "Запросы к AI и их стоимость по сотрудникам за месяц.",
};

/** Tokens and the provider calls behind one person's requests: the detail under their row. */
function UsageDetails({ row }: { row: UsageRow }) {
  return (
    <div className="space-y-3 text-[13px] text-text-secondary">
      <ul className="space-y-1">
        {row.featureBreakdown.map((fb) => (
          <li key={fb.feature} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 sm:grid sm:grid-cols-[180px_260px_minmax(0,1fr)]">
            <span className="font-medium text-text-primary">{featureLabel(fb.feature)}</span>
            <span className="tabular-nums">
              {fb.requestCount} {requestsWord(fb.requestCount)}
              {fb.costMicroUsd > 0 && ` · ${formatMicroUsd(fb.costMicroUsd, fb.costApproximate)}`}
              {fb.regenerateRatePct > 0 && ` · перегенерации ${formatPercent(fb.regenerateRatePct)}`}
            </span>
            <span className="tabular-nums text-text-muted">
              токены: {formatCompact(fb.tokenCounts.input)} на входе · {formatCompact(fb.tokenCounts.output)} на выходе
              {" · "}{formatCompact(fb.tokenCounts.cacheTotal)} из кэша
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-border-light pt-2 text-xs tabular-nums text-text-muted">
        Всего токенов: {formatCompact(row.tokenCounts.input)} на входе · {formatCompact(row.tokenCounts.output)} на выходе
        {" · "}{formatCompact(row.tokenCounts.cacheTotal)} из кэша · {formatMicroUsd(row.cost.microUsd, row.cost.approximate)}
      </p>
      {row.gateway.requestCount > 0 && (
        <p className="text-xs tabular-nums text-text-muted">
          Обращения к провайдерам: {row.gateway.requestCount}
          {" · "}выполнено {row.gateway.completedCount}
          {" · "}с ошибкой {row.gateway.failedCount}
          {row.gateway.cancelledCount > 0 && <>{" · "}отменено {row.gateway.cancelledCount}</>}
          {row.gateway.openReservationCount > 0 && <>{" · "}ещё идут {row.gateway.openReservationCount}</>}
          {row.gateway.providerBreakdown.map((provider) => (
            <span key={provider.provider}>
              {" · "}{provider.provider}: {provider.requestCount} / {formatMicroUsd(provider.costMicroUsd)}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

export function UsagePage() {
  const [mode, setMode] = useState<UsagePeriod>("day");
  const [anchor, setAnchor] = useState(todayISO);
  const [expandedUsers, setExpandedUsers] = useState<Set<number>>(new Set());

  const range = usageRange(anchor, mode);
  const today = todayISO();
  const canGoNext = range.to < today;

  const { data, isLoading, isError, isFetching, refetch } = useAdminChatterUsage(range);

  const rows = data?.rows ?? [];
  const activeRows = rows.filter((r) => r.totalGenerations > 0);

  function toggleExpanded(userId: number) {
    setExpandedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  const retry = (
    <button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">
      Повторить
    </button>
  );

  // The header and the period stay on screen while a report loads: changing
  // the period never makes the controls disappear.
  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 max-w-2xl">
        <p className="text-sm text-text-secondary">{PERIOD_INTRO[mode]}</p>
        <details className="help mt-1">
          <summary>Как это считается</summary>
          <div className="help-body">
            <p>
              Считаются запросы к AI, включая неудачные и отменённые; сообщения, отправленные фанам, не считаются.
            </p>
            <p>
              Перегенерации — доля ответов, которые сотрудник попросил сгенерировать заново. Больше 30% отмечается
              как «много». Дни считаются по московскому времени.
            </p>
          </div>
        </details>
      </div>
      <UsageDateNav
        mode={mode}
        onModeChange={(m) => {
          setMode(m);
          setExpandedUsers(new Set());
        }}
        label={usageDateLabel(anchor, mode)}
        onPrev={() => {
          setAnchor(shiftAnchor(anchor, mode, -1));
          setExpandedUsers(new Set());
        }}
        onNext={() => {
          setAnchor(shiftAnchor(anchor, mode, 1));
          setExpandedUsers(new Set());
        }}
        canGoNext={canGoNext}
      />
    </div>
  );

  let body;
  if (isLoading) {
    body = <div className="card"><TableSkeleton rows={4} columns={5} /></div>;
  } else if (isError && !data) {
    body = (
      <StatusPanel
        title="Не удалось загрузить расходы на AI"
        description="Сервер не ответил. Попробуйте ещё раз."
        tone="error"
        action={retry}
      />
    );
  } else if (!data) {
    body = <StatusPanel title="Нет данных" description="Отчёт пришёл пустым." tone="error" />;
  } else {
    body = (
      <>
        {isError && (
          <div role="alert" className="notice notice-warning flex-wrap items-center justify-between">
            <span>Обновить не получилось — показан прежний отчёт.</span>
            {retry}
          </div>
        )}
        <section aria-label="Расходы на AI по сотрудникам" className="card">
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th className="num">Запросов</th>
                  <th className="num">Стоимость</th>
                  <th className="num" title="Доля ответов, которые сгенерировали заново">Перегенерации</th>
                  <th>Чаще всего</th>
                </tr>
              </thead>
              <tbody>
                {activeRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted py-10 text-center">
                      За этот период запросов к AI не было.
                    </td>
                  </tr>
                )}
                {activeRows.map((row) => {
                  const isExpanded = expandedUsers.has(row.userId);
                  const detailsId = `usage-details-${row.userId}`;
                  return (
                    <Fragment key={row.userId}>
                      <tr onClick={() => toggleExpanded(row.userId)} className="cursor-pointer">
                        <td className="font-medium">
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            aria-controls={detailsId}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleExpanded(row.userId);
                            }}
                            className="inline-flex items-center gap-2 text-left font-medium"
                          >
                            <span aria-hidden="true" className="inline-block w-3 text-text-muted">
                              {isExpanded ? "▾" : "▸"}
                            </span>
                            {row.username}
                          </button>
                        </td>
                        <td className="num font-semibold">{row.totalGenerations}</td>
                        <td className="num">{formatMicroUsd(row.cost.microUsd, row.cost.approximate)}</td>
                        <td className="num">
                          <span className={row.warning ? "font-semibold text-warning-dark" : "text-text-secondary"}>
                            {formatPercent(row.regenerateRatePct)}
                          </span>
                          {row.warning && (
                            <span className="badge badge-warning ml-2" title="Перегенерировали больше 30% ответов">много</span>
                          )}
                        </td>
                        <td className="muted">
                          {row.topFeature
                            ? (
                              <>
                                {featureLabel(row.topFeature.feature)}
                                <span className="ml-1.5 tabular-nums text-text-muted">
                                  {row.topFeature.requestCount} · {formatPercent(row.topFeature.sharePct)}
                                </span>
                              </>
                            )
                            : "—"}
                        </td>
                      </tr>
                      <tr hidden={!isExpanded}>
                        <td colSpan={5} className="bg-hover-alt">
                          <div id={detailsId}>
                            <UsageDetails row={row} />
                          </div>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </>
    );
  }

  return (
    <div className="space-y-5">
      {header}
      {body}
    </div>
  );
}
