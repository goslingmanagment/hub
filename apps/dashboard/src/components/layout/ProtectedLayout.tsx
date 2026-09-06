import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useAuthMe, useOverview } from "@/api/queries";
import { DashboardShellProvider } from "./DashboardShellContext.js";
import { Sidebar } from "./Sidebar.js";
import { Topbar } from "./Topbar.js";

export function ProtectedLayout() {
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  useEffect(() => setNavigationOpen(false), [location.pathname]);
  const { data, isLoading, isError } = useAuthMe();
  const {
    data: overview,
    isLoading: isPageCatalogLoading,
    isError: isPageCatalogError,
    error: pageCatalogError,
  } = useOverview();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div className="text-text-muted text-sm">Loading...</div>
      </div>
    );
  }

  if (isError || !data) {
    return <Navigate to="/login" replace />;
  }

  const shellValue = {
    pageCatalogState: isPageCatalogLoading ? "loading" : isPageCatalogError ? "error" : "ready",
    pageCatalogError: isPageCatalogError
      ? (pageCatalogError instanceof Error ? pageCatalogError : new Error("Page catalog failed to load"))
      : null,
    pages: overview?.pages ?? [],
    findPageByLabel: (pageLabel: string | undefined) =>
      overview?.pages.find((page) => page.label === pageLabel) ?? null,
  } as const;

  return (
    <DashboardShellProvider value={shellValue}>
      <div className="flex min-h-screen bg-bg">
        {navigationOpen && <button type="button" aria-label="Закрыть навигацию" className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={() => setNavigationOpen(false)} />}
        <div className={navigationOpen ? "relative z-20 md:z-auto" : "hidden md:block"}><Sidebar user={data.user} /></div>
        <div className="min-w-0 flex-1 md:ml-[248px]">
          <Topbar user={data.user} onOpenNavigation={() => setNavigationOpen(true)} />
          <main className="mt-[56px] min-w-0 p-0 md:p-8 max-w-[1200px]">
            <Outlet />
          </main>
        </div>
      </div>
    </DashboardShellProvider>
  );
}
