import { describe, expect, it } from "vitest";

import { matchSiteRequest, SITE_OTHER_ROUTE } from "../apps/runtime/src/sync/fansly/route-match.ts";

// Which route a request of a page's own site takes (Project Browser, spec
// §2.2–2.4; stage 3 PR 8): the catalogue's API routes by method and path, the
// site's other API reads on `site.other`, the two login writes, nothing else.

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
