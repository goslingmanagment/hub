import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SpenderPeriodOption = "today" | "7d" | "30d" | "90d" | "180d" | "all";

interface SpenderPeriodState {
  period: SpenderPeriodOption;
  setPeriod: (period: SpenderPeriodOption) => void;
}

const DEFAULT_PERIOD: SpenderPeriodOption = "7d";
const PERIOD_STORE_VERSION = 1;
const SUPPORTED_PERIODS = new Set<SpenderPeriodOption>(["today", "7d", "30d", "90d", "180d", "all"]);

export function migrateSpenderPeriodState(persistedState: unknown) {
  const persistedPeriod = typeof persistedState === "object"
    && persistedState !== null
    && "period" in persistedState
    && typeof persistedState.period === "string"
    && SUPPORTED_PERIODS.has(persistedState.period as SpenderPeriodOption)
    ? persistedState.period as SpenderPeriodOption
    : DEFAULT_PERIOD;

  return {
    period: persistedPeriod,
  };
}

export const useSpenderPeriodStore = create<SpenderPeriodState>()(
  persist(
    (set) => ({
      period: DEFAULT_PERIOD,
      setPeriod: (period) => set({ period }),
    }),
    {
      name: "agencyhub-spender-period",
      version: PERIOD_STORE_VERSION,
      migrate: migrateSpenderPeriodState,
    },
  ),
);
