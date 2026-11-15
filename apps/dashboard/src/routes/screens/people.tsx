/**
 * Group people: Hub «Люди», the registry (products plan §2.2, §4.3) — the list and a person's card. The person's work is
 * Workboard «Команда». The console's old «Команда → Люди» (`/team/people…`) leads here (App.tsx, lib/workboard.ts).
 */
import { Navigate, Route, useLocation } from "react-router";
import { teamPeopleInHub } from "@/lib/workboard";
import { named, Owner } from "./shared.js";

const PeoplePage = named(() => import("@/pages/people/PeoplePage"), "PeoplePage");
const PersonPage = named(() => import("@/pages/people/PersonPage"), "PersonPage");

export function peopleRoutes() {
  return (
    <Route element={<Owner />}>
      <Route path="people" element={<PeoplePage />} />
      <Route path="people/:ref/:tab?" element={<PersonPage />} />
    </Route>
  );
}

/** `/team/people…`: the registry's old address in the console, Hub «Люди» now. */
export function TeamPeopleToHub() {
  const location = useLocation();
  return <Navigate replace to={teamPeopleInHub(location.pathname) ?? "/people"} />;
}
