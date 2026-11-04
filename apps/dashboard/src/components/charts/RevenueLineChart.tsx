import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { sumMills } from "@agency_hub_core/shared";
import { formatChange, formatMills } from "@/lib/format";
import {
  CHART_ANIMATION,
  CHART_MARGIN,
  ChartLegend,
  ChartTooltipCard,
  activeDot,
  chartGridProps,
  lineCursor,
  useTickBudget,
  xAxisProps,
  yAxisProps,
  type ChartSeries,
  type ChartTooltipRenderProps,
} from "./ChartKit.js";
import { usdAxisFormatter } from "./format.js";
import { evenTickIndices, linearTicks } from "./scale.js";

export interface RevenueLinePoint {
  /** The x value: a day (`YYYY-MM-DD`) or a month's first day. */
  date: string;
  current: number | null;
  previous?: number | null | undefined;
  /** The day of the previous window this point is compared with. */
  previousDate?: string | undefined;
  /** Today, still going: a ring instead of a dot, and the tooltip says so. */
  incomplete?: boolean | undefined;
}

const COLOR = "var(--color-chart-blue)";
const COMPARE = "var(--color-chart-compare)";

/** The change of one day, for the tooltip: a whole number of mills by the money helper. */
export function dayChange(point: RevenueLinePoint): string | null {
  if (point.current === null || point.previous === null || point.previous === undefined) return null;
  const delta = sumMills([point.current, -point.previous]);
  const pct = point.previous === 0 ? null : ((point.current - point.previous) / Math.abs(point.previous)) * 100;
  return formatChange(delta, pct);
}

/**
 * Money by day: one straight line, and when given a neutral line of the previous
 * window on the same positions. No fill, no gradient, no invented humps. A day
 * without data is a hole, never a zero.
 */
export function RevenueLineChart({ points, currentLabel, previousLabel, formatDate, height = 300 }: {
  points: readonly RevenueLinePoint[];
  currentLabel: string;
  /** With it the second line is drawn and the legend appears. */
  previousLabel?: string | undefined;
  formatDate: (date: string) => string;
  height?: number;
}) {
  const { budget, onResize } = useTickBudget();
  const series: ChartSeries[] = [
    { key: "current", label: currentLabel, color: COLOR },
    ...(previousLabel ? [{ key: "previous", label: previousLabel, color: COMPARE }] : []),
  ];
  const values = points.flatMap((point) => [point.current, previousLabel ? point.previous ?? null : null]).filter((value): value is number => value !== null);
  const yScale = linearTicks(Math.min(0, ...values), Math.max(0, ...values), { integer: true });
  const step = (yScale.ticks[1] ?? 1) - (yScale.ticks[0] ?? 0);
  const xTicks = evenTickIndices(points.length, Math.min(budget, 7)).map((index) => points[index]!.date);
  const dotOf = (props: { cx?: number | undefined; cy?: number | undefined; index: number }) => {
    const { cx, cy, index } = props;
    const point = points[index];
    if (cx == null || cy == null || point === undefined || point.current === null) return <g key={index} />;
    const last = index === points.length - 1;
    if (!last && points.length > 14) return <g key={index} />;
    return (
      <circle
        key={index}
        cx={cx}
        cy={cy}
        r={last ? 4 : 3}
        fill={point.incomplete ? "var(--color-card)" : COLOR}
        stroke={point.incomplete ? COLOR : "var(--color-card)"}
        strokeWidth={point.incomplete ? 2 : 1.5}
      />
    );
  };

  return (
    <>
      <ChartLegend series={series} />
      <ResponsiveContainer width="100%" height={height} onResize={onResize}>
        <LineChart data={points as RevenueLinePoint[]} margin={CHART_MARGIN}>
          <CartesianGrid {...chartGridProps} />
          <XAxis {...xAxisProps} dataKey="date" ticks={xTicks} tickFormatter={(value: unknown) => formatDate(String(value))} />
          <YAxis {...yAxisProps} domain={yScale.domain} ticks={yScale.ticks} tickFormatter={usdAxisFormatter(step)} />
          {values.some((value) => value < 0) ? <ReferenceLine y={0} stroke="var(--color-border-strong)" /> : null}
          {previousLabel && (
            <Line type="linear" dataKey="previous" name={previousLabel} stroke={COMPARE} strokeWidth={2} dot={false} activeDot={activeDot(COMPARE)} connectNulls={false} {...CHART_ANIMATION} />
          )}
          <Line type="linear" dataKey="current" name={currentLabel} stroke={COLOR} strokeWidth={2} dot={dotOf} activeDot={activeDot(COLOR)} connectNulls={false} {...CHART_ANIMATION} />
          <Tooltip
            cursor={lineCursor}
            filterNull={false}
            isAnimationActive={false}
            wrapperStyle={{ zIndex: 20 }}
            content={(props: ChartTooltipRenderProps) => (
              <ChartTooltipCard
                {...props}
                series={series}
                formatValue={formatMills}
                formatLabel={(label) => formatDate(String(label))}
                note={(row) => {
                  const point = row as unknown as RevenueLinePoint;
                  const change = dayChange(point);
                  return point.incomplete ? `${change ? `${change}, ` : ""}день ещё идёт` : change;
                }}
              />
            )}
          />
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}
