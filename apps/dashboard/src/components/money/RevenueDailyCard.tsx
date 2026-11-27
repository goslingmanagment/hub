import { useMemo, useState, type ReactNode } from "react";
import { BUSINESS_TIME_ZONE, sumMills, toBusinessDate } from "@agency_hub_core/shared";
import { useRevenueChart, useRevenueChartComparison } from "@/api/overview";
import { ChartTable } from "@/components/charts/ChartTable";
import { MoneyDelta } from "@/components/money/Delta";
import { ruPlural } from "@/lib/plural";
import { RevenueLineChart, dayChange, type RevenueGoal, type RevenueLinePoint } from "@/components/charts/RevenueLineChart";
import { businessDateRange } from "@/components/charts/scale";
import { Skeleton } from "@/components/ui/Skeleton";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { Segmented } from "@/components/ui/Segmented";
import { formatBusinessDateMonth, formatBusinessDateShort, formatMills, formatWindowRange } from "@/lib/format";
import { businessDayOf, lastBusinessDayOf, mainRevenueWindow, revenueComparisonRange, type RevenueWindow } from "@/lib/revenueWindow";

type Series = ReadonlyArray<{ businessDate: string; netAmountMills: number }>;

/** Today in Hub's days: Moscow. */
const today = () => toBusinessDate(new Date(), BUSINESS_TIME_ZONE);

/** The days of the axis, the window's: inside it a day without operations is a zero. */
function dailyPoints(current: Series, previous: Series | undefined, window: RevenueWindow | null): RevenueLinePoint[] {
  const known = current.map((point) => point.businessDate).sort();
  const from = window?.from ? businessDayOf(window.from) : known[0];
  const to = window?.to ? lastBusinessDayOf(window.to) : known.at(-1);
  if (!from || !to) return [];
  const values = new Map(current.map((point) => [point.businessDate, point.netAmountMills]));
  const before = new Map((previous ?? []).map((point) => [point.businessDate, point.netAmountMills]));
  const comparisonDays = window?.comparisonFrom && window.comparisonTo
    ? businessDateRange(businessDayOf(window.comparisonFrom), lastBusinessDayOf(window.comparisonTo))
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

/** The average of whole mills, or nothing to average. */
function averageMills(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.round(Number(sumMills(values)) / values.length);
}

/**
 * Money a day (owner, 2026-11-28): the period's finished days only — today is still
 * going and would pull the average down — against the previous period's days.
 */
export function dailyPace(points: readonly RevenueLinePoint[]) {
  const current = averageMills(points.flatMap((point) => (point.current === null || point.incomplete ? [] : [point.current])));
  const previous = averageMills(points.flatMap((point) => (point.previous === null || point.previous === undefined ? [] : [point.previous])));
  const delta = current !== null && previous !== null ? current - previous : null;
  const pct = delta !== null && previous ? (delta / Math.abs(previous)) * 100 : null;
  return { current, days: points.filter((point) => point.current !== null && !point.incomplete).length, delta, pct };
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
export function RevenueDailyCard({ scope, title = "Доход по дням", period, windowAt, windows, totalMills, select, allowMonthly = false, onShowWeek, goal, enabled = true }: {
  scope: string;
  /** The card's heading: «Доход по дням» unless the card is one of several. */
  title?: string;
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
  /** A day's bar across the daily line; months are not compared with it. */
  goal?: RevenueGoal | undefined;
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
  const days = useMemo(
    () => (!series ? [] : dailyPoints(series, previousSeries, period === "all" ? null : main)),
    [main, period, previousSeries, series],
  );
  const points = useMemo(() => (!series ? [] : monthly ? monthlyPoints(series) : days), [days, monthly, series]);
  const pace = dailyPace(days);
  const formatDate = monthly ? formatBusinessDateMonth : formatBusinessDateShort;
  const currentLabel = main?.from && main.to && compared ? formatWindowRange(main.from, main.to) : "Доход";
  const previousLabel = compared && previousSeries ? revenueComparisonRange(main) ?? undefined : undefined;

  return (
    <section className="card" aria-label={title}>
      <div className="card-header">
        <div className="min-w-0">
          <h2 className="card-title">{title}</h2>
          {totalMills !== null && totalMills !== undefined && (
            <p className="card-description">Итого за период: <span className="font-medium text-text-primary tabular-nums">{formatMills(totalMills)}</span></p>
          )}
          {!single && pace.current !== null && (
            <p className="card-description" title={`Среднее за ${pace.days} ${ruPlural(pace.days, "полный день", "полных дня", "полных дней")}: сегодняшний день ещё идёт и в среднее не входит`}>
              В среднем в день: <span className="font-medium text-text-primary tabular-nums">{formatMills(pace.current)}</span>
              {compared && pace.delta !== null && <> <MoneyDelta mills={pace.delta} pct={pace.pct} /></>}
            </p>
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
                <RevenueLineChart points={points} currentLabel={currentLabel} previousLabel={previousLabel} formatDate={formatDate} goal={monthly ? undefined : goal} />
                {compared && previous.isError && (
                  <p className="mt-2 text-xs text-text-secondary">
                    Прошлый период не пришёл. <button type="button" className="link" onClick={() => void previous.refetch()}>Повторить</button>
                  </p>
                )}
                <ChartTable
                  caption={title}
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
