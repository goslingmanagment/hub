import { Suspense, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Link, Outlet, useLocation, useMatch, useParams } from "react-router";
import type { Platform } from "@agency_hub_core/shared";
import { useAuthMe, useOverview } from "@/api/queries";
import { PLATFORM_WORD } from "@/components/shared/PlatformBadge";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { Notice } from "@/components/ui/Notice";
import { PageFresh } from "@/components/ui/PageHeader";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ScreenFrameContext, type ScreenFrame } from "@/components/ui/screenFrame";
import { getSyncUxDisplayMode, getSyncUxExceptionKind, syncStatusWord } from "@/components/shared/syncUxDisplay";
import { buildPageCollectionRoute, buildPageRoute, buildPageSectionRoute, decodeRouteSegment } from "@/lib/navigation";
import { matchScreen, pageCardTabs } from "@/lib/sections";
import { OtherPageChip } from "./PageFilterChip.js";
import { PeriodControl, PeriodMissingNote } from "./PeriodControl.js";
import { ScreenFallback } from "./ScreenFrame.js";
import { useDashboardShell } from "./DashboardShellContext.js";

type CardPage = { id: number; label: string; platform: Platform; username: string | null; modelName: string };

/** How the page is collected: silent while it works, a word only when it does not. */
function CollectionState({ page, owner }: { page: CardPage; owner: boolean }) {
  const syncQuery = useOverview();
  const syncUx = syncQuery.data?.pages.find((item) => item.id === page.id)?.syncUx;
  if (!syncUx) return null;
  const exception = getSyncUxDisplayMode(syncUx, "page_detail") === "exception" ? getSyncUxExceptionKind(syncUx) : null;
  if (page.platform === "fansly" && exception === null) {
    return syncUx.updatedAt ? <PageFresh at={syncUx.updatedAt} /> : null;
  }
  // A team lead cannot tell «switched off» from «broken» on OnlyFans yet: no word at all.
  if (page.platform === "onlyfans" && !owner) return null;
  return <StatusBadge status={syncStatusWord(syncUx, page.platform)} title={undefined} />;
}

function CollectionNotice({ page, owner }: { page: CardPage; owner: boolean }) {
  const syncQuery = useOverview();
  const syncUx = syncQuery.data?.pages.find((item) => item.id === page.id)?.syncUx;
  if (syncQuery.isError) return <QueryNotice error stale={Boolean(syncUx)} retry={syncQuery.refetch} />;
  if (!syncUx || getSyncUxDisplayMode(syncUx, "page_detail") !== "exception") return null;
  const exception = getSyncUxExceptionKind(syncUx);
  if (page.platform !== "fansly") return null;
  if (exception === "credentials") {
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
  if (exception === "attention" || exception === "off") {
    return (
      <Notice
        tone={exception === "attention" ? "danger" : "warning"}
        action={owner ? <Link to={buildPageCollectionRoute(page.label)} className="btn btn-sm">Сбор данных страницы</Link> : undefined}
      >
        {exception === "off" ? "Часть данных не обновляется." : "Данные могут быть неполными."}
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
  const { findPageByLabel, pageCatalogState } = useDashboardShell();
  const { data: auth } = useAuthMe();
  const location = useLocation();
  const role = auth?.user.role ?? "team_lead";
  const page = findPageByLabel(pageLabel);
  const owner = role === "owner";
  const screen = matchScreen(location.pathname)?.screen ?? null;
  const onSummary = useMatch("/pages/:pageLabel") !== null;
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [windowSlot, setWindowSlot] = useState<HTMLElement | null>(null);
  const frame = useMemo<ScreenFrame>(() => ({
    mode: "inline",
    slots: { title: null, subtitle: null, actions: actionsSlot, window: windowSlot },
  }), [actionsSlot, windowSlot]);

  const browserTitle = `${screen && screen.id !== "page" ? `${screen.title} · ` : ""}${pageLabel ?? "Страница"} — Hub`;
  useEffect(() => {
    document.title = browserTitle;
  }, [browserTitle]);

  if (pageCatalogState === "loading") return <ScreenFallback />;
  if (!page) {
    return (
      <StatusPanel
        title="Такой страницы нет"
        description="Её нет среди доступных вам."
        action={<Link to="/" className="btn btn-sm">На главную</Link>}
      />
    );
  }

  const tabs = pageCardTabs(page, role);
  const screenInTabs = tabs.some((tab) => tab.screenId === screen?.id);
  return (
    <ScreenFrameContext.Provider value={frame}>
      <div className="min-w-0">
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
            {onSummary && <PeriodControl />}
            <OtherPageChip current={page.label} to={(label) => buildPageRoute(label)} />
          </div>
        </div>
        <div className="page-meta">
          <p className="page-subtitle">
            {page.username ? `@${page.username}` : "Имя на площадке неизвестно"} · модель {page.modelName}
          </p>
          <div className="page-window">
            <PeriodMissingNote />
            <span ref={setWindowSlot} />
            {onSummary && " "}
            <CollectionState page={page} owner={owner} />
          </div>
        </div>
        <div className="mb-6 empty:hidden"><CollectionNotice page={page} owner={owner} /></div>
        <SectionTabs label="Разделы страницы" items={tabs} current={tabs.find((tab) => tab.screenId === screen?.id)?.to} />
        <Suspense fallback={<ScreenFallback />}>
          {screen?.platforms && !screen.platforms.includes(page.platform)
            ? <StatusPanel title={page.platform === "telegram" ? "Hub не собирает данные Telegram" : screen.platformsNote ?? "У этой страницы такого экрана нет"} />
            : <Outlet />}
        </Suspense>
      </div>
    </ScreenFrameContext.Provider>
  );
}
