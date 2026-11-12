/**
 * Group system: Система (design/screens/system.md). Every screen here is the
 * owner's, but one: a team lead reads «Медиа» and «Выгрузки» of the OnlyFans API.
 */
import { Route } from "react-router";
import { named, Owner } from "./shared.js";

const CollectionPage = named(() => import("@/pages/system/collection/CollectionPage"), "CollectionPage");
const CollectionPageDetail = named(() => import("@/pages/system/collection/CollectionPageDetail"), "CollectionPageDetail");
const FailuresPage = named(() => import("@/pages/system/failures/FailuresPage"), "FailuresPage");
const HistoryRequestsPage = named(() => import("@/pages/system/history/HistoryRequestsPage"), "HistoryRequestsPage");
const AgentKeysPage = named(() => import("@/pages/system/agent-keys/AgentKeysPage"), "AgentKeysPage");
const AgentReportsPage = named(() => import("@/pages/system/reports/AgentReportsPage"), "AgentReportsPage");
const AgentReportPage = named(() => import("@/pages/system/reports/AgentReportPage"), "AgentReportPage");
const SystemStatePage = named(() => import("@/pages/system/state/SystemStatePage"), "SystemStatePage");
const PeopleMessagesPage = named(() => import("@/pages/system/people-messages/PeopleMessagesPage"), "PeopleMessagesPage");
const OnlyfansApiScreen = named(() => import("@/pages/system/onlyfans-api/OnlyfansApiScreen"), "OnlyfansApiScreen");
const DevScreen = named(() => import("@/pages/system/dev/DevScreen"), "DevScreen");
const SyncStatusPage = named(() => import("@/pages/system/dev/SyncStatusPage"), "SyncStatusPage");

export function systemRoutes() {
  return (
    <>
      <Route element={<Owner />}>
        <Route path="system/collection" element={<CollectionPage />} />
        <Route path="system/collection/:pageLabel" element={<CollectionPageDetail />} />
        <Route path="system/failures" element={<FailuresPage />} />
        <Route path="system/history-requests" element={<HistoryRequestsPage />} />
        <Route path="system/agent-keys" element={<AgentKeysPage />} />
        <Route path="system/reports" element={<AgentReportsPage />} />
        <Route path="system/reports/:slug" element={<AgentReportPage />} />
        <Route path="system/state" element={<SystemStatePage />} />
        <Route path="system/people-messages" element={<PeopleMessagesPage />} />
        <Route path="system/dev" element={<DevScreen />} />
        <Route path="system/dev/log/:runId" element={<SyncStatusPage />} />
      </Route>
      {/* One screen of sections; a team lead reads «Медиа» and «Выгрузки» there, as before (their writes are the owner's on the server). */}
      <Route path="system/onlyfans-api" element={<OnlyfansApiScreen />} />
    </>
  );
}
