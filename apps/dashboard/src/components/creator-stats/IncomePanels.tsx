import { useMemo } from "react";
import { Link, useLocation } from "react-router";
import { sumMills, type Mills } from "@agency_hub_core/shared";

import type { MoneyRevenueMixResponse, PageRevenueResponse, RevenueDailyResponse } from "@agency_hub_core/contracts";
import type { ChartSeries } from "@/components/charts/ChartKit";
import { ChartTable } from "@/components/charts/ChartTable";
import { usdAxisFormatter } from "@/components/charts/format";
import { MoneyDelta } from "@/components/money/Delta";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatCount, formatDateTime, formatMills, formatSignedMills } from "@/lib/format";
import { buildRevenueTransactionsRoute } from "@/lib/overviewNavigation";
import { ANTHROPIC_RECONCILIATION_STATUS } from "@/lib/statusWords";

import { StatsCard, StatsEmpty } from "./StatsCard.js";
import {
  IN_PROGRESS_NOTE,
  OTHER_TYPE_COLOR,
  barRows,
  coveredFrom,
  dayUnfinished,
  formatMonth,
  formatStatsDay,
  keysByTotal,
  pivotDays,
  revenueTypeColor,
  revenueTypeLabel,
  shiftDay,
  windowDays,
  type CreatorStats,
  type DayPoint,
  type Kpi,
} from "./creator-stats-model.js";

type Query<T> = { data: T | undefined; isPending: boolean; isError: boolean; refetch: () => unknown };

const toNumber = (mills: Mills) => Number(mills);

/** Fansly's money of the window by its own days: sums of whole mills, for showing only. */
export function fanslyNetByDay(stats: CreatorStats): Map<string, Mills> {
  const byDay = new Map<string, Array<number>>();
  for (const row of stats.revenue) {
    if (row.netMills === null) continue;
    byDay.set(row.day, [...(byDay.get(row.day) ?? []), row.netMills]);
  }
  return new Map([...byDay.entries()].map(([day, values]) => [day, sumMills(values)]));
}

export function fanslyNet(stats: CreatorStats): Mills | null {
  const values = stats.revenue.flatMap((row) => (row.netMills === null ? [] : [row.netMills]));
  return values.length === 0 ? null : sumMills(values);
}

export type CheckState =
  | { kind: "waiting" }
  | { kind: "no-answer" }
  | { kind: "same" }
  | { kind: "counting" }
  | { kind: "differs"; difference: Mills; days: Array<{ day: string; fansly: Mills; hub: Mills; difference: Mills }> | null };

/**
 * Do Fansly and Hub's operations agree over the same days? Equal sums: «Сходится».
 * Unequal, and only today differs: «Досчитывается» (Fansly is read once an hour).
 * A closed day differs: «Расходится», with the days. The days are asked only when
 * the sums disagree; until they come the word waits.
 */
export function checkState(stats: CreatorStats, hub: Query<PageRevenueResponse>, hubDays: Query<RevenueDailyResponse>, today: string): CheckState {
  if (hub.data === undefined) return hub.isError ? { kind: "no-answer" } : { kind: "waiting" };
  const fansly = fanslyNet(stats) ?? sumMills([]);
  const hubTotal = sumMills([hub.data.totalNetMills]);
  if (fansly === hubTotal) return { kind: "same" };
  const difference = sumMills([fansly, -hubTotal]);
  if (hubDays.data === undefined) return hubDays.isError ? { kind: "differs", difference, days: null } : { kind: "waiting" };
  const fanslyDays = fanslyNetByDay(stats);
  const hubByDay = new Map(hubDays.data.series.map((point) => [point.businessDate, sumMills([point.netAmountMills])]));
  const days = [...new Set([...fanslyDays.keys(), ...hubByDay.keys()])]
    .filter((day) => day >= stats.window.fromDay && day <= stats.window.toDay)
    .map((day) => {
      const fanslyDay = fanslyDays.get(day) ?? sumMills([]);
      const hubDay = hubByDay.get(day) ?? sumMills([]);
      return { day, fansly: fanslyDay, hub: hubDay, difference: sumMills([fanslyDay, -hubDay]) };
    })
    .filter((day) => day.difference !== 0n)
    .sort((left, right) => right.day.localeCompare(left.day));
  if (days.length > 0 && days.every((day) => day.day === today)) return { kind: "counting" };
  return { kind: "differs", difference, days };
}

function hubRoute(pageLabel: string, from: string | null, to: string | null, backTo: string): string {
  return buildRevenueTransactionsRoute({ pageLabel, from, to, backTo });
}

