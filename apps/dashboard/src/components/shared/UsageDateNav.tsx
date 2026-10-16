import { ChevronLeft, ChevronRight } from "lucide-react";
import type { UsagePeriod } from "@/lib/format";

const modes: { key: UsagePeriod; label: string }[] = [
  { key: "day", label: "День" },
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
];

interface UsageDateNavProps {
  mode: UsagePeriod;
  onModeChange: (mode: UsagePeriod) => void;
  label: string;
  onPrev: () => void;
  onNext: () => void;
  canGoNext: boolean;
}

/** The period of a usage report: day, week or month, and arrows to step through them. */
export function UsageDateNav({ mode, onModeChange, label, onPrev, onNext, canGoNext }: UsageDateNavProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1">
        <button type="button" onClick={onPrev} className="btn btn-icon" aria-label="Предыдущий период">
          <ChevronLeft size={16} />
        </button>
        <span className="min-w-[140px] text-center text-sm font-medium tabular-nums text-text-primary" aria-live="polite">
          {label}
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={!canGoNext}
          className="btn btn-icon"
          aria-label="Следующий период"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="segmented" role="group" aria-label="Период">
        {modes.map((m) => (
          <button
            key={m.key}
            type="button"
            aria-pressed={mode === m.key}
            onClick={() => onModeChange(m.key)}
            className="segment"
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
