import { usePeriodStore, type Period } from "@/stores/periodStore";
import { useLocation, useSearchParams } from "react-router";
import { overviewSearch, parseOverviewState } from "@/lib/overviewNavigation";
import { resolveDashboardPeriod, resolveSpenderPeriod, revenuePeriod } from "@/lib/navigation";

const PERIOD_LABELS: Record<Period, string> = {
  today: "Сегодня",
  "7d": "7 дней",
  "30d": "30 дней",
  "90d": "90 дней",
  "180d": "180 дней",
  all: "Всё время",
};

// Revenue is computed for these four; the spender reports go back further.
const OPTIONS = {
  dashboard: ["today", "7d", "30d", "all"],
  spender: ["today", "7d", "30d", "90d", "180d", "all"],
} as const satisfies Record<string, readonly Period[]>;

type PeriodSelectorMode = keyof typeof OPTIONS;

interface PeriodSelectorProps {
  mode?: PeriodSelectorMode;
}

/** The console's one period control. Whatever is picked here holds on every
 *  screen that reports over a period; the URL keeps it for the screen it is
 *  on, so a shared link opens what its sender saw. */
export function PeriodSelector({ mode = "dashboard" }: PeriodSelectorProps) {
  const { period, setPeriod } = usePeriodStore();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const isOverview = location.pathname === "/";
  const overview = parseOverviewState(search, period);

  const selectedKey: Period = mode === "spender"
    ? resolveSpenderPeriod(search.get("period"), period)
    : isOverview ? overview.period : resolveDashboardPeriod(search.get("period"), period);
  const options = OPTIONS[mode];

  function handleSelect(key: Period) {
    setPeriod(key);
    if (isOverview) setSearch(overviewSearch({ ...overview, period: revenuePeriod(key) }), { state: location.state });
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
      <select aria-label="Период отчёта" className="select min-h-9 max-w-36 sm:hidden" value={selectedKey} onChange={(event) => handleSelect(event.target.value as Period)}>
        {options.map((key) => <option key={key} value={key}>{PERIOD_LABELS[key]}</option>)}
      </select>
      <div className="segmented hidden sm:inline-flex" role="group" aria-label="Период отчёта">
        {options.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={selectedKey === key}
            onClick={() => handleSelect(key)}
            className="segment"
          >
            {PERIOD_LABELS[key]}
          </button>
        ))}
      </div>
    </div>
  );
}
