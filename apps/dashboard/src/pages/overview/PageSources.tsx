import { useSyncExternalStore } from "react";
import { Link } from "react-router";
import type { PlatformRevenueWindow } from "@agency_hub_core/contracts";
import { usePageRevenue } from "@/api/pages";
import {
  buildPageRoute,
  buildPageSectionRoute,
  buildPageSyncRoute,
} from "@/lib/navigation";
import {
  buildRevenueTransactionsRoute,
  buildSubscriberRoute,
} from "@/lib/overviewNavigation";
import type { PeriodOption } from "@/stores/periodStore";
import { isAlertState } from "@/components/shared/syncUxDisplay";
import {
  SOURCE_LABELS,
  money,
  describeWindows,
  type PageRow,
} from "./presentation.js";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { RevenueDelta } from "./RevenueValue.js";

// Match the two column-hiding breakpoints in overview.css. A spanning cell
// must use the visible count, otherwise native tables create phantom columns.
const hiddenColumnQueries = ["(max-width: 1024px)", "(max-width: 900px)"];
function subscribeColumns(notify: () => void) {
  const queries = hiddenColumnQueries.map((query) => window.matchMedia(query));
  for (const query of queries) query.addEventListener("change", notify);
  return () => {
    for (const query of queries) query.removeEventListener("change", notify);
  };
}
function visibleColumns() {
  return 5 - hiddenColumnQueries.filter((query) => window.matchMedia(query).matches).length;
}

export function AudienceLink({
  page,
  backTo,
}: {
  page: PageRow;
  backTo: string;
}) {
  const metric = page.catalog?.subscriberCount;
  if (!metric?.available || metric.value == null || page.status === "deleted")
    return <span title="Счётчик недоступен">—</span>;
  return (
    <Link
      className="v1-audience-link"
      to={buildSubscriberRoute(page.pageLabel, "all", backTo)}
      title="Текущий список Hub; может отличаться от счётчика страницы. Это не число платящих."
    >
      {metric.value.toLocaleString("ru-RU")}
    </Link>
  );
}

