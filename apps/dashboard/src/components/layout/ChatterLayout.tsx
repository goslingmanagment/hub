import { Navigate, Outlet, useLocation } from "react-router";
import { useAuthMe, useLogout } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { buildLoginRoute } from "@/lib/navigation";
import { clearDashboardSession } from "@/lib/queryClient";
import { CHATTER_SITE_ORIGIN, isConsoleSite } from "@/lib/sites";

// Decision 351: the shell for /account. A chatter has no owner console, so
// there is no sidebar and no page catalogue here — one line of chrome above a
// single column. The owner and a team lead may open the same page (it is their
// account too); the layout does not branch on role — except on the console's
// own production name, where a chatter is told that their cabinet is elsewhere.

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

  // The console's own name is not a chatter's place: the cabinet is on the
  // chatters' site, and a session does not carry from one name to the other.
  // Opening the cabinet here left a person who also has an owner login
  // guessing why the console would not open. So the page says whose name this
  // is and offers both ways out. An owner or a team lead still gets their
  // account here.
  if (isConsoleSite() && data.user.role === "chatter") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg p-6">
        <div className="max-w-md rounded-xl border border-border bg-card p-6">
          <h1 className="font-semibold text-text-primary">Это консоль владельца</h1>
          <p className="mt-2 text-sm text-text-secondary">
            Вы вошли как {data.user.username}. Это логин чаттера: консоль ему недоступна, а аккаунт ChatGoose открывается на своём адресе.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
            <button
              type="button"
              onClick={() => void handleLogout()}
              disabled={logout.isPending}
              className="min-h-11 rounded-lg bg-accent px-4 text-white disabled:opacity-50"
            >
              Войти под другим логином
            </button>
            <a href={`${CHATTER_SITE_ORIGIN}/account`} className="text-sm text-text-secondary underline">
              Открыть аккаунт ChatGoose
            </a>
          </div>
        </div>
      </div>
    );
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
