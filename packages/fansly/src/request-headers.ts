import type {
  FanslyClientCheckRoute,
  FanslySessionBundle,
} from "@agency_hub_core/shared";

import { FanslyClientTsClock } from "./client-ts.ts";

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

export type FanslyClientCheckResolution = {
  readonly route: FanslyClientCheckRoute | null;
  readonly check: string | null;
  readonly state: "present" | "missing" | "route_unclassified";
};

/** Same coarse route families captured by the browser extension. */
export function fanslyClientCheckRoute(pathname: string): FanslyClientCheckRoute | null {
  if (pathname.includes("/account/wallets/earnings/")) return "earnings";
  if (pathname.includes("/subscribers")) return "subscribers";
  if (pathname.includes("/media/orderhistory")) return "media";
  if (pathname.includes("/messaging/groups")) return "messagingGroups";
  if (pathname.includes("/group/")) return "group";
  if (pathname.includes("/message")) return "message";
  if (pathname === "/account" || pathname.includes("/account?")) return "account";
  return null;
}

export function resolveFanslyClientCheck(
  session: FanslySessionBundle,
  pathname: string,
): FanslyClientCheckResolution {
  const route = fanslyClientCheckRoute(pathname);
  if (route === null) {
    return { route: null, check: null, state: "route_unclassified" };
  }
  const check = session.routeChecks?.[route]?.trim() || null;
  return check === null
    ? { route, check: null, state: "missing" }
    : { route, check, state: "present" };
}

/** fansly-client-ts's caches, by the id its tail comes from: a Node page's
 *  requests are one long document of the site's (client-ts.ts). */
const clientTsClocks = new Map<string, FanslyClientTsClock>();
const CLIENT_TS_CLOCKS = 256;

/** fansly-client-ts as the site's hidden interceptor sets it (client-ts.ts):
 *  the tail from the session's id, without one from the device's
 *  (`fansly-client-id`), with neither the time itself; never below a value
 *  given before for the same id. The time is the clock: Node knows no
 *  server offset, and the site uses one only past 30 s. */
function clientTs(session: FanslySessionBundle, nowMs: number): number {
  const id = session.fanslySessionId || session.fanslyClientId || "";
  let clock = clientTsClocks.get(id);
  if (clock === undefined) {
    clock = new FanslyClientTsClock();
    if (clientTsClocks.size >= CLIENT_TS_CLOCKS) clientTsClocks.delete(clientTsClocks.keys().next().value!);
  } else {
    clientTsClocks.delete(id);
  }
  clientTsClocks.set(id, clock);
  return clock.next(nowMs, id);
}

/**
 * Outgoing insertion order follows the captured HAR after the transport-owned
 * `Host` field. The capture was Firefox, so it carried no `sec-ch-*` headers;
 * inventing Chromium client hints would reduce rather than improve parity.
 */
export function buildFanslyRequestHeaders(
  session: FanslySessionBundle,
  pathname: string,
  nowMs = Date.now(),
): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": CAPTURED_BROWSER_HEADERS["user-agent"],
    accept: CAPTURED_BROWSER_HEADERS.accept,
    "accept-language": CAPTURED_BROWSER_HEADERS["accept-language"],
    "accept-encoding": CAPTURED_BROWSER_HEADERS["accept-encoding"],
    referer: CAPTURED_BROWSER_HEADERS.referer,
  };

  if (session.fanslyClientId) headers["fansly-client-id"] = session.fanslyClientId;
  headers["fansly-client-ts"] = String(clientTs(session, nowMs));
  if (session.fanslySessionId) headers["fansly-session-id"] = session.fanslySessionId;

  const clientCheck = resolveFanslyClientCheck(session, pathname);
  if (clientCheck.check !== null) headers["fansly-client-check"] = clientCheck.check;

  headers.origin = CAPTURED_BROWSER_HEADERS.origin;
  headers.dnt = CAPTURED_BROWSER_HEADERS.dnt;
  headers["sec-gpc"] = CAPTURED_BROWSER_HEADERS["sec-gpc"];
  headers["sec-fetch-dest"] = CAPTURED_BROWSER_HEADERS["sec-fetch-dest"];
  headers["sec-fetch-mode"] = CAPTURED_BROWSER_HEADERS["sec-fetch-mode"];
  headers["sec-fetch-site"] = CAPTURED_BROWSER_HEADERS["sec-fetch-site"];
  headers.authorization = session.authorization;
  return headers;
}

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
