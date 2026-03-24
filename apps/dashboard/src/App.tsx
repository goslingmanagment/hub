import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router";
import { OwnerRoute } from "./components/layout/OwnerRoute";
import { ProtectedLayout } from "./components/layout/ProtectedLayout";

const LoginPage = lazy(() => import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })));
const OverviewPage = lazy(() => import("./pages/OverviewPage").then((m) => ({ default: m.OverviewPage })));
const PageDetailPage = lazy(() => import("./pages/PageDetailPage").then((m) => ({ default: m.PageDetailPage })));
const SubscribersPage = lazy(() => import("./pages/SubscribersPage").then((m) => ({ default: m.SubscribersPage })));
const FollowersPage = lazy(() => import("./pages/FollowersPage").then((m) => ({ default: m.FollowersPage })));
const FanProfilePage = lazy(() => import("./pages/FanProfilePage").then((m) => ({ default: m.FanProfilePage })));
const TopSupportersPage = lazy(() => import("./pages/TopSupportersPage").then((m) => ({ default: m.TopSupportersPage })));
const CrmPage = lazy(() => import("./pages/CrmPage").then((m) => ({ default: m.CrmPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage").then((m) => ({ default: m.NotificationsPage })));
const LogPage = lazy(() => import("./pages/dev/LogPage").then((m) => ({ default: m.LogPage })));
const QueuePage = lazy(() => import("./pages/dev/QueuePage").then((m) => ({ default: m.QueuePage })));
const DbStatsPage = lazy(() => import("./pages/dev/DbStatsPage").then((m) => ({ default: m.DbStatsPage })));
const IncidentsPage = lazy(() => import("./pages/dev/IncidentsPage").then((m) => ({ default: m.IncidentsPage })));

function LazyFallback() {
  return <div className="flex items-center justify-center h-full py-20 text-zinc-500">Loading…</div>;
}

export function App() {
  return (
    <Suspense fallback={<LazyFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="pages/:pageLabel" element={<PageDetailPage />} />
          <Route path="pages/:pageLabel/subscribers" element={<SubscribersPage />} />
          <Route path="pages/:pageLabel/followers" element={<FollowersPage />} />
          <Route path="pages/:pageLabel/top-supporters" element={<TopSupportersPage />} />
          <Route path="pages/:pageLabel/crm" element={<CrmPage />} />
          <Route path="pages/:pageLabel/fans/:platform/:platformUserId" element={<FanProfilePage />} />
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
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
