import { lazy, Suspense } from "react";
import { Outlet, Route, Routes } from "react-router";
import { NotFoundScreen, OwnerRoute } from "./components/layout/OwnerRoute.js";
import { ChatterLayout } from "./components/layout/ChatterLayout.js";
import { PageCardLayout } from "./components/layout/PageCardLayout.js";
import { ProtectedLayout } from "./components/layout/ProtectedLayout.js";
import { ScreenFrame } from "./components/layout/ScreenFrame.js";
import { ErrorBoundary } from "./components/shared/ErrorBoundary.js";
import { LEGACY_ROUTES, SETTINGS_INDEX_RULE } from "./lib/redirects.js";
import { Legacy } from "./routes/legacy.js";
import { LiveLegacy } from "./routes/LiveLegacy.js";
import * as Screens from "./routes/screens.js";

const LoginPage = lazy(() => import("./pages/LoginPage.js").then((m) => ({ default: m.LoginPage })));
const JoinPage = lazy(() => import("./pages/account/JoinPage.js").then((m) => ({ default: m.JoinPage })));
const AccountPage = lazy(() => import("./pages/account/AccountPage.js").then((m) => ({ default: m.AccountPage })));
const CreatorStatsPage = lazy(() => import("./pages/CreatorStatsPage.js").then((m) => ({ default: m.CreatorStatsPage })));
const PageSummaryScreen = lazy(() => import("./routes/pageCard.js").then((m) => ({ default: m.PageSummaryScreen })));
const PageAccountScreen = lazy(() => import("./routes/pageCard.js").then((m) => ({ default: m.PageAccountScreen })));
const PagePromoScreen = lazy(() => import("./routes/pageCard.js").then((m) => ({ default: m.PagePromoScreen })));
const PageMassMessagesPage = lazy(() => import("./pages/PageMassMessagesPage.js").then((m) => ({ default: m.PageMassMessagesPage })));
const PageBrowserLoginPage = lazy(() => import("./pages/page-browser/PageBrowserLoginPage.js").then((m) => ({ default: m.PageBrowserLoginPage })));

function LazyFallback() {
  return <div role="status" className="flex items-center justify-center h-full py-20 text-text-muted">Загружаем экран…</div>;
}

/** Every screen behind it is the owner's: hidden in the menu (lib/sections.ts) and
 *  refused here, both. The server's own check stays the real protection. */
