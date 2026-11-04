/**
 * `?page=` as an address says it (design/ia.md §3.2). One value is reserved:
 * `?page=all` opens every page by link, stronger than the remembered filter and
 * leaving it alone. A link that counts over every page («Ждут вас», «На смене»)
 * must open every page, whatever was picked by hand.
 *
 * The value is the filter's: it never reaches a request and never the memory.
 * Whoever reads the address reads it through here.
 */
export const ALL_PAGES_PARAM = "all";

/** The page this address narrows to; null: no page in it, or every page by link. */
export function pageFromSearch(search: URLSearchParams): string | null {
  const raw = search.get("page");
  return raw === null || raw === "" || raw === ALL_PAGES_PARAM ? null : raw;
}

/**
 * A screen that rebuilds its address from its own view carries `?page=all`
 * across a change of the rest: without it the memory would take over on the
 * next render and the screen would jump to another page's rows.
 */
export function keepAllPages(current: URLSearchParams, next: URLSearchParams): URLSearchParams {
  if (current.get("page") === ALL_PAGES_PARAM && !next.has("page")) next.set("page", ALL_PAGES_PARAM);
  return next;
}
