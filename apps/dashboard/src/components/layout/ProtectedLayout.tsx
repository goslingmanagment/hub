import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useAuthMe, useLogout, useOverview } from "@/api/queries";
import { DashboardShellProvider } from "./DashboardShellContext.js";
import { Sidebar } from "./Sidebar.js";
import { Topbar } from "./Topbar.js";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { buildLoginRoute } from "@/lib/authNavigation";
import { clearDashboardSession } from "@/lib/queryClient";
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

function DashboardAccessDenied({ user, retry }: {
  user: { username: string; role: string };
  retry: () => unknown;
}) {
  const location = useLocation();
  const logout = useLogout();
  const inFlight = useRef(false);
  const [logoutError, setLogoutError] = useState(false);
  async function switchAccount() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLogoutError(false);
    try {
      await logout.mutateAsync();
      clearDashboardSession();
      window.location.assign(buildLoginRoute(`${location.pathname}${location.search}${location.hash}`));
    } catch {
      setLogoutError(true);
    } finally {
      inFlight.current = false;
    }
  }
  return <div className="flex min-h-screen items-center justify-center bg-bg p-4">
    <section className="w-full max-w-lg space-y-4 rounded-xl border border-border bg-card p-6">
      <h1 className="text-xl font-bold text-text-primary">Нет доступа к панели</h1>
      <p className="break-words text-sm text-text-secondary">Вы вошли как {user.username}. Панель доступна владельцу и руководителю команды. Если доступ нужен для работы, обратитесь к владельцу.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={logout.isPending} onClick={() => void switchAccount()} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{logout.isPending ? "Выходим…" : "Выйти и сменить аккаунт"}</button>
        <button type="button" onClick={() => void retry()} className="rounded-lg border border-border px-4 py-2 text-sm text-text-primary hover:bg-hover">Проверить доступ</button>
      </div>
      {logoutError && <p role="alert" className="text-sm text-danger">Не удалось выйти. Сессия может быть активна. Повторите выход.</p>}
    </section>
  </div>;
}

export function ProtectedLayout() {
  const location = useLocation();
  const { data, isLoading, isError, error, refetch } = useAuthMe();

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

  if (data.user.role !== "owner" && data.user.role !== "team_lead") {
    return <DashboardAccessDenied user={data.user} retry={refetch} />;
  }
  return <AuthorizedDashboard user={data.user} authError={isError} retryAuth={refetch} />;
}

function AuthorizedDashboard({ user, authError, retryAuth }: {
  user: { username: string; role: string };
  authError: boolean;
  retryAuth: () => unknown;
}) {
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  // Warm the lazy Analytics route only after dashboard access is established.
  useEffect(() => {
    if (location.pathname === "/analytics") {
      void import("@/api/pages").then(module => module.prefetchPages());
    }
  }, [location.pathname]);
  const closeNavigation = useCallback(() => setNavigationOpen(false), []);
  useEffect(() => setNavigationOpen(false), [location.key]);
  const {
    data: overview,
    isLoading: isPageCatalogLoading,
    isError: isPageCatalogError,
    error: pageCatalogError,
    refetch: refetchPageCatalog,
  } = useOverview();

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
        {navigationOpen && <MobileNavigation user={user} close={closeNavigation} />}
        <div className="hidden md:block"><Sidebar user={user} /></div>
        <div className="min-w-0 flex-1 md:ml-[248px]">
          <Topbar user={user} onOpenNavigation={() => setNavigationOpen(true)} />
          <main className="mt-[56px] min-w-0 p-0 md:p-8 max-w-[1200px]">
            {authError && <div className="p-4 md:p-0"><QueryNotice error stale retry={retryAuth} /></div>}
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
