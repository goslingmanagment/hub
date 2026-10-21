// The query string of a Fansly API request, written the way the web app
// writes its own (bundle main.2e6b96097a4bb73b, 2026-10-08):
// - the route's keys first, in the order the spec gives them;
// - values as the app concatenates them: ids, numbers and comma lists go out
//   raw (`ids=1,2`, never `%2C`), anything else percent-encoded;
// - `ngsw-bypass=true` LAST: the app's interceptor appends it to the finished
//   URL (`url += (url has "?" ? "&" : "?") + "ngsw-bypass=true"`).

const BYPASS = "ngsw-bypass=true";

function value(raw: string): string {
  return encodeURIComponent(raw).replaceAll("%2C", ",");
}

/** `?k=v&…&ngsw-bypass=true`; `?ngsw-bypass=true` for a route without keys. */
export function fanslyQueryString(query: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(query).map(([key, raw]) => `${key}=${value(raw)}`);
  pairs.push(BYPASS);
  return `?${pairs.join("&")}`;
}
