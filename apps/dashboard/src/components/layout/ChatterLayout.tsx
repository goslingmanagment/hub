import { Navigate, useLocation } from "react-router";
import { useAuthMe } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { ACCOUNT_SCREEN, CHATTER_HOME, buildLoginRoute, cabinetRedirect, chatterExit } from "@/lib/navigation";
import { isConsoleSite } from "@/lib/sites";
import { LeaveForWorkboard } from "@/routes/ToWorkboard";

// `/account`, the old cabinet. «Аккаунт и устройства» is Workboard's screen
// since 12.11 (`/workboard/account`, in the name menu): this address only
// sends people on, signed in — the cabinet's old tabs to a chatter's «Мои
// смены», anyone else to the account screen on this host.
//
// The console's own production name serves a chatter nothing: their place is
// on the team's name (chatterExit). A narrow session (opened from the
// extension) opens the team's place alone: the account's devices and password
// are not its to change.

export function ChatterLayout() {
  const location = useLocation();
  const { data, isLoading, isError, error, refetch, isFetching } = useAuthMe();

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

  const chatter = data.user.role === "chatter";
  if (chatter && isConsoleSite()) return <LeaveForWorkboard href={chatterExit()} />;
  if (data.narrow) return <LeaveForWorkboard href={CHATTER_HOME} />;
  const left = chatter ? cabinetRedirect(new URLSearchParams(location.search)) : null;
  return <LeaveForWorkboard href={left ?? ACCOUNT_SCREEN} />;
}
