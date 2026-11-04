import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { useSyncEnginePages, useSyncOverview } from "@/api/queries";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { staleDataText } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { RowMenu } from "@/components/ui/RowMenu";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { buildPageRoute, buildPageSectionRoute } from "@/lib/navigation";
import { isPlainRowClick } from "@/lib/rowClick";
import { COLLECTION_STATUS, type StatusWord } from "@/lib/statusWords";
import { useEngineStatusOf } from "@/pages/settings/engine/useEngineStatusOf";
import { freshOf, MomentCell, OfapiOffBanner, OfapiUnknownNotice, platformName, useOfapi } from "../shared.js";
import { collectionRow, sortRows, type CollectionRow } from "./collectionRows.js";
import { FanslyPauseCard } from "./FanslyPauseCard.js";

const NEEDS_ACTION: ReadonlySet<string> = new Set([
  COLLECTION_STATUS.requiresAction.word,
  COLLECTION_STATUS.attention.word,
  COLLECTION_STATUS.delayed.word,
]);

function collectionRoute(pageLabel: string): string {
  return `/system/collection/${encodeURIComponent(pageLabel)}`;
}

function is(word: StatusWord | null, other: StatusWord): boolean {
  return word !== null && word.word === other.word;
}

/** The three tiles: collected, needs an action, not collected on purpose. */
function Tiles({ rows, ofapiOn, enginesFailed }: { rows: readonly CollectionRow[]; ofapiOn: boolean; enginesFailed: boolean }) {
  const counted = rows.filter((row) => row.page.platform === "fansly" || (ofapiOn && row.page.platform === "onlyfans"));
  const working = counted.filter((row) => is(row.word, COLLECTION_STATUS.healthy)).length;
  const action = rows.filter((row) => row.word !== null && NEEDS_ACTION.has(row.word.word));
  const offOnPurpose = {
    onlyfans: rows.filter((row) => is(row.word, COLLECTION_STATUS.ofapiOff)).length,
    telegram: rows.filter((row) => is(row.word, COLLECTION_STATUS.notNeeded)).length,
    paused: rows.filter((row) => is(row.word, COLLECTION_STATUS.paused)).length,
  };
  const purposeTotal = offOnPurpose.onlyfans + offOnPurpose.telegram + offOnPurpose.paused;
  const purposeMeta = [
    offOnPurpose.onlyfans > 0 ? `OnlyFans ${offOnPurpose.onlyfans}` : null,
    offOnPurpose.telegram > 0 ? `Telegram ${offOnPurpose.telegram}` : null,
    offOnPurpose.paused > 0 ? `на паузе ${offOnPurpose.paused}` : null,
  ].filter(Boolean).join(", ");
  return (
    <StatGrid className="sys-tiles-3">
      <Stat
        label="Собираются"
        value={enginesFailed ? "—" : `${working} из ${counted.length}`}
        meta={enginesFailed ? "Hub не ответил" : ofapiOn ? "страниц" : "страниц Fansly"}
      />
      <Stat
        label="Нужно действие"
        value={enginesFailed ? "—" : action.length}
        meta={enginesFailed ? "Hub не ответил" : action.length === 0 ? "Всё в порядке" : action.map((row) => row.page.pageLabel).join(", ")}
      />
      <Stat label="Не собираются намеренно" value={purposeTotal} meta={purposeMeta || "таких нет"} />
    </StatGrid>
  );
}

function RowActions({ row }: { row: CollectionRow }) {
  const navigate = useNavigate();
  const label = row.page.pageLabel;
  const telegram = row.page.platform === "telegram";
  return (
    <div className="sys-actions-inner">
      {row.login && row.page.platform === "fansly" && (
        <Link to={buildPageSectionRoute(label, "browser-login")} className="btn btn-sm">Войти в Fansly</Link>
      )}
      <RowMenu
        label={`Ещё: ${label}`}
        items={telegram
          ? [{ label: "Карточка страницы", onSelect: () => navigate(buildPageRoute(label)) }]
          : [
            { label: "Сбор данных страницы", onSelect: () => navigate(collectionRoute(label)) },
            { label: "Карточка страницы", onSelect: () => navigate(buildPageRoute(label)) },
            { label: "Сбои страницы", onSelect: () => navigate(`/system/failures?page=${encodeURIComponent(label)}`) },
            { label: "Заявки на историю страницы", onSelect: () => navigate(`/system/history-requests?page=${encodeURIComponent(label)}`) },
          ]}
      />
    </div>
  );
}

