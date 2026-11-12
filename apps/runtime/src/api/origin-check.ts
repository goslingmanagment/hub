import { AppError } from "../services/errors.ts";
import { isLoopbackOrigin } from "../services/signin-handoff.ts";

/**
 * The `Origin` check of a change made with a cookie (ecosystem plan §3.2 p.1).
 *
 * SameSite does not separate the agency's names: `tasks.`, `ext.`, the public
 * site and every other `*.gosling-agency.ru` are the SAME site as `hub.` and
 * `chatgoose.`, so a page on any of them could send a simple POST (a form, a
 * `text/plain` fetch: no preflight) that carries the console's Lax cookie.
 * Every state-changing request that a cookie authenticates must therefore come
 * from a page of one of Hub's own web names.
 *
 * - A bearer request (`Authorization: Bearer`) is never checked: the cookie
 *   plays no part in it (request-auth.ts reads the bearer and nothing else).
 * - A request with no session cookie is checked only on the routes that make
 *   or end one (sign-in, sign-out, the invitation's redeem): a forged sign-in
 *   would put a browser in someone else's account.
 * - `Origin` present: it must be one of the allowed origins exactly; `null`
 *   (a sandboxed frame, a privacy redirect) is a browser that will not say, and
 *   is refused. Absent: `Sec-Fetch-Site` decides when the browser sent it;
 *   neither header is a client that is not a browser (a script, a test), which
 *   a forged page cannot be — every browser sends `Origin` with a POST.
 */

const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Routes that take no principal yet make or end a cookie session. */
export const COOKIE_SESSION_ROUTE_KEYS: ReadonlySet<string> = new Set(["login", "logout", "authRedeemAccountLink"]);

/** Route kinds that take no principal: no cookie authenticates them. */
const PRINCIPAL_FREE_KINDS: ReadonlySet<string> = new Set(["public", "hmac"]);

export interface OriginCheckInput {
  method: string;
  routeKey: string;
  authKind: string;
  headers: Record<string, string | string[] | undefined>;
  hasSessionCookie: boolean;
  /** Hub's own web names, exactly as a browser sends them (`https://hub.gosling-agency.ru`). */
  allowedOrigins: ReadonlySet<string>;
  /** Outside production: a page of the one-name dev setup (`localhost`, `127.0.0.1`, `[::1]`). */
  allowLoopback: boolean;
}

export const CROSS_ORIGIN_REFUSAL_MESSAGE = "A change signed in by a cookie is taken only from Hub's own pages";

function headerOf(headers: OriginCheckInput["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function hasBearer(headers: OriginCheckInput["headers"]): boolean {
  const authorization = headerOf(headers, "authorization");
  return typeof authorization === "string" && /^bearer\s+\S/i.test(authorization);
}

/** Whether `origin` (an `Origin` header's value) is a page of Hub's own. */
export function isAllowedOrigin(origin: string, allowedOrigins: ReadonlySet<string>, allowLoopback: boolean): boolean {
  if (allowedOrigins.has(origin)) return true;
  return allowLoopback && isLoopbackOrigin(origin);
}

/** The refusal of a cross-origin change made with a cookie, or null. Pure. */
export function crossOriginRefusal(input: OriginCheckInput): AppError | null {
  if (!STATE_CHANGING_METHODS.has(input.method.toUpperCase())) return null;
  if (hasBearer(input.headers)) return null;
  const cookieAuthenticated = input.hasSessionCookie && !PRINCIPAL_FREE_KINDS.has(input.authKind);
  if (!cookieAuthenticated && !COOKIE_SESSION_ROUTE_KEYS.has(input.routeKey)) return null;

  const origin = headerOf(input.headers, "origin");
  if (typeof origin === "string") {
    return isAllowedOrigin(origin.trim(), input.allowedOrigins, input.allowLoopback)
      ? null
      : new AppError(CROSS_ORIGIN_REFUSAL_MESSAGE, 403, "cross_origin");
  }
  const fetchSite = headerOf(input.headers, "sec-fetch-site");
  if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") {
    return new AppError(CROSS_ORIGIN_REFUSAL_MESSAGE, 403, "cross_origin");
  }
  return null;
}
