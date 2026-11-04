import { Fragment, useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { OfapiCreditsLedgerResponse } from "@agency_hub_core/contracts";
import {
  CHART_ANIMATION,
  CHART_MARGIN,
  ChartTooltipCard,
  activeDot,
  chartGridProps,
  lineCursor,
  useTickBudget,
  xAxisProps,
  yAxisProps,
  type ChartTooltipRenderProps,
} from "@/components/charts/ChartKit";
import { evenTickIndices, linearTicks } from "@/components/charts/scale";
import { formatBusinessDateShort, formatDate, formatDateTime } from "@/lib/format";
import { credits, creditsToUsd, creditsWord, fmtCredits, operationLabel } from "@/lib/ofapiCredits";
import { ruPlural } from "@/lib/plural";
import type { OfapiStatus } from "@/lib/statusWords";

export const LEDGER_PAGE_SIZE = 50;
export const CHART_DAYS = 30;
export const BREAKDOWN_DAYS = [7, 30, 90] as const;

/** The validated chart hues in their categorical order (never the status colours). */
export const SOURCE_SERIES = [
  { key: "rest", label: "Приложение", color: "var(--color-chart-blue)" },
  { key: "webhookAccrual", label: "События OnlyFans", color: "var(--color-chart-orange)" },
  { key: "external", label: "Сверка баланса", color: "var(--color-chart-aqua)" },
  { key: "adjustment", label: "Корректировки", color: "var(--color-text-muted)" },
] as const;

export const SOURCE_FILTER_OPTIONS = [
  { value: "", label: "Все источники" },
  { value: "rest", label: "Приложение" },
  { value: "webhook_accrual", label: "События OnlyFans" },
  { value: "external", label: "Сверка баланса" },
  { value: "refill", label: "Рост баланса" },
  { value: "adjustment", label: "Корректировки" },
] as const;

const LEDGER_SOURCE_LABELS: Readonly<Record<string, string>> = {
  rest: "Приложение",
  webhook_accrual: "Событие OnlyFans",
  external: "Сверка баланса",
  refill: "Рост баланса",
  adjustment: "Корректировка",
};
export const sourceLabel = (source: string) => LEDGER_SOURCE_LABELS[source] ?? source;


export { credits, creditsToUsd, creditsWord, fmtCredits, operationLabel };
export const daysWord = (value: number) => ruPlural(value, "день", "дня", "дней");
/** A UTC day of the hub's ledger, written as a day: «4 нояб.». */
export const humanDay = (day: string) => formatBusinessDateShort(day);
export { formatDate, formatDateTime };

/** A page's revenue ÷ the estimated cost of its credits; null without a price. */
export function computeRoi(revenueMills: number, amount: number, microUsdPerCredit: number): number | null {
  if (microUsdPerCredit <= 0 || amount <= 0) return null;
  const costMills = (amount * microUsdPerCredit) / 1000;
  return costMills > 0 ? revenueMills / costMills : null;
}

export function ledgerDateStart(value: string) {
  return value ? `${value}T00:00:00.000Z` : undefined;
}

export function ledgerDateEndExclusive(value: string) {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!year || !month || !day) return undefined;
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString();
}

export function BudgetMeter({ spentToday, dailyCeiling, state, retryAt, ofapi }: {
  spentToday: number;
  dailyCeiling: number;
  state: "ok" | "budget_exhausted" | "floor_blocked";
  retryAt: string | null;
  ofapi: OfapiStatus;
}) {
  const on = ofapi === "on";
  const paused = state !== "ok";
  const pct = dailyCeiling > 0 ? Math.max(0, Math.min(100, Math.round((spentToday / dailyCeiling) * 100))) : 0;
  const bar = !on ? "ofc-bar-off" : paused ? "ofc-bar-danger" : pct >= 80 ? "ofc-bar-warning" : "ofc-bar-on";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">Все траты OnlyFans API</span>
        <span className="tabular-nums text-text-secondary">{fmtCredits(spentToday)} из {credits(dailyCeiling)}</span>
      </div>
      <div
        className="ofc-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Дневной лимит кредитов: ${spentToday} из ${dailyCeiling}`}
      >
        <div className={bar} style={{ width: `${pct}%` }} />
      </div>
      {paused && on && (
        <p className="ofc-note ai-warn">
          {state === "floor_blocked"
            ? "На паузе: баланс ниже порога автостопа."
            : `На паузе: дневной лимит исчерпан. Продолжит ${retryAt ? `в ${formatDateTime(retryAt)}` : "после сброса лимита"}.`}
        </p>
      )}
    </div>
  );
}

