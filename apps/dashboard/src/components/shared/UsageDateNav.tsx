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

export function UsageDateNav({ mode, onModeChange, label, onPrev, onNext, canGoNext }: UsageDateNavProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Arrow navigation */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Предыдущий период"
          onClick={onPrev}
          className="flex h-8 w-8 items-center justify-center rounded-button border border-border bg-card text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
        >
          <ChevronLeft size={16} />
        </button>

        <span className="min-w-[150px] text-center text-sm font-medium text-text-primary">
          {label}
        </span>

        <button
          type="button"
          aria-label="Следующий период"
          onClick={onNext}
          disabled={!canGoNext}
          className="flex h-8 w-8 items-center justify-center rounded-button border border-border bg-card text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Period mode toggle */}
      <div className="flex items-center gap-1">
        {modes.map((m) => {
          const isActive = mode === m.key;
          return (
            <button
              key={m.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onModeChange(m.key)}
              className={`rounded-button px-3 py-1.5 text-[13px] font-medium transition-colors ${
                isActive
                  ? "bg-accent text-white"
                  : "border border-border bg-card text-text-secondary hover:bg-hover"
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
