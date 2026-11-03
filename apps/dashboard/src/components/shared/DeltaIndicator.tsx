import { formatDelta } from "@/lib/format";

interface DeltaIndicatorProps {
  pct: number | null;
}

const directionColors = {
  up: "text-up",
  down: "text-down",
  neutral: "text-text-muted",
} as const;

export function DeltaIndicator({ pct }: DeltaIndicatorProps) {
  const { text, direction } = formatDelta(pct);

  return (
    <span className={`whitespace-nowrap text-xs font-medium tabular-nums ${directionColors[direction]}`}>
      {text}
    </span>
  );
}
