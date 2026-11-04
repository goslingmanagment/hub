import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { NotFoundScreen } from "./components/layout/OwnerRoute.js";
import { ChatterLayout } from "./components/layout/ChatterLayout.js";
import { ProtectedLayout } from "./components/layout/ProtectedLayout.js";
import { ScreenFrame } from "./components/layout/ScreenFrame.js";
import { ErrorBoundary } from "./components/shared/ErrorBoundary.js";
import { LEGACY_ROUTES, SETTINGS_INDEX_RULE } from "./lib/redirects.js";
import { Legacy } from "./routes/legacy.js";
import { LiveLegacy } from "./routes/LiveLegacy.js";
import { fansRoutes, pageCardRoutes } from "./routes/screens/fans-page.js";
import { homeMoneyRoutes } from "./routes/screens/home-money.js";
import { publicationsRoutes } from "./routes/screens/publications.js";
import { settingsRoutes } from "./routes/screens/settings.js";
import { statsRoutes } from "./routes/screens/stats.js";
import { systemRoutes } from "./routes/screens/system.js";
import { teamRoutes } from "./routes/screens/team.js";

const LoginPage = lazy(() => import("./pages/LoginPage.js").then((m) => ({ default: m.LoginPage })));
const JoinPage = lazy(() => import("./pages/account/JoinPage.js").then((m) => ({ default: m.JoinPage })));
const AccountPage = lazy(() => import("./pages/account/AccountPage.js").then((m) => ({ default: m.AccountPage })));

function LazyFallback() {
  return <div role="status" className="flex items-center justify-center h-full py-20 text-text-muted">Загружаем экран…</div>;
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
                {/* Each group's routes live in its own file: routes/screens/<group>.tsx. */}
                {homeMoneyRoutes()}
                {fansRoutes()}
                {statsRoutes()}
                {publicationsRoutes()}
                {teamRoutes()}
                {settingsRoutes()}
                {systemRoutes()}
              </Route>
              {pageCardRoutes()}
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
