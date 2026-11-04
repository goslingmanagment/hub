import type { AdminAiSpendResponse } from "@agency_hub_core/contracts";
import { MOSCOW_TIME_ZONE } from "@agency_hub_core/shared";
import { StackedBarChart, type StackedBarChartSeries } from "@/components/shared/StackedBarChart";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatAiUsd, formatBusinessDateShort, formatDayRange, type UsagePeriod } from "@/lib/format";
import { anyFeatureLabel, callsWord, sharePct, todayMoscow } from "./aiShared.js";

type Spend = AdminAiSpendResponse;

const SERIES_COLORS = [
  "var(--color-chart-blue)",
  "var(--color-chart-orange)",
  "var(--color-chart-aqua)",
  "var(--color-chart-violet)",
  "var(--color-chart-magenta)",
  "var(--color-chart-lime)",
];

const dollars = (value: number) => formatAiUsd(Math.round(value * 1_000_000));

/** The days of the period that have begun: «В день» divides by them, not by the days with spend. */
function daysSoFar(from: string, to: string): number {
  const last = to < todayMoscow() ? to : todayMoscow();
  return Math.max(1, Math.round((Date.parse(last) - Date.parse(from)) / 86_400_000) + 1);
}

function SpendChart({ data, mode }: { data: Spend; mode: UsagePeriod }) {
  const byHour = mode === "day";
  const features = data.breakdowns.feature.map((row) => row.key);
  const shown = features.slice(0, SERIES_COLORS.length);
  const series: StackedBarChartSeries[] = [
    ...shown.map((feature, index) => ({ key: feature, label: anyFeatureLabel(feature), color: SERIES_COLORS[index]! })),
    ...(features.length > shown.length ? [{ key: "other", label: "Прочее", color: "var(--color-border-strong)" }] : []),
  ];
  let rows: Array<Record<string, string | number>>;
  if (byHour) {
    rows = Array.from({ length: 24 }, (_, hour) => {
      const key = String(hour).padStart(2, "0");
      const row = data.breakdowns.hour.find((item) => item.key === key);
      return { x: key, total: (row?.costMicroUsd ?? 0) / 1_000_000 };
    });
  } else {
    // Every day of the period up to today, gaps included, so the bars stay evenly spaced.
    const days: string[] = [];
    const last = data.to < todayMoscow() ? data.to : todayMoscow();
    for (let day = new Date(`${data.from}T00:00:00Z`); day.toISOString().slice(0, 10) <= last; day.setUTCDate(day.getUTCDate() + 1)) {
      days.push(day.toISOString().slice(0, 10));
    }
    rows = days.map((day) => {
      const row: Record<string, string | number> = { x: day };
      for (const item of data.breakdowns.dayFeature) {
        const [itemDay, feature] = item.key.split("|");
        if (itemDay !== day || feature === undefined) continue;
        const target = shown.includes(feature) ? feature : "other";
        row[target] = Number(row[target] ?? 0) + item.costMicroUsd / 1_000_000;
      }
      return row;
    });
  }
  // The owner's AI setting changes, one mark per day (or hour) they fell on; the list is under «Подробнее».
  const marks = new Map<string, number>();
  for (const change of data.settingChanges) {
    const local = new Date(change.at).toLocaleString("sv-SE", { timeZone: MOSCOW_TIME_ZONE });
    const x = byHour ? local.slice(11, 13) : local.slice(0, 10);
    if (rows.some((row) => row.x === x)) marks.set(x, (marks.get(x) ?? 0) + 1);
  }
  return (
    <StackedBarChart
      title=""
      markers={[...marks.entries()].map(([x, count]) => ({ x, label: `⚙${count}` }))}
      data={rows}
      xKey="x"
      series={byHour ? [{ key: "total", label: "Траты", color: "var(--color-chart-blue)" }] : series}
      xTickFormatter={(value) => (byHour ? `${value}:00` : formatBusinessDateShort(value))}
      valueFormatter={dollars}
      height={260}
    />
  );
}

/** «За период»: what the period cost, by whose click, and day by day. */
export function AiPeriodBlock({ data, mode, onShowMonth }: { data: Spend; mode: UsagePeriod; onShowMonth: () => void }) {
  const total = data.total;
  const human = data.breakdowns.branch.find((row) => row.key === "human")?.costMicroUsd ?? 0;
  const background = data.breakdowns.branch.find((row) => row.key === "background")?.costMicroUsd ?? 0;
  const empty = total.calls === 0 && total.costMicroUsd === 0;
  return (
    <section className="card" aria-labelledby="ai-period-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="ai-period-title" className="card-title">За период</h2>
          <p className="card-description">{formatDayRange(data.from, data.to)}</p>
        </div>
      </div>
      {empty ? (
        <div className="card-body">
          <div className="empty">
            <p className="empty-title">За эти дни трат на ИИ нет</p>
            {mode !== "month" && <div className="empty-actions"><button type="button" className="btn btn-sm" onClick={onShowMonth}>Показать месяц</button></div>}
          </div>
        </div>
      ) : (
        <div className="card-body space-y-6">
          <StatGrid className="ai-strip">
            <Stat label="Всего" value={formatAiUsd(total.costMicroUsd)} meta={callsWord(total.calls)} />
            {mode !== "day" && (
              <Stat label="В день" value={formatAiUsd(Math.round(total.costMicroUsd / daysSoFar(data.from, data.to)))} meta="Среднее по дням периода" />
            )}
            <Stat label="По кнопке чаттера" value={sharePct(human, total.costMicroUsd)} meta={`${formatAiUsd(human)}; сам Hub ${formatAiUsd(background)}`} />
            {/* Two overlapping sets (a failed regeneration is both): shown apart, never summed. */}
            <Stat label="Перегенерации" value={formatAiUsd(total.regenerationMicroUsd)} meta={`ошибки и отмены ${formatAiUsd(total.failedMicroUsd)}`} />
          </StatGrid>
          <div>
            <h3 className="ai-subtitle">{mode === "day" ? "Траты по часам" : "Траты по дням и функциям"}</h3>
            <SpendChart data={data} mode={mode} />
          </div>
        </div>
      )}
    </section>
  );
}
