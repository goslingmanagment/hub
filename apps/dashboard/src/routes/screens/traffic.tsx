/**
 * Group traffic: Трафик. Its first screen is «Сводка», the traffic routine's
 * daily summary published as an agent's report page (ecosystem plan, package
 * O); then «Продвижение» of one page (a tab of the page's card until 12.11).
 * The owner's only.
 */
import { Route } from "react-router";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { useRoutePageLabel } from "@/components/layout/usePageFilter";
import { named, OnePage, Owner } from "./shared.js";

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
      <Route path="traffic" element={<TrafficSummaryPage />} />
      <Route path="traffic/promo" element={<OnePage><PromoScreen /></OnePage>} />
    </Route>
  );
}
