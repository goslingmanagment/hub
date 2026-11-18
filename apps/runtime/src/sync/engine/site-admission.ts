import type { FanslyRoute } from "../fansly/routes.ts";
import type { SiteRequestEnd } from "./ports.ts";

// What a page's own site request does to the page (Project Browser, plan
// §3.2, spec §3). Since variant Б (protocol minor 4) the page's browser lets
// the site's requests go and tells the engine what left and how it ended
// (`engine/site-slot.ts`, `recordObservedSiteSend`, `commitObservedSiteEnd`):
// nothing of the site waits for the engine's admission. Its answers hold the
// engine's routes and the page's credentials by the engine's own rules.

/** The API paths (from `/api/v1`) the login screens read, as the test
 *  account showed them (stage 1, sessions 1–5): the app's version, the
 *  third-party sign-in providers, the device id (the operator's map names
 *  them apart: the device id's answer is no platform data). The operator's
 *  map keeps the same list (`tests/page-browser-operations.test.ts`). */
export const LOGIN_SCREEN_READS: ReadonlySet<string> = new Set(["/versioning", "/thirdpartyconnect/providers", "/device/id"]);

/** A site request as its answer is committed: its route, and whether the
 *  manual login's exemption covers it. */
export interface ClassifiedSiteRequest {
  route: FanslyRoute;
  /** A login operation, or a read the site's interface makes, in the
   *  manual login: its 401/403 holds nothing. */
  exempt: boolean;
}

/** What an answer to a site request does to the page's holds (the engine's
 *  own rules, `engine/errors.ts`): a 429 or a 5xx naming its own deadline
 *  holds the route that answered; a 401/403 holds the page's credentials —
 *  except in the manual login, whose requests answer 401 before the login
 *  by design. A network failure of the site's own request holds nothing:
 *  the site cancels its requests itself (a page left, a route changed). */
export type SiteAnswerEffect = { kind: "none" } | { kind: "route_limited"; httpStatus: number; retryAfterMs: number | null } | { kind: "auth"; httpStatus: number };

export function siteAnswerEffect(end: SiteRequestEnd, manualLogin: boolean): SiteAnswerEffect {
  if (end.kind !== "response") return { kind: "none" };
  if (end.status === 429 || (end.status >= 500 && end.retryAfterMs !== null)) {
    return { kind: "route_limited", httpStatus: end.status, retryAfterMs: end.retryAfterMs };
  }
  if ((end.status === 401 || end.status === 403) && !manualLogin) return { kind: "auth", httpStatus: end.status };
  return { kind: "none" };
}
