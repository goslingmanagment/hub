/**
 * Group team: Команда (design/screens/team.md). The routes and the screens they
 * render. `/account`, `/join` and `/login` stay in App.tsx: their pages are this
 * group's too, and are rebuilt in their own files.
 */
import { Route } from "react-router";
import { named, Owner } from "./shared.js";

const ClientHeldSendsPage = named(() => import("@/pages/ClientHeldSendsPage"), "ClientHeldSendsPage");
const TeamShiftsPage = named(() => import("@/pages/team/TeamShiftsPage"), "TeamShiftsPage");
const TeamCoveragePage = named(() => import("@/pages/team/TeamCoveragePage"), "TeamCoveragePage");
const ChattersPage = named(() => import("@/pages/team/ChattersPage"), "ChattersPage");
const ChatterPage = named(() => import("@/pages/team/ChatterPage"), "ChatterPage");
const TeamPayoutsPage = named(() => import("@/pages/team/TeamPayoutsPage"), "TeamPayoutsPage");
const TeamSalesPage = named(() => import("@/pages/team/TeamSalesPage"), "TeamSalesPage");
const TeamWinBackPage = named(() => import("@/pages/team/TeamWinBackPage"), "TeamWinBackPage");
const TeamCustomsPage = named(() => import("@/pages/team/TeamCustomsPage"), "TeamCustomsPage");
const PeopleLayout = named(() => import("@/pages/team/people/PeopleLayout"), "PeopleLayout");
const PeoplePage = named(() => import("@/pages/team/people/PeoplePage"), "PeoplePage");
const PersonPage = named(() => import("@/pages/team/people/PersonPage"), "PersonPage");
const ModelApplicationsPage = named(() => import("@/pages/team/applications/ModelApplicationsPage"), "ModelApplicationsPage");
const ModelApplicationPage = named(() => import("@/pages/team/applications/ModelApplicationPage"), "ModelApplicationPage");

export function teamRoutes() {
  return (
    <>
      {/* Owner and team leads (`session`), except the people and the questionnaires. */}
      <Route path="team/shifts" element={<TeamShiftsPage />} />
      <Route path="team/coverage" element={<TeamCoveragePage />} />
      <Route path="team/held-sends" element={<ClientHeldSendsPage />} />
      <Route path="team/chatters" element={<ChattersPage />} />
      <Route path="team/chatters/:userId" element={<ChatterPage />} />
      <Route path="team/payouts" element={<TeamPayoutsPage />} />
      <Route path="team/sales" element={<TeamSalesPage />} />
      <Route path="team/win-back" element={<TeamWinBackPage />} />
      <Route path="team/customs" element={<TeamCustomsPage />} />
      <Route element={<Owner />}>
        {/* One frame over the list and the card: it holds the only copy of a fresh link. */}
        <Route element={<PeopleLayout />}>
          <Route path="team/people" element={<PeoplePage />} />
          <Route path="team/people/:userId" element={<PersonPage />} />
        </Route>
        {/* The site's model questionnaires, live. */}
        <Route path="team/applications" element={<ModelApplicationsPage />} />
        <Route path="team/applications/:ref" element={<ModelApplicationPage />} />
      </Route>
    </>
  );
}