function Owner() {
  return <OwnerRoute><Outlet /></OwnerRoute>;
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
            <Route element={<LiveLegacy />}>
              <Route element={<ScreenFrame />}>
                <Route index element={<Screens.OverviewPage />} />

                <Route path="money/transactions" element={<Screens.TransactionsPage />} />
                <Route element={<Owner />}>
                  <Route path="money/costs/ai" element={<Screens.AiCostsScreen />} />
                  <Route path="money/costs/anthropic" element={<Screens.AnthropicReconciliationScreen />} />
                  <Route path="money/costs/onlyfans-api" element={<Screens.OnlyFansApiCostsScreen />} />
                </Route>

                <Route path="fans" element={<Screens.PayingFansScreen />} />
                <Route path="fans/subscribers" element={<Screens.SubscribersScreen />} />
                <Route path="fans/followers" element={<Screens.FollowersScreen />} />
                <Route path="fans/gone" element={<Screens.GoneFansScreen />} />
                <Route path="fans/by-spend" element={<Screens.BySpendScreen />} />
                <Route path="fans/by-spend/:bucketKey" element={<Screens.BySpendListScreen />} />
                <Route path="fans/:pageLabel/:platform/:platformUserId" element={<Screens.FanProfilePage />} />
                <Route path="fans/:platform/:platformUserId" element={<Screens.FanAnyPageScreen />} />

                <Route element={<Owner />}>
                  <Route path="stats" element={<CreatorStatsPage tab="overview" />} />
                  <Route path="stats/content" element={<CreatorStatsPage tab="content" />} />
                  <Route path="stats/audience" element={<CreatorStatsPage tab="audience" />} />
                  <Route path="stats/income" element={<Screens.AnalyticsPage />} />
                  <Route path="publications" element={<Screens.PublicationsScreen />} />
                </Route>

                {/* Owner and team leads (`session`), except the people. */}
                <Route path="team/shifts" element={<Screens.ShiftsScreen />} />
                <Route path="team/coverage" element={<Screens.TeamCoveragePage />} />
                <Route path="team/held-sends" element={<Screens.ClientHeldSendsPage />} />
                <Route path="team/chatters" element={<Screens.TeamNumbersPage />} />
                <Route path="team/chatters/:userId" element={<Screens.TeamChatterStatsPage />} />
                <Route path="team/payouts" element={<Screens.TeamShiftReportsPage />} />
                <Route path="team/sales" element={<Screens.TeamSalesPage />} />
                <Route path="team/win-back" element={<Screens.TeamApproachesPage />} />
                <Route path="team/customs" element={<Screens.TeamCustomsPage />} />
                <Route element={<Owner />}>
                  <Route path="team/people" element={<Screens.TeamTab />} />
                  <Route path="team/people/:userId" element={<Screens.TeamTab />} />
                </Route>

                <Route element={<Owner />}>
                  <Route path="settings/pages" element={<Screens.PagesTab />} />
                  <Route path="settings/pages/connect" element={<Screens.PageBrowserDraftPage />} />
                  <Route path="settings/pages/connect/:profileId" element={<Screens.PageBrowserOnboardingPage />} />
                  <Route path="settings/ai/personas" element={<Screens.AiPersonasTab />} />
                  <Route path="settings/ai/personas/:key" element={<Screens.PersonaScreen />} />
                  <Route path="settings/ai/features" element={<Screens.FeaturesTab />} />
                  <Route path="settings/ai/features/:featureId" element={<Screens.FeatureScreen />} />
                  <Route path="settings/ai/limits" element={<Screens.AiLimitsScreen />} />
                  <Route path="settings/notifications" element={<Screens.NotificationsSettingsSection />} />

                  <Route path="system/collection" element={<Screens.CollectionScreen />} />
                  <Route path="system/collection/:pageLabel" element={<Screens.CollectionPageScreen />} />
                  <Route path="system/failures" element={<Screens.FailuresPage />} />
                  <Route path="system/history-requests" element={<Screens.AgentHydrationPage />} />
                  <Route path="system/agent-keys" element={<Screens.TechnicalTab />} />
                  <Route path="system/onlyfans-api" element={<Screens.OnlyFansApiStatusScreen />} />
                  <Route path="system/onlyfans-api/collection" element={<Screens.CollectionTab />} />
                  <Route path="system/onlyfans-api/tools" element={<Screens.OfapiApiTab />} />
                  <Route path="system/onlyfans-api/actions" element={<Screens.OfapiActions />} />
                  <Route path="system/dev/log" element={<Screens.DevLogScreen />} />
                  <Route path="system/dev/log/:runId" element={<Screens.SyncStatusPage />} />
                  <Route path="system/dev/queue" element={<Screens.QueuePage />} />
                  <Route path="system/dev/database" element={<Screens.DbStatsPage />} />
                  <Route path="system/dev/extension" element={<Screens.ClientHealthPage />} />
                  <Route path="system/dev/config" element={<Screens.ConfigurationTab />} />
                </Route>
                {/* A team lead reads these two, as before; their writes are the owner's on the server. */}
                <Route path="system/onlyfans-api/media" element={<Screens.OfapiMediaPage />} />
                <Route path="system/onlyfans-api/exports" element={<Screens.OfapiExportsPage />} />
              </Route>

              {/* A page's own card: an object, not a branch of the menu. */}
              <Route path="pages/:pageLabel" element={<PageCardLayout />}>
                <Route index element={<PageSummaryScreen />} />
                <Route element={<Owner />}>
                  <Route path="account" element={<PageAccountScreen />} />
                  <Route path="promo" element={<PagePromoScreen />} />
                  <Route path="mass-messages" element={<PageMassMessagesPage />} />
                  <Route path="browser-login" element={<PageBrowserLoginPage />} />
                </Route>
              </Route>
            </Route>

            {/* Every old address lands on its new place, with its parameters. */}
            {LEGACY_ROUTES.map((rule) => <Route key={rule.path} path={rule.path} element={<Legacy rule={rule} />} />)}
            <Route path="settings" element={<Legacy rule={SETTINGS_INDEX_RULE} />} />

            <Route path="*" element={<NotFoundScreen />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
