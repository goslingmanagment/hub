import { Tooltip } from "@/components/shared/Tooltip";
import type { DaySlot } from "./trafficDays";

/** The heights of a chart: a large row, a small row of a source, the page of one link. */
const BOXES = {
  large: { height: 132, top: 26, bottom: 10 },
  small: { height: 52, top: 22, bottom: 8 },
  page: { height: 220, top: 16, bottom: 10 },
} as const;
const LABEL_GAP = 9;

export interface DayLineProps {
  /** One value per slot; null: unknown (a gap), or a day to come. */
  values: ReadonlyArray<number | null>;
  slots: readonly DaySlot[];
  /** The top of the scale. */
  max: number;
  size: keyof typeof BOXES;
  /** Which values are printed above their points: every one, all but zeros, none (the hint has them). */
  labels: "all" | "nonzero" | "none";
  /** A soft area under the line, up to the last finished day. */
  area: boolean;
  /** The hover hint of each slot; null: none. */
  hints: ReadonlyArray<string | null>;
  /** What the chart is, for a screen reader. */
  title: string;
  format?: (value: number) => string;
}

/**
 * New fans (or clicks, or money) per day: straight segments between known
 * days, a point on each, the value above it (below in a valley of a large
 * chart). An unknown day breaks the line; a day to come has nothing. Today is
 * not over: no line goes into it, and its hollow point shows only when it is
 * above zero. A value below zero (a recalculation) sits on the baseline.
 * The plot around it (the parent, `.ts-plot`) draws the weeks and today's band.
 */
export function DayLine({ values, slots, max, size, labels, area, hints, title, format = String }: DayLineProps) {
  const box = BOXES[size];
  const count = slots.length;
  const span = box.height - box.top - box.bottom;
  const top = Math.max(1, max);
  const yOf = (value: number) => box.top + (1 - Math.min(Math.max(value, 0), top) / top) * span;
  const xPct = (index: number) => `${((index + 0.5) / count) * 100}%`;
  const todayAt = slots.findIndex((slot) => slot.when === "today");
  const points = values.map((value, index) => {
    if (value === null || slots[index]?.when === "future") return null;
    if (index === todayAt && value <= 0) return null;
    return { index, value, y: yOf(value), today: index === todayAt };
  });
  // Runs of consecutive known finished days: a line inside each, nothing across a gap.
  const runs: Array<Array<{ index: number; y: number }>> = [];
  let run: Array<{ index: number; y: number }> = [];
  for (const point of points) {
    if (point === null || point.today) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push(point);
    }
  }
  if (run.length > 0) runs.push(run);
  const base = box.height - box.bottom;
  const xy = (point: { index: number; y: number }) => `${point.index + 0.5},${point.y}`;

  return (
    <>
      <svg className="ts-chart" width="100%" height={box.height} role="img" aria-label={title}>
        <svg viewBox={`0 0 ${count} ${box.height}`} preserveAspectRatio="none" width="100%" height={box.height} aria-hidden="true">
          {area && runs.filter((part) => part.length > 1).map((part) => (
            <polygon
              key={`a${part[0]!.index}`}
              className="ts-area"
              points={[`${part[0]!.index + 0.5},${base}`, ...part.map(xy), `${part.at(-1)!.index + 0.5},${base}`].join(" ")}
            />
          ))}
          {runs.filter((part) => part.length > 1).map((part) => (
            <polyline key={`l${part[0]!.index}`} className="ts-line" vectorEffect="non-scaling-stroke" points={part.map(xy).join(" ")} />
          ))}
        </svg>
        {points.map((point) => {
          if (point === null) return null;
          const before = points[point.index - 1];
          const after = points[point.index + 1];
          const valley = size === "large" && before && after && point.value < before.value && point.value < after.value;
          const below = valley && point.y + LABEL_GAP + 13 <= box.height;
          const printed = labels === "all" || (labels === "nonzero" && point.value !== 0);
          return (
            <g key={point.index}>
              <circle className={point.today ? "ts-dot ts-dot-today" : "ts-dot"} cx={xPct(point.index)} cy={point.y} r={point.today ? 3.5 : count > 20 ? 2.5 : 3} />
              {printed && (
                <text
                  className={point.value === 0 ? "ts-value ts-value-zero" : "ts-value"}
                  x={xPct(point.index)}
                  y={below ? point.y + LABEL_GAP + 10 : point.y - LABEL_GAP}
                  textAnchor="middle"
                >
                  {format(point.value)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="ts-hits" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
        {slots.map((slot, index) => {
          const hint = hints[index] ?? null;
          return hint === null
            ? <span key={slot.date} />
            : <Tooltip key={slot.date} className="ts-hit" content={hint}><span aria-hidden="true" /></Tooltip>;
        })}
      </div>
    </>
  );
}
