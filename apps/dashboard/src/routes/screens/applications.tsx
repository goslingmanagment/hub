/**
 * Group applications: «Анкеты», the site's model questionnaires. They stayed in
 * the console when «Команда» moved to Workboard (hiring models is not the team's
 * control); their addresses stayed too. Every other `/team/*` address leaves for
 * Workboard (routes/ToWorkboard.tsx).
 */
import { Route } from "react-router";
import { named, Owner } from "./shared.js";

const ModelApplicationsPage = named(() => import("@/pages/applications/ModelApplicationsPage"), "ModelApplicationsPage");
const ModelApplicationPage = named(() => import("@/pages/applications/ModelApplicationPage"), "ModelApplicationPage");

export function applicationsRoutes() {
  return (
    <Route element={<Owner />}>
      {/* The site's model questionnaires, live. */}
      <Route path="team/applications" element={<ModelApplicationsPage />} />
      <Route path="team/applications/:ref" element={<ModelApplicationPage />} />
    </Route>
  );
}
