import { ChevronLeft, ChevronRight } from "lucide-react";
import { shiftAnchor, usageDateLabel, type UsagePeriod } from "@/lib/format";

/**
 * The arrows of a screen whose time is a place on a calendar, not a window from now:
 * a day of limits, a week of AI spending. In the header, beside or instead of the
 * period's segments; the place itself lives in the address. Only moves: it writes nothing.
 */
export function PeriodStepper({ label, onPrev, onNext, canNext, prevLabel = "Предыдущий период", nextLabel = "Следующий период" }: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  canNext: boolean;
  prevLabel?: string;
  nextLabel?: string;
}) {
  return (
    <span className="period-stepper">
      <button type="button" className="btn btn-icon" aria-label={prevLabel} onClick={onPrev}><ChevronLeft size={16} aria-hidden="true" /></button>
      <span className="min-w-[96px] text-center text-sm tabular-nums" aria-live="polite">{label}</span>
      <button type="button" className="btn btn-icon" aria-label={nextLabel} disabled={!canNext} onClick={onNext}><ChevronRight size={16} aria-hidden="true" /></button>
    </span>
  );
}

/** A Moscow day (`YYYY-MM-DD`), to today and no further. */
export function DayNav({ day, today, onChange }: { day: string; today: string; onChange: (day: string) => void }) {
  return (
    <PeriodStepper
      label={usageDateLabel(day, "day")}
      prevLabel="Предыдущий день"
      nextLabel="Следующий день"
      canNext={day < today}
      onPrev={() => onChange(shiftAnchor(day, "day", -1))}
      onNext={() => onChange(shiftAnchor(day, "day", 1))}
    />
  );
}

/** A day, a week or a month around an anchor date (`?period=`, `?at=`). */
export function AnchorNav({ anchor, mode, today, onChange }: { anchor: string; mode: UsagePeriod; today: string; onChange: (anchor: string) => void }) {
  const next = shiftAnchor(anchor, mode, 1);
  return (
    <PeriodStepper
      label={usageDateLabel(anchor, mode)}
      canNext={anchor < today && next <= today}
      onPrev={() => onChange(shiftAnchor(anchor, mode, -1))}
      onNext={() => onChange(next)}
    />
  );
}
