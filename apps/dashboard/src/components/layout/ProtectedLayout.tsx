import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useAuthMe, usePages } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { CHATTER_HOME, buildLoginRoute } from "@/lib/navigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { DashboardShellProvider } from "./DashboardShellContext.js";
import { Sidebar } from "./Sidebar.js";
import { Topbar } from "./Topbar.js";

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
    <div role="alert" className="max-w-md rounded-xl border border-border bg-card p-6">
      <h1 className="font-semibold text-text-primary">Не удалось проверить вход</h1>
      <p className="mt-2 text-sm text-text-secondary">Hub не подтвердил состояние сессии. Повторите запрос, когда связь восстановится.</p>
      <button type="button" disabled={isFetching} onClick={() => void refetch()} className="mt-4 min-h-11 rounded-lg bg-accent px-4 text-white disabled:opacity-50">{isFetching ? "Проверяем…" : "Повторить"}</button>
    </div>
  </div>;

  // Decision 351: every page behind this layout is owner or team-lead work and
  // answers 403 for a chatter. Send them to their own cabinet instead of
  // rendering a console full of refusals.
  if (data.user.role === "chatter") {
    return <Navigate to={CHATTER_HOME} replace />;
  }

  const shellValue = {
    pageCatalogState: pages ? "ready" : isPageCatalogLoading ? "loading" : "error",
    pageCatalogError: isPageCatalogError
      ? (pageCatalogError instanceof Error ? pageCatalogError : new Error("Page catalog failed to load"))
      : null,
    pages: pages ?? [],
    findPageByLabel: (pageLabel: string | undefined) =>
      pages?.find((page) => page.label === pageLabel) ?? null,
  } as const;

  return (
    <DashboardShellProvider value={shellValue}>
      <div className="flex min-h-screen bg-bg">
        {navigationOpen && <MobileNavigation user={data.user} close={closeNavigation} />}
        <div className="hidden md:block"><Sidebar user={data.user} /></div>
        <div className="min-w-0 flex-1 md:ml-[248px]">
          <Topbar user={data.user} onOpenNavigation={() => setNavigationOpen(true)} />
          <main className="mt-[56px] min-w-0 p-0 md:p-8 max-w-[1200px]">
            {isPageCatalogError && <div className="p-4 md:p-0"><p className="mb-1 text-sm font-semibold text-text-primary">Каталог страниц</p><QueryNotice error stale={Boolean(pages)} retry={refetchPages} /></div>}
            <Outlet />
          </main>
        </div>
      </div>
    </DashboardShellProvider>
  );
}
