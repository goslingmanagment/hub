import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, Navigate, useSearchParams } from "react-router";
import { useLogin, useLogout, useAuthMe } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { resolveLoginReturnPath, resolveRoleHome } from "@/lib/navigation";
import { clearDashboardSession } from "@/lib/queryClient";
import { CHATTER_SITE_ORIGIN, isChatterSite, isConsoleSite } from "@/lib/sites";

// One sign-in screen for two names. A chatter signs in to the product they
// use, so on their site it carries that product's wordmark — the one
// ChatterLayout and /join show — and not the name of a console they never see.
function Wordmark() {
  return isChatterSite()
    ? <><span>Chat</span>Goose</>
    : <><span>Agency</span>Hub</>;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = resolveLoginReturnPath(params.get("next"));
  const login = useLogin();
  const logout = useLogout();
  const authQuery = useAuthMe();
  const { data: auth, isLoading: authLoading } = authQuery;
  const submitting = useRef(false);

  // Two doors. The console's own name is the owner's and the team leads' way
  // in; a chatter login belongs to ChatGoose and is not accepted here. A
  // session of one — made by this form a moment ago, or left in the browser
  // from before the names were split — is ended, and the form says where that
  // login is at home. No cabinet opens under the console's name.
  const turnedAway = isConsoleSite() && !authQuery.isError && auth?.user.role === "chatter";
  const [wasTurnedAway, setWasTurnedAway] = useState(false);
  const endSession = logout.mutate;
  useEffect(() => {
    if (!turnedAway) return;
    setWasTurnedAway(true);
    endSession(undefined, { onSuccess: () => clearDashboardSession() });
  }, [turnedAway, endSession]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (authLoading) {
    return (
      <div className="entry-screen">
        <div role="status" className="text-sm text-text-secondary">Проверяем вход…</div>
      </div>
    );
  }

  if (auth?.user && !authQuery.isError && !turnedAway) {
    return <Navigate to={resolveRoleHome(auth.user.role, returnTo)} replace />;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current || login.isPending || !username.trim() || !password) return;
    submitting.current = true;
    login.mutate(
      { username, password },
      {
        onSuccess: (state) => {
          // Turned away above, once the session it has just made is read back.
          if (isConsoleSite() && state.user.role === "chatter") return;
          setWasTurnedAway(false);
          navigate(resolveRoleHome(state.user.role, returnTo), { replace: true });
        },
        onSettled: () => { submitting.current = false; },
      },
    );
  }

  return (
    <div className="entry-screen">
      <h1 className="entry-logo">
        <Wordmark />
      </h1>
      <div className="entry-card">
        {authQuery.isError && !(authQuery.error instanceof KernelApiError && authQuery.error.status === 401) && <p role="alert" className="notice notice-warning mb-4">Не удалось проверить текущую сессию. Можно повторить вход.</p>}
        {(turnedAway || wasTurnedAway) && (
          <p role="alert" className="notice mb-4">
            Это вход в консоль. Аккаунт ChatGoose — на{" "}
            <a href={`${CHATTER_SITE_ORIGIN}/account`} className="link">chatgoose.gosling-agency.ru</a>.
          </p>
        )}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-busy={login.isPending}>
          <div className="flex flex-col gap-2">
            <label htmlFor="username" className="field-label mb-0">
              Логин
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              disabled={login.isPending}
              value={username}
              onChange={(e) => { setUsername(e.target.value); login.reset(); }}
              required
              className="input"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="password" className="field-label mb-0">
              Пароль
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              disabled={login.isPending}
              value={password}
              onChange={(e) => { setPassword(e.target.value); login.reset(); }}
              required
              className="input"
            />
          </div>

          {login.isError && <p role="alert" className="field-error">{login.error instanceof KernelApiError && login.error.status === 401 ? "Неверный логин или пароль." : "Не удалось войти. Повторите попытку."}</p>}
          <button
            type="submit"
            disabled={login.isPending || !username.trim() || !password}
            className="btn btn-primary entry-submit"
          >
            {login.isPending ? "Входим…" : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
