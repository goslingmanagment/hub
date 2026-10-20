import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router";
import { OwnerRoute } from "./components/layout/OwnerRoute.js";
import { ChatterLayout } from "./components/layout/ChatterLayout.js";
import { ProtectedLayout } from "./components/layout/ProtectedLayout.js";
import { ErrorBoundary } from "./components/shared/ErrorBoundary.js";
import { SystemRoutesLayout, TabbedSectionLayout } from "./components/layout/SectionLayouts.js";
import { PageLayout } from "./components/layout/PageLayout.js";

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
const ClientHeldSendsPage = lazy(() => import("./pages/ClientHeldSendsPage.js").then((m) => ({ default: m.ClientHeldSendsPage })));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage.js").then((m) => ({ default: m.AnalyticsPage })));
const AgentHydrationPage = lazy(() => import("./pages/AgentHydrationPage.js").then((m) => ({ default: m.AgentHydrationPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage.js").then((m) => ({ default: m.SettingsPage })));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage.js").then((m) => ({ default: m.NotificationsPage })));
const IncidentsPage = lazy(() => import("./pages/notifications/NotificationsIncidentsTab.js").then((m) => ({ default: m.NotificationsIncidentsTab })));
const LogPage = lazy(() => import("./pages/dev/LogPage.js").then((m) => ({ default: m.LogPage })));
const QueuePage = lazy(() => import("./pages/dev/QueuePage.js").then((m) => ({ default: m.QueuePage })));
const DbStatsPage = lazy(() => import("./pages/dev/DbStatsPage.js").then((m) => ({ default: m.DbStatsPage })));
const SyncAnomaliesPage = lazy(() => import("./pages/dev/IncidentsPage.js").then((m) => ({ default: m.IncidentsPage })));
const SyncStatusPage = lazy(() => import("./pages/dev/SyncStatusPage.js").then((m) => ({ default: m.SyncStatusPage })));
const ClientHealthPage = lazy(() => import("./pages/dev/ClientHealthPage.js").then((m) => ({ default: m.ClientHealthPage })));
const PageBrowserLoginPage = lazy(() => import("./pages/page-browser/PageBrowserLoginPage.js").then((m) => ({ default: m.PageBrowserLoginPage })));
const PageBrowserOnboardingPage = lazy(() => import("./pages/page-browser/PageBrowserOnboardingPage.js").then((m) => ({ default: m.PageBrowserOnboardingPage })));
const PageBrowserDraftPage = lazy(() => import("./pages/page-browser/PageBrowserDraftPage.js").then((m) => ({ default: m.PageBrowserDraftPage })));

function LazyFallback() {
  return <div role="status" className="flex items-center justify-center h-full py-20 text-text-muted">Загружаем страницу…</div>;
}

export function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LazyFallback />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          {/* /join has no session yet — it is the page that
              creates the credential — so it sits outside ProtectedLayout. */}
          <Route path="/join" element={<JoinPage />} />
          <Route element={<ChatterLayout />}>
            <Route path="/account" element={<AccountPage />} />
          </Route>
          <Route element={<ProtectedLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="transactions" element={<TransactionsPage />} />
            {/* A page's views are tabs under one header (PageLayout). */}
            <Route path="pages/:pageLabel" element={<PageLayout />}>
              <Route index element={<PageDetailPage />} />
              <Route path="subscribers" element={<SubscribersPage />} />
              <Route path="followers" element={<FollowersPage />} />
              <Route path="top-supporters" element={<TopSupportersPage />} />
              <Route path="deleted-fans" element={<DeletedFansPage />} />
            </Route>
            <Route path="pages/:pageLabel/spender-autolists/:bucketKey" element={<SpenderAutoListPage />} />
            <Route path="pages/:pageLabel/fans/:platform/:platformUserId" element={<FanProfilePage />} />
            {/* Project Browser PR 15: the owner logs a page's server browser in. */}
            <Route path="pages/:pageLabel/browser-login" element={<OwnerRoute><PageBrowserLoginPage /></OwnerRoute>} />
            {/* Project Browser PR 16: a new page connected through its own browser. */}
            {/* Owner decision 2026-10-15: a page's browser starts here — its proxy pasted and checked, its environment confirmed. */}
            <Route path="browser-profiles/new" element={<OwnerRoute><PageBrowserDraftPage /></OwnerRoute>} />
            <Route path="browser-profiles/:profileId" element={<OwnerRoute><PageBrowserOnboardingPage /></OwnerRoute>} />
            {/* One section per job: OnlyFans tools, costs, and the queues that wait
                for a person. Each screen keeps its own URL; the section adds the
                title and the tabs. */}
            <Route element={<TabbedSectionLayout id="onlyfans" />}>
              <Route path="ofapi-marketing" element={<OwnerRoute><OfapiMarketing /></OwnerRoute>} />
              <Route path="ofapi-media" element={<OfapiMediaPage />} />
              <Route path="ofapi-exports" element={<OfapiExportsPage />} />
              <Route path="ofapi-actions" element={<OwnerRoute><OfapiActions /></OwnerRoute>} />
            </Route>
            <Route element={<OwnerRoute><TabbedSectionLayout id="costs" /></OwnerRoute>}>
              <Route path="ofapi-credits" element={<OfapiCreditsPage />} />
              <Route path="usage" element={<UsagePage />} />
            </Route>
            <Route element={<TabbedSectionLayout id="attention" />}>
              {/* chat-extension H-7e. The owner and team leads, like the two routes
                  behind it (`session`); a chatter never reaches this layout. */}
              <Route path="held-sends" element={<ClientHeldSendsPage />} />
              <Route path="agent-hydration" element={<OwnerRoute><AgentHydrationPage /></OwnerRoute>} />
              <Route path="incidents" element={<OwnerRoute><IncidentsPage /></OwnerRoute>} />
            </Route>
            {/* WP-S1. Owner-only, matching the routes behind it: every serving
                endpoint this page calls declares `owner-session` + page scope. */}
            <Route path="analytics" element={<OwnerRoute><AnalyticsPage /></OwnerRoute>} />
            <Route path="notifications" element={<OwnerRoute><NotificationsPage /></OwnerRoute>} />
            <Route
              path="settings"
              element={(
                <OwnerRoute>
                  <SettingsPage />
                </OwnerRoute>
              )}
            />
            <Route element={<OwnerRoute><SystemRoutesLayout /></OwnerRoute>}>
              <Route path="dev/log" element={<LogPage />} />
              <Route path="dev/queue" element={<QueuePage />} />
              <Route path="dev/db-stats" element={<DbStatsPage />} />
              <Route path="dev/incidents" element={<SyncAnomaliesPage />} />
              <Route path="dev/sync-status" element={<SyncStatusPage />} />
              <Route path="dev/client-health" element={<ClientHealthPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
