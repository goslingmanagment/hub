import { useCallback } from "react";
import { useLocation, useSearchParams } from "react-router";
import { periodDays, periodParam, resolvePeriod, type PeriodKey, type ResolvedPeriod } from "@/lib/period";
import { forcedPeriodOf, matchScreen, type ForcedPeriod, type ScreenPeriod } from "@/lib/sections";
import { usePeriodStore, type Period } from "@/stores/periodStore";

export interface ScreenPeriodView extends ResolvedPeriod {
  period: ScreenPeriod | null;
  /** The number of days of `key`, for screens that ask by days. */
  days: number;
  /** The choice by hand: a shared period is remembered, an own one is not. */
  select: (key: PeriodKey) => void;
  /** A filter of the screen looks at a period of its own: `key` is that one. */
  forced: ForcedPeriod | null;
}

/**
 * The period of the screen at the current address: the header's control and the
 * screen read this one answer. Period and page are independent: a change of
 * either resets the list position and not the other.
 */
export function useScreenPeriod(fallback: PeriodKey = "7d"): ScreenPeriodView {
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const stored = usePeriodStore((state) => state.period);
  const setStored = usePeriodStore((state) => state.setPeriod);
  const screen = matchScreen(location.pathname)?.screen ?? null;
  const period = screen?.period ?? null;
  const forced = screen ? forcedPeriodOf(screen, search) : null;

  const chosen = period
    ? resolvePeriod({
        periodClass: period.class,
        options: period.options,
        fallback: period.default,
        raw: periodParam(search),
        stored,
      })
    : { key: fallback, missing: null };
  // The address and the memory stay as they are: back to another filter, back to the choice.
  const resolved = forced ? { key: forced.key, missing: null } : chosen;

  const isForced = forced !== null;
  const select = useCallback((key: PeriodKey) => {
    if (isForced) return;
    if (period?.class === "shared") setStored(key as Period);
    const next = new URLSearchParams(window.location.search);
    next.set("period", key);
    // The old names of the same choice, and what the change makes meaningless.
    for (const name of ["range", "days", "offset", "spendersOffset", "txOffset"]) next.delete(name);
    setSearch(next, { state: location.state });
  }, [isForced, location.state, period?.class, setSearch, setStored]);

  return { ...resolved, period, days: periodDays(resolved.key), select, forced };
}
