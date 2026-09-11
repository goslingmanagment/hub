/** An explicit unavailable target must never fall back to another account. */
export function resolveOfapiPage<T extends { id: number; label: string }>(
  pages: readonly T[] | undefined,
  requestedLabel: string | null,
): T | undefined {
  return requestedLabel === null
    ? pages?.[0]
    : pages?.find((page) => page.label === requestedLabel);
}

/** Preserve existing query parameters and fragments while carrying page context. */
export function ofapiPageHref(path: string, pageLabel: string | null | undefined): string {
  if (pageLabel == null) return path;
  const hashAt = path.indexOf("#");
  const hash = hashAt < 0 ? "" : path.slice(hashAt);
  const base = hashAt < 0 ? path : path.slice(0, hashAt);
  const queryAt = base.indexOf("?");
  const pathname = queryAt < 0 ? base : base.slice(0, queryAt);
  const search = new URLSearchParams(queryAt < 0 ? "" : base.slice(queryAt + 1));
  search.set("page", pageLabel);
  return `${pathname}?${search.toString()}${hash}`;
}
