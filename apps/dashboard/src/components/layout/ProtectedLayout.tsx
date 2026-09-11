import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useAuthMe, useOverview } from "@/api/queries";
import { DashboardShellProvider } from "./DashboardShellContext.js";
import { Sidebar } from "./Sidebar.js";
import { Topbar } from "./Topbar.js";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { buildLoginRoute } from "@/lib/authNavigation";
import { KernelApiError } from "@/api/sdk";

function MobileNavigation({ user, close }: {
  user: { username: string; role: string };
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    const wide = window.matchMedia("(min-width: 768px)");
    const onResize = () => {
      if (wide.matches) close();
    };
    wide.addEventListener("change", onResize);
    return () => {
      wide.removeEventListener("change", onResize);
      element.close();
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [close]);
  return (
    <dialog
      ref={dialog}
      aria-label="Основная навигация"
      className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[248px] max-w-none border-0 p-0 backdrop:bg-black/30"
      onCancel={close}
      onClick={(event) => {
        if (
          event.target === event.currentTarget
          && event.clientX > event.currentTarget.getBoundingClientRect().right
        ) close();
      }}
    >
      <Sidebar user={user} />
      <button
        type="button"
        aria-label="Закрыть навигацию"
        className="fixed left-[216px] top-2 z-30 rounded bg-card p-2 text-text-secondary"
        onClick={close}
      >
        ×
      </button>
    </dialog>
  );
}

export function ProtectedLayout() {
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const closeNavigation = useCallback(() => setNavigationOpen(false), []);
  useEffect(() => setNavigationOpen(false), [location.key]);
  const { data, isLoading, isError, error, refetch } = useAuthMe();
  const {
    data: overview,
    isLoading: isPageCatalogLoading,
    isError: isPageCatalogError,
    error: pageCatalogError,
    refetch: refetchPageCatalog,
  } = useOverview();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div className="text-text-muted text-sm" role="status">Проверяем сессию…</div>
      </div>
    );
  }

  if (!data) {
    if (!isError || (error instanceof KernelApiError && error.status === 401)) {
      return <Navigate to={buildLoginRoute(`${location.pathname}${location.search}${location.hash}`)} replace />;
    }
    return <div className="min-h-screen bg-bg p-6 flex items-center justify-center"><StatusPanel title="Не удалось проверить сессию" description="Сервер временно недоступен. Повторите запрос, чтобы продолжить с этой страницы." tone="error" action={<button type="button" className="text-accent font-semibold underline" onClick={() => void refetch()}>Повторить</button>} /></div>;
  }

  const shellValue = {
    pageCatalogState: overview ? "ready" : isPageCatalogLoading ? "loading" : isPageCatalogError ? "error" : "ready",
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
        {navigationOpen && <MobileNavigation user={data.user} close={closeNavigation} />}
        <div className="hidden md:block"><Sidebar user={data.user} /></div>
        <div className="min-w-0 flex-1 md:ml-[248px]">
          <Topbar user={data.user} onOpenNavigation={() => setNavigationOpen(true)} />
          <main className="mt-[56px] min-w-0 p-0 md:p-8 max-w-[1200px]">
            {isError && <div className="p-4 md:p-0"><QueryNotice error stale retry={refetch} /></div>}
            {isPageCatalogError && <div className="p-4 md:p-0"><QueryNotice error stale={Boolean(overview)} retry={refetchPageCatalog} /></div>}
            <ErrorBoundary inset resetKey={`${location.pathname}${location.search}`}>
              <Suspense fallback={<div className="p-4"><StatusPanel title="Открываем раздел…" /></div>}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </DashboardShellProvider>
  );
}
