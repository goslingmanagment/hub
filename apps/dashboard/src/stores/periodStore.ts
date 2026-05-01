import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PeriodOption = "today" | "7d" | "30d" | "all";

interface PeriodState {
  period: PeriodOption;
  setPeriod: (period: PeriodOption) => void;
}

const DEFAULT_PERIOD: PeriodOption = "7d";
const PERIOD_STORE_VERSION = 3;
const SUPPORTED_PERIODS = new Set<PeriodOption>(["today", "7d", "30d", "all"]);

export function migratePeriodState(persistedState: unknown, persistedVersion: number) {
  const persistedPeriod = typeof persistedState === "object"
    && persistedState !== null
    && "period" in persistedState
    && typeof persistedState.period === "string"
    && SUPPORTED_PERIODS.has(persistedState.period as PeriodOption)
    ? persistedState.period as PeriodOption
    : DEFAULT_PERIOD;

  return {
    period: persistedVersion < PERIOD_STORE_VERSION && persistedPeriod === "30d"
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
