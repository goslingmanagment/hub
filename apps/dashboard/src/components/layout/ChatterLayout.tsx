import { Navigate, useLocation } from "react-router";
import { useAuthMe } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { ACCOUNT_SCREEN, WORKBOARD_HOME, buildLoginRoute, cabinetRedirect, workboardHere } from "@/lib/navigation";
import { LeaveForWorkboard } from "@/routes/ToWorkboard";

// `/account`, the old cabinet. «Аккаунт и устройства» is Workboard's screen
// since 12.11 (`/workboard/account`, in the name menu): this address only
// sends people on, signed in — the cabinet's old tabs to a chatter's «Мои
// смены», anyone else to the account screen on this host.
//
// Workboard has one address, the team's name: from the console's name everyone
// goes there signed in (workboardHere). A narrow session (opened from the extension) opens the
// team's place alone: the account's devices and password are not its to change.

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
  if (data.narrow) return <LeaveForWorkboard href={WORKBOARD_HOME} />;
  const left = chatter ? cabinetRedirect(new URLSearchParams(location.search)) : null;
  return <LeaveForWorkboard href={workboardHere(left ?? ACCOUNT_SCREEN)} />;
}
