import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The one remembered reporting period of the console. Every screen of the
 * shared class reads it (lib/sections.ts), so 30 days chosen on Income are
 * still 30 days on Fans and on a page's card. A `?period=` in the URL wins on
 * the screen it is on, and only a choice by hand is remembered: a link opens
 * what its sender saw and changes nothing else.
 */
export type Period = "today" | "7d" | "14d" | "30d" | "90d" | "180d" | "365d" | "all";

/** The periods the revenue reports (Income, a page's summary) answer for. */
export type PeriodOption = "today" | "7d" | "30d" | "all";

/** The periods the spender reports (fans, auto-lists, a fan) answer for. */
export type SpenderPeriodOption = "today" | "7d" | "30d" | "90d" | "180d" | "all";

interface PeriodState {
  period: Period;
  setPeriod: (period: Period) => void;
}

const DEFAULT_PERIOD: Period = "7d";
// v4: one period for the whole console (the spender screens had their own,
// and Top fans a third that defaulted to all time).
const PERIOD_STORE_VERSION = 4;
const SUPPORTED_PERIODS = new Set<Period>(["today", "7d", "14d", "30d", "90d", "180d", "365d", "all"]);

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
