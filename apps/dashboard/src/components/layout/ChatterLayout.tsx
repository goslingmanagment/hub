import { Navigate, Outlet, useLocation } from "react-router";
import { useAuthMe, useLogout } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { buildLoginRoute } from "@/lib/navigation";
import { clearDashboardSession } from "@/lib/queryClient";

// Decision 349: the shell for /account. A chatter has no owner console, so
// there is no sidebar and no page catalogue here — one line of chrome above a
// single column. The owner and a team lead may open the same page (it is their
// account too); the layout does not branch on role.

export function ChatterLayout() {
  const location = useLocation();
  const { data, isLoading, isError, error, refetch, isFetching } = useAuthMe();
  const logout = useLogout();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div role="status" className="text-sm text-text-muted">Проверяем вход…</div>
      </div>
    );
  }

  if (error instanceof KernelApiError && error.status === 401) {
    return <Navigate to={buildLoginRoute(`${location.pathname}${location.search}`)} replace />;
  }

  if (isError || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg p-6">
        <div role="alert" className="max-w-md rounded-xl border border-border bg-card p-6">
          <h1 className="font-semibold text-text-primary">Не удалось проверить вход</h1>
          <p className="mt-2 text-sm text-text-secondary">Повторите запрос, когда связь восстановится.</p>
          <button
            type="button"
            disabled={isFetching}
            onClick={() => void refetch()}
            className="mt-4 min-h-11 rounded-lg bg-accent px-4 text-white disabled:opacity-50"
          >
            {isFetching ? "Проверяем…" : "Повторить"}
          </button>
        </div>
      </div>
    );
  }

  async function handleLogout() {
    if (logout.isPending) return;
    try {
      await logout.mutateAsync();
      clearDashboardSession();
      window.location.assign("/login");
    } catch { /* The mutation retains the failure; never claim an unconfirmed sign-out. */ }
  }

  return (
    <div className="min-h-screen bg-bg">
      <header className="flex h-[56px] items-center justify-between gap-3 border-b border-border bg-card px-4 sm:px-6">
        <span className="text-base font-bold">
          <span className="text-accent">Chat</span>
          <span>Goose</span>
        </span>
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-sm text-text-secondary">{data.user.username}</span>
          <button
            type="button"
            onClick={() => void handleLogout()}
            disabled={logout.isPending}
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
          >
            Выйти
          </button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[720px] px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
