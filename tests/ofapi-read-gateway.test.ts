import { describe, expect, it } from "vitest";

import { resolveOfapiReadGatewayRequest } from "../apps/runtime/src/services/ofapi-read-gateway.ts";

const ACCOUNT = "acct_01000000000000000000000000000000";

describe("OFAPI read gateway allowlist", () => {
  it.each([
    ["accounts", {}, "accounts"],
    ["whoami", {}, "whoami"],
    [`${ACCOUNT}/chats`, { limit: "50", order: "recent", skip_users: "none" }, "proxy"],
    [`${ACCOUNT}/chats/123/messages`, { limit: "100", order: "desc", first_id: "456" }, "proxy"],
    [`${ACCOUNT}/chats/123/messages/456`, {}, "proxy"],
    [`${ACCOUNT}/chats/123/media`, { type: "video", limit: "20", offset: "0", skip_users: "all" }, "proxy"],
    [`${ACCOUNT}/users/list`, { ids: "1,2,3" }, "proxy"],
    [`${ACCOUNT}/users/example%20fan`, {}, "proxy"],
    [`${ACCOUNT}/transactions`, { limit: "100", startDate: "2026-06-19 00:00:00" }, "proxy"],
    [`${ACCOUNT}/fans/all`, { limit: "20", offset: "0" }, "proxy"],
    [`${ACCOUNT}/fans/active`, { limit: "20", query: "fan" }, "proxy"],
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
    [`${ACCOUNT}/users/list`, { ids: "1,2,not-a-number" }],
    [`${ACCOUNT}/media/vault`, { limit: "9" }],
    [`${ACCOUNT}/messages`, {}],
    [`${ACCOUNT}/media/vault/delete-media`, {}],
    ["not-an-account/chats", {}],
    [`${ACCOUNT}/chats`, { limit: ["10", "20"] }],
    [`${ACCOUNT}/chats/%2F/messages`, {}],
  ])("rejects unsafe request %s", (path, query) => {
    expect(() => resolveOfapiReadGatewayRequest(path, query)).toThrow(
      "Invalid OFAPI read gateway request",
    );
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
