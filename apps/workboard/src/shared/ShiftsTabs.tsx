import { Tabs } from "@agency_hub_core/ui";
import { useMe } from "./useMe";

/**
 * The tabs of «Смены» (products plan §2.3, package W): a chatter's «Мои» (their own shifts with their reports) and
 * «Команда» (the shifts of their teams; Hub cuts them to the teams, services/teams.ts); the owner and a team lead read
 * the journal of their teams. Everyone has «Отчёты» (every report of the teams' shifts, owner 2026-11-19) and
 * «График»: the standing schedule of the teams.
 */
export function ShiftsTabs() {
  const { role } = useMe();
  const items = role === "chatter"
    ? [
      { to: "/shifts/mine", label: "Мои", end: true },
      { to: "/shifts/team", label: "Команда", end: true },
      { to: "/shifts/reports", label: "Отчёты", end: true },
      { to: "/shifts/schedule", label: "График", end: true },
    ]
    : [{ to: "/shifts", label: "Журнал", end: true }, { to: "/shifts/reports", label: "Отчёты", end: true }, { to: "/shifts/schedule", label: "График", end: true }];
  return <Tabs label="Смены" className="wb-shifts-tabs" items={items} />;
}
