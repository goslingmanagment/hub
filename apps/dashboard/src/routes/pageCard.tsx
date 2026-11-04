/**
 * The tabs of a page's card. The page is in the path: nothing here reads the filter.
 */
import { useParams } from "react-router";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { decodeRouteSegment } from "@/lib/navigation";
import { AccountPage } from "@/pages/page-card/AccountPage";
import { PromoFansly } from "@/pages/page-card/PromoFansly";
import { PromoOnlyFans } from "@/pages/page-card/PromoOnlyFans";
import { SummaryPage } from "@/pages/page-card/SummaryPage";

function usePage() {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  return useDashboardShell().findPageByLabel(decodeRouteSegment(pageLabel));
}

/** «Сводка»; a Telegram page says so inside. */
export function PageSummaryScreen() {
  return <SummaryPage />;
}

/** «Аккаунт на Fansly»: how the page looks there and how it is set up there (`#fansly-settings`). */
export function PageAccountScreen() {
  return <AccountPage />;
}

/** «Продвижение»: Fansly's own promo, or the OnlyFans links as of 1 November. */
export function PagePromoScreen() {
  const page = usePage();
  return page?.platform === "onlyfans" ? <PromoOnlyFans /> : <PromoFansly />;
}
