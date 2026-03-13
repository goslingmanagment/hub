import { Routes, Route, Navigate } from "react-router";
import { OwnerRoute } from "./components/layout/OwnerRoute";
import { ProtectedLayout } from "./components/layout/ProtectedLayout";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PageDetailPage } from "./pages/PageDetailPage";
import { SubscribersPage } from "./pages/SubscribersPage";
import { FollowersPage } from "./pages/FollowersPage";
import { FanProfilePage } from "./pages/FanProfilePage";
import { SettingsPage } from "./pages/SettingsPage";
import { LogPage } from "./pages/dev/LogPage";
import { SyncStatusPage } from "./pages/dev/SyncStatusPage";
import { QueuePage } from "./pages/dev/QueuePage";
import { DbStatsPage } from "./pages/dev/DbStatsPage";
import { IncidentsPage } from "./pages/dev/IncidentsPage";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="pages/:pageLabel" element={<PageDetailPage />} />
        <Route path="pages/:pageLabel/subscribers" element={<SubscribersPage />} />
        <Route path="pages/:pageLabel/followers" element={<FollowersPage />} />
        <Route path="pages/:pageLabel/fans/:platform/:platformUserId" element={<FanProfilePage />} />
        <Route
          path="settings"
          element={(
            <OwnerRoute>
              <SettingsPage />
            </OwnerRoute>
          )}
        />
        <Route path="dev/log" element={<OwnerRoute><LogPage /></OwnerRoute>} />
        <Route path="dev/sync-status" element={<OwnerRoute><SyncStatusPage /></OwnerRoute>} />
        <Route path="dev/queue" element={<OwnerRoute><QueuePage /></OwnerRoute>} />
        <Route path="dev/db-stats" element={<OwnerRoute><DbStatsPage /></OwnerRoute>} />
        <Route path="dev/incidents" element={<OwnerRoute><IncidentsPage /></OwnerRoute>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
