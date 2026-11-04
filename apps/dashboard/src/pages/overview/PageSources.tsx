import { Link } from "react-router";
import type { PlatformRevenueWindow } from "@agency_hub_core/contracts";
import { usePageRevenue } from "@/api/pages";
import { IncomeKinds, incomeKindRows, type IncomeKindRow } from "@/components/money/IncomeKinds";
import { Skeleton } from "@/components/ui/Skeleton";
import { buildFansRoute, buildPageCollectionRoute, buildPageRoute } from "@/lib/navigation";
import { buildRevenueTransactionsRoute, buildSubscriberRoute } from "@/lib/overviewNavigation";
import { formatCount, formatUtcWindowRange } from "@/lib/format";
import { OFAPI_FROZEN_NOTE, type OfapiStatus } from "@/lib/statusWords";
import type { PeriodOption } from "@/stores/periodStore";
import { isAlertState } from "@/components/shared/syncUxDisplay";
import type { PageRow } from "./presentation.js";

/** Counts that only the switched-off API kept fresh: an OnlyFans page's, while it is off. */
export function frozenAudience(platform: string | null | undefined, ofapi: OfapiStatus): boolean {
  return platform === "onlyfans" && ofapi === "off";
}

function AudienceCount({ value, available, to, title, frozen }: {
  value: number | null;
  available: boolean;
  to: string;
  title: string;
  frozen: boolean;
}) {
  if (!available || value == null) return <span className="text-text-muted" title="Значения нет">—</span>;
  return (
    <span className="audience-cell">
      <Link className="money-link" to={to} title={title}>{formatCount(value)}</Link>
      {frozen && <span className="audience-note">{OFAPI_FROZEN_NOTE}</span>}
    </span>
  );
}

export function PaidSubscribersLink({ page, backTo, ofapi }: { page: PageRow; backTo: string; ofapi: OfapiStatus }) {
  const metric = page.catalog?.paidSubscriberCount;
  return (
    <AudienceCount
      value={metric?.value ?? null}
      available={Boolean(metric?.available) && page.status !== "deleted"}
      to={buildSubscriberRoute(page.pageLabel, "paid", backTo)}
      title="Оплатили текущий период подписки"
      frozen={frozenAudience(page.catalog?.platform ?? page.platform, ofapi)}
    />
  );
}

export function FreeAudienceLink({ page, backTo, ofapi }: { page: PageRow; backTo: string; ofapi: OfapiStatus }) {
  const metric = page.catalog?.freeAudienceCount;
  const fansly = page.catalog?.platform === "fansly";
  return (
    <AudienceCount
      value={metric?.value ?? null}
      available={Boolean(metric?.available) && page.status !== "deleted"}
      to={fansly ? buildFansRoute("followers", page.pageLabel) : buildSubscriberRoute(page.pageLabel, "free", backTo)}
      title={fansly ? "Фолловеры страницы" : "Бесплатные и пробные подписки"}
      frozen={frozenAudience(page.catalog?.platform ?? page.platform, ofapi)}
    />
  );
}

/** «Сейчас: 42 платных · 9 744 бесплатных», each a link to its list. */
export function AudienceNow({ page, backTo, ofapi }: { page: PageRow; backTo: string; ofapi: OfapiStatus }) {
  const paid = page.catalog?.paidSubscriberCount;
  const free = page.catalog?.freeAudienceCount;
  const fansly = page.catalog?.platform === "fansly";
  const count = (metric: typeof paid) => (metric?.available && metric.value !== null ? formatCount(metric.value) : "—");
  return (
    <span className="text-text-secondary">
      Сейчас:{" "}
      <Link className="money-link text-text-primary" to={buildSubscriberRoute(page.pageLabel, "paid", backTo)}>{count(paid)} платных</Link>
      {" · "}
      <Link className="money-link text-text-primary" to={fansly ? buildFansRoute("followers", page.pageLabel) : buildSubscriberRoute(page.pageLabel, "free", backTo)}>
        {count(free)} бесплатных
      </Link>
      {frozenAudience(page.catalog?.platform ?? page.platform, ofapi) && `, ${OFAPI_FROZEN_NOTE}`}
    </span>
  );
}

/** The window of a page's platform. */
export function pageWindowOf(page: PageRow, windows: readonly PlatformRevenueWindow[]) {
  const platform = page.platform ?? page.catalog?.platform;
  return windows.find((window) => window.platform === platform) ?? null;
}

/** What a page's sum opens: its operations in the exact window of its platform. */
export function pageTransactionsLink(page: PageRow, window: PlatformRevenueWindow | null, backTo: string, previous = false, type?: string) {
  if (!window) return null;
  return buildRevenueTransactionsRoute({
    pageLabel: page.pageLabel,
    from: previous ? window.comparisonFrom : window.from,
    to: previous ? window.comparisonTo : window.to,
    ...(type ? { type: type as NonNullable<Parameters<typeof buildRevenueTransactionsRoute>[0]["type"]> } : {}),
    backTo,
  });
}

