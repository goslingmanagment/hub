/**
 * Group fans-page: Фаны, a page's card, the login and connecting a page
 * (design/screens/fans-page.md). The routes and what they render until each
 * screen is rebuilt; routes/pageCard.tsx is this group's too.
 */
import { Link, Navigate, Route, useLocation, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { kernel, KernelApiError } from "@/api/sdk";
import { PageCardLayout } from "@/components/layout/PageCardLayout";
import { ScreenFallback } from "@/components/layout/ScreenFrame";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { named, OnePage, Owner } from "./shared.js";

const PayersPage = named(() => import("@/pages/fans/PayersPage"), "PayersPage");
const SubscribersPage = named(() => import("@/pages/fans/SubscribersPage"), "SubscribersPage");
const FollowersPage = named(() => import("@/pages/fans/FollowersPage"), "FollowersPage");
const GonePage = named(() => import("@/pages/fans/GonePage"), "GonePage");
const BySpendPage = named(() => import("@/pages/fans/BySpendPage"), "BySpendPage");
const BySpendListPage = named(() => import("@/pages/fans/BySpendListPage"), "BySpendListPage");
const FanCardPage = named(() => import("@/pages/fans/FanCardPage"), "FanCardPage");
const PageBrowserOnboardingPage = named(() => import("@/pages/page-browser/PageBrowserOnboardingPage"), "PageBrowserOnboardingPage");
const PageBrowserDraftPage = named(() => import("@/pages/page-browser/PageBrowserDraftPage"), "PageBrowserDraftPage");
const PageSummaryScreen = named(() => import("../pageCard.js"), "PageSummaryScreen");
const PageAccountScreen = named(() => import("../pageCard.js"), "PageAccountScreen");
const PagePromoScreen = named(() => import("../pageCard.js"), "PagePromoScreen");
const MassMessagesPage = named(() => import("@/pages/page-card/MassMessagesPage"), "MassMessagesPage");
const PageBrowserLoginPage = named(() => import("@/pages/page-browser/PageBrowserLoginPage"), "PageBrowserLoginPage");

const FAN_PLATFORMS: ReadonlySet<string> = new Set(["fansly", "onlyfans", "telegram"]);

/** A fan with no page in the address: opens the page where they spent the most.
 *  Writes nothing; the address's `?period=` and the state go on. */
function FanAnyPageScreen() {
  const { platform = "", platformUserId = "" } = useParams<{ platform: string; platformUserId: string }>();
  const location = useLocation();
  const known = FAN_PLATFORMS.has(platform);
  const detail = useQuery({
    queryKey: ["crossPageFanDetail", platform, platformUserId],
    queryFn: () => kernel.crossPageFanDetail({ params: { platform, platformUserId } as Parameters<typeof kernel.crossPageFanDetail>[0]["params"] }),
    meta: { suppressGlobalError: true },
    retry: false,
    enabled: known,
  });
  if (!known) return <StatusPanel title="Такой страницы нет" action={<Link to="/" className="btn btn-sm">На главную</Link>} />;
  if (detail.isLoading) return <ScreenFallback />;
  const missing = detail.error instanceof KernelApiError && detail.error.status === 404;
  if (detail.isError && !missing) return <NoAnswerPanel retry={detail.refetch} />;
  // The most money first; a tie keeps the answer's order.
  const top = (detail.data?.pages ?? []).reduce<{ pageLabel: string; totalCreatorNetMills: number } | null>(
    (best, page) => (best === null || page.totalCreatorNetMills > best.totalCreatorNetMills ? page : best),
    null,
  );
  if (!top) {
    return (
      <StatusPanel
        title="Такого фана нет на ваших страницах"
        description="Он мог удалить аккаунт. Операции такого фана остаются в истории."
        action={<Link to="/fans" className="btn btn-sm">К фанам</Link>}
      />
    );
  }
  return <Navigate to={`${buildFanProfileNavigation(top.pageLabel, platform, platformUserId, "/fans").to}${location.search}`} state={location.state ?? { backTo: "/fans" }} replace />;
}

export function fansRoutes() {
  return (
    <>
      <Route path="fans" element={<PayersPage />} />
      <Route path="fans/subscribers" element={<OnePage><SubscribersPage /></OnePage>} />
      <Route path="fans/followers" element={<OnePage><FollowersPage /></OnePage>} />
      <Route path="fans/gone" element={<OnePage><GonePage /></OnePage>} />
      <Route path="fans/by-spend" element={<OnePage><BySpendPage /></OnePage>} />
      <Route path="fans/by-spend/:bucketKey" element={<OnePage><BySpendListPage /></OnePage>} />
      <Route path="fans/:pageLabel/:platform/:platformUserId" element={<FanCardPage />} />
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
        <Route path="mass-messages" element={<MassMessagesPage />} />
        <Route path="browser-login" element={<PageBrowserLoginPage />} />
      </Route>
    </Route>
  );
}
