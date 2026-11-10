import { useEffect } from "react";
import { Outlet } from "react-router";
import { EmptyState, LinkButton } from "@agency_hub_core/ui";
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
  useEffect(() => {
    document.title = "Workboard";
  }, []);
}

function NotForChatter() {
  useWorkboardTitle();
  return (
    <div className="wb-content">
      <EmptyState title="Этот раздел — для владельца и тимлидов" action={<LinkButton variant="primary" to={homePath("chatter")}>Мои отчёты</LinkButton>}>
        Твои отчёты по сменам — в «Моих отчётах».
      </EmptyState>
    </div>
  );
}

function ForChatterOnly() {
  useWorkboardTitle();
  return (
    <div className="wb-content">
      <EmptyState title="Это раздел чаттера" action={<LinkButton to={homePath("owner")}>К сменам</LinkButton>}>
        Здесь чаттер видит свои отчёты по сменам. У вашей учётной записи их нет.
      </EmptyState>
    </div>
  );
}
