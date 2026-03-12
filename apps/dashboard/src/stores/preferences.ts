import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PreferencesStore {
  defaultPeriod: string;
  tablePageSize: number;
  sidebarCollapsed: boolean;
  spenderScope: string;
  setDefaultPeriod: (v: string) => void;
  setTablePageSize: (v: number) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setSpenderScope: (v: string) => void;
}

export const usePreferencesStore = create<PreferencesStore>()(
  persist(
    (set) => ({
      defaultPeriod: "30d",
      tablePageSize: 50,
      sidebarCollapsed: false,
      spenderScope: "agency",
      setDefaultPeriod: (v) => set({ defaultPeriod: v }),
      setTablePageSize: (v) => set({ tablePageSize: v }),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      setSpenderScope: (v) => set({ spenderScope: v }),
    }),
    { name: "agency-hub-preferences" },
  ),
);
