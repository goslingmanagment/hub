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

type PeriodSelectorMode = "dashboard" | "spender" | "topSupporters";

interface PeriodSelectorProps {
  mode?: PeriodSelectorMode;
}

export function PeriodSelector({ mode = "dashboard" }: PeriodSelectorProps) {
  const dashboardPeriod = usePeriodStore();
  const spenderPeriod = useSpenderPeriodStore();

  const selectedKey = mode === "topSupporters"
    ? spenderPeriod.topSupportersPeriod
    : mode === "spender"
      ? spenderPeriod.period
      : dashboardPeriod.period;
  const options = mode === "dashboard" ? dashboardOptions : spenderOptions;

  function handleSelect(key: PeriodOption | SpenderPeriodOption) {
    if (mode === "topSupporters") {
      spenderPeriod.setTopSupportersPeriod(key as SpenderPeriodOption);
      return;
    }
    if (mode === "spender") {
      spenderPeriod.setPeriod(key as SpenderPeriodOption);
      return;
    }
    dashboardPeriod.setPeriod(key as PeriodOption);
  }

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Reporting period">
      {options.map((opt) => {
        const isActive = selectedKey === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            aria-pressed={isActive}
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
