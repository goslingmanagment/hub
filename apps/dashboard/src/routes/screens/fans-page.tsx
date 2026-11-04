/**
 * Group fans-page: Фаны, a page's card, the login and connecting a page
 * (design/screens/fans-page.md). The routes and what they render until each
 * screen is rebuilt; routes/pageCard.tsx is this group's too.
 */
import { lazy } from "react";
import { Link, Navigate, Route, useLocation, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { kernel } from "@/api/sdk";
import { usePageSpenderAutoLists } from "@/api/queries";
import { PageCardLayout } from "@/components/layout/PageCardLayout";
import { ScreenFallback } from "@/components/layout/ScreenFrame";
import { useRoutePageLabel } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { named, OnePage, Owner } from "./shared.js";

const SpenderAutoListPage = named(() => import("@/pages/SpenderAutoListPage"), "SpenderAutoListPage");
const DeletedFansPage = named(() => import("@/pages/DeletedFansPage"), "DeletedFansPage");
const SubscribersPage = named(() => import("@/pages/SubscribersPage"), "SubscribersPage");
const FollowersPage = named(() => import("@/pages/FollowersPage"), "FollowersPage");
const FanProfilePage = named(() => import("@/pages/FanProfilePage"), "FanProfilePage");
const TopSupportersPage = named(() => import("@/pages/TopSupportersPage"), "TopSupportersPage");
const PageSpenderAutoListsSection = lazy(() => import("@/pages/PageDetailPage").then((module) => ({ default: module.PageSpenderAutoListsSection })));
const PageBrowserOnboardingPage = named(() => import("@/pages/page-browser/PageBrowserOnboardingPage"), "PageBrowserOnboardingPage");
const PageBrowserDraftPage = named(() => import("@/pages/page-browser/PageBrowserDraftPage"), "PageBrowserDraftPage");
const PageSummaryScreen = named(() => import("../pageCard.js"), "PageSummaryScreen");
const PageAccountScreen = named(() => import("../pageCard.js"), "PageAccountScreen");
const PagePromoScreen = named(() => import("../pageCard.js"), "PagePromoScreen");
const PageMassMessagesPage = named(() => import("@/pages/PageMassMessagesPage"), "PageMassMessagesPage");
const PageBrowserLoginPage = named(() => import("@/pages/page-browser/PageBrowserLoginPage"), "PageBrowserLoginPage");

/** The lists by the sum spent, of one page. Their period is their own. */
function BySpendScreen() {
  const pageLabel = useRoutePageLabel() ?? "";
  const { key } = useScreenPeriod();
  const spender = key === "all" ? "lifetime" : (key as "today" | "7d" | "30d" | "90d" | "180d");
  const lists = usePageSpenderAutoLists(pageLabel, { period: spender }, { enabled: pageLabel.length > 0 });
  if (lists.isLoading) return <TableSkeleton rows={4} columns={3} />;
  if (lists.isError && !lists.data) return <NoAnswerPanel retry={lists.refetch} />;
  return <PageSpenderAutoListsSection pageLabel={pageLabel} autoLists={lists.data} period={key} />;
}

/** A fan with no page in the address: opens the page where they spent the most. */
function FanAnyPageScreen() {
  const { platform = "", platformUserId = "" } = useParams<{ platform: string; platformUserId: string }>();
  const location = useLocation();
  const detail = useQuery({
    queryKey: ["crossPageFanDetail", platform, platformUserId],
    queryFn: () => kernel.crossPageFanDetail({ params: { platform, platformUserId } as Parameters<typeof kernel.crossPageFanDetail>[0]["params"] }),
    meta: { suppressGlobalError: true },
    retry: false,
  });
  if (detail.isLoading) return <ScreenFallback />;
  const top = [...(detail.data?.pages ?? [])].sort((a, b) => b.totalCreatorNetMills - a.totalCreatorNetMills)[0];
  if (!top) {
    return (
      <StatusPanel
        title={detail.isError ? "Hub не ответил" : "Такого фана нет на ваших страницах"}
        action={<Link to="/fans" className="btn btn-sm">К фанам</Link>}
      />
    );
  }
  const target = buildFanProfileNavigation(top.pageLabel, platform, platformUserId, "/fans");
  return <Navigate to={target.to} state={location.state ?? target.state} replace />;
}

export function fansRoutes() {
  return (
    <>
      <Route path="fans" element={<OnePage><TopSupportersPage /></OnePage>} />
      <Route path="fans/subscribers" element={<OnePage><SubscribersPage /></OnePage>} />
      <Route path="fans/followers" element={<OnePage><FollowersPage /></OnePage>} />
      <Route path="fans/gone" element={<OnePage><DeletedFansPage /></OnePage>} />
      <Route path="fans/by-spend" element={<BySpendScreen />} />
      <Route path="fans/by-spend/:bucketKey" element={<OnePage><SpenderAutoListPage /></OnePage>} />
      <Route path="fans/:pageLabel/:platform/:platformUserId" element={<FanProfilePage />} />
      <Route path="fans/:platform/:platformUserId" element={<FanAnyPageScreen />} />
      {/* Connecting a page: in the addresses of Настройки, one process with the login. */}
      <Route element={<Owner />}>
        <Route path="settings/pages/connect" element={<PageBrowserDraftPage />} />
        <Route path="settings/pages/connect/:profileId" element={<PageBrowserOnboardingPage />} />
      </Route>
    </>
  );
}

/** A page's own card: an object, not a branch of the menu. Outside the screens' frame. */
export function pageCardRoutes() {
  return (
    <Route path="pages/:pageLabel" element={<PageCardLayout />}>
      <Route index element={<PageSummaryScreen />} />
      <Route element={<Owner />}>
        <Route path="account" element={<PageAccountScreen />} />
        <Route path="promo" element={<PagePromoScreen />} />
        <Route path="mass-messages" element={<PageMassMessagesPage />} />
        <Route path="browser-login" element={<PageBrowserLoginPage />} />
      </Route>
    </Route>
  );
}
