import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { parsePeriod, resolvePeriod, withPeriod, type PeriodSpec, type ResolvedPeriod } from "@agency_hub_core/ui/period";

export interface UsePeriod {
  /** What the address asks for (the current week when it asks nothing). */
  spec: PeriodSpec;
  /** Its dates: `from`/`to` (Moscow days, both included), `previous`, `startsAt`/`endsAt` instants, labels. */
  period: ResolvedPeriod;
  /** Today in Moscow. */
  today: string;
  /** Changes the period in the address (a new history entry: Back returns to the old one). */
  setPeriod: (spec: PeriodSpec) => void;
}

/**
 * The one period of the whole app, in the address (spec §3):
 * `?week=YYYY-MM-DD` · `?days=14|30` · `?from=&to=`. Every screen reads it here;
 * every drill-down carries it (PersonLink, `carryParams`).
 */
export function usePeriod(): UsePeriod {
  const [search, setSearch] = useSearchParams();
  const today = moscowToday();
  const spec = useMemo(() => parsePeriod(search, today), [search, today]);
  const period = useMemo(() => resolvePeriod(spec, today), [spec, today]);
  const setPeriod = useCallback((next: PeriodSpec) => setSearch((current) => withPeriod(current, next)), [setSearch]);
  return { spec, period, today, setPeriod };
}