/** The four tiles of «Доход Fansly». A tile whose query did not answer says so itself. */
export function IncomeTiles({ stats, kpi, hub, check, pageLabel }: {
  stats: CreatorStats;
  /** Fansly's own total of the summary window, for the comparison. */
  kpi: Kpi;
  hub: Query<PageRevenueResponse>;
  check: CheckState;
  pageLabel: string;
}) {
  const location = useLocation();
  const net = fanslyNet(stats);
  const sameWindow = stats.totalsWindow !== null
    && stats.totalsWindow.fromDay === stats.window.fromDay && stats.totalsWindow.toDay === stats.window.toDay;
  const delta = sameWindow && net !== null && kpi.previous !== null ? sumMills([net, -kpi.previous]) : null;
  const pct = delta !== null && kpi.previous ? (toNumber(delta) / Math.abs(kpi.previous)) * 100 : null;
  const grossValues = stats.revenue.flatMap((row) => (row.grossMills === null ? [] : [row.grossMills]));
  const purchases = stats.revenue.reduce((sum, row) => sum + (row.transactions ?? 0), 0);
  const refunds = stats.revenue.reduce((sum, row) => sum + (row.refunds ?? 0), 0);
  const window = hub.data?.platformWindows[0];
  const backTo = `${location.pathname}${location.search}`;

  return (
    <div className="stat-grid stats-strip">
      <div className="stat">
        <p className="stat-label">Доход по данным Fansly</p>
        <p className="stat-value">{net === null ? "—" : formatMills(net)}</p>
        <p className="stat-meta"><MoneyDelta mills={delta} pct={pct} /></p>
      </div>
      {hub.data ? (
        <Link className="stat" to={hubRoute(pageLabel, window?.from ?? null, window?.to ?? null, backTo)}>
          <p className="stat-label">По операциям Hub</p>
          <p className="stat-value">{formatMills(hub.data.totalNetMills)}</p>
          <div className="stat-meta"><CheckWord check={check} /></div>
        </Link>
      ) : (
        <div className="stat">
          <p className="stat-label">По операциям Hub</p>
          {hub.isError ? (
            <>
              <p className="stat-value">—</p>
              <p className="stat-meta">
                Hub не ответил{" "}
                <button type="button" className="link" onClick={() => void hub.refetch()}>Повторить</button>
              </p>
            </>
          ) : (
            <>
              <p className="stat-value"><Skeleton width={140} className="stats-skeleton-value" /></p>
              <p className="stat-meta"><Skeleton width={90} /></p>
            </>
          )}
        </div>
      )}
      <div className="stat">
        <p className="stat-label">До комиссии</p>
        <p className="stat-value">{grossValues.length === 0 ? "—" : formatMills(sumMills(grossValues))}</p>
        <p className="stat-meta">по данным Fansly</p>
      </div>
      <div className="stat">
        <p className="stat-label">Покупок</p>
        <p className="stat-value">{stats.revenue.length === 0 ? "—" : formatCount(purchases)}</p>
        <p className="stat-meta">{refunds > 0 ? `возвратов — ${formatCount(refunds)}` : "возвратов нет"}</p>
      </div>
    </div>
  );
}

function CheckWord({ check }: { check: CheckState }) {
  switch (check.kind) {
    case "waiting":
      return <Skeleton width={90} />;
    case "no-answer":
      return <>Hub не ответил</>;
    case "same":
      return <StatusBadge bare status={ANTHROPIC_RECONCILIATION_STATUS.ok} />;
    case "counting":
      return (
        <>
          <StatusBadge bare status={ANTHROPIC_RECONCILIATION_STATUS.open} />
          <span className="stats-check-note">Сегодняшний день ещё идёт: Hub читает Fansly раз в час.</span>
        </>
      );
    case "differs":
      return (
        <>
          <StatusBadge status={ANTHROPIC_RECONCILIATION_STATUS.mismatch} />
          <span className="stats-check-note">Разница {formatSignedMills(check.difference)}</span>
        </>
      );
  }
}

// ── revenue by day ───────────────────────────────────────────────────────────

const MAX_SERIES = 6;
const OTHER_KEY = "__other";

