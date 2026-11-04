/**
 * Group publications: Публикации (design/screens/publications.md). One address,
 * two side panels (`?publication=`, `?panel=settings`) and windows. The owner's.
 */
import { Route } from "react-router";
import { named, Owner } from "./shared.js";

const PublicationsPage = named(() => import("@/pages/publications/PublicationsPage"), "PublicationsPage");

export function publicationsRoutes() {
  return (
    <Route element={<Owner />}>
      <Route path="publications" element={<PublicationsPage />} />
    </Route>
  );
}
