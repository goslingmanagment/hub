import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { SearchInput } from "@/components/shared/SearchInput";
import { resolveUsageSearch } from "@/lib/usageNavigation";
import type { AdminChatterUsageResponse } from "@agency_hub_core/contracts";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import { useAdminChatterUsage } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { UsageDateNav } from "@/components/shared/UsageDateNav";
import { type UsagePeriod, usageRange, shiftAnchor, usageDateLabel } from "@/lib/format";

const FEATURE_ORDER: { key: string; label: string }[] = [
  { key: "fast-reply", label: "Fast Reply" },
  { key: "fan-summary", label: "Fan Summary" },
  { key: "improve-draft", label: "Improve Draft" },
  { key: "help-me", label: "Help Me" },
  { key: "chat-review", label: "Chat Review" },
  { key: "scan", label: "Scan" },
  { key: "ping", label: "Ping" },
  { key: "hi-greeting", label: "Hi Greeting" },
  { key: "coach-chat", label: "Coach" },
  { key: "workboard-closing", label: "Диалоги Workboard" },
  { key: "voice-script", label: "Голосовые сообщения" },
];

const FEATURE_LABELS: Record<string, string> = Object.fromEntries(
  FEATURE_ORDER.map((f) => [f.key, f.label]),
);

type UsageRow = AdminChatterUsageResponse["rows"][number];

function formatCompact(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const k = value / 1_000;
    return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
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

function formatFeatureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature;
}

function todayISO(): string {
  return toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
}

function getFeatureCount(row: UsageRow, feature: string): number {
  return row.featureBreakdown.find((f) => f.feature === feature)?.requestCount ?? 0;
}

const SUBTITLE: Record<UsagePeriod, string> = {
  day: "Использование ИИ сотрудниками за день.",
  week: "Использование ИИ сотрудниками за неделю.",
  month: "Использование ИИ сотрудниками за месяц.",
};

