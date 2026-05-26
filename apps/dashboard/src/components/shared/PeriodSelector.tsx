import { usePeriodStore, type PeriodOption } from "@/stores/periodStore";
import { useSpenderPeriodStore, type SpenderPeriodOption } from "@/stores/spenderPeriodStore";

const dashboardOptions: { key: PeriodOption; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "all", label: "All" },
];

const spenderOptions: { key: SpenderPeriodOption; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "90d", label: "90D" },
  { key: "180d", label: "180D" },
  { key: "all", label: "All" },
];

interface PeriodSelectorProps {
  mode?: "dashboard" | "spender";
}

export function PeriodSelector({ mode = "dashboard" }: PeriodSelectorProps) {
  const dashboardPeriod = usePeriodStore();
  const spenderPeriod = useSpenderPeriodStore();
  const periodState = mode === "spender" ? spenderPeriod : dashboardPeriod;
  const options = mode === "spender" ? spenderOptions : dashboardOptions;

  function handleSelect(key: PeriodOption | SpenderPeriodOption) {
    if (mode === "spender") {
      spenderPeriod.setPeriod(key as SpenderPeriodOption);
      return;
    }
    dashboardPeriod.setPeriod(key as PeriodOption);
  }

  return (
    <div className="flex items-center gap-1">
      {options.map((opt) => {
        const isActive = periodState.period === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => handleSelect(opt.key)}
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
