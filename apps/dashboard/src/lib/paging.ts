/** The most pages one chart follows before it stops and says so (the last
 *  page's `nextCursor` stays non-null, which the panel reads as "cut"). */
const MAX_FOLLOWED_PAGES = 10;

/**
 * Every page of a keyset-paged window, joined.
 *
 * A chart needs the WHOLE window, not its first page: profile traffic is eight
 * source codes a day, so 90 days is 720 rows against a 500-row page — and
 * with the rows ordered oldest first, the newest month silently fell off the
 * right edge of the chart.
 */
export async function followPages<T extends { nextCursor: string | null }>(
  fetchPage: (cursor: string | undefined) => Promise<T>,
  join: (first: T, pages: readonly T[]) => T,
): Promise<T> {
  const pages: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && pages.length < MAX_FOLLOWED_PAGES);
  return pages.length === 1 ? pages[0]! : join(pages[0]!, pages);
}
