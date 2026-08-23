import { describe, expect, it } from "vitest";

import { redactedFanslyRequestHeaderPlan } from "@agency_hub_core/fansly";
import { summarizeEndpointProbe } from
  "../apps/runtime/src/services/fansly-endpoint-probe.ts";

describe("fansly:endpoint-probe request header print", () => {
  it("redacts credentials while preserving outgoing insertion order", () => {
    const plan = redactedFanslyRequestHeaderPlan({
      authorization: "secret-auth",
      fanslyClientId: "secret-client",
      fanslySessionId: "secret-session",
      routeChecks: { message: "secret-check" },
    }, "/message/broadcast/stats", 1_777_000_000_000);

    expect(plan.clientCheck).toEqual({ route: "message", state: "present" });
    expect(plan.headers.map((header) => header.name)).toEqual([
      "user-agent",
      "accept",
      "accept-language",
      "accept-encoding",
      "referer",
      "fansly-client-id",
      "fansly-client-ts",
      "fansly-session-id",
      "fansly-client-check",
      "origin",
      "dnt",
      "sec-gpc",
      "sec-fetch-dest",
      "sec-fetch-mode",
      "sec-fetch-site",
      "authorization",
    ]);
    expect(JSON.stringify(plan)).not.toContain("secret-");
  });

  it("reports an unclassified route instead of printing a stale global check", () => {
    const plan = redactedFanslyRequestHeaderPlan({
      authorization: "secret-auth",
      fanslyClientCheck: "stale-global-check",
    }, "/post/123/replies");
    expect(plan.clientCheck).toEqual({ route: null, state: "route_unclassified" });
    expect(plan.headers.some((header) => header.name === "fansly-client-check")).toBe(false);

    const report = summarizeEndpointProbe([{
      page: "lora-1",
      route: "GET /post/{postId}/replies",
      verdict: "skipped",
      httpStatus: null,
      errorCode: null,
      itemCount: null,
      bare: true,
      shape: null,
      wallClockMs: 0,
      message: "dry-run (not called)",
      requestHeaders: plan,
    }]);
    expect(report).toContain("REQUEST HEADERS (secret values redacted");
    expect(report).toContain("client-check route=unclassified state=route_unclassified");
    expect(report).toContain("fansly-client-check: <not sent — no captured check for this route>");
    expect(report).not.toContain("stale-global-check");
  });
});
