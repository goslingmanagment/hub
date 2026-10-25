/** Exact non-secret values captured in the 2026-08-21 Firefox HAR. */
const CAPTURED_BROWSER_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "gzip, deflate, br, zstd",
  referer: "https://fansly.com/",
  origin: "https://fansly.com",
  dnt: "1",
  "sec-gpc": "1",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
} as const);

/** Every header a request can carry that belongs to a session or a client
 *  identity — none of them is ever on a session-less request. */
export const FANSLY_SESSION_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "fansly-client-id",
  "fansly-client-ts",
  "fansly-session-id",
  "fansly-client-check",
]);

/**
 * The headers of a session-less request (the public account reader, arena
 * "vanished chat" R5): the captured browser's own, in the HAR's order, and
 * nothing of a session — no authorization, no `fansly-*` client or session
 * header, no cookie. Takes no session: there is nothing to put one in.
 */
export function buildFanslyAnonymousRequestHeaders(): Record<string, string> {
  return {
    "user-agent": CAPTURED_BROWSER_HEADERS["user-agent"],
    accept: CAPTURED_BROWSER_HEADERS.accept,
    "accept-language": CAPTURED_BROWSER_HEADERS["accept-language"],
    "accept-encoding": CAPTURED_BROWSER_HEADERS["accept-encoding"],
    referer: CAPTURED_BROWSER_HEADERS.referer,
    origin: CAPTURED_BROWSER_HEADERS.origin,
    dnt: CAPTURED_BROWSER_HEADERS.dnt,
    "sec-gpc": CAPTURED_BROWSER_HEADERS["sec-gpc"],
    "sec-fetch-dest": CAPTURED_BROWSER_HEADERS["sec-fetch-dest"],
    "sec-fetch-mode": CAPTURED_BROWSER_HEADERS["sec-fetch-mode"],
    "sec-fetch-site": CAPTURED_BROWSER_HEADERS["sec-fetch-site"],
  };
}
