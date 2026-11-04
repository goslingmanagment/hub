import type { SpenderDetailResponse } from "@agency_hub_core/contracts";
import { useSpenderDetail } from "@/api/queries";
import { MoneyDelta } from "@/components/money/Delta";
import { SpenderTrendPanel } from "@/components/shared/SpenderTrendPanel";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatDay, formatMills, formatTimeOfDay } from "@/lib/format";
import { SOURCE_LABELS } from "@/lib/revenueDisplay";
import { ruPlural } from "@/lib/plural";
import { lastPurchaseKind, periodColumn, previousPhrase, spenderPeriodOf } from "../fanWords.js";
import type { PayerRow } from "../useAllPayers.js";

type Detail = SpenderDetailResponse;

/** The two reads of the money block: the screen's period, and all time unless it is that. */
export function useFanMoney(platform: string, platformUserId: string, pageLabel: string, period: string) {
  const spenderPeriod = spenderPeriodOf(period);
  const windowQuery = useSpenderDetail(platform, platformUserId, { scope: "page", pageLabel, period: spenderPeriod });
  const lifetimeQuery = useSpenderDetail(platform, platformUserId, { scope: "page", pageLabel, period: "lifetime" });
  return { windowQuery, lifetimeQuery: period === "all" ? windowQuery : lifetimeQuery };
}

/**
 * The money strip: all time is the answer, the period beside it, the last purchase,
 * and over every page of the platform the viewer sees. No answer is «—», never a zero.
 */
export function FanMoneyTiles({ money, pageLabel, platformName, period, row, lastTransactionAt }: {
  money: ReturnType<typeof useFanMoney>;
  pageLabel: string;
  platformName: string;
  period: string;
  row: PayerRow | null | undefined;
  lastTransactionAt: string | null;
}) {
  const { windowQuery, lifetimeQuery } = money;
  const lifetime = lifetimeQuery.data;
  const window = windowQuery.data;
  const loading = (query: { data: unknown; isError: boolean }) => query.data === undefined && !query.isError;
  const noAnswer = <span className="stat-meta-error">Hub не ответил</span>;
  const pages = lifetime?.pages.length ?? 0;
  const last = row?.lastTransaction ?? null;
  const lastAt = last?.occurredAt ?? lastTransactionAt;

  return (
    <StatGrid className="fan-tiles">
      <Stat
        label="За всё время"
        value={lifetime ? formatMills(lifetime.metrics.lifetime.scopeCreatorNetAmountMills) : loading(lifetimeQuery) ? <Skeleton width={120} /> : "—"}
        meta={lifetime ? `на ${pageLabel}` : lifetimeQuery.isError ? noAnswer : undefined}
      />
      {period !== "all" && (
        <Stat
          label={periodColumn(period)}
          value={window?.metrics.window ? formatMills(window.metrics.window.creatorNetAmountMills) : loading(windowQuery) ? <Skeleton width={120} /> : "—"}
          meta={windowQuery.isError && !window
            ? noAnswer
            : window
              ? (period === "today" || !window.metrics.comparison
                ? "—"
                : <><MoneyDelta mills={window.metrics.comparison.deltaCreatorNetAmountMills} pct={window.metrics.comparison.deltaPct} /> {previousPhrase(period)}</>)
              : undefined}
        />
      )}
      <Stat
        label="Последняя покупка"
        value={lastAt ? formatDay(lastAt) : "—"}
        meta={last
          ? `${formatTimeOfDay(last.occurredAt)}, ${lastPurchaseKind(last.canonicalType)} ${formatMills(last.creatorNetAmountMills)}`
          : lastAt ? formatTimeOfDay(lastAt) : "Покупок не было"}
      />
      {pages > 1 && lifetime && (
        <Stat
          label={`Всего на ${platformName}`}
          value={formatMills(lifetime.metrics.lifetime.platformCreatorNetAmountMills)}
          meta={`на ${pages} ${ruPlural(pages, "странице", "страницах", "страницах")}`}
        />
      )}
    </StatGrid>
  );
}

/** Every kind of income in both columns, the zeros hidden; the total is the server's. */
function kindRows(window: Detail | undefined, lifetime: Detail | undefined) {
  const kinds = new Map<string, { window: number | null; lifetime: number | null }>();
  for (const item of window?.typeBreakdown ?? []) kinds.set(item.canonicalType, { window: item.creatorNetAmountMills, lifetime: null });
  for (const item of lifetime?.typeBreakdown ?? []) {
    kinds.set(item.canonicalType, { window: kinds.get(item.canonicalType)?.window ?? null, lifetime: item.creatorNetAmountMills });
  }
  return [...kinds.entries()]
    .filter(([, value]) => (value.window ?? 0) !== 0 || (value.lifetime ?? 0) !== 0)
    .sort((a, b) => (b[1].lifetime ?? 0) - (a[1].lifetime ?? 0));
}

/** «Из чего складывается» and «Траты по дням», one card. */
export function FanMoneyBreakdown({ money, period, pageLabel, platform, platformUserId }: {
  money: ReturnType<typeof useFanMoney>;
  period: string;
  pageLabel: string;
  platform: string;
  platformUserId: string;
}) {
  const { windowQuery, lifetimeQuery } = money;
  const window = windowQuery.data;
  const lifetime = lifetimeQuery.data;
  const showWindow = period !== "all";
  const rows = kindRows(showWindow ? window : undefined, lifetime);
  const cell = (value: number | null | undefined, query: { data: unknown; isError: boolean }) =>
    query.data === undefined ? (query.isError ? "—" : <Skeleton width={64} />) : formatMills(value ?? 0);

  return (
    <section className="card" aria-labelledby="fan-money-title">
      <div className="card-header">
        <div>
          <h2 id="fan-money-title" className="card-title">Из чего складывается</h2>
          <p className="card-description">После комиссии площадки, по операциям этой страницы.</p>
        </div>
      </div>
      {!window && !lifetime && (windowQuery.isError || lifetimeQuery.isError) ? (
        <NoAnswerPanel retry={() => { void windowQuery.refetch(); void lifetimeQuery.refetch(); }} />
      ) : (
        <div className="table-wrap">
          <table className="data-table fan-table" aria-label="Из чего складывается">
            <thead>
              <tr>
                <th scope="col">Вид дохода</th>
                {showWindow && <th scope="col" className="num">{periodColumn(period)}</th>}
                <th scope="col" className="num">За всё время</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (window || lifetime) && (
                <tr><td colSpan={showWindow ? 3 : 2} className="muted">Покупок не было.</td></tr>
              )}
              {rows.map(([type, value]) => (
                <tr key={type}>
                  <td>{SOURCE_LABELS[type] ?? type}</td>
                  {showWindow && <td className="num">{cell(value.window, windowQuery)}</td>}
                  <td className="num">{cell(value.lifetime, lifetimeQuery)}</td>
                </tr>
              ))}
              <tr className="row-total">
                <td>Итого</td>
                {showWindow && <td className="num">{window?.metrics.window ? formatMills(window.metrics.window.creatorNetAmountMills) : "—"}</td>}
                <td className="num">{lifetime ? formatMills(lifetime.metrics.lifetime.scopeCreatorNetAmountMills) : "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {period !== "today" && (
        <div className="fan-card-section">
          <h3 className="fan-subtitle">Траты по дням</h3>
          <SpenderTrendPanel
            pageLabel={pageLabel}
            platform={platform}
            platformUserId={platformUserId}
            period={period}
            tiles={false}
            headline={{ label: periodColumn(period), mills: null, count: null }}
          />
        </div>
      )}
    </section>
  );
}
