import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SpenderPeriodOption = "today" | "7d" | "30d" | "90d" | "180d" | "all";

interface SpenderPeriodState {
  period: SpenderPeriodOption;
  topSupportersPeriod: SpenderPeriodOption;
  setPeriod: (period: SpenderPeriodOption) => void;
  setTopSupportersPeriod: (period: SpenderPeriodOption) => void;
}

const DEFAULT_PERIOD: SpenderPeriodOption = "7d";
const DEFAULT_TOP_SUPPORTERS_PERIOD: SpenderPeriodOption = "all";
const PERIOD_STORE_VERSION = 2;
const SUPPORTED_PERIODS = new Set<SpenderPeriodOption>(["today", "7d", "30d", "90d", "180d", "all"]);

function readPersistedPeriod(value: unknown, fallback: SpenderPeriodOption): SpenderPeriodOption {
  if (typeof value !== "string") return fallback;
  return SUPPORTED_PERIODS.has(value as SpenderPeriodOption)
    ? value as SpenderPeriodOption
    : fallback;
}

export function migrateSpenderPeriodState(persistedState: unknown) {
  const obj = typeof persistedState === "object" && persistedState !== null
    ? persistedState as Record<string, unknown>
    : null;

  return {
    period: readPersistedPeriod(obj?.period, DEFAULT_PERIOD),
    topSupportersPeriod: readPersistedPeriod(
      obj?.topSupportersPeriod,
      DEFAULT_TOP_SUPPORTERS_PERIOD,
    ),
  };
}

export const useSpenderPeriodStore = create<SpenderPeriodState>()(
  persist(
    (set) => ({
      period: DEFAULT_PERIOD,
      topSupportersPeriod: DEFAULT_TOP_SUPPORTERS_PERIOD,
      setPeriod: (period) => set({ period }),
      setTopSupportersPeriod: (topSupportersPeriod) => set({ topSupportersPeriod }),
    }),
    {
      name: "agencyhub-spender-period",
      version: PERIOD_STORE_VERSION,
      migrate: migrateSpenderPeriodState,
    },
  ),
);
