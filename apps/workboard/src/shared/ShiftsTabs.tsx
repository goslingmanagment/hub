import { Tabs } from "@agency_hub_core/ui";
import { useMe } from "./useMe";

/**
 * «Мои» and «Команда» on a chatter's «Смены» (products plan §2.3): their own shifts with their reports, and the shifts
 * of their teams (Hub cuts them to the teams, services/teams.ts). The owner and a team lead read the journal itself.
 */
export function ShiftsTabs() {
  const { role } = useMe();
  if (role !== "chatter") return null;
  return (
    <Tabs
      label="Чьи смены"
      className="wb-shifts-tabs"
      items={[{ to: "/my/shifts", label: "Мои", end: true }, { to: "/shifts", label: "Команда", end: true }]}
    />
  );
}
