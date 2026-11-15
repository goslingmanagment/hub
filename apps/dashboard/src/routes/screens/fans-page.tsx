/**
 * Group fans-page: a page's own Fansly screens (its account and the login, under Настройки → Модели и страницы since
 * its card left on 12.11) and connecting a page (design/screens/fans-page.md). «Фаны» itself is Workboard's since
 * products package M (apps/workboard/src/screens/fans).
 */
import type { ReactNode } from "react";
import { Link, Route, useParams } from "react-router";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { ScreenFallback } from "@/components/layout/ScreenFrame";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { decodeRouteSegment } from "@/lib/navigation";
import { named, Owner } from "./shared.js";

const PageBrowserOnboardingPage = named(() => import("@/pages/page-browser/PageBrowserOnboardingPage"), "PageBrowserOnboardingPage");
const PageBrowserDraftPage = named(() => import("@/pages/page-browser/PageBrowserDraftPage"), "PageBrowserDraftPage");
const AccountPage = named(() => import("@/pages/page-card/AccountPage"), "AccountPage");
const PageBrowserLoginPage = named(() => import("@/pages/page-browser/PageBrowserLoginPage"), "PageBrowserLoginPage");

export function pageScreensRoutes() {
  return (
    <>
      {/* Connecting a page: in the addresses of Настройки, one process with the login. */}
      <Route element={<Owner />}>
        <Route path="settings/pages/connect" element={<PageBrowserDraftPage />} />
        <Route path="settings/pages/connect/:profileId" element={<PageBrowserOnboardingPage />} />
        {/* A page's account on Fansly and its login: they were tabs of the page's card. */}
        <Route path="settings/pages/:pageLabel/account" element={<FanslyPage><AccountPage /></FanslyPage>} />
        <Route path="settings/pages/:pageLabel/login" element={<FanslyPage><PageBrowserLoginPage /></FanslyPage>} />
      </Route>
    </>
  );
}

/**
 * A page's own Fansly screen, the page in the path: one that is not there, or
 * not on Fansly, is said so instead of the screen.
 */
function FanslyPage({ children }: { children: ReactNode }) {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  const { findPageByLabel, pageCatalogState, retryPageCatalog } = useDashboardShell();
  const page = findPageByLabel(decodeRouteSegment(pageLabel));
  if (pageCatalogState === "loading") return <ScreenFallback />;
  if (pageCatalogState === "error") return <NoAnswerPanel retry={retryPageCatalog} />;
  if (!page) return <StatusPanel title="Такой страницы нет" description="Её нет среди доступных вам." action={<Link to="/settings/pages" className="btn btn-sm">Модели и страницы</Link>} />;
  if (page.platform !== "fansly") return <StatusPanel title="Этот экран есть только у страниц Fansly" action={<Link to="/settings/pages" className="btn btn-sm">Модели и страницы</Link>} />;
  return <>{children}</>;
}
