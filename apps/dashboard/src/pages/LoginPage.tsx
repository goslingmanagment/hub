import { useState, type FormEvent } from "react";
import { useNavigate, Navigate } from "react-router";
import { toast } from "sonner";
import { useLogin, useAuthMe } from "@/api/queries";

export function LoginPage() {
  const navigate = useNavigate();
  const login = useLogin();
  const { data: auth, isLoading: authLoading } = useAuthMe();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div className="text-text-muted text-sm">Loading...</div>
      </div>
    );
  }

  if (auth?.user) {
    return <Navigate to="/" replace />;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    login.mutate(
      { username, password },
      {
        onSuccess: () => navigate("/"),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Login failed"),
      },
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-bg">
      <div className="w-[380px] rounded-xl border border-border bg-card p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-bold">
          <span className="text-accent">Agency</span>
          <span>Hub</span>
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="username" className="text-sm text-text-secondary">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
              required
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-sm text-text-secondary">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          <button
            type="submit"
            disabled={login.isPending}
            className="w-full rounded-lg bg-accent py-2.5 font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {login.isPending ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
