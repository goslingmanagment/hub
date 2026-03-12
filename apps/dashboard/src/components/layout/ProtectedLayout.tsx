import { useEffect } from "react";
import { Navigate } from "react-router";
import { useMe } from "@/api/queries";
import { useAuthStore } from "@/stores/auth";
import { AppShell } from "./AppShell";
import { Skeleton } from "@/components/ui/skeleton";

export function ProtectedLayout() {
  const { data, isLoading, isError } = useMe();
  const setAuth = useAuthStore((s) => s.setAuth);

  useEffect(() => {
    if (data) {
      setAuth(data.user, data.authMethod);
    }
  }, [data, setAuth]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950">
        <Skeleton className="h-8 w-32" />
      </div>
    );
  }

  if (isError || !data) {
    return <Navigate to="/login" replace />;
  }

  return <AppShell />;
}
