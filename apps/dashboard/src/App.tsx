import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useParams } from "react-router";
import { OwnerRoute } from "./components/layout/OwnerRoute.js";
import { ProtectedLayout } from "./components/layout/ProtectedLayout.js";
import { ErrorBoundary } from "./components/shared/ErrorBoundary.js";
import { resolveLegacyWorkboardRedirect } from "./lib/navigation.js";

const LoginPage = lazy(() => import("./pages/LoginPage.js").then((m) => ({ default: m.LoginPage })));
const OverviewPage = lazy(() => import("./pages/OverviewPage.js").then((m) => ({ default: m.OverviewPage })));
const PageDetailPage = lazy(() => import("./pages/PageDetailPage.js").then((m) => ({ default: m.PageDetailPage })));
const SpenderAutoListPage = lazy(() => import("./pages/SpenderAutoListPage.js").then((m) => ({ default: m.SpenderAutoListPage })));
const DeletedFansPage = lazy(() => import("./pages/DeletedFansPage.js").then((m) => ({ default: m.DeletedFansPage })));
const SubscribersPage = lazy(() => import("./pages/SubscribersPage.js").then((m) => ({ default: m.SubscribersPage })));
const FollowersPage = lazy(() => import("./pages/FollowersPage.js").then((m) => ({ default: m.FollowersPage })));
const FanProfilePage = lazy(() => import("./pages/FanProfilePage.js").then((m) => ({ default: m.FanProfilePage })));
const TopSupportersPage = lazy(() => import("./pages/TopSupportersPage.js").then((m) => ({ default: m.TopSupportersPage })));
const WorkboardPage = lazy(() => import("./pages/WorkboardPage.js").then((m) => ({ default: m.WorkboardPage })));
const WorkboardV2Page = lazy(() => import("./pages/WorkboardV2Page.js").then((m) => ({ default: m.WorkboardV2Page })));
const WorkboardV3Page = lazy(() => import("./pages/WorkboardV3Page.js").then((m) => ({ default: m.WorkboardV3Page })));
const UsagePage = lazy(() => import("./pages/UsagePage.js").then((m) => ({ default: m.UsagePage })));
const AiAnalyticsPage = lazy(() => import("./pages/AiAnalyticsPage.js").then((m) => ({ default: m.AiAnalyticsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage.js").then((m) => ({ default: m.SettingsPage })));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage.js").then((m) => ({ default: m.NotificationsPage })));
const LogPage = lazy(() => import("./pages/dev/LogPage.js").then((m) => ({ default: m.LogPage })));
const QueuePage = lazy(() => import("./pages/dev/QueuePage.js").then((m) => ({ default: m.QueuePage })));
const DbStatsPage = lazy(() => import("./pages/dev/DbStatsPage.js").then((m) => ({ default: m.DbStatsPage })));
const IncidentsPage = lazy(() => import("./pages/dev/IncidentsPage.js").then((m) => ({ default: m.IncidentsPage })));
const SyncStatusPage = lazy(() => import("./pages/dev/SyncStatusPage.js").then((m) => ({ default: m.SyncStatusPage })));

function LazyFallback() {
  return <div className="flex items-center justify-center h-full py-20 text-zinc-500">Loading…</div>;
}

function LegacyWorkboardRedirect() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  return <Navigate to={resolveLegacyWorkboardRedirect(pageLabel)} replace />;
}

export function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LazyFallback />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="pages/:pageLabel" element={<PageDetailPage />} />
            <Route path="pages/:pageLabel/spender-autolists/:bucketKey" element={<SpenderAutoListPage />} />
            <Route path="pages/:pageLabel/deleted-fans" element={<DeletedFansPage />} />
            <Route path="pages/:pageLabel/subscribers" element={<SubscribersPage />} />
            <Route path="pages/:pageLabel/followers" element={<FollowersPage />} />
            <Route path="pages/:pageLabel/top-supporters" element={<TopSupportersPage />} />
            <Route path="pages/:pageLabel/workboard" element={<WorkboardPage />} />
            <Route path="pages/:pageLabel/workboard/v2" element={<WorkboardV2Page />} />
            <Route path="pages/:pageLabel/workboard/v3" element={<WorkboardV3Page />} />
            <Route path="pages/:pageLabel/crm" element={<LegacyWorkboardRedirect />} />
            <Route path="pages/:pageLabel/fans/:platform/:platformUserId" element={<FanProfilePage />} />
            <Route path="usage" element={<OwnerRoute><UsagePage /></OwnerRoute>} />
            <Route path="ai-analytics" element={<OwnerRoute><AiAnalyticsPage /></OwnerRoute>} />
            <Route path="notifications" element={<OwnerRoute><NotificationsPage /></OwnerRoute>} />
            <Route
              path="settings"
              element={(
                <OwnerRoute>
                  <SettingsPage />
                </OwnerRoute>
              )}
            />
            <Route path="dev/log" element={<OwnerRoute><LogPage /></OwnerRoute>} />
            <Route path="dev/queue" element={<OwnerRoute><QueuePage /></OwnerRoute>} />
            <Route path="dev/db-stats" element={<OwnerRoute><DbStatsPage /></OwnerRoute>} />
            <Route path="dev/incidents" element={<OwnerRoute><IncidentsPage /></OwnerRoute>} />
            <Route path="dev/sync-status" element={<OwnerRoute><SyncStatusPage /></OwnerRoute>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
