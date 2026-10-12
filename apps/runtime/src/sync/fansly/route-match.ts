import { FANSLY_ROUTES, type FanslyRoute, type FanslyRouteHost, type FanslyRouteSpec } from "./routes.ts";

// Which route a request of a page's own site takes (Project Browser, plan
// §3.2, spec §2.2–2.4; stage 3 PR 8). The engine admits the site's requests
// on the same routes and budgets as its own sends, so a request seen by the
// page's browser is matched to a catalogue route by its method and path.
//
// - The catalogue's templates are relative to the API base (`/api/v1`);
//   `:id` and `{id}` stand for exactly one segment, and among the templates
//   that match, a literal segment beats a parameter at the first place they
//   differ. The query never changes the route (`ngsw-bypass=true` included).
// - An API GET outside the catalogue takes `site.other`: the site's own
//   paths share one budget (the family `site`, owner decision №3).
// - The two login operations are the only writes (`auth.login`,
//   `auth.twofa`; spec §2.4); every other write is refused here, as the
//   extension and the operator refuse it.
// - A preflight (OPTIONS) has no route of its own: it goes under its
//   request's admission (owner decision №1), so it is not matched here.

/** The API's base path; the catalogue's templates are relative to it. */
export const FANSLY_API_BASE_PATH = "/api/v1";

/** The route of an API GET of the site outside the catalogue. */
export const SITE_OTHER_ROUTE = "site.other";

export type FanslyLoginRoute = "auth.login" | "auth.twofa";

const LOGIN_PATHS: Readonly<Record<string, FanslyLoginRoute>> = {
  "/login": "auth.login",
  "/login/twofa": "auth.twofa",
};

export type SiteRequestMatch =
  | { kind: "route"; route: FanslyRoute }
  | { kind: "site_other"; route: typeof SITE_OTHER_ROUTE }
  | { kind: "login"; route: FanslyLoginRoute }
  | { kind: "refused"; reason: "not_api_path" | "write" | "method" | "not_a_route" };

interface CompiledTemplate {
  route: FanslyRoute;
  /** null for a parameter segment. */
  segments: Array<string | null>;
}

function segmentsOf(path: string): string[] {
  const bare = path.split("?", 1)[0]!.split("#", 1)[0]!;
  const trimmed = bare.length > 1 && bare.endsWith("/") ? bare.slice(0, -1) : bare;
  return trimmed.split("/").slice(1);
}

function isParameter(segment: string): boolean {
  return /^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment) || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment);
}

/** -1 when `a` is the more specific of two templates of the same length. */
function bySpecificity(a: CompiledTemplate, b: CompiledTemplate): number {
  for (let i = 0; i < a.segments.length; i++) {
    const aLiteral = a.segments[i] !== null;
    const bLiteral = b.segments[i] !== null;
    if (aLiteral !== bLiteral) return aLiteral ? -1 : 1;
  }
  return 0;
}

/** A matcher of API paths over a set of route specs (the catalogue's API
 *  routes in production; a table of its own in tests). */
export function compileApiMatcher(specs: Iterable<FanslyRouteSpec>): (apiPath: string) => FanslyRoute | null {
  const byLength = new Map<number, CompiledTemplate[]>();
  for (const spec of specs) {
    // GET templates of the API only: a login operation (POST) is matched by
    // its path below, and a route without a path template (`<…>`, the site's
    // reads outside the catalogue) matches nothing by itself.
    if (spec.host !== "api" || (spec.method as string) !== "GET" || spec.template.startsWith("<")) continue;
    const segments = segmentsOf(spec.template).map((segment) => (isParameter(segment) ? null : segment));
    const list = byLength.get(segments.length) ?? [];
    list.push({ route: spec.route, segments });
    byLength.set(segments.length, list);
  }
  for (const list of byLength.values()) list.sort(bySpecificity);
  return (apiPath) => {
    const segments = segmentsOf(apiPath);
    if (segments.some((segment) => segment === "")) return null;
    for (const candidate of byLength.get(segments.length) ?? []) {
      if (candidate.segments.every((literal, i) => literal === null || literal === segments[i])) return candidate.route;
    }
    return null;
  };
}

const matchApiPath = compileApiMatcher(FANSLY_ROUTES.values());

/** The route of one request of the site: `host` is the class of its host
 *  (the API, the socket, the media CDN), `path` its URL's path (a query is
 *  ignored). */
export function matchSiteRequest(host: FanslyRouteHost, method: string, path: string): SiteRequestMatch {
  const verb = method.toUpperCase();
  if (host === "ws") {
    return verb === "GET" && segmentsOf(path).join("/") === "" ? { kind: "route", route: "ws.upgrade" } : { kind: "refused", reason: "not_a_route" };
  }
  if (host === "cdn") return verb === "GET" ? { kind: "route", route: "cdn.media" } : { kind: "refused", reason: "write" };
  const bare = path.split("?", 1)[0]!;
  if (bare !== FANSLY_API_BASE_PATH && !bare.startsWith(`${FANSLY_API_BASE_PATH}/`)) return { kind: "refused", reason: "not_api_path" };
  const apiPath = bare.slice(FANSLY_API_BASE_PATH.length) || "/";
  if (verb === "GET") {
    const route = matchApiPath(apiPath);
    return route !== null ? { kind: "route", route } : { kind: "site_other", route: SITE_OTHER_ROUTE };
  }
  if (verb === "POST") {
    const normalized = `/${segmentsOf(apiPath).join("/")}`;
    const login = Object.hasOwn(LOGIN_PATHS, normalized) ? LOGIN_PATHS[normalized]! : null;
    return login !== null ? { kind: "login", route: login } : { kind: "refused", reason: "write" };
  }
  if (verb === "PUT" || verb === "PATCH" || verb === "DELETE") return { kind: "refused", reason: "write" };
  return { kind: "refused", reason: "method" };
}
