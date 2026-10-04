import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router";
import { OwnerRoute } from "./components/layout/OwnerRoute.js";
import { ChatterLayout } from "./components/layout/ChatterLayout.js";
import { ProtectedLayout } from "./components/layout/ProtectedLayout.js";
import { ErrorBoundary } from "./components/shared/ErrorBoundary.js";

const LoginPage = lazy(() => import("./pages/LoginPage.js").then((m) => ({ default: m.LoginPage })));
const JoinPage = lazy(() => import("./pages/account/JoinPage.js").then((m) => ({ default: m.JoinPage })));
const AccountPage = lazy(() => import("./pages/account/AccountPage.js").then((m) => ({ default: m.AccountPage })));
const OverviewPage = lazy(() => import("./pages/OverviewPage.js").then((m) => ({ default: m.OverviewPage })));
const TransactionsPage = lazy(() => import("./pages/TransactionsPage.js").then((m) => ({ default: m.TransactionsPage })));
const PageDetailPage = lazy(() => import("./pages/PageDetailPage.js").then((m) => ({ default: m.PageDetailPage })));
const SpenderAutoListPage = lazy(() => import("./pages/SpenderAutoListPage.js").then((m) => ({ default: m.SpenderAutoListPage })));
const DeletedFansPage = lazy(() => import("./pages/DeletedFansPage.js").then((m) => ({ default: m.DeletedFansPage })));
const SubscribersPage = lazy(() => import("./pages/SubscribersPage.js").then((m) => ({ default: m.SubscribersPage })));
const FollowersPage = lazy(() => import("./pages/FollowersPage.js").then((m) => ({ default: m.FollowersPage })));
const FanProfilePage = lazy(() => import("./pages/FanProfilePage.js").then((m) => ({ default: m.FanProfilePage })));
const TopSupportersPage = lazy(() => import("./pages/TopSupportersPage.js").then((m) => ({ default: m.TopSupportersPage })));
const UsagePage = lazy(() => import("./pages/UsagePage.js").then((m) => ({ default: m.UsagePage })));
const OfapiMediaPage = lazy(() => import("./pages/OfapiMediaPage.js").then((m) => ({ default: m.OfapiMediaPage })));
const OfapiMarketing = lazy(() => import("./pages/OfapiMarketing.js").then((m) => ({ default: m.OfapiMarketing })));
const OfapiActions = lazy(() => import("./pages/OfapiActions.js").then((m) => ({ default: m.OfapiActions })));
const OfapiExportsPage = lazy(() => import("./pages/OfapiExportsPage.js").then((m) => ({ default: m.OfapiExportsPage })));
const OfapiCreditsPage = lazy(() => import("./pages/OfapiCreditsPage.js").then((m) => ({ default: m.OfapiCreditsPage })));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage.js").then((m) => ({ default: m.AnalyticsPage })));
const AgentHydrationPage = lazy(() => import("./pages/AgentHydrationPage.js").then((m) => ({ default: m.AgentHydrationPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage.js").then((m) => ({ default: m.SettingsPage })));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage.js").then((m) => ({ default: m.NotificationsPage })));
const LogPage = lazy(() => import("./pages/dev/LogPage.js").then((m) => ({ default: m.LogPage })));
const QueuePage = lazy(() => import("./pages/dev/QueuePage.js").then((m) => ({ default: m.QueuePage })));
const DbStatsPage = lazy(() => import("./pages/dev/DbStatsPage.js").then((m) => ({ default: m.DbStatsPage })));
const IncidentsPage = lazy(() => import("./pages/dev/IncidentsPage.js").then((m) => ({ default: m.IncidentsPage })));
const SyncStatusPage = lazy(() => import("./pages/dev/SyncStatusPage.js").then((m) => ({ default: m.SyncStatusPage })));
const ClientHealthPage = lazy(() => import("./pages/dev/ClientHealthPage.js").then((m) => ({ default: m.ClientHealthPage })));

function LazyFallback() {
  return <div role="status" className="flex items-center justify-center h-full py-20 text-text-muted">Загружаем страницу…</div>;
}

export function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LazyFallback />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          {/* Decision 351: /join has no session yet — it is the page that
              creates the credential — so it sits outside ProtectedLayout. */}
          <Route path="/join" element={<JoinPage />} />
          <Route element={<ChatterLayout />}>
            <Route path="/account" element={<AccountPage />} />
          </Route>
          <Route element={<ProtectedLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="transactions" element={<TransactionsPage />} />
            <Route path="pages/:pageLabel" element={<PageDetailPage />} />
            <Route path="pages/:pageLabel/spender-autolists/:bucketKey" element={<SpenderAutoListPage />} />
            <Route path="pages/:pageLabel/deleted-fans" element={<DeletedFansPage />} />
            <Route path="pages/:pageLabel/subscribers" element={<SubscribersPage />} />
            <Route path="pages/:pageLabel/followers" element={<FollowersPage />} />
            <Route path="pages/:pageLabel/top-supporters" element={<TopSupportersPage />} />
            <Route path="pages/:pageLabel/fans/:platform/:platformUserId" element={<FanProfilePage />} />
            <Route path="usage" element={<OwnerRoute><UsagePage /></OwnerRoute>} />
            <Route path="ofapi-media" element={<OfapiMediaPage />} />
            <Route path="ofapi-marketing" element={<OwnerRoute><OfapiMarketing /></OwnerRoute>} />
            <Route path="ofapi-actions" element={<OwnerRoute><OfapiActions /></OwnerRoute>} />
            <Route path="ofapi-exports" element={<OfapiExportsPage />} />
            <Route path="ofapi-credits" element={<OwnerRoute><OfapiCreditsPage /></OwnerRoute>} />
            {/* WP-S1. Owner-only, matching the routes behind it: every serving
                endpoint this page calls declares `owner-session` + page scope. */}
            <Route path="analytics" element={<OwnerRoute><AnalyticsPage /></OwnerRoute>} />
            <Route path="notifications" element={<OwnerRoute><NotificationsPage /></OwnerRoute>} />
            <Route path="agent-hydration" element={<OwnerRoute><AgentHydrationPage /></OwnerRoute>} />
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
            <Route path="dev/client-health" element={<OwnerRoute><ClientHealthPage /></OwnerRoute>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
