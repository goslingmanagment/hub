import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useLogin, useMe } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginPage() {
  const { data: me, isLoading } = useMe();
  const navigate = useNavigate();
  const login = useLogin();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (isLoading) return null;
  if (me) return <Navigate to="/overview" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate(
      { username, password },
      { onSuccess: () => navigate("/overview", { replace: true }) },
    );
  };

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 p-6">
        <h1 className="text-xl font-semibold text-zinc-100">Agency Hub</h1>
        <div className="space-y-2">
          <Input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {login.isError && (
          <p className="text-sm text-red-400">
            {(login.error as any)?.body?.message || "Login failed"}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? "Logging in..." : "Log in"}
        </Button>
      </form>
    </div>
  );
}
