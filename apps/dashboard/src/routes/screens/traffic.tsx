/**
 * Group traffic: Трафик. Its first screen is «Источники», the OnlyFans links
 * by source day by day over two weeks, and the pages of one source and of one link under it; then «Сводка», the traffic routine's
 * daily summary published as an agent's report page (ecosystem plan, package
 * O); then «Продвижение» of one page (a tab of the page's card until 12.11).
 * The owner's only.
 */
import { Route } from "react-router";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { useRoutePageLabel } from "@/components/layout/usePageFilter";
import { named, OnePage, Owner } from "./shared.js";

const TrafficSourcesPage = named(() => import("@/pages/traffic/TrafficSourcesPage"), "TrafficSourcesPage");
const TrafficLinkPage = named(() => import("@/pages/traffic/TrafficLinkPage"), "TrafficLinkPage");
const TrafficSourcePage = named(() => import("@/pages/traffic/TrafficSourcePage"), "TrafficSourcePage");
const TrafficSummaryPage = named(() => import("@/pages/traffic/TrafficSummaryPage"), "TrafficSummaryPage");
const PromoFansly = named(() => import("@/pages/page-card/PromoFansly"), "PromoFansly");
const PromoOnlyFans = named(() => import("@/pages/page-card/PromoOnlyFans"), "PromoOnlyFans");

/** Fansly's own promo, or the OnlyFans links as of 1 November. */
function PromoScreen() {
  const page = useDashboardShell().findPageByLabel(useRoutePageLabel());
  if (!page) return null;
  return page.platform === "onlyfans" ? <PromoOnlyFans /> : <PromoFansly />;
}

export function trafficRoutes() {
  return (
    <Route element={<Owner />}>
      <Route path="traffic/sources" element={<TrafficSourcesPage />} />
      <Route path="traffic/link/:pageId/:kind/:ref" element={<TrafficLinkPage />} />
      <Route path="traffic/source/:key" element={<TrafficSourcePage />} />
      <Route path="traffic" element={<TrafficSummaryPage />} />
      <Route path="traffic/promo" element={<OnePage><PromoScreen /></OnePage>} />
    </Route>
  );
}
