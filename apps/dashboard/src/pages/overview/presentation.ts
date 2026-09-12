import type {
  OverviewResponse,
  OverviewRevenueResponse,
  PlatformRevenueWindow,
} from "@agency_hub_core/contracts";
import { PLATFORM_DISPLAY_NAME } from "@/lib/platformUrls";
import type { PageSort } from "@/lib/overviewNavigation";

export type CatalogPage = OverviewResponse["pages"][number];
export type RevenuePage = OverviewRevenueResponse["pages"][number];
export type PageRow = RevenuePage & { catalog: CatalogPage | undefined };
export { SOURCE_LABELS, money, signedMoney } from "@/lib/revenueDisplay";

/** Calendar padding is presentation of stored daily sums, not a claim about
 * platform capture. Unbounded history uses only its observed date extent. */
export function calendarSeries(
  series: Array<{ businessDate: string; netAmountMills: number }>,
  windows: PlatformRevenueWindow[],
) {
  const bounded = windows.filter((window) => window.from && window.to);
  const from =
    bounded
      .map((window) => window.from!)
      .sort()[0]
      ?.slice(0, 10) ?? series[0]?.businessDate;
  const exclusiveTo = bounded
    .map((window) => window.to!)
    .sort()
    .at(-1);
  const to = exclusiveTo
    ? new Date(Date.parse(exclusiveTo) - 1).toISOString().slice(0, 10)
    : series.at(-1)?.businessDate;
  if (!from || !to) return [];
  const values = new Map(
    series.map((point) => [point.businessDate, point.netAmountMills]),
  );
  const result: Array<{ businessDate: string; value: number }> = [];
  for (
    const day = new Date(`${from}T00:00:00Z`);
    day.toISOString().slice(0, 10) <= to;
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    const businessDate = day.toISOString().slice(0, 10);
    result.push({ businessDate, value: values.get(businessDate) ?? 0 });
  }
  return result;
}
export function groupRevenue(
  report: OverviewRevenueResponse,
  catalog: CatalogPage[],
  sort: PageSort,
) {
  const metadata = new Map(catalog.map((page) => [page.id, page]));
  return [...report.models]
    .sort(
      (a, b) =>
        b.netEarningsMills - a.netEarningsMills ||
        a.modelSlug.localeCompare(b.modelSlug),
    )
    .map((model) => {
      const pages = report.pages
        .filter((page) => page.modelSlug === model.modelSlug)
        .map((page) => ({ ...page, catalog: metadata.get(page.pageId) }));
      if (sort !== "source")
        pages.sort((a, b) => {
          if (a.deltaNetMills == null) return b.deltaNetMills == null ? 0 : 1;
          if (b.deltaNetMills == null) return -1;
          return (
            (sort === "decline"
              ? a.deltaNetMills - b.deltaNetMills
              : b.deltaNetMills - a.deltaNetMills) ||
            a.pageLabel.localeCompare(b.pageLabel)
          );
        });
      return { model, pages };
    });
}
const dayFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
export function windowLabel(from: string | null, to: string | null): string {
  return from && to
    ? `${dayFormat.format(new Date(from))} — ${dayFormat.format(new Date(Date.parse(to) - 1))}`
    : "Вся сохранённая история";
}
export function describeWindows(
  windows: PlatformRevenueWindow[],
  previous = false,
) {
  return windows
    .map(
      (window) =>
        `${PLATFORM_DISPLAY_NAME[window.platform]}: ${windowLabel(previous ? window.comparisonFrom : window.from, previous ? window.comparisonTo : window.to)}`,
    )
    .join(" · ");
}
export function describeMixedRevenueWindows(
  windows: PlatformRevenueWindow[] | undefined,
  periodLabel: string,
): string | null {
  if (!windows || windows.length < 2) return null;
  const spans = windows
    .filter((window) => window.from && window.to)
    .map((window) => ({
      platform: PLATFORM_DISPLAY_NAME[window.platform],
      days: Math.round(
        (Date.parse(window.to!) - Date.parse(window.from!)) / 86_400_000,
      ),
    }));
  if (spans.length < 2 || new Set(spans.map((span) => span.days)).size < 2)
    return null;
  return `“${periodLabel}” uses ${spans.map((span) => `${span.days} days on ${span.platform}`).join(", ")}. Each page is compared with its own preceding window.`;
}
