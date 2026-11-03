import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { useAuthMe } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";

/**
 * A screen of the owner. A team lead does not see its menu item and, reaching it
 * anyway, is told so instead of being moved away silently. The screen is not
 * rendered, so none of the owner's data is even asked for; the server's own check
 * stays the real protection.
 */
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
    return (
      <StatusPanel
        title="Нет доступа"
        description="Этот экран только для владельца."
        action={<Link to="/" className="btn btn-sm">На главную</Link>}
      />
    );
  }

  return <>{children}</>;
}

/** An address nothing lives at: said plainly, inside the console. */
export function NotFoundScreen() {
  useEffect(() => {
    document.title = "Такой страницы нет — Hub";
  }, []);
  return (
    <StatusPanel
      title="Такой страницы нет"
      description="Возможно, ссылка устарела или в ней опечатка."
      action={<Link to="/" className="btn btn-sm">На главную</Link>}
    />
  );
}
