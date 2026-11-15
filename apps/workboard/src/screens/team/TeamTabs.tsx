import { Tabs } from "@agency_hub_core/ui";

/** «Команда»'s tabs (products plan §2.3): the people at work, and the newcomers' first week. */
export function TeamTabs() {
  return <Tabs label="Команда" items={[{ to: "/team", label: "Люди", end: true }, { to: "/team/newcomers", label: "Новички", end: true }]} />;
}