export function PageSources({
  page,
  period,
  windowAt,
  windows,
  backTo,
  showChart,
  isOwner,
}: {
  page: PageRow;
  period: PeriodOption;
  windowAt: string | undefined;
  windows: PlatformRevenueWindow[];
  backTo: string;
  showChart: (scope: string) => void;
  isOwner: boolean;
}) {
  const columnCount = useSyncExternalStore(subscribeColumns, visibleColumns, () => 5);
  const active = page.status !== "deleted";
  // Avoid resolving a second relative window against a newer server clock.
  const query = usePageRevenue(page.pageLabel, period, {
    enabled: active && Boolean(windowAt),
    ...(windowAt ? { windowAt } : {}),
  });
  const report = query.data;
  const platform = page.platform ?? page.catalog?.platform;
  const pageWindow = windows.find((window) => window.platform === platform);
  const rows =
    report?.comparison?.sources ??
    report?.breakdown.map((source) => ({
      ...source,
      currentNetMills: source.netAmountMills,
      previousNetMills: null,
      deltaNetMills: null,
      deltaPct: null,
    }));
  const sync = page.catalog?.syncUx;
  const transactionsLink = (
    previous: boolean,
    type?: NonNullable<typeof rows>[number]["canonicalType"],
  ) =>
    pageWindow
      ? buildRevenueTransactionsRoute({
          pageLabel: page.pageLabel,
          from: previous ? pageWindow.comparisonFrom : pageWindow.from,
          to: previous ? pageWindow.comparisonTo : pageWindow.to,
          ...(type ? { type } : {}),
          backTo,
        })
      : null;

  return (
    <tr className="v1-detail-row">
      <td colSpan={columnCount}>
        <div className="v1-detail" id={`sources-${page.pageId}`}>
          <section className="v1-detail-section">
            <h3>Источники дохода · {page.pageLabel}</h3>
            <QueryNotice
              error={query.isError}
              stale={Boolean(report)}
              retry={query.refetch}
            />
            {!active ? (
              <p>
                Страница удалена. Её доход сохранён; операции доступны по ссылке
                на сумму.
              </p>
            ) : !windowAt ? (
              <p>
                Сервер не поддерживает закреплённое окно. Детализация
                недоступна.
              </p>
            ) : query.isLoading ? (
              <p role="status">Загружаем источники…</p>
            ) : (
              rows && (
                <div className="v1-sources-wrap">
                  <table
                    className="v1-sources"
                    aria-label={`Сравнение источников ${page.pageLabel}`}
                  >
                    <thead>
                      <tr>
                        <th>Источник</th>
                        <th>Выбрано</th>
                        <th>Ранее</th>
                        <th>Изменение</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((source) => (
                        <tr key={source.canonicalType}>
                          <th scope="row">
                            {SOURCE_LABELS[source.canonicalType] ??
                              source.canonicalType}
                          </th>
                          <td>
                            {transactionsLink(false, source.canonicalType) ? (
                              <Link
                                id={`source-current-${page.pageId}-${source.canonicalType}`}
                                className="v1-audience-link"
                                to={
                                  transactionsLink(false, source.canonicalType)!
                                }
                              >
                                {money(source.currentNetMills)}
                              </Link>
                            ) : (
                              money(source.currentNetMills)
                            )}
                          </td>
                          <td>
                            {source.previousNetMills != null &&
                            transactionsLink(true, source.canonicalType) ? (
                              <Link
                                id={`source-previous-${page.pageId}-${source.canonicalType}`}
                                className="v1-audience-link"
                                to={
                                  transactionsLink(true, source.canonicalType)!
                                }
                              >
                                {money(source.previousNetMills)}
                              </Link>
                            ) : (
                              money(source.previousNetMills)
                            )}
                          </td>
                          <td>
                            <RevenueDelta {...source} />
                          </td>
                        </tr>
                      ))}
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={4}>В этом окне операций не записано.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )
            )}
            {report && (
              <p className="v1-zero-note">
                В итог входят корректировки {money(report.adjustmentMills)} и
                суммы без классификации {money(report.unclassifiedMills)}. Ноль
                в Hub не доказывает отсутствие возвратов на платформе.
              </p>
            )}
            <div className="v1-detail-actions">
              {active && (
                <button
                  id={`source-chart-${page.pageId}`}
                  type="button"
                  className="v1-text-button"
                  onClick={() => showChart(`page:${page.pageLabel}`)}
                >
                  Показать на графике ↓
                </button>
              )}
              {transactionsLink(false) && (
                <Link
                  id={`source-operations-${page.pageId}`}
                  className="v1-external-link"
                  to={transactionsLink(false)!}
                >
                  Все операции окна →
                </Link>
              )}
              {active && (
                <Link
                  id={`source-page-${page.pageId}`}
                  className="v1-external-link"
                  to={`${buildPageRoute(page.pageLabel)}?${new URLSearchParams({ period })}`}
                  state={{ backTo }}
                >
                  Страница →
                </Link>
              )}
            </div>
          </section>
          <section className="v1-detail-section v1-detail-notes">
            <h3>Контекст сравнения</h3>
            <p className="v1-mobile-previous">
              Предыдущее окно:{" "}
              <strong>{money(page.previousNetEarningsMills)}</strong>.
            </p>
            {pageWindow && (
              <p>
                Выбрано: {describeWindows([pageWindow])}.<br />
                Ранее:{" "}
                {period === "all"
                  ? "сравнения нет"
                  : describeWindows([pageWindow], true)}
                . Даты UTC.
              </p>
            )}
            <p>
              Текущий день ещё идёт. Здесь сравниваются сохранённые операции
              Hub; полнота истории на платформе не подтверждена.
            </p>
            {sync && isAlertState(sync) && (
              <p className="v1-capture-note">
                Сбор: {sync.label}. {sync.detail}{" "}
                {isOwner && platform && (
                  <Link
                    className="v1-external-link"
                    to={buildPageSyncRoute(platform, page.pageLabel)}
                  >
                    Проверить сбор →
                  </Link>
                )}
              </p>
            )}
            {active && (
              <div className="v1-detail-actions">
                <Link
                  id={`expiring-subscribers-${page.pageId}`}
                  className="v1-external-link"
                  to={buildSubscriberRoute(
                    page.pageLabel,
                    "expiring7d",
                    backTo,
                  )}
                >
                  Истекают ≤7 дней →
                </Link>
                <Link
                  id={`norenew-subscribers-${page.pageId}`}
                  className="v1-external-link"
                  to={buildSubscriberRoute(page.pageLabel, "norenew", backTo)}
                >
                  Автопродление выключено →
                </Link>
              </div>
            )}
            {active && (
              <details className="v1-audience-note">
                <summary>Аудитория страницы</summary>
                <p>
                  Подписчики: <AudienceLink page={page} backTo={backTo} />.{" "}
                  {platform === "fansly"
                    ? "Счётчик Fansly; подписчики входят во followers. Список Hub может отличаться."
                    : "Текущие записи подписок Hub; счётчик followers недоступен."}
                </p>
                <p>
                  Это доступ к странице, включая бесплатный и пробный. Период
                  дохода не меняет текущую аудиторию.
                </p>
                {platform === "fansly" &&
                  page.catalog?.followerCount.available &&
                  page.catalog.followerCount.value != null && (
                    <p>
                      Followers:{" "}
                      <Link
                        className="v1-audience-link"
                        to={`${buildPageSectionRoute(page.pageLabel, "followers")}?${new URLSearchParams({ backTo })}`}
                      >
                        {page.catalog.followerCount.value.toLocaleString(
                          "ru-RU",
                        )}
                      </Link>
                      .
                    </p>
                  )}
                <p>
                  Нет даты окончания или статуса продления — запись не попадает
                  в соответствующий фильтр.
                </p>
              </details>
            )}
          </section>
        </div>
      </td>
    </tr>
  );
}
