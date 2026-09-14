import { usePeriodStore, type PeriodOption } from "@/stores/periodStore";
import { useSpenderPeriodStore, type SpenderPeriodOption } from "@/stores/spenderPeriodStore";
import { useLocation, useSearchParams } from "react-router";
import { overviewSearch, parseOverviewState } from "@/lib/overviewNavigation";
import { resolveDashboardPeriod, resolveSpenderPeriod } from "@/lib/navigation";

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
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const isOverview = location.pathname === "/";
  const overview = parseOverviewState(search, dashboardPeriod.period);

  const selectedKey = mode === "topSupporters"
    ? resolveSpenderPeriod(search.get("period"), spenderPeriod.topSupportersPeriod)
    : mode === "spender"
      ? resolveSpenderPeriod(search.get("period"), spenderPeriod.period)
      : isOverview ? overview.period : resolveDashboardPeriod(search.get("period"), dashboardPeriod.period);
  const options = mode === "dashboard" ? dashboardOptions : spenderOptions;

  function handleSelect(key: PeriodOption | SpenderPeriodOption) {
    if (mode === "topSupporters") {
      spenderPeriod.setTopSupportersPeriod(key as SpenderPeriodOption);
    } else if (mode === "spender") {
      spenderPeriod.setPeriod(key as SpenderPeriodOption);
    } else {
      dashboardPeriod.setPeriod(key as PeriodOption);
    }
    if (isOverview) setSearch(overviewSearch({ ...overview, period: key as PeriodOption }), { state: location.state });
    else {
      const next = new URLSearchParams(search);
      next.set("period", key);
      next.delete("offset");
      next.delete("spendersOffset");
      setSearch(next, { state: location.state });
    }
  }

  return (
    <div>
      <select aria-label="Период отчёта" className="min-h-11 max-w-32 rounded-lg border border-border bg-card px-2 text-sm sm:hidden" value={selectedKey} onChange={(event) => handleSelect(event.target.value as PeriodOption | SpenderPeriodOption)}>
        {options.map((opt) => <option key={opt.key} value={opt.key}>{opt.key === "today" ? "Сегодня" : opt.key === "all" ? "Всё время" : `${opt.key.slice(0, -1)} дней`}</option>)}
      </select>
      <div className="hidden items-center gap-1 sm:flex" role="group" aria-label="Reporting period">{options.map((opt) => {
        const isActive = selectedKey === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => handleSelect(opt.key)}
            className={`rounded-button px-2 sm:px-3 py-1.5 text-[13px] font-medium transition-colors ${
              isActive
                ? "bg-accent text-white"
                : "border border-border bg-card text-text-secondary hover:bg-hover"
            }`}
          >
            {opt.label}
          </button>
        );
      })}</div>
    </div>
  );
}
