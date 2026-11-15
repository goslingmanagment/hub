/**
 * «Публикации» and «Статистика → Контент» are ContentOps' own screens (products package C2). Hub links them by its hop
 * `/contentops/<screen>`: Hub's server sends the person on to ContentOps, signed in, on the model of the page or the
 * post the address names (apps/runtime/src/services/content-screens-moved.ts); the console loads it from the server
 * (routes/ToContentops.tsx).
 */
export function contentopsScreen(screen: "publications" | "stats", query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString();
  return `/contentops/${screen}${search ? `?${search}` : ""}`;
}
