import { describe, expect, it } from "vitest";

import { routeSchemas } from "../packages/contracts/src/routes.ts";

describe("route schema security", () => {
  it("marks conversation and workboard routes as cookie-only", () => {
    const cookieOnlySecurity = [{ cookieAuth: [] }];

    expect(routeSchemas.pageConversationPreview.security).toEqual(cookieOnlySecurity);
    expect(routeSchemas.pageConversationMessages.security).toEqual(cookieOnlySecurity);
    expect(routeSchemas.workboard.security).toEqual(cookieOnlySecurity);
    expect(routeSchemas.workboardPresence.security).toEqual(cookieOnlySecurity);
    expect(routeSchemas.workboardSnooze.security).toEqual(cookieOnlySecurity);
    expect(routeSchemas.workboardUnsnooze.security).toEqual(cookieOnlySecurity);
  });

  it("documents logout as an idempotent cookie-clearing route", () => {
    expect((routeSchemas.logout as { security?: unknown }).security).toBeUndefined();
  });

  it("marks desktop-facing AI gateway routes as bearer-only", () => {
    const bearerOnlySecurity = [{ bearerAuth: [] }];

    expect(routeSchemas.aiGatewayStream.security).toEqual(bearerOnlySecurity);
  });
});
