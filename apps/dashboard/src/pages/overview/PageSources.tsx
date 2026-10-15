import { Link } from "react-router";
import type { PlatformRevenueWindow } from "@agency_hub_core/contracts";
import { usePageRevenue } from "@/api/pages";
import { buildPageRoute, buildPageSyncRoute } from "@/lib/navigation";
import {
  buildRevenueTransactionsRoute,
  buildSubscriberRoute,
} from "@/lib/overviewNavigation";
import type { PeriodOption } from "@/stores/periodStore";
import { isAlertState } from "@/components/shared/syncUxDisplay";
import { SOURCE_LABELS, money, windowLabel, type PageRow } from "./presentation.js";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { RevenueDelta } from "./RevenueValue.js";

export function AudienceLink({
  page,
  backTo,
}: {
  page: PageRow;
  backTo: string;
}) {
  const metric = page.catalog?.subscriberCount;
  if (!metric?.available || metric.value == null || page.status === "deleted")
    return (
      <span className="text-text-muted" title="Счётчик недоступен">
        —
      </span>
    );
  return (
    <Link
      className="ov-money-link"
      to={buildSubscriberRoute(page.pageLabel, "all", backTo)}
      title="Текущие подписчики страницы"
    >
      {metric.value.toLocaleString("ru-RU")}
    </Link>
  );
}

/** The expanded row of a page: where its money came from, against the
 *  previous window, each amount opening its operations. */
export function PageSources({
  page,
  period,
  windowAt,
  windows,
  backTo,
  isOwner,
}: {
  page: PageRow;
  period: PeriodOption;
  windowAt: string | undefined;
  windows: PlatformRevenueWindow[];
  backTo: string;
  isOwner: boolean;
}) {
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
  // The row's badge names the problem; the owner gets the way to fix it.
  const checkSync = Boolean(sync && isAlertState(sync) && isOwner) && platform;
  const transactionsLink = (
    previous: boolean,
    type: NonNullable<typeof rows>[number]["canonicalType"],
  ) =>
    pageWindow
      ? buildRevenueTransactionsRoute({
          pageLabel: page.pageLabel,
          from: previous ? pageWindow.comparisonFrom : pageWindow.from,
          to: previous ? pageWindow.comparisonTo : pageWindow.to,
          type,
          backTo,
        })
      : null;
  const amountLink = (
    previous: boolean,
    source: NonNullable<typeof rows>[number],
  ) => {
    const value = previous ? source.previousNetMills : source.currentNetMills;
    const to = value == null ? null : transactionsLink(previous, source.canonicalType);
    return to ? (
      <Link
        id={`source-${previous ? "previous" : "current"}-${page.pageId}-${source.canonicalType}`}
        className="ov-money-link"
        to={to}
      >
        {money(value)}
      </Link>
    ) : (
      money(value)
    );
  };

  return (
    <tr className="ov-detail-row">
      <td colSpan={5}>
        <div className="ov-detail" id={`sources-${page.pageId}`}>
          <div className="ov-detail-head">
            <h3 className="ov-detail-title">Источники дохода</h3>
            {pageWindow && (
              <p className="ov-detail-dates">
                {windowLabel(pageWindow.from, pageWindow.to)}
                {period !== "all" &&
                  pageWindow.comparisonFrom &&
                  ` · прошлый период: ${windowLabel(pageWindow.comparisonFrom, pageWindow.comparisonTo)}`}
              </p>
            )}
          </div>
          <QueryNotice
            error={query.isError}
            stale={Boolean(report)}
            retry={query.refetch}
          />
          {!active ? (
            <p className="ov-detail-note">
              Страница удалена. Её доход сохранён; операции открываются по
              ссылке на сумму в строке.
            </p>
          ) : !windowAt ? (
            <p className="ov-detail-note">
              Детализация недоступна: сервер не поддерживает этот запрос.
            </p>
          ) : query.isLoading ? (
            <p className="ov-detail-note" role="status">
              Загружаем источники…
            </p>
          ) : (
            rows && (
              <div className="ov-sources-wrap">
                <table
                  className="ov-sources"
                  aria-label={`Источники дохода ${page.pageLabel}`}
                >
                  <thead>
                    <tr>
                      <th scope="col">Источник</th>
                      <th scope="col" className="num">
                        Доход
                      </th>
                      <th scope="col" className="num ov-sources-previous">
                        Прошлый период
                      </th>
                      <th scope="col" className="num">
                        Изменение
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((source) => (
                      <tr key={source.canonicalType}>
                        <th scope="row">
                          {SOURCE_LABELS[source.canonicalType] ??
                            source.canonicalType}
                        </th>
                        <td className="num">{amountLink(false, source)}</td>
                        <td className="num ov-sources-previous">
                          {amountLink(true, source)}
                        </td>
                        <td className="num">
                          <RevenueDelta {...source} />
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="ov-detail-note">
                          За этот период операций нет.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )
          )}
          {(active || checkSync) && (
            <div className="flex flex-wrap items-center gap-2">
              {active && (
                <Link
                  id={`source-page-${page.pageId}`}
                  className="btn btn-sm"
                  to={`${buildPageRoute(page.pageLabel)}?${new URLSearchParams({ period })}`}
                  state={{ backTo }}
                >
                  Открыть страницу
                </Link>
              )}
              {checkSync && (
                <Link
                  id={`source-sync-${page.pageId}`}
                  className="btn btn-ghost btn-sm"
                  to={buildPageSyncRoute(platform, page.pageLabel)}
                >
                  Проверить сбор данных
                </Link>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}
