import { createContext, useContext, type ReactNode } from "react";
import type { OverviewResponse } from "@agency_hub_core/contracts";

type PageItem = OverviewResponse["pages"][number];
type PageCatalogState = "loading" | "ready" | "error";

interface DashboardShellValue {
  pageCatalogState: PageCatalogState;
  pageCatalogError: Error | null;
  pages: PageItem[];
  findPageByLabel: (pageLabel: string | undefined) => PageItem | null;
}

const DashboardShellContext = createContext<DashboardShellValue | null>(null);

export function DashboardShellProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: DashboardShellValue;
}) {
  return (
    <DashboardShellContext.Provider value={value}>
      {children}
    </DashboardShellContext.Provider>
  );
}

export function useDashboardShell() {
  const value = useContext(DashboardShellContext);
  if (!value) {
    throw new Error("DashboardShellContext is missing");
  }
  return value;
}

