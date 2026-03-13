import { usePeriodStore, type PeriodOption } from "@/stores/periodStore";

const options: { key: PeriodOption; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "all", label: "All" },
];

export function PeriodSelector() {
  const { period, setPeriod } = usePeriodStore();

  return (
    <div className="flex items-center gap-1">
      {options.map((opt) => {
        const isActive = period === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => setPeriod(opt.key)}
            className={`rounded-button px-3 py-1.5 text-[13px] font-medium transition-colors ${
              isActive
                ? "bg-accent text-white"
                : "border border-border bg-card text-text-secondary hover:bg-hover"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
