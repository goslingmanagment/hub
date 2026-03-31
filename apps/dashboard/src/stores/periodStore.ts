import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PeriodOption = "today" | "7d" | "30d" | "all";

interface PeriodState {
  period: PeriodOption;
  setPeriod: (period: PeriodOption) => void;
}

const DEFAULT_PERIOD: PeriodOption = "30d";
const SUPPORTED_PERIODS = new Set<PeriodOption>(["today", "7d", "30d", "all"]);

export const usePeriodStore = create<PeriodState>()(
  persist(
    (set) => ({
      period: DEFAULT_PERIOD,
      setPeriod: (period) => set({ period }),
    }),
    {
      name: "agencyhub-period",
      version: 2,
      migrate: (persistedState) => {
        const persistedPeriod = typeof persistedState === "object"
          && persistedState !== null
          && "period" in persistedState
          && typeof persistedState.period === "string"
          && SUPPORTED_PERIODS.has(persistedState.period as PeriodOption)
          ? persistedState.period as PeriodOption
          : DEFAULT_PERIOD;

        return { period: persistedPeriod };
      },
    },
  ),
);
