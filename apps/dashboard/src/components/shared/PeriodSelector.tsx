import { usePeriodStore, type PeriodOption } from "@/stores/periodStore";
import { useSpenderPeriodStore, type SpenderPeriodOption } from "@/stores/spenderPeriodStore";
import { useLocation, useSearchParams } from "react-router";
import { overviewSearch, parseOverviewState } from "@/lib/overviewNavigation";
import { resolveDashboardPeriod, resolveSpenderPeriod } from "@/lib/navigation";

const dashboardOptions: { key: PeriodOption; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7d", label: "7 дней" },
  { key: "30d", label: "30 дней" },
  { key: "all", label: "Всё время" },
];

const spenderOptions: { key: SpenderPeriodOption; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7d", label: "7 дней" },
  { key: "30d", label: "30 дней" },
  { key: "90d", label: "90 дней" },
  { key: "180d", label: "180 дней" },
  { key: "all", label: "Всё время" },
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
      <select aria-label="Период отчёта" className="select min-h-9 max-w-36 sm:hidden" value={selectedKey} onChange={(event) => handleSelect(event.target.value as PeriodOption | SpenderPeriodOption)}>
        {options.map((opt) => <option key={opt.key} value={opt.key}>{opt.label}</option>)}
      </select>
      <div className="segmented hidden sm:inline-flex" role="group" aria-label="Период отчёта">
        {options.map((opt) => (
          <button
            key={opt.key}
            type="button"
            aria-pressed={selectedKey === opt.key}
            onClick={() => handleSelect(opt.key)}
            className="segment"
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
