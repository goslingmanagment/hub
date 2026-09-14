import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAuthMe } from "@/api/queries";

export function OwnerRoute({ children }: { children: ReactNode }) {
  const { data, isLoading } = useAuthMe();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <span role="status" className="text-sm text-text-muted">Проверяем доступ…</span>
      </div>
    );
  }

  if (data?.user.role !== "owner") {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
