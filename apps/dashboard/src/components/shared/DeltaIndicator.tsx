import { formatDelta } from "@/lib/format";

interface DeltaIndicatorProps {
  pct: number | null;
}

const directionColors = {
  up: "text-green",
  down: "text-danger",
  neutral: "text-text-muted",
} as const;

export function DeltaIndicator({ pct }: DeltaIndicatorProps) {
  const { text, direction } = formatDelta(pct);

  return (
    <span className={`text-[12px] font-semibold ${directionColors[direction]}`}>
      {text}
    </span>
  );
}
