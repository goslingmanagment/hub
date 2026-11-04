import { Suspense, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Link, Outlet, useLocation, useMatch, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Platform } from "@agency_hub_core/shared";
import { useAuthMe } from "@/api/queries";
import { PLATFORM_WORD } from "@/components/shared/PlatformBadge";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { Notice } from "@/components/ui/Notice";
import { PageFresh } from "@/components/ui/PageHeader";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ScreenFrameContext, type ScreenFrame } from "@/components/ui/screenFrame";
import { buildPageCollectionRoute, buildPageRoute, buildPageSectionRoute, decodeRouteSegment } from "@/lib/navigation";
import { matchScreen, pageCardTabs } from "@/lib/sections";
import { usePageCollection, type PageCollection } from "@/pages/page-card/usePageCollection";
import { OtherPageChip } from "./PageFilterChip.js";
import { PeriodControl, PeriodMissingNote } from "./PeriodControl.js";
import { ScreenFallback } from "./ScreenFrame.js";
import { useDashboardShell } from "./DashboardShellContext.js";

type CardPage = { id: number; label: string; platform: Platform; username: string | null; modelName: string; lastLightSyncAt: string | null };

/** Quiet while it works: «Обновлено в 23:41, 5 мин назад»; a word only when it does not. */
function CollectionState({ page, collection }: { page: CardPage; collection: PageCollection }) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  if (collection.hidden) return null;
  if (collection.word === null) return <Skeleton width={96} />;
  if (collection.kind === "working") {
    if (!page.lastLightSyncAt) return null;
    return (
      <PageFresh
        at={page.lastLightSyncAt}
        refreshing={refreshing}
        // Reads the current tab's queries again; writes nothing.
        onRefresh={() => {
          setRefreshing(true);
          void queryClient.refetchQueries({ type: "active" }).finally(() => setRefreshing(false));
        }}
      />
    );
  }
  if (collection.kind === "notNeeded") return <span>{collection.word.word}</span>;
  return <StatusBadge status={collection.word} />;
}

/** The one notice under the header, when the collection asks for a person. */
function CollectionNotice({ page, collection, owner }: { page: CardPage; collection: PageCollection; owner: boolean }) {
  if (collection.kind === "login") {
    return (
      <Notice
        tone="danger"
        role="alert"
        action={owner ? <Link to={buildPageSectionRoute(page.label, "browser-login")} className="btn btn-primary btn-sm">Войти в Fansly</Link> : undefined}
      >
        {page.label}: Fansly просит войти заново. Новые сообщения не приходят.
      </Notice>
    );
  }
  if (collection.kind === "attention") {
    return (
      <Notice
        tone="danger"
        detail={collection.reason ? `Причина: ${collection.reason}.` : undefined}
        action={owner ? <Link to={buildPageCollectionRoute(page.label)} className="btn btn-sm">Сбор данных страницы</Link> : undefined}
      >
        {page.label}: Hub не читает страницу.
      </Notice>
    );
  }
  if (collection.kind === "ofapiOff") {
    return (
      <Notice tone="off" action={owner ? <Link to="/system/onlyfans-api" className="btn btn-sm">OnlyFans API</Link> : undefined}>
        <b>OnlyFans API выключен с 1 ноября.</b> Подписки и ссылки этой страницы — по 1 ноября. Доход и переписка идут из ленты ChatSpace.
      </Notice>
    );
  }
  return null;
}

/**
 * A page's own card: an object, not a branch of the menu. The page is in the
 * path, the filter does not touch it, and everything about the page sits under
 * one header. «Другая страница» opens another card and leaves the filter alone.
 */
