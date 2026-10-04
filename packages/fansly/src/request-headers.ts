import type {
  FanslyClientCheckRoute,
  FanslySessionBundle,
} from "@agency_hub_core/shared";

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
  headers["fansly-client-ts"] = String(nowMs);
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
