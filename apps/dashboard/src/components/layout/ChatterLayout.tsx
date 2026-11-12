import { Navigate, Outlet, useLocation } from "react-router";
import { useAuthMe, useLogout } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { CHATTER_HOME, buildLoginRoute, chatterExit, leavesTheConsole } from "@/lib/navigation";
import { clearDashboardSession } from "@/lib/queryClient";
import { isConsoleSite } from "@/lib/sites";
import { LeaveForWorkboard } from "@/routes/ToWorkboard";

// The shell for /account. A chatter has no owner console, so
// there is no sidebar and no page catalogue here — one line of chrome above a
// single column. The owner and a team lead may open the same page (it is their
// account too); the layout does not branch on role.
//
// The console's own production name serves no cabinet at all: the account
// lives on the chatters' site, and a session does not carry between the two
// names. There this layout only sends people on — an owner or a team lead to
// the console, a chatter to their place on the team's name, signed in.

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
        <div role="alert" className="card card-body max-w-md">
          <h1 className="card-title">Не удалось проверить вход</h1>
          <p className="mt-2 text-sm text-text-secondary">Повтори, когда связь восстановится.</p>
          <button
            type="button"
            disabled={isFetching}
            onClick={() => void refetch()}
            className="btn btn-primary mt-4"
          >
            {isFetching ? "Проверяем…" : "Повторить"}
          </button>
        </div>
      </div>
    );
  }

  if (isConsoleSite()) {
    const exit = data.user.role === "chatter" ? chatterExit() : "/";
    return leavesTheConsole(exit) ? <LeaveForWorkboard href={exit} /> : <Navigate to={exit} replace />;
  }

  // A narrow session (opened from the extension) opens the team's place alone:
  // the account's devices and password are not its to change.
  if (data.narrow) {
    return <LeaveForWorkboard href={CHATTER_HOME} />;
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
      <header className="cabinet-bar">
        <span className="cabinet-logo"><span>Chat</span>Goose</span>
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-sm text-text-secondary">{data.user.username}</span>
          <button
            type="button"
            onClick={() => void handleLogout()}
            disabled={logout.isPending}
            className="btn btn-sm"
          >
            Выйти
          </button>
        </div>
      </header>
      <main className="cabinet-main">
        <Outlet />
      </main>
    </div>
  );
}
