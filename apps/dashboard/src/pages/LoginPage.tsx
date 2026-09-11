import { useRef, useState, type FormEvent } from "react";
import { useNavigate, Navigate, useSearchParams } from "react-router";
import { useLogin, useAuthMe } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { resolveLoginReturnPath } from "@/lib/navigation";

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = resolveLoginReturnPath(params.get("next"));
  const login = useLogin();
  const authQuery = useAuthMe();
  const { data: auth, isLoading: authLoading } = authQuery;
  const submitting = useRef(false);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div role="status" className="text-text-muted text-sm">Проверяем вход…</div>
      </div>
    );
  }

  if (auth?.user && !authQuery.isError) {
    return <Navigate to={returnTo} replace />;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current || login.isPending || !username.trim() || !password) return;
    submitting.current = true;
    login.mutate(
      { username, password },
      {
        onSuccess: () => navigate(returnTo, { replace: true }),
        onSettled: () => { submitting.current = false; },
      },
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="w-full max-w-[380px] rounded-xl border border-border bg-card p-6 sm:p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-bold">
          <span className="text-accent">Agency</span>
          <span>Hub</span>
        </h1>

        {authQuery.isError && !(authQuery.error instanceof KernelApiError && authQuery.error.status === 401) && <p role="alert" className="mb-4 text-sm text-text-secondary">Не удалось проверить текущую сессию. Можно повторить вход.</p>}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-busy={login.isPending}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="username" className="text-sm text-text-secondary">
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
              placeholder="Введите логин"
              required
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-sm text-text-secondary">
              Пароль
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              disabled={login.isPending}
              value={password}
              onChange={(e) => { setPassword(e.target.value); login.reset(); }}
              placeholder="Введите пароль"
              required
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          {login.isError && <p role="alert" className="text-sm text-danger">{login.error instanceof KernelApiError && login.error.status === 401 ? "Неверный логин или пароль." : "Не удалось войти. Повторите попытку."}</p>}
          <button
            type="submit"
            disabled={login.isPending || !username.trim() || !password}
            className="w-full rounded-lg bg-accent py-2.5 font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {login.isPending ? "Входим…" : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
