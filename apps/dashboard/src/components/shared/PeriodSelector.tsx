import { usePeriodStore, type PeriodOption } from "@/stores/periodStore";
import {
  useSpenderPeriodStore,
  type SpenderPeriodOption,
} from "@/stores/spenderPeriodStore";
import { useLocation, useSearchParams } from "react-router";
import { overviewSearch, parseOverviewState } from "@/lib/overviewNavigation";

const dashboardOptions: { key: PeriodOption; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "all", label: "Всё" },
];

const spenderOptions: { key: SpenderPeriodOption; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "90d", label: "90D" },
  { key: "180d", label: "180D" },
  { key: "all", label: "Всё" },
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

  const fallbackKey =
    mode === "topSupporters"
      ? spenderPeriod.topSupportersPeriod
      : mode === "spender"
        ? spenderPeriod.period
        : isOverview
          ? overview.period
          : dashboardPeriod.period;
  const options = mode === "dashboard" ? dashboardOptions : spenderOptions;
  const requestedPeriod = search.get("period");
  const selectedKey = options.some((option) => option.key === requestedPeriod)
    ? requestedPeriod!
    : fallbackKey;

  function handleSelect(key: PeriodOption | SpenderPeriodOption) {
    if (key === selectedKey) return;
    if (mode === "topSupporters") {
      spenderPeriod.setTopSupportersPeriod(key as SpenderPeriodOption);
    } else if (mode === "spender") {
      spenderPeriod.setPeriod(key as SpenderPeriodOption);
    } else {
      dashboardPeriod.setPeriod(key as PeriodOption);
    }
    if (isOverview) {
      setSearch(overviewSearch({ ...overview, period: key as PeriodOption }));
    } else {
      setSearch((previous) => {
        const next = new URLSearchParams(previous);
        next.set("period", key);
        for (const offsetKey of ["offset", "txOffset", "spendersOffset"])
          next.delete(offsetKey);
        return next;
      });
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label="Период отчёта"
    >
      <select
        aria-label="Период отчёта"
        value={selectedKey}
        onChange={(event) =>
          handleSelect(event.target.value as PeriodOption | SpenderPeriodOption)
        }
        className="sm:hidden max-w-[140px] rounded-button border border-border bg-card px-2 py-1.5 text-[13px] text-text-primary"
      >
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      <div className="hidden sm:flex items-center gap-1">
        {options.map((opt) => {
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
        })}
      </div>
    </div>
  );
}
