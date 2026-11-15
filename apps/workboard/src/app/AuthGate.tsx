import { useEffect, type ReactNode } from "react";
import { Button, EmptyState, ErrorState, Spinner } from "@agency_hub_core/ui";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { peerOriginOf, signInHopHref, siteOf } from "@agency_hub_core/ui/sites";
import { signInHref } from "@/shared/hub";
import { useMe } from "@/shared/useMe";

/**
 * Workboard needs Hub's session: `me` first. Nobody signed in → the sign-in on
 * this host, and back here after it (hub.ts does the redirect on the 401).
 * Workboard has one address for every role, the team's name (products plan
 * §2.3): anyone on the console's name is taken there, to the same screen,
 * signed in on the way (the session crosses by a one-time code). In production
 * Hub's server sends a Workboard address on the console's name there before
 * this app loads; this is the same rule for a page that got here anyway.
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
            Workboard открывается с той же учётной записью, что и Hub.
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

  const team = siteOf(window.location.origin) === "console" ? peerOriginOf(window.location.origin) : null;
  if (team !== null) {
    return <ToTeamsName team={team} />;
  }

  return <>{children}</>;
}

/** Anyone on the console's name: the same screen on the team's name, signed in on the way (a page load). */
function ToTeamsName({ team }: { team: string }) {
  useEffect(() => {
    const { pathname, search, hash } = window.location;
    window.location.replace(signInHopHref(team, `${team}${pathname}${search}${hash}`));
  }, [team]);
  return (
    <div className="wb-gate" role="status">
      <Spinner />
      <span>Открываем Workboard…</span>
    </div>
  );
}
