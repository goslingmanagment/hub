import { formatDuration, formatMills } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { shortDay } from "@/pages/account/stats/statsView";

/**
 * A chatter's days as small bars, on the chatter's own scale (their best day is
 * full height): the row shows their rise or fall; the money beside it compares
 * them with the others. A day without a shift is no bar; a shift that sold
 * nothing is a stub on the baseline. Each bar says its numbers on hover.
 */

export interface DayMoney {
  date: string;
  salesNetMills: number;
  shifts: number;
  workedMinutes: number;
}

const WIDTH = 200;
const HEIGHT = 40;

export function DayBars({ days, today, label }: { days: readonly DayMoney[]; today: string; label: string }) {
  const max = Math.max(0, ...days.map((day) => day.salesNetMills));
  const gap = days.length > 20 ? 1 : 2;
  const bar = days.length === 0 ? 0 : (WIDTH - gap * (days.length - 1)) / days.length;
  return (
    <svg className="team-daybars" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width={WIDTH} height={HEIGHT} role="img" aria-label={label}>
      <line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} stroke="var(--color-border)" />
      {days.map((day, index) => {
        if (day.shifts === 0) return null;
        const height = max > 0 ? Math.max(2, (day.salesNetMills / max) * (HEIGHT - 2)) : 2;
        const shifts = `${day.shifts} ${ruPlural(day.shifts, "смена", "смены", "смен")}`;
        return (
          <rect
            key={day.date}
            x={index * (bar + gap)}
            y={HEIGHT - height}
            width={bar}
            height={height}
            rx={Math.min(1.5, bar / 2)}
            fill="var(--color-chart-blue)"
            fillOpacity={day.date === today ? 0.5 : 1}
          >
            <title>{`${shortDay(day.date)}: ${formatMills(day.salesNetMills)}, ${shifts}, ${formatDuration(day.workedMinutes)}${day.date === today ? " (день ещё идёт)" : ""}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
