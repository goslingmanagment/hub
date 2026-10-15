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

/** Russian plural: plural(2, "страница", "страницы", "страниц"). */
export function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** A server-computed change in percent, as the table prints it. */
export function formatPct(pct: number) {
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

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

/** The pages that moved most against the previous window, from the server's
 * own per-page deltas. Nothing when no page has a comparison. */
export function biggestMovers(pages: RevenuePage[]) {
  const compared = pages
    .filter((page) => page.deltaNetMills != null && page.deltaNetMills !== 0)
    .sort(
      (a, b) =>
        b.deltaNetMills! - a.deltaNetMills! ||
        a.pageLabel.localeCompare(b.pageLabel),
    );
  const first = compared[0];
  const last = compared.at(-1);
  return {
    growth: first && first.deltaNetMills! > 0 ? first : undefined,
    decline: last && last.deltaNetMills! < 0 ? last : undefined,
  };
}

const dayMonth = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const withYear = (date: Date) =>
  `${dayMonth.format(date)} ${date.getUTCFullYear()}`;

/** "8 окт. — 15 окт. 2026" for a window whose end is exclusive. */
export function windowLabel(from: string | null, to: string | null): string {
  if (!from || !to) return "Вся сохранённая история";
  const start = new Date(from);
  const end = new Date(Date.parse(to) - 1);
  if (start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10))
    return withYear(start);
  return `${start.getUTCFullYear() === end.getUTCFullYear() ? dayMonth.format(start) : withYear(start)} — ${withYear(end)}`;
}

/** One range when every platform shares it; each platform's range otherwise
 * (OnlyFans windows run a day longer, see describeMixedRevenueWindows). */
export function describeWindows(
  windows: PlatformRevenueWindow[],
  previous = false,
) {
  const labels = windows.map((window) => ({
    platform: PLATFORM_DISPLAY_NAME[window.platform],
    text: windowLabel(
      previous ? window.comparisonFrom : window.from,
      previous ? window.comparisonTo : window.to,
    ),
  }));
  if (new Set(labels.map((label) => label.text)).size <= 1)
    return labels[0]?.text ?? windowLabel(null, null);
  return labels.map((label) => `${label.platform}: ${label.text}`).join(" · ");
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
  const parts = spans.map(
    (span) =>
      `${span.days} ${plural(span.days, "день", "дня", "дней")} у ${span.platform}`,
  );
  return `Период «${periodLabel}» охватывает ${parts.slice(0, -1).join(", ")} и ${parts.at(-1)}; каждая страница сравнивается с предыдущим окном своей длины.`;
}
