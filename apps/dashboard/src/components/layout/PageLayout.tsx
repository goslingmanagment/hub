import { Link, Outlet, useParams } from "react-router";
import { useAuthMe, useOverview } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { getSyncUxDisplayMode, getSyncUxExceptionKind, syncStateLabel, syncTone } from "@/components/shared/syncUxDisplay";
import { SectionTabs, type SectionTabItem } from "@/components/ui/SectionTabs";
import { buildPageRoute, buildPageSectionRoute, buildPageSyncRoute } from "@/lib/navigation";
import { useDashboardShell } from "./DashboardShellContext.js";

const TONE_BADGE = { ok: "badge-success", warn: "badge-warning", error: "badge-danger", muted: "" } as const;
const TONE_DOT = { ok: "status-dot-ok", warn: "status-dot-warn", error: "status-dot-error", muted: "" } as const;

/**
 * Everything about one page sits under one header: who the page is, whether
 * its data is being collected, and its views as tabs. The views used to hang
 * off the sidebar and appear only once a page was open.
 */
export function PageLayout() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const { findPageByLabel } = useDashboardShell();
  const page = findPageByLabel(pageLabel);
  if (!page) return <Outlet />;
  return (
    <div className="min-w-0">
      <PageIdentity page={page} />
      <SectionTabs label="Разделы страницы" items={pageTabs(page)} />
      <Outlet />
    </div>
  );
}

function pageTabs(page: { label: string; platform: "fansly" | "onlyfans" }): SectionTabItem[] {
  return [
    { to: buildPageRoute(page.label), label: "Обзор" },
    { to: buildPageSectionRoute(page.label, "subscribers"), label: "Подписчики" },
    ...(page.platform === "fansly" ? [{ to: buildPageSectionRoute(page.label, "followers"), label: "Фолловеры" }] : []),
    { to: buildPageSectionRoute(page.label, "top-supporters"), label: "Топ фанов" },
    { to: buildPageSectionRoute(page.label, "deleted-fans"), label: "Удалённые фаны" },
  ];
}

function exceptionMessage(kind: "attention" | "off") {
  return kind === "off"
    ? "Часть данных не обновляется — проверьте сбор данных."
    : "Данные могут быть неполными — проверьте сбор данных.";
}

export function PageIdentity({ page }: {
  page: { id: number; label: string; platform: "fansly" | "onlyfans"; username: string | null; modelName: string };
}) {
  const { data: auth } = useAuthMe();
  const syncQuery = useOverview();
  const syncUx = syncQuery.data?.pages.find((item) => item.id === page.id)?.syncUx;
  const isOwner = auth?.user.role === "owner";
  const exceptionKind = syncUx && getSyncUxDisplayMode(syncUx, "page_detail") === "exception"
    ? getSyncUxExceptionKind(syncUx)
    : null;
  const tone = syncUx ? syncTone(syncUx) : "muted";

  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="page-title">{page.label}</h1>
        <PlatformBadge platform={page.platform} />
        {syncUx ? (
          <span className={`badge ${TONE_BADGE[tone]}`} title={syncUx.detail ?? undefined}>
            <span className={`status-dot ${TONE_DOT[tone]}`} aria-hidden="true" />
            {syncStateLabel(syncUx, page.platform)}
          </span>
        ) : (
          <span className="badge">{syncQuery.isLoading ? "Загружаем состояние сбора…" : "Состояние сбора недоступно"}</span>
        )}
      </div>
      <p className="page-subtitle">
        {page.username ? `@${page.username}` : "Имя на площадке неизвестно"} · модель {page.modelName}
      </p>
      <div className="mt-3 empty:hidden">
        <QueryNotice error={syncQuery.isError} stale={Boolean(syncUx)} retry={syncQuery.refetch} />
        {syncUx && (exceptionKind === "attention" || exceptionKind === "off") && (
          <div className={`notice ${exceptionKind === "attention" ? "notice-danger" : "notice-warning"}`}>
            <span className="min-w-0 flex-1">{exceptionMessage(exceptionKind)}</span>
            {isOwner && (
              <Link to={buildPageSyncRoute(page.platform, page.label)} className="link shrink-0">
                Открыть сбор данных
              </Link>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
