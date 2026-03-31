import { Navigate, Outlet } from "react-router";
import { useAuthMe, useOverview } from "@/api/queries";
import { DashboardShellProvider } from "./DashboardShellContext.js";
import { Sidebar } from "./Sidebar.js";
import { Topbar } from "./Topbar.js";

export function ProtectedLayout() {
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
        <Sidebar user={data.user} />
        <div className="ml-[248px] flex-1">
          <Topbar user={data.user} />
          <main className="mt-[56px] p-8 max-w-[1200px]">
            <Outlet />
          </main>
        </div>
      </div>
    </DashboardShellProvider>
  );
}
