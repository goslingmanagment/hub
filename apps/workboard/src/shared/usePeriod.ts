import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useSearchParams } from "react-router";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { hasPeriodParams, parsePeriod, pickPeriodParams, resolvePeriod, withPeriod, type PeriodSpec, type ResolvedPeriod } from "@agency_hub_core/ui/period";

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
 * every drill-down carries it (PersonLink, `carryParams`). An address without
 * one opens the period last used in this tab (`useRestoredPeriod` in the shell).
 */
export function usePeriod(): UsePeriod {
  const [search, setSearch] = useSearchParams();
  const today = moscowToday();
  const spec = useMemo(() => parsePeriod(search, today), [search, today]);
  const period = useMemo(() => resolvePeriod(spec, today), [spec, today]);
  const setPeriod = useCallback((next: PeriodSpec) => setSearch((current) => withPeriod(current, next)), [setSearch]);
  return { spec, period, today, setPeriod };
}

/** The tab's last period, as address parameters (`week=2026-10-26`). Per tab: sessionStorage. */
const MEMORY_KEY = "workboard:period";

function readRemembered(): string | null {
  try {
    return window.sessionStorage.getItem(MEMORY_KEY);
  } catch {
    return null;
  }
}

function remember(params: string): void {
  try {
    window.sessionStorage.setItem(MEMORY_KEY, params);
  } catch {
    // No storage (a private window, blocked site data): a bare address opens the current week.
  }
}

/**
 * The shell's half of the period memory (spec §3 r2, D3): every period an
 * address names is remembered for this tab; an address that names none gets the
 * remembered one. Returns the search to replace the address with, or null when
 * the address is fine as it is. The shell renders `<Navigate replace>` with it
 * before any screen reads, so a screen never fetches the current week first.
 * `enabled` false (a chatter's part of Workboard): nothing is remembered or restored.
 */
export function useRestoredPeriod(enabled: boolean = true): string | null {
  const location = useLocation();
  const search = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const named = hasPeriodParams(search);
  useEffect(() => {
    if (enabled && named) remember(pickPeriodParams(search).toString());
  }, [enabled, named, search]);
  if (!enabled || named) return null;
  const stored = readRemembered();
  if (!stored) return null;
  const restored = new URLSearchParams(stored);
  if (!hasPeriodParams(restored)) return null;
  const merged = new URLSearchParams(search);
  for (const [key, value] of pickPeriodParams(restored)) merged.set(key, value);
  return `?${merged.toString()}`;
}
