import { Link, Navigate, useLocation, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { NoAnswerPanel, StatusPanel } from "@agency_hub_core/ui/console/StatusPanel";
import { buildFanProfileNavigation } from "@agency_hub_core/ui/fanLinks";
import { kernel, KernelApiError } from "./sdk.js";
import { ScreenFallback } from "./frame.js";

/**
 * «Фаны»: a fan with no page in the address (moved from the console, products package M). Hub answers the fan's
 * pages by the viewer's teams, so the page picked is always one the viewer sees.
 */
const FAN_PLATFORMS: ReadonlySet<string> = new Set(["fansly", "onlyfans", "telegram"]);

/** A fan with no page in the address: opens the page where they spent the most.
 *  Writes nothing; the address's `?period=` and the state go on. */
export function FanAnyPageScreen() {
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

