import type { ReactNode } from "react";
import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link, useParams } from "react-router";
import { usePageSyncBlocks, useSyncEnginePages, useSyncHistoryRequests } from "@/api/queries";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { OtherPageChip } from "@/components/layout/PageFilterChip";
import { staleDataText } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { buildPageCollectionRoute, buildPageRoute, buildPageSectionRoute, decodeRouteSegment } from "@/lib/navigation";
import { KernelApiError } from "@/api/sdk";
import { browserAlertLines, browserBufferTroubleLines } from "@/pages/settings/engine/engineBrowserDisplay";
import { engineAttentionText, engineBlockLabel, engineBlockOrder, isEngineBlock } from "@/pages/settings/engine/engineBlockDisplay";
import { engineAgeText, isCredentialsStop, openHistoryRequests, type EngineStatusState } from "@/pages/settings/engine/engineDisplay";
import { engineHasBrowser } from "@/pages/settings/engine/enginePageSummary";
import { useEngineStatusOf } from "@/pages/settings/engine/useEngineStatusOf";
import { SyncDiagnosisHeadline } from "./SyncDiagnosis.js";
import { EngineRequestsTable, OPEN_REQUESTS_LIMIT } from "../history/EngineRequestsCard.js";
import { freshOf, OfapiOffBanner, OfapiUnknownNotice, platformName, useOfapi } from "../shared.js";
import { collectionRow } from "./collectionRows.js";
import { CoverageBlock } from "./CoverageBlock.js";
import { EngineBlocksTable } from "./EngineBlocksTable.js";
import { EngineDetails } from "./EngineDetails.js";
import { LegacyBlocksTable } from "./LegacyBlocksTable.js";

/** The notices of a Fansly page: what is broken first, then what waits; no more than two. */
function EngineNotices({ page, state }: { page: SyncBlocksPage; state: EngineStatusState }) {
  const label = page.pageLabel;
  const browser = state.kind === "ready" ? state.status.browser : undefined;
  const login = <Link to={buildPageSectionRoute(label, "browser-login")} className="btn btn-sm">Войти в Fansly</Link>;
  const notices: ReactNode[] = [];
  const blocks = engineBlockOrder().map((key) => page.blocks[key]).filter(isEngineBlock);
  const refused = blocks.some((block) => block.engine.stops.some(isCredentialsStop));
  if (browser?.login.needed) {
    notices.push(
      <Notice key="login" tone="danger" action={login}>
        {label}: {browser.login.why === "login_required" ? "Fansly вышел из аккаунта в браузере страницы." : "Fansly не принимает сессию браузера."} Новые данные не приходят.
      </Notice>,
    );
  } else if (refused) {
    notices.push(
      <Notice
        key="refused"
        tone="danger"
        action={engineHasBrowser(state)
          ? login
          : <Link to={`/settings/pages/connect?forPage=${encodeURIComponent(label)}`} className="btn btn-sm">Подключить страницу Fansly</Link>}
      >
        {label}: Fansly не принимает вход. Из страницы ничего не читается.
      </Notice>,
    );
  } else if (browser !== undefined && (browser.proxy.problem === "unavailable" || browser.proxy.problem === "auth")) {
    notices.push(
      <Notice key="proxy" tone="danger">
        {label}: {browser.proxy.problem === "auth" ? "прокси не принимает вход." : "прокси недоступен."} Браузер страницы не может дойти до Fansly.
      </Notice>,
    );
  } else if (state.kind === "ready" && !state.status.owner.running) {
    const age = engineAgeText(state.status.owner.heartbeatAt);
    notices.push(
      <Notice key="owner" tone="danger">
        {label}: {age === null ? "сервер сбора не запущен." : `сервер сбора не отвечает ${age}.`} Из страницы ничего не читается.
      </Notice>,
    );
  }
  const browserLines = browser ? [...browserAlertLines(browser, Date.now()), ...browserBufferTroubleLines(browser, Date.now())] : [];
  const workLines = blocks
    .map((block) => ({ label: engineBlockLabel(block.block), text: engineAttentionText(block.engine) }))
    .filter((line) => line.text !== "")
    .map((line) => `${line.label}: ${line.text}.`);
  const warnings = [...browserLines.map((line) => `${line.charAt(0).toUpperCase()}${line.slice(1)}.`), ...workLines];
  if (warnings.length > 0 && notices.length < 2) {
    notices.push(
      <Notice key="work" tone="warning">
        <span className="block">{warnings.map((line) => <span key={line} className="block">{line}</span>)}</span>
      </Notice>,
    );
  }
  return <>{notices.slice(0, 2)}</>;
}

