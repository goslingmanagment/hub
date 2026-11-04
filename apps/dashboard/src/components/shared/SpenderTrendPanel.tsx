import { useSpenderSeries } from "@/api/queries";
import { ChartTable } from "@/components/charts/ChartTable";
import { RevenueLineChart, type RevenueLinePoint } from "@/components/charts/RevenueLineChart";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatBusinessDateShort, formatCount, formatMills } from "@/lib/format";

/** The headline numbers the caller already has, from the list's row or the card. */
export interface TrendHeadline {
  /** «За 7 дней»: the period's sum; for all time, the lifetime one. */
  label: string;
  mills: number | null;
  /** The period's operations; for all time the series' own count. */
  count: number | null;
}

/**
 * «Траты по дням»: the fan's money a day over the screen's period, a straight line,
 * no fill. «Сегодня» or a single point: the tiles only. Reads only.
 */
export function SpenderTrendPanel({ pageLabel, platform, platformUserId, period, headline, tiles = true }: {
  /** Null: every page of the platform. */
  pageLabel: string | null;
  platform: string;
  platformUserId: string;
  /** The screen's period key: `all` is asked as `lifetime`. */
  period: string;
  headline: TrendHeadline;
  /** The fan's card has its own tiles above. */
  tiles?: boolean;
}) {
  const spenderPeriod = period === "all" ? "lifetime" : period;
  const query = useSpenderSeries(platform, platformUserId, {
    scope: pageLabel ? "page" : "agency",
    ...(pageLabel ? { pageLabel } : {}),
    period: spenderPeriod,
    granularity: "auto",
  });

  if (!query.data) {
    if (query.isError) return <NoAnswerPanel retry={query.refetch} />;
    return (
      <div className="fan-trend" aria-busy="true">
        {tiles && <StatGrid><Stat label={headline.label} value={<Skeleton width={96} />} /><Stat label="Операций" value={<Skeleton width={48} />} /><Stat label="Самый крупный день" value={<Skeleton width={96} />} /></StatGrid>}
        <div className="fan-trend-chart"><Skeleton width="100%" className="!h-[200px]" /></div>
      </div>
    );
  }

  const buckets = query.data.items;
  const points: RevenueLinePoint[] = buckets.map((bucket) => ({ date: bucket.fromBusinessDate, current: bucket.metrics.creatorNetAmountMills }));
  const largest = buckets.reduce<(typeof buckets)[number] | null>(
    (best, bucket) => (best === null || bucket.metrics.creatorNetAmountMills > best.metrics.creatorNetAmountMills ? bucket : best),
    null,
  );
  // A count of operations, not money: plain arithmetic.
  const seriesCount = buckets.reduce((sum, bucket) => sum + bucket.metrics.transactionCount, 0);
  const spent = buckets.some((bucket) => bucket.metrics.creatorNetAmountMills !== 0);
  const count = period === "all" ? seriesCount : headline.count;

  return (
    <div className="fan-trend">
      {tiles && (
        <StatGrid>
          <Stat label={headline.label} value={headline.mills === null ? "—" : formatMills(headline.mills)} />
          <Stat label="Операций" value={count === null ? "—" : formatCount(count)} />
          <Stat
            label="Самый крупный день"
            value={largest && largest.metrics.creatorNetAmountMills > 0 ? formatMills(largest.metrics.creatorNetAmountMills) : "—"}
            meta={largest && largest.metrics.creatorNetAmountMills > 0 ? formatBusinessDateShort(largest.fromBusinessDate) : undefined}
          />
        </StatGrid>
      )}
      {!tiles && largest && largest.metrics.creatorNetAmountMills > 0 && (
        <p className="fan-trend-note">Самый крупный день: <span className="tabular-nums">{formatMills(largest.metrics.creatorNetAmountMills)}</span>, {formatBusinessDateShort(largest.fromBusinessDate)}</p>
      )}
      {!spent ? (
        <div className="empty"><p className="empty-title">За этот период трат нет.</p></div>
      ) : period === "today" || points.length < 2 ? null : (
        <>
          <div className="fan-trend-chart">
            <RevenueLineChart points={points} currentLabel="Траты" formatDate={formatBusinessDateShort} height={220} />
          </div>
          <ChartTable
            rows={buckets}
            rowKey={(bucket) => bucket.fromBusinessDate}
            caption="Траты по дням"
            columns={[
              { key: "day", label: "День", value: (bucket) => bucket.fromBusinessDate === bucket.toBusinessDateInclusive ? formatBusinessDateShort(bucket.fromBusinessDate) : `${formatBusinessDateShort(bucket.fromBusinessDate)} – ${formatBusinessDateShort(bucket.toBusinessDateInclusive)}` },
              { key: "count", label: "Операций", num: true, value: (bucket) => formatCount(bucket.metrics.transactionCount) },
              { key: "net", label: "После комиссии", num: true, value: (bucket) => formatMills(bucket.metrics.creatorNetAmountMills) },
            ]}
          />
        </>
      )}
    </div>
  );
}
