/**
 * The tabs of a page's card, from the existing screens. The page is in the path:
 * nothing here reads the filter.
 */
import { useLocation, useParams } from "react-router";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { OfapiMarketing } from "@/pages/OfapiMarketing";
import { PageDetailPage } from "@/pages/PageDetailPage";
import { PagePromoPage } from "@/pages/PagePromoPage";
import { PageProfilePage } from "@/pages/PageProfilePage";
import { PageSettingsPage } from "@/pages/PageSettingsPage";
import { decodeRouteSegment } from "@/lib/navigation";
import { useScrollToAnchor } from "@/lib/useScrollToAnchor";

function usePage() {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  return useDashboardShell().findPageByLabel(decodeRouteSegment(pageLabel));
}

export function PageSummaryScreen() {
  const page = usePage();
  if (page?.platform === "telegram") return <StatusPanel title="Hub не собирает данные Telegram" />;
  return <PageDetailPage />;
}

/** «Аккаунт на Fansly»: how the page looks there, and how it is set up there
 *  (`#fansly-settings`, the old «Настройки» tab). */
export function PageAccountScreen() {
  const { hash } = useLocation();
  useScrollToAnchor("fansly-settings", hash === "#fansly-settings");
  return (
    <div className="space-y-12">
      <PageProfilePage />
      <section id="fansly-settings" className="scroll-mt-16 space-y-4" aria-labelledby="fansly-settings-title">
        <h2 id="fansly-settings-title" className="section-title">Как настроено на Fansly</h2>
        <PageSettingsPage />
      </section>
    </div>
  );
}

/** «Продвижение»: Fansly's own promo, or the OnlyFans links as of 1 November. */
export function PagePromoScreen() {
  const page = usePage();
  return page?.platform === "onlyfans" ? <OfapiMarketing /> : <PagePromoPage />;
}
