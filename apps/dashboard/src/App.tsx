import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { NotFoundScreen } from "./components/layout/OwnerRoute.js";
import { ChatterLayout } from "./components/layout/ChatterLayout.js";
import { ProtectedLayout } from "./components/layout/ProtectedLayout.js";
import { ScreenFrame } from "./components/layout/ScreenFrame.js";
import { ErrorBoundary } from "./components/shared/ErrorBoundary.js";
import { LEGACY_ROUTES, SETTINGS_INDEX_RULE } from "./lib/redirects.js";
import { Legacy } from "./routes/legacy.js";
import { LiveLegacy, PageCardLegacy } from "./routes/LiveLegacy.js";
import { homeMoneyRoutes, MoneyIndex } from "./routes/screens/home-money.js";
import { settingsRoutes } from "./routes/screens/settings.js";
import { statsRoutes } from "./routes/screens/stats.js";
import { systemRoutes } from "./routes/screens/system.js";
import { trafficRoutes } from "./routes/screens/traffic.js";
import { waitingRoutes } from "./routes/screens/waiting.js";
import { peopleRoutes, TeamPeopleToHub } from "./routes/screens/people.js";
import { applicationsRoutes } from "./routes/screens/applications.js";
import { ToContentops, ToWorkboard } from "./routes/ToWorkboard.js";
import { pageScreensRoutes } from "./routes/screens/fans-page.js";

const LoginPage = lazy(() => import("./pages/LoginPage.js").then((m) => ({ default: m.LoginPage })));
const JoinPage = lazy(() => import("./pages/account/JoinPage.js").then((m) => ({ default: m.JoinPage })));

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
          {/* «Команда» is Workboard now: every old address of it leaves for its screen there
              (lib/workboard.ts), before any frame of the console loads. «Анкеты» stay below. */}
          {/* «Команда → Люди» was the registry: Hub «Люди» now (products plan §4.3), the rest of «Команда» is Workboard's. */}
          <Route path="/team/people/*" element={<TeamPeopleToHub />} />
          <Route path="/team/*" element={<ToWorkboard />} />
          <Route path="/held-sends" element={<ToWorkboard />} />
          {/* «Фаны» and «Рассылки» moved to Workboard (products package M). */}
          <Route path="/fans/*" element={<ToWorkboard />} />
          <Route path="/content/mass-messages" element={<ToWorkboard />} />
          {/* «Публикации» and «Статистика контента» are ContentOps' screens (products package C2): Hub draws them on
              bare pages of their own (frame/*.html), and its old addresses lead to ContentOps. */}
          <Route path="/content/publications" element={<ToContentops />} />
          <Route path="/stats/content" element={<ToContentops />} />
          {/* «Аккаунт и устройства» is Workboard's screen: the old address leads there (or a chatter's old tab to «Мои смены»). */}
          <Route path="/account" element={<ChatterLayout />} />
          <Route element={<ProtectedLayout />}>
            <Route element={<LiveLegacy />}>
              <Route element={<ScreenFrame />}>
                {/* Each group's routes live in its own file: routes/screens/<group>.tsx. */}
                {homeMoneyRoutes()}
                {waitingRoutes()}
                {pageScreensRoutes()}
                {statsRoutes()}
                {trafficRoutes()}
                {applicationsRoutes()}
                {peopleRoutes()}
                {settingsRoutes()}
                {systemRoutes()}
              </Route>
            </Route>

            {/* Every old address lands on its new place, with its parameters. */}
            {/* `/money` follows its row too, but a team lead lands on «Операции» (R0б). */}
            {LEGACY_ROUTES.map((rule) => (
              <Route
                key={rule.path}
                path={rule.path}
                element={rule.path === "money" ? <MoneyIndex rule={rule} /> : rule.path === "pages/:pageLabel" ? <PageCardLegacy rule={rule} /> : <Legacy rule={rule} />}
              />
            ))}
            <Route path="settings" element={<Legacy rule={SETTINGS_INDEX_RULE} />} />

            <Route path="*" element={<NotFoundScreen />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
