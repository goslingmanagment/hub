import { useId } from "react";

interface TrendSparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}

/** Generic inline trend: a filled polyline over an ordered numeric series. */
export function TrendSparkline({
  values,
  width = 140,
  height = 36,
  color = "var(--color-accent)",
}: TrendSparklineProps) {
  const gradientId = useId();
  if (values.length === 0) {
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

  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const yFor = (value: number) => height - 2 - ((value - min) / range) * (height - 6);
  const stepX = width / (values.length - 1);
  const points = values.map((value, index) => {
    const x = index * stepX;
    const y = yFor(value);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const zeroY = yFor(0).toFixed(1);
  const areaPoints = `0,${zeroY} ${points.join(" ")} ${width},${zeroY}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="trend"
      className="shrink-0"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#${gradientId})`} />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
