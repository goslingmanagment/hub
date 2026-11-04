import { useMemo, useState, type ReactNode } from "react";
import { sumMills } from "@agency_hub_core/shared";
import { useRevenueChart, useRevenueChartComparison } from "@/api/overview";
import { ChartTable } from "@/components/charts/ChartTable";
import { RevenueLineChart, dayChange, type RevenueLinePoint } from "@/components/charts/RevenueLineChart";
import { businessDateRange } from "@/components/charts/scale";
import { Skeleton } from "@/components/ui/Skeleton";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { Segmented } from "@/components/ui/Segmented";
import { formatBusinessDateMonth, formatBusinessDateShort, formatMills, formatUtcWindowRange } from "@/lib/format";
import { mainRevenueWindow, revenueComparisonRange, type RevenueWindow } from "@/lib/revenueWindow";

type Series = ReadonlyArray<{ businessDate: string; netAmountMills: number }>;

const today = () => new Date().toISOString().slice(0, 10);
const lastDayOf = (toExclusive: string) => new Date(Date.parse(toExclusive) - 1).toISOString().slice(0, 10);

/** The days of the axis, the window's: inside it a day without operations is a zero. */
function dailyPoints(current: Series, previous: Series | undefined, window: RevenueWindow | null): RevenueLinePoint[] {
  const known = current.map((point) => point.businessDate).sort();
  const from = window?.from?.slice(0, 10) ?? known[0];
  const to = window?.to ? lastDayOf(window.to) : known.at(-1);
  if (!from || !to) return [];
  const values = new Map(current.map((point) => [point.businessDate, point.netAmountMills]));
  const before = new Map((previous ?? []).map((point) => [point.businessDate, point.netAmountMills]));
  const comparisonDays = window?.comparisonFrom && window.comparisonTo
    ? businessDateRange(window.comparisonFrom.slice(0, 10), lastDayOf(window.comparisonTo))
    : [];
  const now = today();
  return businessDateRange(from, to).map((date, index) => {
    const previousDate = comparisonDays[index];
    return {
      date,
      current: date > now ? null : values.get(date) ?? 0,
      previous: previous && previousDate !== undefined ? before.get(previousDate) ?? 0 : null,
      ...(previousDate === undefined ? {} : { previousDate }),
      incomplete: date === now,
    };
  });
}

function monthlyPoints(current: Series): RevenueLinePoint[] {
  const months = new Map<string, number[]>();
  for (const point of current) {
    const month = `${point.businessDate.slice(0, 7)}-01`;
    months.set(month, [...(months.get(month) ?? []), point.netAmountMills]);
  }
  return [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({ date, current: Number(sumMills(values)) }));
}

/**
 * «Доход по дням», the same card wherever money is shown by day (Главная, a page's
 * summary): the line of the period and the neutral line of the previous one, the
 * total from the server, «Числа таблицей». `scope` is what `useRevenueChart` reads:
 * `agency`, `model:<slug>`, `page:<label>`. Reads only; the caller holds the choice.
 */
