/**
 * Group traffic: Трафик. Its first screen is «Сводка», the traffic routine's
 * daily summary published as an agent's report page (ecosystem plan, package
 * O). The owner's only.
 */
import { Route } from "react-router";
import { named, Owner } from "./shared.js";

const TrafficSummaryPage = named(() => import("@/pages/traffic/TrafficSummaryPage"), "TrafficSummaryPage");

export function trafficRoutes() {
  return (
    <Route element={<Owner />}>
      <Route path="traffic" element={<TrafficSummaryPage />} />
    </Route>
  );
}
