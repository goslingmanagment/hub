import { describe, expect, it } from "vitest";

import { routeSchemas, routeSecurityFromAuth } from "../packages/contracts/src/routes.ts";

// Since kernel Stage 19 the OpenAPI `security` of every route is DERIVED from
// its declared `auth` policy (routeSecurityFromAuth) — these pins now assert
// the declarations that drive both the document and the enforcement middleware.

describe("route schema security", () => {
  it("marks conversation and workboard routes as cookie-only", () => {
    const cookieOnlySecurity = [{ cookieAuth: [] }];

    for (const key of [
      "pageConversationPreview",
      "pageConversationMessages",
      "workboardV2",
      "workboardV2Contact",
      "workboardV2Snooze",
      "workboardV2Unsnooze",
    ] as const) {
      expect(routeSchemas[key].auth.kind, key).toBe("session");
      expect(routeSecurityFromAuth(routeSchemas[key].auth), key).toEqual(cookieOnlySecurity);
    }
  });

  it("documents logout as an idempotent cookie-clearing route", () => {
    expect(routeSchemas.logout.auth.kind).toBe("public");
    expect(routeSecurityFromAuth(routeSchemas.logout.auth)).toBeUndefined();
  });

  it("marks desktop-facing AI gateway routes as bearer-only", () => {
    const bearerOnlySecurity = [{ bearerAuth: [] }];

    expect(routeSchemas.aiGatewayStream.auth.kind).toBe("apiKey");
    expect(routeSecurityFromAuth(routeSchemas.aiGatewayStream.auth)).toEqual(bearerOnlySecurity);
  });

  it("documents pending device-token activation as bearer-only", () => {
    const bearerOnlySecurity = [{ bearerAuth: [] }];

    expect(routeSchemas.authActivateDeviceToken.auth.kind).toBe("pending-device-token");
    expect(routeSecurityFromAuth(routeSchemas.authActivateDeviceToken.auth))
      .toEqual(bearerOnlySecurity);
  });
});