/** «Баланс»: one line, no fill; the increases found by the balance check are neutral marks. */
export function BalanceChart({ days, balanceByDay, refills, usd, frozen }: {
  days: string[];
  balanceByDay: Map<string, number>;
  refills: Array<{ day: string; credits: number; count: number }>;
  usd?: ((amount: number) => string) | undefined;
  frozen: boolean;
}) {
  const color = "var(--color-chart-blue)";
  // The axis spans the whole window, so «Последние 30 дней» is honest even when the
  // readings only cover a part of it.
  const data = days.map((day) => ({ day, value: balanceByDay.get(day) ?? null }));
  const hasReadings = balanceByDay.size > 0;
  const { budget, onResize } = useTickBudget();
  const yScale = linearTicks(0, Math.max(0, ...balanceByDay.values()), { integer: true });
  const xTicks = evenTickIndices(data.length, budget).map((index) => data[index]!.day);
  const refillCount = refills.reduce((sum, refill) => sum + refill.count, 0);
  const refillTotal = refills.reduce((sum, refill) => sum + refill.credits, 0);
  const firstReadingDay = hasReadings ? [...balanceByDay.keys()].sort()[0] : null;
  const startedLate = firstReadingDay != null && days.length > 0 && firstReadingDay > (days[0] ?? "");

  return (
    <section className="card" aria-labelledby="ofc-balance-title">
      <div className="card-header">
        <h2 id="ofc-balance-title" className="card-title">Баланс</h2>
        <span className="text-sm text-text-secondary">Последние {CHART_DAYS} дней{frozen ? ", по 1 ноября" : ""}</span>
      </div>
      <div className="card-body">
        {!hasReadings ? (
          <div className="empty"><p className="empty-text">Показаний баланса пока нет: график начнётся с первой проверки баланса.</p></div>
        ) : (
          <ResponsiveContainer width="100%" height={260} onResize={onResize}>
            <LineChart data={data} margin={CHART_MARGIN}>
              <CartesianGrid {...chartGridProps} />
              <XAxis {...xAxisProps} dataKey="day" ticks={xTicks} tickFormatter={formatBusinessDateShort} />
              <YAxis {...yAxisProps} domain={yScale.domain} ticks={yScale.ticks} tickFormatter={fmtCredits} width={64} />
              {refills.map((refill) => <ReferenceLine key={refill.day} x={refill.day} stroke="var(--color-chart-compare)" strokeDasharray="4 4" />)}
              <Line
                type="linear"
                dataKey="value"
                name="Баланс"
                // A balance is a level: between two readings it moved from one to the other.
                connectNulls
                stroke={color}
                strokeWidth={2}
                dot={false}
                activeDot={activeDot(color)}
                {...CHART_ANIMATION}
              />
              <Tooltip
                cursor={lineCursor}
                filterNull={false}
                isAnimationActive={false}
                wrapperStyle={{ zIndex: 20 }}
                content={(tooltip: ChartTooltipRenderProps) => (
                  <ChartTooltipCard
                    {...tooltip}
                    series={[{ key: "value", label: "Баланс", color }]}
                    formatValue={(amount) => `${credits(amount)}${usd ? ` · ${usd(amount)}` : ""}`}
                    formatLabel={(label) => formatBusinessDateShort(String(label))}
                    emptyText="Нет показания баланса за этот день"
                  />
                )}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
        {(refillCount > 0 || startedLate) && (
          <p className="ofc-note">
            {refillCount > 0 && `${refillCount} ${ruPlural(refillCount, "увеличение", "увеличения", "увеличений")} баланса по сверке за период, +${credits(refillTotal)}`}
            {refillCount > 0 && startedLate && ", "}
            {startedLate && firstReadingDay && `показания с ${humanDay(firstReadingDay)}`}
          </p>
        )}
      </div>
    </section>
  );
}

const ESTIMATE_EXPLANATIONS: Record<OfapiCreditsLedgerResponse["rows"][number]["source"], string> = {
  rest: "Оценка при учёте запроса; подтверждения и уточнения идут отдельными корректировками",
  webhook_accrual: "Оценка по числу полученных событий, а не подтверждённое списание",
  external: "Необъяснённое уменьшение баланса после учтённых расходов; источник не подтверждён",
  refill: "Увеличение баланса после учтённых расходов; платёж не подтверждён",
  adjustment: "Оценочная корректировка учёта кредитов",
};

/** Ledger credits are «spent»: positive took the balance down, negative brought it up. */
function ledgerAmount(row: { credits: number; estimated: boolean }) {
  const approx = row.estimated ? "≈ " : "";
  if (row.credits === 0) return `${approx}0`;
  return row.credits < 0 ? `${approx}+${fmtCredits(Math.abs(row.credits))}` : `${approx}−${fmtCredits(row.credits)}`;
}

export function LedgerRow({ row, showHttp, ofapi }: { row: OfapiCreditsLedgerResponse["rows"][number]; showHttp: boolean; ofapi: OfapiStatus }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const explanation = row.estimated ? ESTIMATE_EXPLANATIONS[row.source] : null;
  const failed = row.httpStatus !== null && row.httpStatus >= 400;
  return (
    <Fragment>
      <tr>
        <td className="ofc-chevron">
          <button
            type="button"
            className="home-expander"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={expanded ? "Свернуть запись" : "Раскрыть запись"}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </td>
        <td className="whitespace-nowrap tabular-nums">{formatDateTime(row.occurredAt)}</td>
        <td className="muted">{sourceLabel(row.source)}</td>
        <td>
          {row.operation ? <span title={row.operation}>{operationLabel(row.operation)}</span> : "—"}
          {failed && !showHttp && <span className={`badge ${ofapi === "on" ? "badge-danger" : ""} ml-2`}>ошибка {row.httpStatus}</span>}
        </td>
        <td className="muted">{row.pageLabel ?? "—"}</td>
        <td className={`num${row.credits < 0 && ofapi === "on" ? " delta-up" : ""}`} title={explanation ?? undefined}>{ledgerAmount(row)}</td>
        <td className="num muted">{row.balanceAfter !== null ? fmtCredits(row.balanceAfter) : "—"}</td>
        {showHttp && <td className="num muted">{row.httpStatus ?? "—"}</td>}
      </tr>
      {expanded && (
        <tr id={detailId} className="row-detail">
          <td colSpan={showHttp ? 8 : 7}>
            <p className="row-detail-note">
              {row.operation ? `Операция ${row.operation} · ` : ""}
              {row.requestId ? `запрос ${row.requestId}` : "без номера запроса"}
              {row.httpStatus !== null ? ` · код ответа ${row.httpStatus}` : ""}
              {explanation ? ` · ${explanation}` : ""}
              {row.accrualDay ? ` · день начисления ${row.accrualDay}` : ""}
              {` · запись #${row.id}`}
            </p>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