export function RevenueByDayPanel({ stats, pageLabel, periodText }: { stats: CreatorStats; pageLabel: string; periodText: string }) {
  const days = windowDays(stats);
  const from = coveredFrom(stats, "series:revenue:day");
  const { series, rows, table } = useMemo(() => {
    const labels = keysByTotal(stats.revenue, (row) => row.productLabel, (row) => row.netMills);
    // Six series at most: the five largest by name, the rest as «Прочее» (on the chart only).
    const shownLabels = labels.length > MAX_SERIES ? labels.filter((label) => label !== "refund").slice(0, MAX_SERIES - 1) : labels;
    const keep = new Set(shownLabels);
    if (labels.length > MAX_SERIES && labels.includes("refund")) keep.add("refund");
    const keyOf = (label: string) => (keep.has(label) ? label : OTHER_KEY);
    const chartKeys = [...labels.filter((label) => keep.has(label)), ...(labels.some((label) => !keep.has(label)) ? [OTHER_KEY] : [])];
    const chartSeries: ChartSeries[] = chartKeys.map((key) => ({
      key,
      label: key === OTHER_KEY ? "Прочее" : revenueTypeLabel(key),
      color: key === OTHER_KEY ? OTHER_TYPE_COLOR : revenueTypeColor(key),
    }));
    const points = pivotDays(days, stats.revenue, (row) => keyOf(row.productLabel), (row) => row.netMills, chartKeys, from);
    const totals = labels.map((label) => {
      const of = stats.revenue.filter((row) => row.productLabel === label);
      return {
        label,
        net: sumMills(of.flatMap((row) => (row.netMills === null ? [] : [row.netMills]))),
        gross: sumMills(of.flatMap((row) => (row.grossMills === null ? [] : [row.grossMills]))),
        transactions: of.reduce((sum, row) => sum + (row.transactions ?? 0), 0),
        refunds: of.reduce((sum, row) => sum + (row.refunds ?? 0), 0),
      };
    }).sort((left, right) => (left.net === right.net ? 0 : left.net > right.net ? -1 : 1));
    return { series: chartSeries, rows: points, table: totals };
  }, [days, from, stats.revenue]);

  const note = (row: Record<string, unknown>) => (dayUnfinished(row) ? IN_PROGRESS_NOTE : null);
  const sum = {
    transactions: table.reduce((acc, row) => acc + row.transactions, 0),
    gross: sumMills(table.map((row) => row.gross)),
    net: sumMills(table.map((row) => row.net)),
    refunds: table.reduce((acc, row) => acc + row.refunds, 0),
  };

  return (
    <StatsCard wide id="stats-income-days" title="Доход по дням" description="После комиссии, по видам дохода Fansly.">
      {stats.revenue.length === 0 ? (
        <StatsEmpty>На {pageLabel} за {periodText} Fansly дохода не прислал.</StatsEmpty>
      ) : (
        <>
          <div className="card-body">
            <StackedBarChart
              title=""
              data={barRows(rows)}
              xKey="bucketStart"
              series={series}
              xTickFormatter={formatStatsDay}
              valueFormatter={(value) => formatMills(value)}
              axisFormatter={usdAxisFormatter}
              tickSpacing={{ spacing: 80, max: 7 }}
              totalLabel="Всего"
              note={note}
              unfinished={dayUnfinished}
              height={280}
            />
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Вид дохода</th>
                  <th scope="col" className="num">Покупок</th>
                  <th scope="col" className="num">До комиссии</th>
                  <th scope="col" className="num">После комиссии</th>
                  <th scope="col" className="num">Возвратов</th>
                </tr>
              </thead>
              <tbody>
                {table.map((row) => (
                  <tr key={row.label}>
                    <td>
                      <span className="stats-swatch" style={{ background: revenueTypeColor(row.label) }} aria-hidden="true" />
                      {revenueTypeLabel(row.label)}
                    </td>
                    <td className="num">{formatCount(row.transactions)}</td>
                    <td className="num muted">{formatMills(row.gross)}</td>
                    <td className="num">{formatMills(row.net)}</td>
                    <td className="num">{row.refunds > 0 ? formatCount(row.refunds) : "—"}</td>
                  </tr>
                ))}
                <tr className="row-total">
                  <td>Итого</td>
                  <td className="num">{formatCount(sum.transactions)}</td>
                  <td className="num">{formatMills(sum.gross)}</td>
                  <td className="num">{formatMills(sum.net)}</td>
                  <td className="num">{sum.refunds > 0 ? formatCount(sum.refunds) : "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="card-body stats-table-after">
            <ChartTable
              caption="Доход по дням"
              rows={rows}
              rowKey={(row: DayPoint) => row.bucketStart}
              columns={[
                { key: "day", label: "День", value: (row) => formatStatsDay(row.bucketStart) },
                ...series.map((entry) => ({ key: entry.key, label: entry.label, num: true, value: (row: DayPoint) => (typeof row[entry.key] === "number" ? formatMills(row[entry.key] as number) : "—") })),
                {
                  key: "total",
                  label: "Всего",
                  num: true,
                  value: (row) => {
                    const values = series.map((entry) => row[entry.key]).filter((value): value is number => typeof value === "number");
                    return values.length === 0 ? "—" : formatMills(sumMills(values));
                  },
                },
              ]}
            />
          </div>
        </>
      )}
    </StatsCard>
  );
}

// ── where it differs ────────────────────────────────────────────────────────

export function MismatchPanel({ check, pageLabel, today, hubDays }: {
  check: Extract<CheckState, { kind: "differs" }>;
  pageLabel: string;
  today: string;
  hubDays: Query<RevenueDailyResponse>;
}) {
  const location = useLocation();
  const backTo = `${location.pathname}${location.search}`;
  return (
    <StatsCard wide id="stats-mismatch" title="Где расходится" description="Дни, где доход по данным Fansly и по операциям Hub не совпал. Новые сверху.">
      {check.days === null ? (
        <div className="empty stats-empty">
          <p className="empty-text">Не удалось получить разбивку по дням.</p>
          <div className="empty-actions"><button type="button" className="btn btn-sm" onClick={() => void hubDays.refetch()}>Повторить</button></div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">День</th>
                <th scope="col" className="num">По данным Fansly</th>
                <th scope="col" className="num">По операциям Hub</th>
                <th scope="col" className="num">Разница</th>
              </tr>
            </thead>
            <tbody>
              {check.days.map((day) => (
                <tr key={day.day}>
                  <td>{formatStatsDay(day.day)}{day.day === today && <span className="muted"> · день идёт</span>}</td>
                  <td className="num">{formatMills(day.fansly)}</td>
                  <td className="num">
                    <Link
                      className="stats-quiet-link"
                      to={hubRoute(pageLabel, `${day.day}T00:00:00.000Z`, `${shiftDay(day.day, 1)}T00:00:00.000Z`, backTo)}
                    >
                      {formatMills(day.hub)}
                    </Link>
                  </td>
                  <td className="num">{formatSignedMills(day.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StatsCard>
  );
}

// ── months ───────────────────────────────────────────────────────────────────

function moneyOrDash(value: number | null): string {
  return value === null ? "—" : formatMills(value);
}

export function MonthsPanel({ months, pageLabel }: { months: Query<MoneyRevenueMixResponse>; pageLabel: string }) {
  const rows = months.data?.months ?? [];
  const real = rows.filter((month) => !month.rollup);
  const rollup = rows.find((month) => month.rollup);
  const newest = rows.reduce<string | null>((latest, month) => (latest === null || month.lastObservedAt > latest ? month.lastObservedAt : latest), null);
  const now = new Date();
  const going = (month: (typeof rows)[number]) =>
    (month.windowEnd !== null && Date.parse(month.windowEnd) > now.getTime())
    || (month.year === now.getUTCFullYear() && month.month === now.getUTCMonth() + 1);
  return (
    <StatsCard
      wide
      id="stats-months"
      title="Итоги по месяцам"
      description="Из выписок Fansly. Не зависят от выбранного периода."
      measure={newest ? <span className="stats-card-note">Обновлено {formatDateTime(newest)}</span> : undefined}
      footer={rollup ? (
        <div className="card-footer stats-rollup">
          <span>Сводный итог Fansly, не складывается с месяцами:</span>
          <span className="tabular-nums">
            до комиссии {moneyOrDash(rollup.totalGrossMills)}, после комиссии{" "}
            <span className="font-medium text-text-primary">{moneyOrDash(rollup.totalNetMills)}</span>
          </span>
        </div>
      ) : undefined}
    >
      {months.data === undefined ? (
        months.isError ? <NoAnswerPanel retry={() => months.refetch()} /> : (
          <div className="card-body"><Skeleton width="60%" /><div className="mt-3"><Skeleton width="50%" /></div><div className="mt-3"><Skeleton width="55%" /></div></div>
        )
      ) : real.length === 0 ? (
        <StatsEmpty>Для {pageLabel} итоги по месяцам ещё не собраны.</StatsEmpty>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Месяц</th>
                <th scope="col" className="num">До комиссии</th>
                <th scope="col" className="num">После комиссии</th>
              </tr>
            </thead>
            <tbody>
              {real.map((month) => (
                <tr key={`${month.year}-${month.month}`}>
                  <td>{formatMonth(month.year, month.month)}{going(month) && <span className="muted">, месяц идёт</span>}</td>
                  <td className="num muted">{moneyOrDash(month.totalGrossMills)}</td>
                  <td className="num">{moneyOrDash(month.totalNetMills)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StatsCard>
  );
}
