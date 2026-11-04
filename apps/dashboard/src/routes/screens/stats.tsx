/**
 * Group stats: Статистика Fansly (design/screens/stats.md). The routes and what
 * they render until each screen is rebuilt. Every screen here is the owner's.
 */
import { lazy } from "react";
import { Route } from "react-router";
import { named, Owner } from "./shared.js";

const CreatorStatsPage = lazy(() => import("@/pages/CreatorStatsPage").then((module) => ({ default: module.CreatorStatsPage })));
const AnalyticsPage = named(() => import("@/pages/AnalyticsPage"), "AnalyticsPage");

export function statsRoutes() {
  return (
    <Route element={<Owner />}>
      <Route path="stats" element={<CreatorStatsPage tab="overview" />} />
      <Route path="stats/content" element={<CreatorStatsPage tab="content" />} />
      <Route path="stats/audience" element={<CreatorStatsPage tab="audience" />} />
      <Route path="stats/income" element={<AnalyticsPage />} />
    </Route>
  );
}
