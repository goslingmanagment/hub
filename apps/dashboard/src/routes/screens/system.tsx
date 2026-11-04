/**
 * Group system: Система (design/screens/system.md). Every screen here is the
 * owner's, but two: a team lead reads «Медиа» and «Выгрузки» of the OnlyFans API.
 */
import { Route } from "react-router";
import { named, Owner } from "./shared.js";

const CollectionPage = named(() => import("@/pages/system/collection/CollectionPage"), "CollectionPage");
const CollectionPageDetail = named(() => import("@/pages/system/collection/CollectionPageDetail"), "CollectionPageDetail");
const FailuresPage = named(() => import("@/pages/system/failures/FailuresPage"), "FailuresPage");
const HistoryRequestsPage = named(() => import("@/pages/system/history/HistoryRequestsPage"), "HistoryRequestsPage");
const AgentKeysPage = named(() => import("@/pages/system/agent-keys/AgentKeysPage"), "AgentKeysPage");
const StatePage = named(() => import("@/pages/system/onlyfans-api/StatePage"), "StatePage");
const RulesPage = named(() => import("@/pages/system/onlyfans-api/rules/CollectionTab"), "CollectionTab");
const ToolsPage = named(() => import("@/pages/system/onlyfans-api/ToolsPage"), "ToolsPage");
const OfapiMediaPage = named(() => import("@/pages/system/onlyfans-api/OfapiMediaPage"), "OfapiMediaPage");
const OfapiExportsPage = named(() => import("@/pages/system/onlyfans-api/OfapiExportsPage"), "OfapiExportsPage");
const OfapiActions = named(() => import("@/pages/system/onlyfans-api/OfapiActions"), "OfapiActions");
const LogPage = named(() => import("@/pages/system/dev/LogPage"), "LogPage");
const SyncStatusPage = named(() => import("@/pages/system/dev/SyncStatusPage"), "SyncStatusPage");
const QueuePage = named(() => import("@/pages/system/dev/QueuePage"), "QueuePage");
const DbStatsPage = named(() => import("@/pages/system/dev/DbStatsPage"), "DbStatsPage");
const ClientHealthPage = named(() => import("@/pages/system/dev/ClientHealthPage"), "ClientHealthPage");
const ConfigurationTab = named(() => import("@/pages/settings/ConfigurationTab"), "ConfigurationTab");

export function systemRoutes() {
  return (
    <>
      <Route element={<Owner />}>
        <Route path="system/collection" element={<CollectionPage />} />
        <Route path="system/collection/:pageLabel" element={<CollectionPageDetail />} />
        <Route path="system/failures" element={<FailuresPage />} />
        <Route path="system/history-requests" element={<HistoryRequestsPage />} />
        <Route path="system/agent-keys" element={<AgentKeysPage />} />
        <Route path="system/onlyfans-api" element={<StatePage />} />
        <Route path="system/onlyfans-api/collection" element={<RulesPage />} />
        <Route path="system/onlyfans-api/tools" element={<ToolsPage />} />
        <Route path="system/onlyfans-api/actions" element={<OfapiActions />} />
        <Route path="system/dev/log" element={<LogPage />} />
        <Route path="system/dev/log/:runId" element={<SyncStatusPage />} />
        <Route path="system/dev/queue" element={<QueuePage />} />
        <Route path="system/dev/database" element={<DbStatsPage />} />
        <Route path="system/dev/extension" element={<ClientHealthPage />} />
        <Route path="system/dev/config" element={<ConfigurationTab />} />
      </Route>
      {/* A team lead reads these two, as before; their writes are the owner's on the server. */}
      <Route path="system/onlyfans-api/media" element={<OfapiMediaPage />} />
      <Route path="system/onlyfans-api/exports" element={<OfapiExportsPage />} />
    </>
  );
}