export function RevenueDailyCard({ scope, period, windowAt, windows, totalMills, select, allowMonthly = false, onShowWeek, enabled = true }: {
  scope: string;
  period: string;
  /** The report's clock: the chart and the report cannot disagree about «today». */
  windowAt: string | undefined;
  /** The windows of the pages in this chart. */
  windows: readonly RevenueWindow[];
  /** The server's sum for this scope. */
  totalMills: number | null | undefined;
  /** The chooser of what to show, on the card's right. */
  select?: ReactNode;
  /** For all time: «По дням · По месяцам». */
  allowMonthly?: boolean;
  /** For «Сегодня»: «Показать 7 дней». */
  onShowWeek?: (() => void) | undefined;
  enabled?: boolean;
}) {
  const main = mainRevenueWindow(windows);
  const single = period === "today";
  const compared = period !== "all" && !single;
  const daily = useRevenueChart(scope, period, windowAt, enabled && !single && Boolean(windowAt));
  const previous = useRevenueChartComparison(scope, main?.comparisonFrom, main?.comparisonTo, enabled && compared);
  const [step, setStep] = useState<"day" | "month">("day");
  const monthly = allowMonthly && period === "all" && step === "month";
  const series = daily.data?.series;
  const previousSeries = compared ? previous.data?.series : undefined;
  const points = useMemo(
    () => (!series ? [] : monthly ? monthlyPoints(series) : dailyPoints(series, previousSeries, period === "all" ? null : main)),
    [main, monthly, period, previousSeries, series],
  );
  const formatDate = monthly ? formatBusinessDateMonth : formatBusinessDateShort;
  const currentLabel = main?.from && main.to && compared ? formatUtcWindowRange(main.from, main.to) : "Доход";
  const previousLabel = compared && previousSeries ? revenueComparisonRange(main) ?? undefined : undefined;
  // OnlyFans' window starts a day earlier: its first day is in the total, not on the axis.
  const other = windows.find((window) => window !== main && window.from && main?.from && window.from < main.from);
  const onlyOther = other?.from ? formatBusinessDateShort(other.from.slice(0, 10)) : null;

  return (
    <section className="card" aria-label="Доход по дням">
      <div className="card-header">
        <div className="min-w-0">
          <h2 className="card-title">Доход по дням</h2>
          {totalMills !== null && totalMills !== undefined && (
            <p className="card-description">Итого за период: <span className="font-medium text-text-primary tabular-nums">{formatMills(totalMills)}</span></p>
          )}
        </div>
        {allowMonthly && period === "all" && (
          <Segmented label="Шаг графика" value={step} onChange={setStep} options={[{ value: "day", label: "По дням" }, { value: "month", label: "По месяцам" }]} />
        )}
        {select}
      </div>
      <div className="card-body">
        {single ? (
          <div className="empty">
            <p className="empty-text">За один день графика нет</p>
            {onShowWeek && <div className="empty-actions"><button type="button" className="btn btn-sm" onClick={onShowWeek}>Показать 7 дней</button></div>}
          </div>
        ) : (
          <>
            <QueryNotice error={daily.isError} stale={Boolean(daily.data)} retry={daily.refetch} at={daily.dataUpdatedAt} />
            {daily.isLoading ? (
              <div role="status" style={{ height: 300 }}><span className="sr-only">Загружаем график…</span><Skeleton width="100%" className="h-full" /></div>
            ) : series && series.length === 0 ? (
              <p className="empty-text py-8 text-center">За этот период операций нет.</p>
            ) : series ? (
              <div className={daily.isFetching ? "is-refreshing" : undefined}>
                <RevenueLineChart points={points} currentLabel={currentLabel} previousLabel={previousLabel} formatDate={formatDate} />
                {compared && previous.isError && (
                  <p className="mt-2 text-xs text-text-secondary">
                    Прошлый период не пришёл. <button type="button" className="link" onClick={() => void previous.refetch()}>Повторить</button>
                  </p>
                )}
                {onlyOther && compared && <p className="mt-2 text-xs text-text-secondary">{onlyOther} есть только у OnlyFans: в итоге учтён, на графике нет.</p>}
                <ChartTable
                  caption="Доход по дням"
                  rows={points}
                  rowKey={(point) => point.date}
                  columns={[
                    { key: "date", label: "Дата", value: (point) => formatDate(point.date) },
                    { key: "current", label: "Доход", num: true, value: (point) => (point.current === null ? "—" : formatMills(point.current)) },
                    ...(previousLabel ? [
                      { key: "previous", label: "Прошлый период", num: true, value: (point: RevenueLinePoint) => (point.previous === null || point.previous === undefined ? "—" : formatMills(point.previous)) },
                      { key: "change", label: "Изменение", num: true, value: (point: RevenueLinePoint) => dayChange(point) ?? "—" },
                    ] : []),
                  ]}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