function PagesTable({ rows }: { rows: readonly CollectionRow[] }) {
  const navigate = useNavigate();
  return (
    <div className="table-wrap">
      <table className="data-table sys-collection">
        <thead>
          <tr>
            <th>Страница</th>
            <th className="sys-col-platform">Площадка</th>
            <th>Состояние</th>
            <th>Последние данные</th>
            <th><span className="sr-only">Действия</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { page } = row;
            const telegram = page.platform === "telegram";
            const owner = [page.modelName, page.username ? `@${page.username}` : null].filter(Boolean).join(" · ");
            return (
              <tr
                key={page.pageId}
                className={telegram ? undefined : "sys-click-row"}
                data-collection-page={page.pageLabel}
                onClick={(event) => {
                  if (!telegram && isPlainRowClick(event)) navigate(collectionRoute(page.pageLabel));
                }}
              >
                <td>
                  <Link to={buildPageRoute(page.pageLabel)} className="sys-row-link">{page.pageLabel}</Link>
                  <span className="cell-second">
                    {owner}
                    <span className="sys-platform-inline"> · {platformName(page.platform)}</span>
                  </span>
                </td>
                <td className="sys-col-platform text-text-secondary">{platformName(page.platform)}</td>
                <td className="status-col">
                  {row.word === null ? (
                    <span className="skeleton" style={{ width: 96 }} aria-hidden="true" />
                  ) : telegram ? (
                    <StatusBadge status={row.word} bare />
                  ) : (
                    <Link to={collectionRoute(page.pageLabel)} className="sys-badge-link"><StatusBadge status={row.word} bare /></Link>
                  )}
                  {row.second && <span className="cell-second sys-clamp">{row.second}</span>}
                </td>
                <td className="text-text-secondary">{telegram ? "—" : <MomentCell at={row.lastAt} />}</td>
                <td className="sys-actions"><RowActions row={row} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** «Сбор данных»: every page in one table — is it collected and what to press (design/screens/system.md §2). */
export function CollectionPage() {
  const overview = useSyncOverview();
  const engines = useSyncEnginePages();
  const statusOf = useEngineStatusOf();
  const ofapi = useOfapi();
  const filter = usePageFilter();

  const allRows = useMemo(() => {
    const now = Date.now();
    return sortRows((overview.data?.pages ?? []).map((page) => collectionRow(page, statusOf(page.pageLabel), ofapi.status, now)));
    // statusOf is rebuilt every render from the engine read; its data is the dependency.
  }, [overview.data, engines.data, engines.isError, ofapi.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageLabel = filter.page;
  const rows = pageLabel ? allRows.filter((row) => row.page.pageLabel === pageLabel) : allRows;
  const othersNeedAction = pageLabel
    ? allRows.filter((row) => row.page.pageLabel !== pageLabel && row.word !== null && NEEDS_ACTION.has(row.word.word)).length
    : 0;
  const stale = overview.isError && overview.data !== undefined;

  return (
    <div className="space-y-6 sys-screen">
      <PageHeader fresh={freshOf(overview, [engines])} />

      {overview.isLoading && !overview.data ? (
        <>
          {!pageLabel && <StatCardSkeleton count={3} />}
          <div className="card"><TableSkeleton rows={9} columns={5} /></div>
        </>
      ) : !overview.data ? (
        <div className="card"><NoAnswerPanel retry={overview.refetch} /></div>
      ) : (
        <>
          {pageLabel ? (
            <p className="table-toolbar-note">
              Показана только {pageLabel}.
              {othersNeedAction > 0 && <> Нужно действие ещё на {othersNeedAction} {othersNeedAction === 1 ? "странице" : "страницах"}.</>}{" "}
              <button type="button" className="link" onClick={() => filter.select(null)}>Показать все страницы</button>
            </p>
          ) : allRows.length > 0 && (
            <Tiles rows={allRows} ofapiOn={ofapi.status === "on"} enginesFailed={engines.isError && !engines.data} />
          )}

          {ofapi.status === "off" && (
            <OfapiOffBanner>Страницы OnlyFans через него не собираются. Деньги и переписка приходят из ленты ChatSpace.</OfapiOffBanner>
          )}
          <OfapiUnknownNotice ofapi={ofapi} />
          {stale && (
            <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void overview.refetch()}>Повторить</button>}>
              {staleDataText(overview.dataUpdatedAt)}
            </Notice>
          )}

          <section className="card" aria-labelledby="collection-pages-title">
            <div className="card-header">
              <h2 id="collection-pages-title" className="card-title">Страницы</h2>
            </div>
            {allRows.length === 0 ? (
              <StatusPanel
                title="Страниц пока нет"
                description="Сбор страницы начинается с её подключения."
                action={<Link to="/settings/pages/connect" className="btn btn-sm">Подключить страницу Fansly</Link>}
              />
            ) : rows.length === 0 ? (
              <StatusPanel
                title={`Для ${pageLabel} данных сбора нет`}
                action={<button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Показать все страницы</button>}
              />
            ) : (
              <PagesTable rows={rows} />
            )}
          </section>
        </>
      )}

      <FanslyPauseCard filteredPage={pageLabel} />

      <Disclosure label="Как это считается">
        <p>
          Работает: Hub читает страницу, и ничто его не держит. Отстаёт: часть данных приходит позже обычного. Не читается: страницу
          никто не читает, например молчит сервер сбора или нет прокси. Нужен вход: Fansly вышел из аккаунта, без входа новых данных нет.
          На паузе: все блоки остановлены вами. Выключено с 1 ноября: OnlyFans API выключен. Сбор не нужен: у Telegram расширение читает
          открытый чат само. Последние данные: самое свежее чтение любого блока страницы.
        </p>
      </Disclosure>
    </div>
  );
}
