import type { ReactNode } from "react";
import { Button, EmptyState, ErrorState, Spinner } from "@agency_hub_core/ui";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { CHATTER_SITE_ORIGIN, CONSOLE_ORIGIN } from "@agency_hub_core/ui/sites";
import { signInHref } from "@/shared/hub";
import { useMe } from "@/shared/useMe";

/**
 * Workboard needs the console's session: `me` first. Nobody signed in → the
 * console's sign-in on this host, and back here after it (hub.ts does the
 * redirect on the 401). A chatter is let in to their own part of Workboard
 * (owner, 2026-11-10; the routes and the menu keep them there) — on the
 * chatters' site. The console's own name is the owner's and the team leads'
 * door: its sign-in ends a chatter's session (the console's LoginPage), and a
 * chatter session left from before the names were split opens nothing here
 * either.
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

  if (me.role === "chatter" && window.location.origin === CONSOLE_ORIGIN) {
    return (
      <div className="wb-gate">
        <EmptyState title="Это вход для владельца и тимлидов" action={<a className="ui-btn" href={`${CHATTER_SITE_ORIGIN}/account`}>Открыть ChatGoose</a>}>
          Твой кабинет и отчёты — в ChatGoose.
        </EmptyState>
      </div>
    );
  }

  return <>{children}</>;
}
