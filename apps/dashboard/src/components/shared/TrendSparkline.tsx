import { useId } from "react";

interface TrendSparklineProps {
  /** Evenly spaced in time. `null` is a bucket nobody measured: the line
   *  breaks there instead of bridging it or dropping to zero. */
  values: ReadonlyArray<number | null>;
  width?: number;
  height?: number;
  color?: string;
  /** What the line shows, for a screen reader and the hover title. */
  label?: string;
}

/** Runs of consecutive measured points, by index. */
function runs(values: ReadonlyArray<number | null>): number[][] {
  const result: number[][] = [];
  let current: number[] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) result.push(current);
      current = [];
    } else {
      current.push(index);
    }
  });
  if (current.length > 0) result.push(current);
  return result;
}

/** Generic inline trend: a filled line over an ordered numeric series. */
export function TrendSparkline({
  values,
  width = 140,
  height = 36,
  color = "var(--color-accent)",
  label = "Динамика",
}: TrendSparklineProps) {
  const gradientId = useId();
  const measured = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (measured.length === 0) {
    return <div style={{ width, height }} />;
  }

  if (values.length === 1) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        role="img" aria-label="One data point; trend unavailable" className="shrink-0">
        <circle cx={width / 2} cy={height / 2} r={2} fill={color} />
      </svg>
    );
  }

  const min = Math.min(...measured, 0);
  const max = Math.max(...measured, 0);
  const range = max - min || 1;
  const yFor = (value: number) => height - 2 - ((value - min) / range) * (height - 6);
  const stepX = width / (values.length - 1);
  const point = (index: number) =>
    `${(index * stepX).toFixed(1)},${yFor(values[index]!).toFixed(1)}`;
  const zeroY = yFor(0).toFixed(1);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="shrink-0"
    >
      <title>{label}</title>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      {runs(values).map((run) => {
        const first = run[0]!;
        const last = run[run.length - 1]!;
        if (run.length === 1) {
          return <circle key={first} cx={first * stepX} cy={yFor(values[first]!)} r={1.75} fill={color} />;
        }
        const line = run.map(point).join(" ");
        return (
          <g key={first}>
            <polygon
              points={`${(first * stepX).toFixed(1)},${zeroY} ${line} ${(last * stepX).toFixed(1)},${zeroY}`}
              fill={`url(#${gradientId})`}
            />
            <polyline
              points={line}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        );
      })}
    </svg>
  );
}