export function PageCardLayout() {
  const { pageLabel: rawLabel } = useParams<{ pageLabel: string }>();
  const pageLabel = rawLabel === undefined ? undefined : decodeRouteSegment(rawLabel);
  const { findPageByLabel, pageCatalogState, retryPageCatalog } = useDashboardShell();
  const page = findPageByLabel(pageLabel);
  if (pageCatalogState === "loading") return <ScreenFallback />;
  // Without the catalog nothing is known about the page: not «there is no such page».
  if (pageCatalogState === "error") return <NoAnswerPanel retry={retryPageCatalog} />;
  if (!page) {
    return (
      <StatusPanel
        title="Такой страницы нет"
        description="Её нет среди доступных вам."
        action={<Link to="/" className="btn btn-sm">На главную</Link>}
      />
    );
  }
  return <PageCard key={page.label} page={page} />;
}

function PageCard({ page }: { page: CardPage }) {
  const { data: auth } = useAuthMe();
  const { pages } = useDashboardShell();
  const location = useLocation();
  const role = auth?.user.role === "owner" ? "owner" : "team_lead";
  const owner = role === "owner";
  const screen = matchScreen(location.pathname)?.screen ?? null;
  const onSummary = useMatch("/pages/:pageLabel") !== null;
  const collection = usePageCollection(page, role);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [windowSlot, setWindowSlot] = useState<HTMLElement | null>(null);
  const frame = useMemo<ScreenFrame>(() => ({
    mode: "inline",
    slots: { title: null, subtitle: null, actions: actionsSlot, window: windowSlot },
  }), [actionsSlot, windowSlot]);

  const browserTitle = `${screen && screen.id !== "page" ? `${screen.title} · ` : ""}${page.label} — Hub`;
  useEffect(() => {
    document.title = browserTitle;
  }, [browserTitle]);

  const tabs = pageCardTabs(page, role);
  const screenInTabs = tabs.some((tab) => tab.screenId === screen?.id);
  // The same tab on another page, if it has it; from the login screen, its summary.
  const otherPage = (label: string) => {
    const target = pages.find((item) => item.label === label);
    if (!target || !screenInTabs) return buildPageRoute(label);
    return pageCardTabs(target, role).find((tab) => tab.screenId === screen?.id)?.to ?? buildPageRoute(label);
  };
  return (
    <ScreenFrameContext.Provider value={frame}>
      <div className="min-w-0 page-card">
        <nav aria-label="Где вы находитесь" className="page-crumbs">
          <span>{page.modelName}</span>
          {!screenInTabs && screen && (
            <span className="inline-flex items-center gap-1">
              <ChevronRight size={14} aria-hidden="true" />
              <Link to={buildPageRoute(page.label)}>{page.label}</Link>
            </span>
          )}
        </nav>
        <div className="page-bar">
          <h1 className="page-title">
            {page.label}
            <span className="page-title-note">{PLATFORM_WORD[page.platform]}</span>
          </h1>
          <div className="page-controls">
            <div ref={setActionsSlot} className="page-actions" />
            {onSummary && page.platform !== "telegram" && <PeriodControl />}
            <OtherPageChip current={page.label} to={otherPage} />
          </div>
        </div>
        <div className="page-meta">
          <p className="page-subtitle">
            {page.username ? `@${page.username}` : "Имя на площадке неизвестно"} · модель {page.modelName}
          </p>
          <div className="page-window">
            <PeriodMissingNote />
            <span ref={setWindowSlot} className="page-card-window" />
            <CollectionState page={page} collection={collection} />
          </div>
        </div>
        <div className="page-card-notice empty:hidden"><CollectionNotice page={page} collection={collection} owner={owner} /></div>
        {tabs.length > 1 && <SectionTabs label="Разделы страницы" items={tabs} current={tabs.find((tab) => tab.screenId === screen?.id)?.to} />}
        <Suspense fallback={<ScreenFallback />}>
          {screen?.platforms && !screen.platforms.includes(page.platform)
            ? <StatusPanel title={page.platform === "telegram" ? "Hub не собирает данные Telegram" : screen.platformsNote ?? "У этой страницы такого экрана нет"} />
            : <Outlet />}
        </Suspense>
      </div>
    </ScreenFrameContext.Provider>
  );
}
