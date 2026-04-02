import { describe, expect, it } from "vitest";

import { routeSchemas } from "../packages/contracts/src/routes.ts";

describe("route schema security", () => {
  it("marks CRM and workboard routes as cookie-only", () => {
    const cookieOnlySecurity = [{ cookieAuth: [] }];

    expect(routeSchemas.crmSummary.security).toEqual(cookieOnlySecurity);
    expect(routeSchemas.crmRetention.security).toEqual(cookieOnlySecurity);
    expect(routeSchemas.crmReactivation.security).toEqual(cookieOnlySecurity);
    expect(routeSchemas.crmConversationPreview.security).toEqual(cookieOnlySecurity);
    expect(routeSchemas.workboard.security).toEqual(cookieOnlySecurity);
    expect(routeSchemas.workboardSnooze.security).toEqual(cookieOnlySecurity);
    expect(routeSchemas.workboardUnsnooze.security).toEqual(cookieOnlySecurity);
  });
});
