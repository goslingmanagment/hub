import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { Menu, Search, X } from "lucide-react";
import { useAuthMe, usePages } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { CHATTER_HOME, buildLoginRoute, chatterExit } from "@/lib/navigation";
import { isPaletteShortcut } from "@/lib/paletteShortcut";
import { isChatterSite } from "@/lib/sites";
import { DashboardShellProvider } from "./DashboardShellContext.js";
import { Sidebar } from "./Sidebar.js";

const CommandPalette = lazy(() => import("./CommandPalette.js").then((module) => ({ default: module.CommandPalette })));

function MobileNavigation({ user, close, onOpenPalette }: {
  user: { username: string; role: string };
  close: () => void;
  onOpenPalette: () => void;
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
      className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[var(--sidebar-width)] max-w-none border-0 bg-bg p-0 backdrop:bg-backdrop"
      onCancel={close}
      onClick={(event) => {
        if (
          event.target === event.currentTarget
          && event.clientX > event.currentTarget.getBoundingClientRect().right
        ) close();
      }}
    >
      <Sidebar user={user} onOpenPalette={onOpenPalette} />
      <button
        type="button"
        aria-label="Закрыть навигацию"
        className="btn btn-ghost btn-icon absolute right-1 top-3 z-30"
        onClick={close}
      >
        <X size={18} aria-hidden="true" />
      </button>
    </dialog>
  );
}

// The chatters' site serves /account, /join and /login of this app and nothing
// else, so a console route is reachable there only from inside the app — the
// catch-all, for one. Whoever arrives that way, of any role, is taken to their
// cabinet before the console asks the kernel for anything: the console has a
// name of its own.
export function ProtectedLayout() {
  if (isChatterSite()) return <Navigate to={CHATTER_HOME} replace />;
  return <ConsoleLayout />;
}

function ConsoleLayout() {
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const closeNavigation = useCallback(() => setNavigationOpen(false), []);
  useEffect(() => setNavigationOpen(false), [location.key]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => {
    setNavigationOpen(false);
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      setNavigationOpen(false);
      setPaletteOpen((open) => !open);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
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
  // answers 403 for a chatter. Send them to their own cabinet instead of
  // rendering a console full of refusals — or, on the console's own name,
  // where there is no cabinet, to the sign-in page that turns them away.
  if (data.user.role === "chatter") {
    return <Navigate to={chatterExit()} replace />;
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
      <div className="app">
        {navigationOpen && <MobileNavigation user={data.user} close={closeNavigation} onOpenPalette={openPalette} />}
        {paletteOpen && (
          <Suspense fallback={null}>
            <CommandPalette role={data.user.role} onClose={closePalette} />
          </Suspense>
        )}
        <Sidebar user={data.user} onOpenPalette={openPalette} />
        <div className="min-w-0">
          <div className="app-strip">
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Открыть навигацию" onClick={() => setNavigationOpen(true)}><Menu size={20} aria-hidden="true" /></button>
            <Link to="/" className="logo !px-0"><span>Agency</span>Hub</Link>
            <button type="button" className="btn btn-ghost btn-icon ml-auto" aria-label="Найти: раздел, страницу, фана" onClick={openPalette}><Search size={18} aria-hidden="true" /></button>
          </div>
          <main className="app-main">
            <div className="app-content">
              {isPageCatalogError && <div className="mb-6"><p className="mb-1 text-sm font-medium text-text-primary">Каталог страниц</p><QueryNotice error stale={Boolean(pages)} retry={refetchPages} /></div>}
              <ErrorBoundary resetKey={location.pathname}>
                <Outlet />
              </ErrorBoundary>
            </div>
          </main>
        </div>
      </div>
    </DashboardShellProvider>
  );
}
