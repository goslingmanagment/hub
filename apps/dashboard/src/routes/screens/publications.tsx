/**
 * Group publications: Публикации (design/screens/publications.md). One address,
 * two side panels (`?publication=`, `?panel=settings`) and windows; and
 * «Рассылки» of one page (a tab of the page's card until 12.11). The owner's.
 */
import { Route } from "react-router";
import { named, OnePage, Owner } from "./shared.js";

const PublicationsPage = named(() => import("@/pages/publications/PublicationsPage"), "PublicationsPage");
const MassMessagesPage = named(() => import("@/pages/page-card/MassMessagesPage"), "MassMessagesPage");

export function publicationsRoutes() {
  return (
    <Route element={<Owner />}>
      <Route path="publications" element={<PublicationsPage />} />
      <Route path="content/mass-messages" element={<OnePage><MassMessagesPage /></OnePage>} />
    </Route>
  );
}
