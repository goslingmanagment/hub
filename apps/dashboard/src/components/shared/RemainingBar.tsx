import { Badge } from "./Badge";

interface RemainingBarProps {
  days: number;
  maxDays?: number;
}

function barColor(days: number): string {
  if (days <= 1) return "#d14343";
  if (days <= 3) return "#b5711a";
  if (days <= 7) return "#f59e0b";
  return "#4ead6b";
}

function textClass(days: number): string {
  if (days <= 1) return "text-danger";
  if (days <= 3) return "text-warning-dark";
  if (days <= 7) return "text-warning";
  return "text-green";
}

export function RemainingBar({ days, maxDays = 30 }: RemainingBarProps) {
  const pct = Math.min(100, (days / maxDays) * 100);
  const color = barColor(days);

  return (
    <div className="flex items-center gap-2">
      <div
        className="relative overflow-hidden rounded-full bg-border"
        style={{ width: 48, height: 4 }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>

      <span className={`text-[12px] tabular-nums ${textClass(days)}`}>{days}d</span>

      {days <= 7 && <Badge variant="exp">EXP</Badge>}
    </div>
  );
}
