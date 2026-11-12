import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { EmptyState, LinkButton } from "@agency_hub_core/ui";
import { placeName } from "@agency_hub_core/ui/place";
import { useFace } from "@/shared/face";
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

function useWorkboardTitle() {
  const place = placeName(useFace());
  useEffect(() => {
    document.title = place;
  }, [place]);
}

function NotForChatter() {
  useWorkboardTitle();
  return (
    <div className="wb-content">
      <EmptyState title="Этот раздел для владельца и тимлидов" action={<LinkButton variant="primary" to={homePath("chatter")}>Мои смены</LinkButton>}>
        Ваши смены и отчёты по ним в «Моих сменах».
      </EmptyState>
    </div>
  );
}

/**
 * The owner or a team lead on a chatter's address: «Мои смены» is Смены of
 * their own shifts (`/shifts?mine=1`, one screen, not a second one); a shift's
 * report, the team's reading of it. Anything else of a chatter's: one sentence.
 */
function ForChatterOnly() {
  const location = useLocation();
  const path = location.pathname.replace(/\/+$/, "");
  if (path === "/my/shifts" || path === "/my/reports") {
    const search = new URLSearchParams(location.search);
    search.set("mine", "1");
    return <Navigate to={{ pathname: "/shifts", search: `?${search.toString()}` }} replace />;
  }
  const report = /^\/my\/shifts\/([^/]+)$/.exec(path);
  if (report) return <Navigate to={{ pathname: `/shifts/report/${report[1]}`, search: location.search }} replace />;
  return <NotYours />;
}

function NotYours() {
  useWorkboardTitle();
  return (
    <div className="wb-content">
      <EmptyState title="Это раздел чаттера" action={<LinkButton to={homePath("owner")}>К сменам</LinkButton>}>
        Здесь чаттер видит свои смены и отчёты по ним. У вашей учётной записи их нет.
      </EmptyState>
    </div>
  );
}
