import { describe, expect, it } from "vitest";

import { resolveOfapiReadGatewayRequest } from "../apps/runtime/src/services/ofapi-read-gateway.ts";

const ACCOUNT = "acct_01000000000000000000000000000000";

describe("OFAPI read gateway allowlist", () => {
  it.each([
    ["accounts", {}, "accounts"],
    ["whoami", {}, "whoami"],
    [`${ACCOUNT}/settings/welcome-message`, {}, "proxy"],
    [`${ACCOUNT}/chats`, { limit: "50", order: "recent", skip_users: "none" }, "proxy"],
    [`${ACCOUNT}/chats/123/messages`, { limit: "100", order: "desc", first_id: "456" }, "proxy"],
    [`${ACCOUNT}/chats/123/messages/456`, {}, "proxy"],
    [`${ACCOUNT}/chats/123/media`, { type: "video", limit: "20", offset: "0", skip_users: "all" }, "proxy"],
    [`${ACCOUNT}/users/list`, { ids: "1,2,3" }, "proxy"],
    [`${ACCOUNT}/users/example%20fan`, {}, "proxy"],
    [`${ACCOUNT}/transactions`, { limit: "100", startDate: "2026-06-19 00:00:00" }, "proxy"],
    [`${ACCOUNT}/fans/all`, { limit: "20", offset: "0" }, "proxy"],
    [`${ACCOUNT}/fans/active`, { limit: "20", query: "fan" }, "proxy"],
    [`${ACCOUNT}/fans/active`, { limit: "20", offset: "0", "filter[online]": "1", "filter[total_spent]": "1" }, "proxy"],
    [`${ACCOUNT}/fans/all`, { "filter[total_spent]": "0" }, "proxy"],
    [`${ACCOUNT}/user-lists`, { limit: "50", offset: "0" }, "proxy"],
    [`${ACCOUNT}/user-lists/123/users`, { limit: "100", offset: "0" }, "proxy"],
    [`${ACCOUNT}/media/vault`, { field: "recent", type: "photo", limit: "24" }, "proxy"],
    [`${ACCOUNT}/media/vault/lists`, { limit: "50" }, "proxy"],
    [`${ACCOUNT}/media/vault/123`, {}, "proxy"],
    [`${ACCOUNT}/media/uploads/ofapi_media_123/status`, {}, "proxy"],
  ])("accepts %s", (path, query, kind) => {
    expect(resolveOfapiReadGatewayRequest(path, query)).toMatchObject({ kind });
  });

  it.each([
    [`${ACCOUNT}/chats`, { unexpected: "1" }],
    [`${ACCOUNT}/chats/123/messages`, { first_id: "1", last_id: "2" }],
    [`${ACCOUNT}/chats/123/messages`, { first_id: "1", order: "asc" }],
    [`${ACCOUNT}/fans/active`, { limit: "21" }],
    [`${ACCOUNT}/fans/active`, { "filter[online]": "2" }],
    [`${ACCOUNT}/fans/active`, { "filter[total_spent]": "-1" }],
    [`${ACCOUNT}/users/list`, { ids: "1,2,not-a-number" }],
    [`${ACCOUNT}/media/vault`, { limit: "9" }],
    [`${ACCOUNT}/messages`, {}],
    [`${ACCOUNT}/settings/welcome-message`, { enabled: "true" }],
    [`${ACCOUNT}/settings/welcome-message/enabled`, {}],
    [`${ACCOUNT}/settings`, {}],
    [`${ACCOUNT}/media/vault/delete-media`, {}],
    ["not-an-account/chats", {}],
    [`${ACCOUNT}/chats`, { limit: ["10", "20"] }],
    [`${ACCOUNT}/chats/%2F/messages`, {}],
  ])("rejects unsafe request %s", (path, query) => {
    expect(() => resolveOfapiReadGatewayRequest(path, query)).toThrow(
      "Invalid OFAPI read gateway request",
    );
  });

  it("requires durable custody for the welcome template with one estimated credit", () => {
    expect(resolveOfapiReadGatewayRequest(`${ACCOUNT}/settings/welcome-message`, {})).toMatchObject({
      kind: "proxy", operation: "ofapi_gateway_welcome_message", captureFirst: true,
      fallbackCredits: 1, fallbackEstimated: true,
    });
  });

  it("admits the bounded latest-fan roster as interactive audience without enabling profile collection", () => {
    const request = resolveOfapiReadGatewayRequest(`${ACCOUNT}/fans/latest`, {
      type: "new", start_date: "2026-09-10", end_date: "2026-09-16", limit: "20", offset: "20",
    });
    expect(request).toMatchObject({
      kind: "proxy", operation: "ofapi_read_fans_latest",
      collectionContext: { category: "core_audience", purpose: "interactive" },
      query: { type: "new", start_date: "2026-09-10", end_date: "2026-09-16", limit: "20", offset: "20" },
    });
    expect(resolveOfapiReadGatewayRequest(`${ACCOUNT}/fans/top`, {})).toMatchObject({
      collectionContext: { category: "profile_notifications" },
    });
    expect(() => resolveOfapiReadGatewayRequest(`${ACCOUNT}/fans/latest`, { limit: "51" })).toThrow();
    expect(() => resolveOfapiReadGatewayRequest(`${ACCOUNT}/fans/latest`, { start_date: "2026-09-10" })).toThrow();
  });

  it("marks the upload-status poll as a known free request", () => {
    expect(resolveOfapiReadGatewayRequest(
      `${ACCOUNT}/media/uploads/ofapi_media_123/status`,
      {},
    )).toMatchObject({
      kind: "proxy",
      fallbackCredits: 0,
      fallbackEstimated: false,
    });
  });
});