/**
 * A page's kinds of income for the period, against the previous window: under
 * its row on Главная, or in the table's place when the filter is on that page.
 * Reads only; every sum opens the operations it is made of.
 */
export function PageKinds({ page, period, windowAt, windows, backTo, total }: {
  page: PageRow;
  period: PeriodOption;
  windowAt: string | undefined;
  windows: readonly PlatformRevenueWindow[];
  backTo: string;
  /** The page's own total as the last row, from the report. */
  total?: boolean;
}) {
  const active = page.status !== "deleted";
  // The report's clock: a second relative window cannot drift from the table's.
  const query = usePageRevenue(page.pageLabel, period, {
    enabled: active && Boolean(windowAt),
    ...(windowAt ? { windowAt } : {}),
  });
  const window = pageWindowOf(page, windows);
  const compare = period === "7d" || period === "30d";
  const amountLink = (row: IncomeKindRow, previous: boolean) => pageTransactionsLink(page, window, backTo, previous, row.canonicalType);

  if (!active) return <p className="row-detail-note">Страница удалена. Её доход сохранён, операции открываются по сумме в строке.</p>;
  if (query.isLoading) {
    return (
      <div role="status" className="row-detail-skeleton">
        <span className="sr-only">Загружаем виды дохода…</span>
        {[180, 140, 160].map((width) => <Skeleton key={width} width={width} />)}
      </div>
    );
  }
  if (!query.data) {
    return (
      <p className="row-detail-note">
        Виды дохода не пришли.{" "}
        <button type="button" className="link" onClick={() => void query.refetch()}>Повторить</button>
      </p>
    );
  }
  const rows = incomeKindRows(query.data);
  if (rows.length === 0 && !total) return <p className="row-detail-note">За этот период операций нет.</p>;
  return (
    <div className={query.isFetching ? "is-refreshing" : undefined}>
      {query.isError && (
        <p className="row-detail-note">
          Не удалось обновить.{" "}
          <button type="button" className="link" onClick={() => void query.refetch()}>Повторить</button>
        </p>
      )}
      <IncomeKinds
        rows={rows}
        label={`Виды дохода ${page.pageLabel}`}
        compare={compare}
        amountLink={amountLink}
        total={total ? {
          label: `Итого по ${page.pageLabel}`,
          currentNetMills: page.netEarningsMills,
          previousNetMills: page.previousNetEarningsMills ?? null,
          deltaNetMills: page.deltaNetMills ?? null,
          deltaPct: page.deltaPct ?? null,
        } : undefined}
      />
    </div>
  );
}

/** The expanded row of a page: «Виды дохода», its dates, the ways on. */
export function PageSources({ page, period, windowAt, windows, backTo, isOwner, ofapi, columns }: {
  page: PageRow;
  period: PeriodOption;
  windowAt: string | undefined;
  windows: PlatformRevenueWindow[];
  backTo: string;
  isOwner: boolean;
  ofapi: OfapiStatus;
  columns: number;
}) {
  const active = page.status !== "deleted";
  const window = pageWindowOf(page, windows);
  const platform = page.platform ?? page.catalog?.platform;
  const sync = page.catalog?.syncUx;
  // The owner's way to the page's collection when something there needs him;
  // not for OnlyFans while the API is off: there is nothing to fix.
  const checkSync = Boolean(sync && isAlertState(sync) && isOwner && !(platform === "onlyfans" && ofapi !== "on"));
  const all = pageTransactionsLink(page, window, backTo);

  return (
    <tr className="row-detail">
      <td colSpan={columns}>
        <div className="row-detail-body" id={`sources-${page.pageId}`}>
          <div className="row-detail-head">
            <h3 className="row-detail-title">Виды дохода</h3>
            {window && (
              <p className="row-detail-dates">
                {window.from && window.to ? formatUtcWindowRange(window.from, window.to) : "Вся сохранённая история"}
                {(period === "7d" || period === "30d") && window.comparisonFrom && window.comparisonTo &&
                  `, прошлый период: ${formatUtcWindowRange(window.comparisonFrom, window.comparisonTo)}`}
              </p>
            )}
          </div>
          <div className="row-detail-table">
            <PageKinds page={page} period={period} windowAt={windowAt} windows={windows} backTo={backTo} />
          </div>
          {(active || checkSync) && (
            <div className="flex flex-wrap items-center gap-2">
              {active && (
                <Link id={`source-page-${page.pageId}`} className="btn btn-sm" to={`${buildPageRoute(page.pageLabel)}?${new URLSearchParams({ period })}`} state={{ backTo }}>
                  Открыть страницу
                </Link>
              )}
              {all && <Link className="btn btn-sm" to={all}>Все операции за период</Link>}
              {checkSync && (
                <Link id={`source-sync-${page.pageId}`} className="btn btn-ghost btn-sm" to={buildPageCollectionRoute(page.pageLabel)}>
                  Сбор данных страницы
                </Link>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}
