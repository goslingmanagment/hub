/**
 * Group system: Система (design/screens/system.md). The routes and what they render
 * until each screen is rebuilt. Every screen here is the owner's, but two.
 */
import { lazy } from "react";
import { Link, Route, useNavigate, useParams, useSearchParams } from "react-router";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { ScreenFallback } from "@/components/layout/ScreenFrame";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { decodeRouteSegment, syncSettingsTab } from "@/lib/navigation";
import { named, OfapiOffNotice, Owner } from "./shared.js";

const AgentHydrationPage = named(() => import("@/pages/system/history/AgentRequestsCard"), "AgentHydrationPage");
const FailuresPage = named(() => import("@/pages/system/failures/FailuresPage"), "NotificationsIncidentsTab");
const LogPage = named(() => import("@/pages/system/dev/LogPage"), "LogPage");
const QueuePage = named(() => import("@/pages/system/dev/QueuePage"), "QueuePage");
const DbStatsPage = named(() => import("@/pages/system/dev/DbStatsPage"), "DbStatsPage");
const SyncAnomaliesPage = named(() => import("@/pages/dev/IncidentsPage"), "IncidentsPage");
const SyncStatusPage = named(() => import("@/pages/system/dev/SyncStatusPage"), "SyncStatusPage");
const ClientHealthPage = named(() => import("@/pages/system/dev/ClientHealthPage"), "ClientHealthPage");
const ConfigurationTab = named(() => import("@/pages/settings/ConfigurationTab"), "ConfigurationTab");
const EngineTab = named(() => import("@/pages/settings/engine/EngineTab"), "EngineTab");
const EnginePageDetail = lazy(() => import("@/pages/settings/engine/EnginePageDetail").then((module) => ({ default: module.EnginePageDetail })));
const SyncTab = named(() => import("@/pages/settings/SyncTab"), "SyncTab");
const TechnicalTab = named(() => import("@/pages/system/agent-keys/AgentKeysPage"), "TechnicalTab");
const CollectionTab = named(() => import("@/pages/settings/CollectionTab"), "CollectionTab");
const OfapiApiTab = named(() => import("@/pages/settings/OfapiApiTab"), "OfapiApiTab");
const WebhookCard = lazy(() => import("@/pages/system/onlyfans-api/rules/CollectionTab").then((module) => ({ default: module.WebhookCard })));
const OfapiMediaPage = named(() => import("@/pages/system/onlyfans-api/OfapiMediaPage"), "OfapiMediaPage");
const OfapiActions = named(() => import("@/pages/system/onlyfans-api/OfapiActions"), "OfapiActions");
const OfapiExportsPage = named(() => import("@/pages/system/onlyfans-api/OfapiExportsPage"), "OfapiExportsPage");

/** «Состояние»: says it plainly and leads to where everything lies. */
function OnlyFansApiStatusScreen() {
  return (
    <div className="space-y-6">
      <OfapiOffNotice>
        Hub больше не собирает через него данные и не тратит кредиты. Переписка, деньги и фаны OnlyFans идут из ленты
        ChatSpace, код остаётся на случай возврата.
      </OfapiOffNotice>
      <WebhookCard />
      <p className="text-sm text-text-secondary">
        Кредиты и журнал операций — в <Link className="link" to="/money/costs/onlyfans-api">Деньги → Расходы → OnlyFans API</Link>.
      </p>
    </div>
  );
}

/** All the pages' collection, until the two old lists become one table. */
function CollectionScreen() {
  return (
    <div className="space-y-8">
      <section className="space-y-4" aria-labelledby="collection-fansly">
        <h2 id="collection-fansly" className="section-title">Fansly</h2>
        <EngineTab />
      </section>
      <section className="space-y-4" aria-labelledby="collection-onlyfans">
        <h2 id="collection-onlyfans" className="section-title">OnlyFans</h2>
        <SyncTab />
      </section>
    </div>
  );
}

/** One page's collection. The page is in the path, so a lever here has no other
 *  target; its key: no open row, dialog or lever survives a change of the page. */
function CollectionPageBody({ pageLabel }: { pageLabel: string }) {
  const { findPageByLabel, pageCatalogState } = useDashboardShell();
  const navigate = useNavigate();
  const page = findPageByLabel(pageLabel);
  if (pageCatalogState === "loading") return <ScreenFallback />;
  const header = <PageHeader title={pageLabel} />;
  if (!page) {
    return (
      <>
        {header}
        <StatusPanel title="Такой страницы нет" action={<Link to="/system/collection" className="btn btn-sm">Ко всем страницам</Link>} />
      </>
    );
  }
  if (syncSettingsTab(page.platform) === "engine") {
    return <>{header}<EnginePageDetail pageLabel={pageLabel} onBack={() => navigate("/system/collection")} /></>;
  }
  return <>{header}<SyncTab /></>;
}

function CollectionPageScreen() {
  const { pageLabel: raw = "" } = useParams<{ pageLabel: string }>();
  const pageLabel = decodeRouteSegment(raw);
  return <CollectionPageBody key={pageLabel} pageLabel={pageLabel} />;
}

/** The old log and its anomalies: one screen, `?problems=1` is only the problems. */
function DevLogScreen() {
  const [search, setSearch] = useSearchParams();
  const problems = search.get("problems") === "1";
  return (
    <div className="space-y-6">
      <Segmented
        label="Что показать"
        value={problems ? "problems" : "all"}
        onChange={(next) => {
          const query = new URLSearchParams(search);
          if (next === "problems") query.set("problems", "1");
          else query.delete("problems");
          setSearch(query);
        }}
        options={[
          { value: "all", label: "Все события" },
          { value: "problems", label: "Только проблемы" },
        ]}
      />
      {problems ? <SyncAnomaliesPage /> : <LogPage />}
    </div>
  );
}

export function systemRoutes() {
  return (
    <>
      <Route element={<Owner />}>
        <Route path="system/collection" element={<CollectionScreen />} />
        <Route path="system/collection/:pageLabel" element={<CollectionPageScreen />} />
        <Route path="system/failures" element={<FailuresPage />} />
        <Route path="system/history-requests" element={<AgentHydrationPage />} />
        <Route path="system/agent-keys" element={<TechnicalTab />} />
        <Route path="system/onlyfans-api" element={<OnlyFansApiStatusScreen />} />
        <Route path="system/onlyfans-api/collection" element={<CollectionTab />} />
        <Route path="system/onlyfans-api/tools" element={<OfapiApiTab />} />
        <Route path="system/onlyfans-api/actions" element={<OfapiActions />} />
        <Route path="system/dev/log" element={<DevLogScreen />} />
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
