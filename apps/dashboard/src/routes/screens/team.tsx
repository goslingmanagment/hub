/**
 * Group team: Команда (design/screens/team.md). The routes and what they render
 * until each screen is rebuilt. `/account`, `/join` and `/login` stay in App.tsx:
 * their pages are this group's too, and are rebuilt in their own files.
 */
import { Suspense } from "react";
import { Route, useLocation } from "react-router";
import { ScreenFallback } from "@/components/layout/ScreenFrame";
import { useScrollToAnchor } from "@/lib/useScrollToAnchor";
import { named, Owner } from "./shared.js";

const ClientHeldSendsPage = named(() => import("@/pages/ClientHeldSendsPage"), "ClientHeldSendsPage");
const TeamShiftsPage = named(() => import("@/pages/team/TeamShiftsPage"), "TeamShiftsPage");
const TeamAuthorsPage = named(() => import("@/pages/team/TeamAuthorsPage"), "TeamAuthorsPage");
const TeamApproachesPage = named(() => import("@/pages/team/TeamApproachesPage"), "TeamApproachesPage");
const TeamNumbersPage = named(() => import("@/pages/team/TeamNumbersPage"), "TeamNumbersPage");
const TeamCustomsPage = named(() => import("@/pages/team/TeamCustomsPage"), "TeamCustomsPage");
const TeamShiftReportsPage = named(() => import("@/pages/team/TeamShiftReportsPage"), "TeamShiftReportsPage");
const TeamSalesPage = named(() => import("@/pages/team/TeamSalesPage"), "TeamSalesPage");
const TeamCoveragePage = named(() => import("@/pages/team/TeamCoveragePage"), "TeamCoveragePage");
const TeamChatterStatsPage = named(() => import("@/pages/team/TeamChatterStatsPage"), "TeamChatterStatsPage");
const TeamTab = named(() => import("@/pages/settings/team/TeamTab"), "TeamTab");

/** Команда → Смены: who worked, and at #authors the messages nobody signed. */
function ShiftsScreen() {
  const location = useLocation();
  const authors = location.hash === "#authors";
  useScrollToAnchor("authors", authors);
  return (
    <div className="space-y-6">
      <TeamShiftsPage />
      <details id="authors" className="help scroll-mt-16" open={authors}>
        <summary>Сообщения без автора</summary>
        <div className="mt-4"><Suspense fallback={<ScreenFallback />}><TeamAuthorsPage /></Suspense></div>
      </details>
    </div>
  );
}

export function teamRoutes() {
  return (
    <>
      {/* Owner and team leads (`session`), except the people. */}
      <Route path="team/shifts" element={<ShiftsScreen />} />
      <Route path="team/coverage" element={<TeamCoveragePage />} />
      <Route path="team/held-sends" element={<ClientHeldSendsPage />} />
      <Route path="team/chatters" element={<TeamNumbersPage />} />
      <Route path="team/chatters/:userId" element={<TeamChatterStatsPage />} />
      <Route path="team/payouts" element={<TeamShiftReportsPage />} />
      <Route path="team/sales" element={<TeamSalesPage />} />
      <Route path="team/win-back" element={<TeamApproachesPage />} />
      <Route path="team/customs" element={<TeamCustomsPage />} />
      <Route element={<Owner />}>
        <Route path="team/people" element={<TeamTab />} />
        <Route path="team/people/:userId" element={<TeamTab />} />
      </Route>
    </>
  );
}
