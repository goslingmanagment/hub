import { lazy, Suspense, useCallback, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useAuthMe, usePages } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { CABINET_PATH, buildLoginRoute, chatterExit, leavesTheConsole } from "@/lib/navigation";
import { isChatterSite } from "@/lib/sites";
import { LeaveForWorkboard } from "@/routes/ToWorkboard";
import { ConsoleFrame } from "./ConsoleFrame.js";
import { DashboardShellProvider } from "./DashboardShellContext.js";

const CommandPalette = lazy(() => import("./CommandPalette.js").then((module) => ({ default: module.CommandPalette })));

// The chatters' site serves /account, /join and /login of this app and nothing
// else, so a console route is reachable there only from inside the app — the
// catch-all, for one. Whoever arrives that way, of any role, is taken to their
// account page before the console asks the kernel for anything: the console has a
// name of its own.
export function ProtectedLayout() {
  if (isChatterSite()) return <Navigate to={CABINET_PATH} replace />;
  return <ConsoleLayout />;
}

function ConsoleLayout() {
  const location = useLocation();
  // The search: the field and ⌘K of the frame open it (packages/ui Place.tsx).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const { data, isLoading, isError, error, refetch, isFetching } = useAuthMe();
  const {
    data: pages,
    isLoading: isPageCatalogLoading,
    isError: isPageCatalogError,
    error: pageCatalogError,
    refetch: refetchPages,
  } = usePages({ enabled: Boolean(data?.user) && !isError });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div role="status" className="text-text-muted text-sm">Проверяем вход…</div>
      </div>
    );
  }

  if (error instanceof KernelApiError && error.status === 401) {
    return <Navigate to={buildLoginRoute(`${location.pathname}${location.search}${location.hash}`)} replace />;
  }
  if (isError || !data) return <div className="flex min-h-screen items-center justify-center bg-bg p-6">
    <div role="alert" className="card card-body max-w-md">
      <h1 className="card-title">Не удалось проверить вход</h1>
      <p className="mt-2 text-sm text-text-secondary">Hub не подтвердил состояние сессии. Повторите запрос, когда связь восстановится.</p>
      <button type="button" disabled={isFetching} onClick={() => void refetch()} className="btn btn-primary mt-4">{isFetching ? "Проверяем…" : "Повторить"}</button>
    </div>
  </div>;

  // Every page behind this layout is owner or team-lead work and
  // answers 403 for a chatter. Send them to their own home — «Мои смены» in
  // Workboard, another app: a page load — instead of rendering a console full
  // of refusals; on the console's own name, to that home on the team's name,
  // signed in on the way.
  if (data.user.role === "chatter") {
    const exit = chatterExit();
    return leavesTheConsole(exit) ? <LeaveForWorkboard href={exit} /> : <Navigate to={exit} replace />;
  }

  const shellValue = {
    pageCatalogState: pages ? "ready" : isPageCatalogLoading ? "loading" : "error",
    pageCatalogError: isPageCatalogError
      ? (pageCatalogError instanceof Error ? pageCatalogError : new Error("Page catalog failed to load"))
      : null,
    retryPageCatalog: refetchPages,
    pages: pages ?? [],
    findPageByLabel: (pageLabel: string | undefined) =>
      pages?.find((page) => page.label === pageLabel) ?? null,
  } as const;

  return (
    <DashboardShellProvider value={shellValue}>
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette role={data.user.role} onClose={closePalette} />
        </Suspense>
      )}
      <ConsoleFrame user={data.user} searchOpen={paletteOpen} setSearchOpen={setPaletteOpen}>
        <main className="app-main">
          <div className="app-content">
            {isPageCatalogError && <div className="mb-6"><p className="mb-1 text-sm font-medium text-text-primary">Каталог страниц</p><QueryNotice error stale={Boolean(pages)} retry={refetchPages} /></div>}
            <ErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </ConsoleFrame>
    </DashboardShellProvider>
  );
}
