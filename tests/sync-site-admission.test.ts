import { describe, expect, it } from "vitest";

import { siteAnswerEffect } from "../apps/runtime/src/sync/engine/site-admission.ts";

// What an answer to a page's own site request does to the page's holds
// (Project Browser, spec §3; the observed site traffic of variant Б commits
// its ends by it, `engine/site-slot.ts` `commitObservedSiteEnd`).

describe("an answer to a site request", () => {
  it("a 429 or a 5xx naming its deadline holds the route; a 401/403 the credentials, except in the manual login", () => {
    expect(siteAnswerEffect({ kind: "response", status: 429, retryAfterMs: null }, false)).toEqual({ kind: "route_limited", httpStatus: 429, retryAfterMs: null });
    expect(siteAnswerEffect({ kind: "response", status: 503, retryAfterMs: 30_000 }, false)).toEqual({ kind: "route_limited", httpStatus: 503, retryAfterMs: 30_000 });
    expect(siteAnswerEffect({ kind: "response", status: 401, retryAfterMs: null }, false)).toEqual({ kind: "auth", httpStatus: 401 });
    expect(siteAnswerEffect({ kind: "response", status: 401, retryAfterMs: null }, true)).toEqual({ kind: "none" });
    expect(siteAnswerEffect({ kind: "response", status: 500, retryAfterMs: null }, false)).toEqual({ kind: "none" });
    expect(siteAnswerEffect({ kind: "transport_error", sent: true, message: "x" }, false)).toEqual({ kind: "none" });
  });
});