/** «Заявки на историю · открыто N» of the page: the first two, the rest on their screen. */
function PageRequests({ pageLabel }: { pageLabel: string }) {
  const open = useSyncHistoryRequests({ pageLabel, state: "open", limit: OPEN_REQUESTS_LIMIT });
  const list = openHistoryRequests(open.data?.requests ?? []);
  return (
    <section className="card" aria-labelledby="page-requests-title">
      <div className="card-header">
        <h2 id="page-requests-title" className="card-title">Заявки на историю{open.data ? ` · открыто ${list.length}` : ""}</h2>
        <Link to={`/system/history-requests?page=${encodeURIComponent(pageLabel)}`} className="link sys-header-link">Все заявки страницы</Link>
      </div>
      {open.isLoading && !open.data ? (
        <div className="card-body"><Skeleton width={240} /></div>
      ) : !open.data ? (
        <p className="card-body text-text-secondary">Заявки не загрузились.</p>
      ) : list.length === 0 ? (
        <p className="card-body text-text-secondary">Открытых заявок нет.</p>
      ) : (
        <EngineRequestsTable requests={list.slice(0, 2)} showPage={false} />
      )}
    </section>
  );
}

function FanslyBody({ page }: { page: SyncBlocksPage }) {
  const statusOf = useEngineStatusOf();
  const state = statusOf(page.pageLabel);
  return (
    <>
      <EngineNotices page={page} state={state} />
      <EngineBlocksTable page={page} />
      <PageRequests pageLabel={page.pageLabel} />
      <CoverageBlock pageLabel={page.pageLabel} pageId={page.pageId} />
      <EngineDetails page={page} state={state} />
    </>
  );
}

function OnlyFansBody({ page }: { page: SyncBlocksPage }) {
  const ofapi = useOfapi();
  return (
    <>
      {ofapi.status === "off" && (
        <OfapiOffBanner>Сбор этой страницы через него не идёт. Деньги, переписка и замеченные фаны приходят из ленты ChatSpace.</OfapiOffBanner>
      )}
      <OfapiUnknownNotice ofapi={ofapi} />
      {ofapi.status === "on" && page.diagnosis && <SyncDiagnosisHeadline diagnosis={page.diagnosis} />}
      <LegacyBlocksTable page={page} ofapi={ofapi.status} blocked={ofapi.block} />
    </>
  );
}

function Body({ pageLabel }: { pageLabel: string }) {
  // A page the catalog does not know is not asked for: the screen says so at once.
  const { findPageByLabel, pageCatalogState } = useDashboardShell();
  const unknown = pageCatalogState === "ready" && findPageByLabel(pageLabel) === null;
  const query = usePageSyncBlocks(pageLabel, { enabled: !unknown });
  const engines = useSyncEnginePages();
  const statusOf = useEngineStatusOf();
  const ofapi = useOfapi();
  const page = query.data?.page;
  const notFound = unknown || (query.error instanceof KernelApiError && query.error.status === 404);
  const row = page ? collectionRow(page, statusOf(page.pageLabel), ofapi.status) : null;
  const isFansly = page?.platform === "fansly";

  const description = page
    ? [platformName(page.platform), page.modelName, page.username ? `@${page.username}` : null].filter(Boolean).join(" · ")
    : undefined;
  const actions = (
    <>
      <OtherPageChip current={pageLabel} to={buildPageCollectionRoute} />
      <Link to={buildPageRoute(pageLabel)} className="btn">Карточка страницы</Link>
      {isFansly && (
        <Link to={buildPageSectionRoute(pageLabel, "browser-login")} className={row?.login ? "btn btn-primary" : "btn"}>Войти в Fansly</Link>
      )}
    </>
  );

  return (
    <div className="space-y-6 sys-screen">
      <PageHeader title={pageLabel} description={description} actions={actions} fresh={freshOf(query, [engines])} />
      {query.isLoading && !query.data && !notFound ? (
        <div className="card"><TableSkeleton rows={5} columns={5} /></div>
      ) : notFound ? (
        <div className="card">
          <StatusPanel
            title={`Страницы ${pageLabel} нет в списке сбора`}
            action={<Link to="/system/collection" className="btn btn-sm">К сбору данных</Link>}
          />
        </div>
      ) : !page ? (
        <div className="card">
          <StatusPanel
            tone="error"
            title="Hub не ответил"
            description="Числа не пришли. Это не ноль: данные могут быть, просто экран их не получил."
            action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}
          />
        </div>
      ) : (
        <>
          {row?.word && page.platform !== "telegram" && (
            <div className="sys-status-line" data-page-status>
              <StatusBadge status={row.word} />
              {row.second && <span className="text-text-secondary">{row.second}</span>}
            </div>
          )}
          {query.isError && (
            <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}>
              {staleDataText(query.dataUpdatedAt)}
            </Notice>
          )}
          {page.platform === "telegram" ? (
            <div className="card">
              <StatusPanel
                title="Сбор не нужен"
                description="Hub не собирает данные Telegram: расширение читает открытый чат само."
                action={<Link to={buildPageRoute(pageLabel)} className="btn btn-sm">Карточка страницы</Link>}
              />
            </div>
          ) : page.platform === "onlyfans" ? (
            <OnlyFansBody page={page} />
          ) : (
            <FanslyBody page={page} />
          )}
        </>
      )}
    </div>
  );
}

/** «Сбор данных страницы»: the page is in the path, never in the filter; a new page starts the screen anew (§3). */
export function CollectionPageDetail() {
  const { pageLabel: raw = "" } = useParams<{ pageLabel: string }>();
  const pageLabel = decodeRouteSegment(raw);
  return <Body key={pageLabel} pageLabel={pageLabel} />;
}
