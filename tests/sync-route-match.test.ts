import { describe, expect, it } from "vitest";

import {
  compileApiMatcher,
  FANSLY_API_BASE_PATH,
  matchSiteRequest,
  SITE_OTHER_ROUTE,
} from "../apps/runtime/src/sync/fansly/route-match.ts";
import { FANSLY_ROUTES, type FanslyRoute, type FanslyRouteSpec } from "../apps/runtime/src/sync/fansly/routes.ts";

// Which route a request of a page's own site takes (Project Browser, spec
// §2.2–2.4; stage 3 PR 8): the catalogue's API routes by method and path, the
// site's other API reads on `site.other`, the two login writes, nothing else.

/** A template with every parameter filled in, as a request would carry it. */
function filled(template: string): string {
  return template.replace(/:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\}/g, "723606174951284736");
}

// The API reads with a path template (a login operation is a POST; the site's
// reads outside the catalogue have no template).
const API_ROUTES = [...FANSLY_ROUTES.values()].filter((spec) => spec.host === "api" && (spec.method as string) === "GET" && !spec.template.startsWith("<"));

describe("the catalogue's API routes", () => {
  it.each(API_ROUTES.map((spec) => [spec.route, spec.template] as const))("%s (%s) matches its own route", (route, template) => {
    expect(matchSiteRequest("api", "GET", `${FANSLY_API_BASE_PATH}${filled(template)}`)).toEqual({ kind: "route", route });
  });

  it("the query never changes the route", () => {
    expect(matchSiteRequest("api", "GET", "/api/v1/account/me?ngsw-bypass=true")).toEqual({ kind: "route", route: "account.me" });
    expect(matchSiteRequest("api", "GET", "/api/v1/messaging/groups?ngsw-bypass=true&offset=0&limit=100&sortOrder=1&flags=0")).toEqual({ kind: "route", route: "messaging.groups" });
  });

  it("a trailing slash and the method's case do not matter", () => {
    expect(matchSiteRequest("api", "get", "/api/v1/account/me/")).toEqual({ kind: "route", route: "account.me" });
  });

  it("a parameter stands for exactly one segment", () => {
    expect(matchSiteRequest("api", "GET", "/api/v1/timelinenew/1/2")).toEqual({ kind: "site_other", route: SITE_OTHER_ROUTE });
    expect(matchSiteRequest("api", "GET", "/api/v1/group")).toEqual({ kind: "site_other", route: SITE_OTHER_ROUTE });
  });
});

describe("a literal segment beats a parameter", () => {
  const table: FanslyRouteSpec[] = [
    { route: "group.detail" as FanslyRoute, method: "GET", host: "api", template: "/group/:groupId", wire: null },
    { route: "messaging.groups" as FanslyRoute, method: "GET", host: "api", template: "/group/list", wire: null },
    { route: "post.replies" as FanslyRoute, method: "GET", host: "api", template: "/{a}/x/:b", wire: null },
    { route: "posts.tips" as FanslyRoute, method: "GET", host: "api", template: "/y/:a/:b", wire: null },
  ];
  const match = compileApiMatcher(table);

  it("the literal wins wherever it is in the table", () => {
    expect(match("/group/list")).toBe("messaging.groups");
    expect(match("/group/123")).toBe("group.detail");
    expect(compileApiMatcher([...table].reverse())("/group/list")).toBe("messaging.groups");
  });

  it("at the first place the templates differ", () => {
    expect(match("/y/x/1")).toBe("posts.tips");
    expect(match("/z/x/1")).toBe("post.replies");
  });

  it("only GET templates of the API take part", () => {
    const withOthers = compileApiMatcher([
      ...table,
      { route: "polls" as FanslyRoute, method: "POST" as "GET", host: "api", template: "/login", wire: null },
      { route: "tips" as FanslyRoute, method: "GET", host: "api", template: "<an API path outside the catalogue>", wire: null },
      { route: "trackinglinks" as FanslyRoute, method: "GET", host: "ws", template: "/login", wire: null },
    ]);
    expect(withOthers("/login")).toBeNull();
    expect(withOthers("/<an API path outside the catalogue>")).toBeNull();
  });
});

describe("the site's own API reads", () => {
  // Paths the site read on the test account (stage 1, sessions 3–5).
  it.each([
    "/api/v1/versioning",
    "/api/v1/settings",
    "/api/v1/notifications/unack",
    "/api/v1/timeline/home",
    "/api/v1/mediastories/following",
    "/api/v1/account/723606174951284736/wallets",
    "/api/v1/streaming/followingstreams/online",
    "/api/v1/contentdiscovery/suggestions",
  ])("%s takes site.other", (path) => {
    expect(matchSiteRequest("api", "GET", `${path}?ngsw-bypass=true`)).toEqual({ kind: "site_other", route: SITE_OTHER_ROUTE });
  });

  it("the site's reads on catalogue routes take those routes", () => {
    expect(matchSiteRequest("api", "GET", "/api/v1/account?ids=1,2&ngsw-bypass=true")).toEqual({ kind: "route", route: "accounts.by_ids" });
    expect(matchSiteRequest("api", "GET", "/api/v1/contentdiscovery/media/suggestionsnew?before=0")).toEqual({ kind: "route", route: "discovery.suggestions" });
  });
});

describe("writes", () => {
  it("the two login operations are the only writes", () => {
    expect(matchSiteRequest("api", "POST", "/api/v1/login?ngsw-bypass=true")).toEqual({ kind: "login", route: "auth.login" });
    expect(matchSiteRequest("api", "POST", "/api/v1/login/twofa")).toEqual({ kind: "login", route: "auth.twofa" });
  });

  it.each([
    ["POST", "/api/v1/message/ack"],
    ["POST", "/api/v1/message/typing"],
    ["POST", "/api/v1/status"],
    ["POST", "/api/v1/login/email"],
    ["POST", "/api/v1/account/me"],
    ["PUT", "/api/v1/login"],
    ["DELETE", "/api/v1/post/1"],
    ["PATCH", "/api/v1/account"],
  ])("%s %s is refused", (method, path) => {
    expect(matchSiteRequest("api", method, path)).toEqual({ kind: "refused", reason: "write" });
  });

  it("a preflight or another method has no route here", () => {
    expect(matchSiteRequest("api", "OPTIONS", "/api/v1/account/me")).toEqual({ kind: "refused", reason: "method" });
    expect(matchSiteRequest("api", "HEAD", "/api/v1/account/me")).toEqual({ kind: "refused", reason: "method" });
  });
});

describe("other hosts and paths", () => {
  it("the socket's Upgrade and the media CDN", () => {
    expect(matchSiteRequest("ws", "GET", "/?v=3")).toEqual({ kind: "route", route: "ws.upgrade" });
    expect(matchSiteRequest("ws", "GET", "/chat")).toEqual({ kind: "refused", reason: "not_a_route" });
    expect(matchSiteRequest("cdn", "GET", "/abc/def.jpg?Signature=x")).toEqual({ kind: "route", route: "cdn.media" });
    expect(matchSiteRequest("cdn", "POST", "/abc")).toEqual({ kind: "refused", reason: "write" });
  });

  it("a path outside the API base is no API request", () => {
    expect(matchSiteRequest("api", "GET", "/account/me")).toEqual({ kind: "refused", reason: "not_api_path" });
    expect(matchSiteRequest("api", "GET", "/api/v10/account/me")).toEqual({ kind: "refused", reason: "not_api_path" });
  });
});
