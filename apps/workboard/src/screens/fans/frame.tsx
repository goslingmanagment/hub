import { createContext, Fragment, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Skeleton, Tabs } from "@agency_hub_core/ui";
import { SaleChainTrigger } from "@agency_hub_core/ui/components/SaleChain";
import { ofapiConfigQuery, ofapiStatusOf } from "@agency_hub_core/ui/console/ofapiStatus";
import { PeriodControl, PeriodMissingNote } from "@agency_hub_core/ui/console/PeriodControl";
import type { OfapiStatus } from "@agency_hub_core/ui/console/statusWords";
import { matchScreen, pageFilterOf, type Screen } from "@agency_hub_core/ui/screens";
import { kernel } from "@/shared/hub";
import { PageFilter } from "@/shared/PageFilter";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { usePageFilter as useAddressPage } from "@/shared/usePageFilter";
import type { HubPage } from "@/shared/usePages";
import { useMe } from "@/shared/useMe";

/**
 * Workboard's frame for «Фаны» (products package M): the screens moved from the console as they were, and read what
 * the console's frame gave them — the page filter, the page catalog, the header — from here. The pages listed are the
 * ones whose fans the viewer reads (`fanPages`: the pages of their teams, Hub decides); the period is the console's
 * (`?period=`, the options of the screen's row in packages/ui/src/screens.ts).
 */

/** The pages whose fans the viewer reads. */
export function useFanPages() {
  return useQuery({ queryKey: ["fanPages"], queryFn: () => kernel.fanPages(), staleTime: 5 * 60_000 });
}

type CatalogPage = HubPage;

/** The console's shell context, as the moved screens ask it. */
export function useDashboardShell() {
  const pages = useFanPages();
  const list = useMemo(() => pages.data ?? [], [pages.data]);
  const findPageByLabel = useCallback(
    (label: string | undefined): CatalogPage | null => (label ? list.find((page) => page.label === label) ?? null : null),
    [list],
  );
  return {
    pages: list,
    findPageByLabel,
    pageCatalogState: pages.isLoading ? "loading" as const : pages.isError ? "error" as const : "ready" as const,
    retryPageCatalog: () => void pages.refetch(),
  };
}

/** The screen's row in the one table (Workboard's router path without its base). */
function useScreenRow(): Screen | null {
  const location = useLocation();
  return (matchScreen(location.pathname) ?? matchScreen(window.location.pathname))?.screen ?? null;
}

/** The page filter as the moved screens read it: `?page=` when it is a page of the viewer's list. */
export function usePageFilter() {
  const { page: asked, setPage } = useAddressPage();
  const { pages, pageCatalogState } = useDashboardShell();
  const item = asked ? pages.find((page) => page.label === asked) ?? null : null;
  // While the list is read, the address is taken at its word; a label the list does not have is every page.
  const page = pageCatalogState === "loading" ? asked : item?.label ?? null;
  return {
    page,
    item: item ? { label: item.label, platform: item.platform, modelName: item.modelName, username: item.username } : null,
    select: setPage,
  };
}

/** The page named by the address (`?page=`), for a screen of one page. */
export function useRoutePageLabel(): string | undefined {
  return usePageFilter().page ?? undefined;
}

const FAN_TABS = [
  { to: "/fans", label: "Платящие", ids: ["fans", "fan", "fan-any-page"] },
  { to: "/fans/by-spend", label: "По сумме трат", ids: ["fans-by-spend", "fans-by-spend-list"] },
  { to: "/fans/subscribers", label: "Подписчики", ids: ["fans-subscribers"] },
  { to: "/fans/followers", label: "Фолловеры", ids: ["fans-followers"] },
  { to: "/fans/gone", label: "Ушли", ids: ["fans-gone"] },
] as const;

/** The tabs of «Фаны», carrying the page. */
function FansTabs() {
  const [search] = useSearchParams();
  const page = search.get("page");
  const query = page ? `?${new URLSearchParams({ page }).toString()}` : "";
  return <Tabs label="Фаны" items={FAN_TABS.map((tab) => ({ to: { pathname: tab.to, search: query }, label: tab.label, end: tab.to === "/fans" }))} />;
}

export interface PageFreshness {
  at: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  frozen?: boolean;
}

/**
 * The console's header of a screen, in Workboard's: the title (the row's, or the object's on a card), the period and
 * the page filter of the row, the dates and «Обновлено», the tabs of «Фаны» on its lists.
 */
/** Whether the screen draws its header itself: the console's frame drew one for screens that do not (Ушли, a card's error). */
const HeaderSeen = createContext<((seen: boolean) => void) | null>(null);

/** The frame of a moved screen: its header when the screen draws none. */
export function FansFrame({ children }: { children: ReactNode }) {
  const [seen, setSeen] = useState(false);
  return (
    <HeaderSeen.Provider value={setSeen}>
      <div className="console-kit">
        {!seen && <DefaultHeader />}
        {children}
      </div>
    </HeaderSeen.Provider>
  );
}

