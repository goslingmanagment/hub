import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { EmptyState, LinkButton } from "@agency_hub_core/ui";
import { productName } from "@agency_hub_core/ui/place";
import { homePath, useMe, type Role } from "@/shared/useMe";

/**
 * The role guard of a group of routes (routes.tsx): its screens open only for
 * `roles`. Anyone else — a chatter with an old link to Выплаты, the owner on a
 * chatter's address — gets one calm sentence and their own home, and the
 * screen is never mounted, so none of its reads is sent. AuthGate has read
 * `me` before any route renders.
 */
export function RoleGate({ roles }: { roles: readonly Role[] }) {
  const { role } = useMe();
  if (role !== null && roles.includes(role)) return <Outlet />;
  return role === "chatter" ? <NotForChatter /> : <ForChatterOnly />;
}

/**
 * «Команда» (products plan §2.3): the owner, a team lead, and a chatter who leads a team by its records (products
 * package T) — the gate follows the records, not the login's role alone (useMe `leadsTeam`). A plain chatter gets the
 * calm sentence of the team's screens; Hub cuts every read to the viewer's teams anyway.
 */
export function TeamGate() {
  const { role, leadsTeam } = useMe();
  if (role !== null && leadsTeam) return <Outlet />;
  return role === "chatter" ? <NotForChatter /> : <ForChatterOnly />;
}

function useWorkboardTitle() {
  useEffect(() => {
    document.title = productName("workboard");
  }, []);
}

function NotForChatter() {
  useWorkboardTitle();
  return (
    <div className="wb-content">
      <EmptyState title="Этот раздел для владельца и тимлидов" action={<LinkButton variant="primary" to={homePath("chatter")}>Сегодня</LinkButton>}>
        Ваша смена, что ждёт вас и ваша неделя в «Сегодня».
      </EmptyState>
    </div>
  );
}

/**
 * The owner or a team lead on a chatter's address: «Мои смены» is Смены of
 * their own shifts (`/shifts?mine=1`, one screen, not a second one); «Начало»
 * (where an invitation used to land everyone) is Workboard's home. Anything
 * else of a chatter's: one sentence. (A shift's report is the board, everyone's
 * address: `/report/:shiftId`.)
 */
function ForChatterOnly() {
  const location = useLocation();
  const path = location.pathname.replace(/\/+$/, "");
  if (path === "/my/shifts" || path === "/my/reports") {
    const search = new URLSearchParams(location.search);
    search.set("mine", "1");
    return <Navigate to={{ pathname: "/shifts", search: `?${search.toString()}` }} replace />;
  }
  if (path === "/start") return <Navigate to={{ pathname: "/", search: location.search }} replace />;
  return <NotYours />;
}

function NotYours() {
  useWorkboardTitle();
  return (
    <div className="wb-content">
      <EmptyState title="Это раздел чаттера" action={<LinkButton to={homePath("owner")}>Сегодня</LinkButton>}>
        Здесь чаттер видит свои смены и отчёты по ним. У вашей учётной записи их нет.
      </EmptyState>
    </div>
  );
}
