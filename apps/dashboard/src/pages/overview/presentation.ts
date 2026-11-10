import type {
  OverviewResponse,
  OverviewRevenueResponse,
} from "@agency_hub_core/contracts";
import type { PageSort } from "@/lib/overviewNavigation";

export type CatalogPage = OverviewResponse["pages"][number];
export type RevenuePage = OverviewRevenueResponse["pages"][number];
export type PageRow = RevenuePage & { catalog: CatalogPage | undefined };

/** Russian plural: plural(2, "страница", "страницы", "страниц"). */
export function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
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

