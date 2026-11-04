/**
 * Group stats: Статистика Fansly (design/screens/stats.md). Four tabs, every one
 * the owner's, every one only reads: Главное, Контент, Аудитория, Доход Fansly.
 * The old addresses (`?tab=`, `?days=`, `/analytics`) are led here by the legacy rules.
 */
import { Route } from "react-router";
import { named, Owner } from "./shared.js";

const StatsMainPage = named(() => import("@/pages/stats/StatsMainPage"), "StatsMainPage");
const StatsContentPage = named(() => import("@/pages/stats/StatsContentPage"), "StatsContentPage");
const StatsAudiencePage = named(() => import("@/pages/stats/StatsAudiencePage"), "StatsAudiencePage");
const StatsIncomePage = named(() => import("@/pages/stats/StatsIncomePage"), "StatsIncomePage");

export function statsRoutes() {
  return (
    <Route element={<Owner />}>
      <Route path="stats" element={<StatsMainPage />} />
      <Route path="stats/content" element={<StatsContentPage />} />
      <Route path="stats/audience" element={<StatsAudiencePage />} />
      <Route path="stats/income" element={<StatsIncomePage />} />
    </Route>
  );
}