function DefaultHeader() {
  return <HeaderView />;
}

export function PageHeader(props: Parameters<typeof HeaderView>[0]) {
  const seen = useContext(HeaderSeen);
  useLayoutEffect(() => {
    seen?.(true);
    return () => seen?.(false);
  }, [seen]);
  return <HeaderView {...props} />;
}

function HeaderView({ title, description, actions, window, fresh }: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleId?: string;
  window?: ReactNode;
  fresh?: PageFreshness | undefined;
}) {
  const screen = useScreenRow();
  const { pages } = useDashboardShell();
  const { page: pageOf } = usePageFilter();
  const mode = screen ? pageFilterOf(screen).mode : "none";
  const card = screen?.id === "fan" || screen?.id === "fan-any-page";
  const filter = mode === "none" ? false : <PageFilter pages={onPlatforms(pages, screen)} everyPage={mode !== "one"} />;
  const meta = description !== undefined || window !== undefined
    ? <span className="fan-header-meta">{description}{description && window ? " · " : null}<PeriodMissingNote />{window}</span>
    : undefined;
  return (
    <ScreenHeader
      title={title ?? screen?.title ?? "Фаны"}
      {...(typeof title !== "string" && screen ? { documentTitle: screen.title } : {})}
      actions={<>{actions}{screen?.period ? <PeriodControl /> : null}</>}
      pageFilter={filter}
      {...(meta !== undefined ? { meta } : {})}
      {...(fresh ? { updatedAt: Date.parse(fresh.at), refreshing: fresh.refreshing ?? false, ...(fresh.onRefresh ? { onRefresh: fresh.onRefresh } : {}) } : {})}
      {...(card || screen?.id === "fans-by-spend-list" ? {} : { tabs: <FansTabs /> })}
      {...(screen?.id === "fans-by-spend-list" ? { back: { to: `/fans/by-spend${pageQuery(pageOf)}`, label: "По сумме трат" } } : {})}
    />
  );
}

function pageQuery(page: string | null): string {
  return page ? `?${new URLSearchParams({ page }).toString()}` : "";
}

/** The pages a screen of some platforms lists (Фолловеры: Fansly's). */
function onPlatforms(pages: readonly CatalogPage[], screen: Screen | null): CatalogPage[] {
  const platforms = screen?.platforms as readonly string[] | undefined;
  return platforms ? pages.filter((page) => platforms.includes(page.platform)) : [...pages];
}

/** A screen of one page opened without one: its header and the pick. */
export function OnePageGate({ children }: { children: ReactNode }) {
  const screen = useScreenRow();
  const { page } = usePageFilter();
  const { pages, pageCatalogState } = useDashboardShell();
  // A one-page list starts anew when its page changes: no row, panel or draft of another page survives.
  if (!screen || pageFilterOf(screen).mode !== "one") return <>{children}</>;
  if (page) return <Fragment key={page}>{children}</Fragment>;
  const offered = onPlatforms(pages, screen);
  return (
    <>
      <PageHeader />
      {pageCatalogState === "loading"
        ? <Skeleton width={320} />
        : (
          <div className="empty">
            <p className="empty-title">{offered.length === 0 ? (screen.platformsNote ?? "Нет страниц.") : "Выберите страницу"}</p>
            {offered.length > 0 && <p className="empty-text">Этот список ведётся по одной странице: выберите её справа вверху.</p>}
          </div>
        )}
    </>
  );
}

/** A screen still loading. */
export function ScreenFallback() {
  return <div className="p-6"><Skeleton width={320} /></div>;
}

/** The viewer's flag of the OnlyFans API: the owner's alone is known; nothing is claimed for anyone else. */
export function useViewerOfapi(): { role: "owner" | "team_lead"; ofapi: OfapiStatus } {
  const { role } = useMe();
  const config = useQuery(ofapiConfigQuery(kernel, role));
  return { role: role === "owner" ? "owner" : "team_lead", ofapi: role === "owner" ? ofapiStatusOf(config.data) : "unknown" };
}

export { OfapiOffNotice } from "@agency_hub_core/ui/console/OfapiOffNotice";

/** Цепочка продажи from a fan's operation: the shared component on Workboard's client. */
export function ChainMoney({ pageLabel, transactionRef, children }: { pageLabel: string; transactionRef: string; children: ReactNode }) {
  return (
    <SaleChainTrigger load={() => kernel.saleChain({ query: { pageLabel, transactionRef } })} align="end">
      {children}
    </SaleChainTrigger>
  );
}

/** Who is looking, as the moved screens asked the console (`useAuthMe`). */
export function useAuthMe() {
  const me = useMe();
  return { data: me.user ? { user: me.user } : undefined };
}