export function UsagePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { mode, anchor, search, corrected } = resolveUsageSearch(searchParams, todayISO());
  function updateParam(key: string, value: string) {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    });
  }
  const setMode = (value: UsagePeriod) => updateParam("mode", value);
  const setAnchor = (value: string) => updateParam("date", value);
  const [expandedUsers, setExpandedUsers] = useState<Set<number>>(new Set());

  useEffect(() => { setExpandedUsers(new Set()); }, [mode, anchor]);
  const range = usageRange(anchor, mode);
  const today = todayISO();
  const canGoNext = range.to < today;

  const { data, isLoading, isError, refetch } = useAdminChatterUsage(range);

  const rows = data?.rows ?? [];
  const usedRows = rows.filter((r) => r.totalGenerations > 0 || r.cost.microUsd > 0 || r.gateway.requestCount > 0 || r.gateway.quotaDeniedCount > 0);
  const activeRows = usedRows.filter(row => row.username.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  // New feature keys must stay visible when the server adds a feature before the UI updates.
  const visibleFeatures = [...new Set([...FEATURE_ORDER.map(f => f.key), ...usedRows.flatMap(row => row.featureBreakdown.map(feature => feature.feature))])];

  function toggleExpanded(userId: number) {
    setExpandedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  const colCount = visibleFeatures.length + 4;

  return (
    <div className="p-4 md:p-0">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-text-primary">Использование ИИ</h1>
          <p className="mt-1 text-sm text-text-muted">{SUBTITLE[mode]}</p>
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

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={value => updateParam("q", value)} placeholder="Поиск сотрудника" />
        <label className="flex items-center gap-2 text-sm text-text-secondary">Дата<input type="date" aria-label="Дата отчёта" max={today} value={anchor} onChange={event => { if (event.target.value) setAnchor(event.target.value); }} className="min-w-0 rounded-lg border border-border bg-card p-2" /></label>
        <button type="button" onClick={() => setAnchor(today)} disabled={anchor === today} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40">Сегодня</button>
        {data && <span className="text-sm text-text-muted">Сотрудников: {activeRows.length} из {usedRows.length}</span>}
      </div>
      <p className="mb-3 text-xs text-text-muted">Период: {range.from} — {range.to} включительно · Москва (UTC+3). Строка сотрудника раскрывает токены и состояние запросов. ~ означает оценку стоимости.</p>
      {corrected && <p role="status" className="mb-3 text-sm text-warning-dark">Дата или период в ссылке некорректны. Показан доступный период; выберите нужную дату выше.</p>}
      <QueryNotice error={isError && Boolean(data)} stale retry={refetch} />
      {isLoading && !data ? (
        <StatusPanel title="Загружаем использование ИИ…" description="Получаем данные сотрудников за выбранный период." />
      ) : !data ? (
        <StatusPanel
          title="Не удалось загрузить использование ИИ"
          description="Повторите запрос или выберите другой период."
          tone="error"
          action={<button type="button" className="text-sm font-semibold text-accent underline" onClick={() => void refetch()}>Повторить</button>}
        />
      ) : (
      <section role="region" aria-label="Использование ИИ по сотрудникам" tabIndex={0} className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-full md:min-w-[980px] border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              <th className="px-1.5 py-3 md:px-4 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                Сотрудник
              </th>
              <th className="px-1.5 py-3 md:px-4 text-right text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                Генераций
              </th>
              <th className="px-1.5 py-3 md:px-4 text-right text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                Расход
              </th>
              <th className="px-1.5 py-3 md:px-4 text-right text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                Повторы
              </th>
              {visibleFeatures.map((feature) => (
                <th
                  key={feature}
                  className="hidden px-4 py-3 text-right md:table-cell text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                >
                  {formatFeatureLabel(feature)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeRows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-sm text-text-muted">
                  {search.trim() ? "Сотрудники по этому запросу не найдены. Очистите поиск." : "За этот период активности нет."}
                </td>
              </tr>
            )}
            {activeRows.map((row) => {
              const isExpanded = expandedUsers.has(row.userId);
              return (
                <Fragment key={row.userId}>
                  <tr
                    onClick={() => toggleExpanded(row.userId)}
                    className={`cursor-pointer border-t border-border transition-colors hover:bg-hover ${
                      row.warning ? "bg-warning/[0.06]" : ""
                    }`}
                  >
                    <td className="px-1.5 py-3 md:px-4 text-sm font-medium text-text-primary">
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpanded(row.userId);
                        }}
                        className="flex min-w-0 max-w-32 items-center gap-1.5 text-left font-medium md:max-w-none text-text-primary hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        <span aria-hidden="true" className="inline-block w-3 text-text-muted">{isExpanded ? "▾" : "▸"}</span>
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{row.username}</span>
                      </button>
                    </td>
                    <td className="px-1.5 py-3 md:px-4 text-right text-sm font-semibold tabular-nums text-text-primary">
                      {row.totalGenerations}
                    </td>
                    <td className="px-1.5 py-3 md:px-4 text-right text-sm tabular-nums text-text-secondary">
                      {formatMicroUsd(row.cost.microUsd, row.cost.approximate)}
                    </td>
                    <td className="px-1.5 py-3 md:px-4 text-right text-sm tabular-nums">
                      <span className={row.warning ? "font-semibold text-warning-dark" : "text-text-secondary"}>
                        {formatPercent(row.regenerateRatePct)}
                      </span>
                      {row.warning && (
                        <span title="Более 30% генераций — повторные запросы" aria-label="Высокая доля повторов" className="ml-1.5 inline-block rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-warning-dark">
                          !
                        </span>
                      )}
                    </td>
                    {visibleFeatures.map((feature) => {
                      const count = getFeatureCount(row, feature);
                      return (
                        <td
                          key={feature}
                          className="hidden px-4 py-3 text-right md:table-cell text-sm tabular-nums text-text-secondary"
                        >
                          {count.toLocaleString("ru-RU")}
                        </td>
                      );
                    })}
                  </tr>
                  {isExpanded && (
                    <tr className="border-t border-border-light">
                      <td colSpan={colCount} className="bg-hover-alt/50 px-4 py-3">
                        <div className="space-y-1 text-[13px] text-text-secondary">
                          {row.featureBreakdown.map((fb, i) => (
                            <div key={fb.feature} className="flex flex-wrap items-baseline gap-2">
                              <span className="w-3 text-center text-text-muted">
                                {i === row.featureBreakdown.length - 1 ? "└" : "├"}
                              </span>
                              <span className="min-w-[120px] font-medium text-text-primary">
                                {formatFeatureLabel(fb.feature)}
                              </span>
                              <span className="tabular-nums">
                                {fb.requestCount} запросов · {formatCompact(fb.tokenCounts.input)} in
                                {" · "}
                                {formatCompact(fb.tokenCounts.output)} out
                                {" · "}
                                {formatCompact(fb.tokenCounts.cacheTotal)} cache
                              </span>
                              {fb.costMicroUsd > 0 && (
                                <span className="tabular-nums text-text-muted">
                                  · {formatMicroUsd(fb.costMicroUsd, fb.costApproximate)}
                                </span>
                              )}
                              {fb.regenerateRatePct > 0 && (
                                <span className="tabular-nums text-text-muted">
                                  · {formatPercent(fb.regenerateRatePct)} regen
                                </span>
                              )}
                            </div>
                          ))}
                          <div className="mt-1.5 border-t border-border-light pt-1.5 text-[12px] tabular-nums text-text-muted">
                            Всего: {formatCompact(row.tokenCounts.input)} in
                            {" · "}
                            {formatCompact(row.tokenCounts.output)} out
                            {" · "}
                            {formatCompact(row.tokenCounts.cacheTotal)} cache
                            {" · "}
                            {formatMicroUsd(row.cost.microUsd, row.cost.approximate)}
                          </div>
                          {(row.gateway.requestCount > 0 || row.gateway.quotaDeniedCount > 0) && (
                            <div className="text-[12px] tabular-nums text-text-muted">
                              Через шлюз ИИ: {row.gateway.requestCount} запросов
                              {" · "}
                              {row.gateway.completedCount} завершено
                              {" · "}
                              {row.gateway.failedCount} с ошибкой
                              {row.gateway.quotaDeniedCount > 0 && <span> · {row.gateway.quotaDeniedCount} отклонено по лимиту</span>}
                              {row.gateway.cancelledCount > 0 && (
                                <>
                                  {" · "}
                                  {row.gateway.cancelledCount} отменено
                                </>
                              )}
                              {row.gateway.openReservationCount > 0 && (
                                <>
                                  {" · "}
                                  {row.gateway.openReservationCount} ожидают завершения
                                </>
                              )}
                              {row.gateway.providerBreakdown.map((provider) => (
                                <span key={provider.provider}>
                                  {" · "}
                                  {provider.provider}: {provider.requestCount} /{" "}
                                  {formatMicroUsd(provider.costMicroUsd)}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>
      )}
    </div>
  );
}
