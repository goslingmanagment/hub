import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PeriodOption = "today" | "7d" | "30d" | "all" | "custom";

interface PeriodState {
  period: PeriodOption;
  customFrom?: string;
  customTo?: string;
  setPeriod: (period: PeriodOption) => void;
  setCustomRange: (from: string, to: string) => void;
}

export const usePeriodStore = create<PeriodState>()(
  persist(
    (set) => ({
      period: "30d",
      setPeriod: (period) => set({ period }),
      setCustomRange: (from, to) => set({ period: "custom", customFrom: from, customTo: to }),
    }),
    { name: "agencyhub-period" },
  ),
);
