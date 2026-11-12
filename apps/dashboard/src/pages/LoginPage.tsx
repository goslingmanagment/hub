import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, Navigate, useSearchParams } from "react-router";
import { useLogin, useAuthMe } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { afterSignIn, chatterExit, isSigninContinuation, leavesTheConsole, resolveLoginReturnPath, resolveRoleHome, silentSignInTry } from "@/lib/navigation";
import { isChatterSite, isConsoleSite } from "@/lib/sites";

// One sign-in screen for two names. A chatter signs in to the product they
// use, so on their site it carries that product's wordmark — the one
// ChatterLayout and /join show — and not the name of a console they never see.
function Wordmark() {
  return isChatterSite()
    ? <><span>Chat</span>Goose</>
    : <><span>Agency</span>Hub</>;
}

/** Back to Workboard, or on to the other name, after the sign-in: outside the console's router, so a page load. */
function LeaveFor({ href }: { href: string }) {
  useEffect(() => {
    window.location.replace(href);
  }, [href]);
  return (
    <div className="entry-screen">
      <div role="status" className="text-sm text-text-secondary">{isWorkboardPathOnly(href) ? "Открываем Workboard…" : "Входим…"}</div>
    </div>
  );
}

function isWorkboardPathOnly(href: string): boolean {
  return leavesTheConsole(href) && !isSigninContinuation(href);
}

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = resolveLoginReturnPath(params.get("next"));
  const login = useLogin();
  const authQuery = useAuthMe();
  const { data: auth, isLoading: authLoading } = authQuery;
  const submitting = useRef(false);
  const [leaving, setLeaving] = useState<string | null>(null);

  // One door for two names. A sign-in on either is planted on the other on the
  // way (afterSignIn); a chatter who signs in on the console's name — or comes
  // to it with a session — is taken to their own place on the team's name,
  // signed in. Nobody is signed out here.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (authLoading) {
    return (
      <div className="entry-screen">
        <div role="status" className="text-sm text-text-secondary">Проверяем вход…</div>
      </div>
    );
  }

  if (leaving !== null) return <LeaveFor href={leaving} />;

  // Nobody signed in on this name: ask the other name once, silently, before
  // showing the form (silentSignInTry; the marker on the way back stops a second try).
  const notSignedIn = authQuery.isError && authQuery.error instanceof KernelApiError && authQuery.error.status === 401;
  const silentTry = notSignedIn ? silentSignInTry(params, returnTo) : null;
  if (silentTry !== null) return <LeaveFor href={silentTry} />;

  // Already signed in on this name (not by this form a moment ago: its own
  // success decides where to go, after `me` was read back): another name's way
  // back goes on; a chatter on the console's name goes to the team's; everyone
  // else home.
  // A narrow session (opened from the extension) is not a sign-in another name
  // takes: for that way back the form is shown.
  const signedIn = Boolean(auth?.user) && !authQuery.isError && !(isSigninContinuation(returnTo) && auth?.narrow);
  if (auth?.user && signedIn && !login.isPending && !login.isSuccess) {
    const home = isSigninContinuation(returnTo)
      ? returnTo
      : auth.user.role === "chatter" && isConsoleSite() ? chatterExit() : resolveRoleHome(auth.user.role, returnTo);
    return leavesTheConsole(home) ? <LeaveFor href={home} /> : <Navigate to={home} replace />;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current || login.isPending || !username.trim() || !password) return;
    submitting.current = true;
    login.mutate(
      { username, password },
      {
        onSuccess: (state) => {
          const next = afterSignIn(state.user.role, returnTo);
          if (leavesTheConsole(next)) setLeaving(next);
          else navigate(next, { replace: true });
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
      {/* A chatter has nobody else to ask: the owner makes the links (a new password, an invitation). */}
      {isChatterSite() && <p className="entry-hint entry-login-help">Нет логина или забыли пароль? Попросите у владельца новую ссылку.</p>}
    </div>
  );
}
