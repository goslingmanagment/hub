/**
 * Group publications: Публикации (design/screens/publications.md). The route and
 * what it renders until the screen is rebuilt. The owner's.
 */
import { Link, Route, useSearchParams } from "react-router";
import { PageHeader } from "@/components/ui/PageHeader";
import { named, Owner } from "./shared.js";

const PublicationsPage = named(() => import("@/pages/publications/PublicationsPage"), "PublicationsPage");
const PublicationSettingsPage = named(() => import("@/pages/publications/PublicationSettingsPage"), "PublicationSettingsPage");

function PublicationsScreen() {
  const [search] = useSearchParams();
  if (search.get("panel") === "settings") {
    return (
      <>
        <PageHeader actions={<Link to="/publications" className="btn">К расписанию</Link>} />
        <PublicationSettingsPage />
      </>
    );
  }
  return (
    <>
      <PageHeader actions={<Link to="/publications?panel=settings" className="btn">Настройки публикации</Link>} />
      <PublicationsPage />
    </>
  );
}

export function publicationsRoutes() {
  return (
    <Route element={<Owner />}>
      <Route path="publications" element={<PublicationsScreen />} />
    </Route>
  );
}
