import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The one reporting period of the console. Every screen that reports over a
 * period reads it, so 30 days chosen on Overview are still 30 days on a page,
 * on Top fans and on a fan's profile. A `?period=` in the URL still wins on
 * the screen it is on, so a shared link opens what its sender saw.
 */
export type Period = "today" | "7d" | "30d" | "90d" | "180d" | "all";

/** The periods the revenue reports (Overview, a page's summary) answer for. */
export type PeriodOption = "today" | "7d" | "30d" | "all";

/** The periods the spender reports (Top fans, auto-lists, a fan) answer for. */
export type SpenderPeriodOption = Period;

interface PeriodState {
  period: Period;
  setPeriod: (period: Period) => void;
}

const DEFAULT_PERIOD: Period = "7d";
// v4: one period for the whole console (the spender screens had their own,
// and Top fans a third that defaulted to all time).
const PERIOD_STORE_VERSION = 4;
const SUPPORTED_PERIODS = new Set<Period>(["today", "7d", "30d", "90d", "180d", "all"]);

export function migratePeriodState(persistedState: unknown, persistedVersion: number) {
  const persistedPeriod = typeof persistedState === "object"
    && persistedState !== null
    && "period" in persistedState
    && typeof persistedState.period === "string"
    && SUPPORTED_PERIODS.has(persistedState.period as Period)
    ? persistedState.period as Period
    : DEFAULT_PERIOD;

  return {
    period: persistedVersion < 3 && persistedPeriod === "30d"
      ? DEFAULT_PERIOD
      : persistedPeriod,
  };
}

export const usePeriodStore = create<PeriodState>()(
  persist(
    (set) => ({
      period: DEFAULT_PERIOD,
      setPeriod: (period) => set({ period }),
    }),
    {
      name: "agencyhub-period",
      version: PERIOD_STORE_VERSION,
      migrate: migratePeriodState,
    },
  ),
);
