import { useState, type FormEvent } from "react";
import { useNavigate, Navigate, useSearchParams } from "react-router";
import { useLogin, useAuthMe } from "@/api/queries";
import { authReturnTo } from "@/lib/authNavigation";

export function LoginPage() {
  const navigate = useNavigate();
  const login = useLogin();
  const [search] = useSearchParams();
  const returnTo = authReturnTo(search.get("returnTo"));
  const [error, setError] = useState<string | null>(null);
  const { data: auth, isLoading: authLoading } = useAuthMe();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div className="text-text-muted text-sm" role="status">Проверяем сессию…</div>
      </div>
    );
  }

  if (auth?.user) {
    return <Navigate to={returnTo} replace />;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    login.mutate(
      { username, password },
      {
        onSuccess: () => navigate(returnTo, { replace: true }),
        onError: (err) =>
          setError(err instanceof Error ? err.message : "Не удалось войти"),
      },
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-bg">
      <div className="w-[380px] max-w-[calc(100%-2rem)] rounded-xl border border-border bg-card p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-bold">
          <span className="text-accent">Agency</span>
          <span>Hub</span>
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="username" className="text-sm text-text-secondary">
              Логин
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Введите логин"
              autoComplete="username"
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Введите пароль"
              autoComplete="current-password"
              required
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          {error && <p role="alert" className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={login.isPending}
            className="w-full rounded-lg bg-accent py-2.5 font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {login.isPending ? "Входим…" : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
