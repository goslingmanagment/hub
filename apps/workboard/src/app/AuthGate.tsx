import type { ReactNode } from "react";
import { Button, EmptyState, ErrorState, Spinner } from "@agency_hub_core/ui";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { signInHref } from "@/shared/hub";
import { useMe } from "@/shared/useMe";

/**
 * Workboard needs the console's session: `me` first. Nobody signed in → the
 * console's sign-in on this host, and back here after it (hub.ts does the
 * redirect on the 401). A chatter has no Workboard: their cabinet is elsewhere.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();

  if (me.isLoading) {
    return (
      <div className="wb-gate" role="status">
        <Spinner />
        <span>Проверяем вход…</span>
      </div>
    );
  }

  if (me.isError) {
    if (hubErrorStatus(me.error) === 401) {
      return (
        <div className="wb-gate">
          <EmptyState title="Вход не выполнен" action={<Button variant="primary" onClick={() => window.location.assign(signInHref())}>Войти</Button>}>
            Workboard открывается с той же учётной записью, что и консоль Hub.
          </EmptyState>
        </div>
      );
    }
    return (
      <div className="wb-gate">
        <ErrorState onRetry={() => void me.refetch()} retrying={me.isFetching}>
          Не удалось проверить вход. Это не значит, что вы вышли: Hub просто не ответил.
        </ErrorState>
      </div>
    );
  }

  if (me.role === "chatter") {
    return (
      <div className="wb-gate">
        <EmptyState title="Workboard — для владельца и тимлидов" action={<a className="ui-btn" href="/account">Открыть кабинет</a>}>
          Ваш кабинет чаттера — в ChatGoose.
        </EmptyState>
      </div>
    );
  }

  return <>{children}</>;
}
