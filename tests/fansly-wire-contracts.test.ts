import { describe, expect, it } from "vitest";

import {
  buildFanslyWireRequest,
  buildFanslyWireUrl,
  FANSLY_MESSAGES_PAGE_LIMIT,
  FANSLY_ORDER_HISTORY_PAGE_LIMIT,
  FANSLY_WIRE_IDS,
  FANSLY_WIRE_SPECS,
  FanslySendRefusedError,
  fanslyWireSpec,
  isFanslyApiWireId,
  isFanslyErrorEnvelope,
  isFanslyWireId,
  parseFanslyAccountMe,
  parseFanslyAccountsByIds,
  parseFanslyEnvelope,
  parseFanslyGroupDetail,
  readFanslyWireResponse,
  type FanslySendRefusalReason,
} from "@agency_hub_core/fansly";

import { WRITTEN_OBSERVATION_KINDS } from "../apps/runtime/src/services/observation-kinds.ts";

// The response contracts of the wire layer: the three new parsers, the order
// in which an answer is read (auth, empty answer, status, envelope, contract),
// and the registry facts every spec must keep.

const BASE_URL = "https://apiv3.fansly.example/api/v1";

function envelope(response: unknown) {
  return JSON.stringify({ success: true, response });
}

function answer(status: number, bodyText: string, headers: Record<string, string> = {}) {
  return { status, headers, bodyText };
}

describe("the wire registry", () => {
  it("declares one spec per id, each API route under a kind the observation registry already knows", () => {
    const registered = new Map(WRITTEN_OBSERVATION_KINDS.map((entry) => [entry.kind, entry.source]));
    expect(FANSLY_WIRE_IDS).toHaveLength(41);
    for (const id of FANSLY_WIRE_IDS) {
      const spec = FANSLY_WIRE_SPECS[id];
      expect(spec.id, id).toBe(id);
      expect(isFanslyWireId(id)).toBe(true);
      if (spec.host !== "api") continue;
      expect(spec.capture, id).toBeUndefined();
      expect(spec.kind, id).not.toBeNull();
      expect(registered.get(spec.kind!), `${id} journals ${spec.kind}`).toBe("pull");
      expect(isFanslyApiWireId(id), id).toBe(true);
    }
    // Step 3, live only: the socket's Upgrade and a CDN hop journal nothing.
    expect(FANSLY_WIRE_IDS.filter((id) => FANSLY_WIRE_SPECS[id].host !== "api").map((id) => {
      const spec = FANSLY_WIRE_SPECS[id];
      return [id, spec.host, spec.kind, spec.capture];
    })).toEqual([["ws.upgrade", "ws", null, "none"], ["cdn.media", "cdn", null, "bytes"]]);
    expect(isFanslyWireId("messages.pages")).toBe(false);
    expect(isFanslyWireId("toString")).toBe(false);
    expect(isFanslyWireId(null)).toBe(false);
  });

  it("keeps the page sizes the lanes walk with", () => {
    expect(FANSLY_ORDER_HISTORY_PAGE_LIMIT).toBe(100);
    expect(FANSLY_MESSAGES_PAGE_LIMIT).toBe(25);
  });

  it("encodes a path id into one segment and refuses parameters no request may carry", () => {
    expect(buildFanslyWireUrl("group.detail", { groupId: "a/b?c" }, BASE_URL))
      .toBe(`${BASE_URL}/group/a%2Fb%3Fc?ngsw-bypass=true`);
    expect(() => buildFanslyWireUrl("group.detail", { groupId: " " }, BASE_URL)).toThrow(RangeError);
    expect(() => buildFanslyWireUrl("messaging.groups", { offset: -1 }, BASE_URL)).toThrow(RangeError);
    expect(() => buildFanslyWireUrl("transactions.page", { limit: 20.5, offset: 0 }, BASE_URL)).toThrow(RangeError);
    expect(() => buildFanslyWireUrl("accounts.by_ids", { ids: [] }, BASE_URL)).toThrow(RangeError);
    expect(() => buildFanslyWireUrl("accounts.by_ids", { ids: Array.from({ length: 101 }, (_, i) => `${i}`) }, BASE_URL))
      .toThrow(RangeError);
    expect(() => buildFanslyWireUrl("posts.tips", { targetIds: [] }, BASE_URL)).toThrow(RangeError);
    expect(() => buildFanslyWireUrl("posts.by_ids", { ids: ["1", ""] }, BASE_URL)).toThrow(RangeError);
    expect(() => buildFanslyWireUrl("messages.page", { groupId: "1", before: "" }, BASE_URL)).toThrow(RangeError);
    expect(() => buildFanslyWireUrl("notifications.page", { before: "0", types: [1.5] }, BASE_URL)).toThrow(RangeError);
    expect(() => buildFanslyWireRequest("account.me", {}, {
      baseUrl: BASE_URL, session: { authorization: "t" }, timeoutMs: 0,
    })).toThrow(RangeError);
  });

  it("builds a request at send time, with that moment's client timestamp", () => {
    const request = buildFanslyWireRequest("messages.page", { groupId: "451", before: null }, {
      baseUrl: BASE_URL,
      session: { authorization: "token", routeChecks: { message: "check-message" } },
      timeoutMs: 20_000,
      nowMs: 1_790_000_000_123,
    });
    expect(request).toMatchObject({
      spec: "messages.page",
      url: `${BASE_URL}/message?ngsw-bypass=true&groupId=451&limit=25`,
      timeoutMs: 20_000,
      headers: {
        "fansly-client-ts": "1790000000123",
        "fansly-client-check": "check-message",
        authorization: "token",
      },
    });
  });
});

describe("parseFanslyAccountMe", () => {
  const account = { id: "acct-1", username: "lana", displayName: null, createdAt: 0, followCount: 3, subscriberCount: 0 };

  it("accepts the served account, counters present or absent", () => {
    expect(parseFanslyAccountMe({ account })).toEqual({ ok: true, value: { account } });
    const { followCount: _f, subscriberCount: _s, ...withoutCounters } = account;
    expect(parseFanslyAccountMe({ account: withoutCounters }).ok).toBe(true);
    expect(parseFanslyAccountMe({ account: { ...account, followCount: null, subscriberCount: null } }).ok).toBe(true);
  });

  it.each([
    [null, "account"],
    [{}, "account"],
    [{ account: [] }, "account"],
    [{ account: { ...account, id: "" } }, "account.id"],
    [{ account: { ...account, id: 7 } }, "account.id"],
    [{ account: { ...account, followCount: -1 } }, "account.followCount"],
    [{ account: { ...account, followCount: 1.5 } }, "account.followCount"],
    [{ account: { ...account, subscriberCount: "4" } }, "account.subscriberCount"],
  ])("refuses %j at %s", (value, field) => {
    const parsed = parseFanslyAccountMe(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.violation.field).toBe(field);
  });
});

describe("parseFanslyAccountsByIds", () => {
  it("accepts an array of accounts with ids, empty included", () => {
    expect(parseFanslyAccountsByIds([])).toEqual({ ok: true, value: [] });
    expect(parseFanslyAccountsByIds([{ id: "1", username: "a" }, { id: "2" }]).ok).toBe(true);
  });

  it("refuses a non-array and a row without an id, naming the row", () => {
    expect(parseFanslyAccountsByIds({ accounts: [] })).toMatchObject({ ok: false, violation: { field: "response" } });
    expect(parseFanslyAccountsByIds([{ id: "1" }, { id: "" }])).toMatchObject({ ok: false, violation: { field: "[1].id" } });
    expect(parseFanslyAccountsByIds([{ id: "1" }, null])).toMatchObject({ ok: false, violation: { field: "[1].id" } });
  });
});

describe("parseFanslyGroupDetail", () => {
  const detail = { id: "g-1", type: 1, groupFlags: 0, users: [{ userId: "u-1" }, { userId: "u-2" }] };

  it("accepts the group the request named", () => {
    expect(parseFanslyGroupDetail(detail, "g-1")).toEqual({ ok: true, value: detail });
  });

  it("refuses another group, or a member without a user id", () => {
    expect(parseFanslyGroupDetail(detail, "g-2").ok).toBe(false);
    expect(parseFanslyGroupDetail({ ...detail, users: [{ userId: "" }] }, "g-1").ok).toBe(false);
    expect(parseFanslyGroupDetail({ ...detail, users: null }, "g-1").ok).toBe(false);
  });

  it("is the group.detail spec's contract, keyed on the requested id", () => {
    const spec = fanslyWireSpec("group.detail");
    expect(spec.parse(detail, { groupId: "g-1" }).ok).toBe(true);
    expect(spec.parse(detail, { groupId: "g-9" }).ok).toBe(false);
  });
});

describe("readFanslyWireResponse", () => {
  it("accepts a success envelope the contract accepts, keeping the response for the journal", () => {
    const response = { messages: [{ id: "m-1" }] };
    expect(readFanslyWireResponse(fanslyWireSpec("messages.page"), { groupId: "g", before: null },
      answer(200, envelope(response)))).toEqual({ kind: "accepted", status: 200, response, value: response });
  });

  it("reports a contract violation with the body still in hand", () => {
    expect(readFanslyWireResponse(fanslyWireSpec("messages.page"), { groupId: "g", before: null },
      answer(200, envelope({ data: [] })))).toMatchObject({
      kind: "contract_violation",
      response: { data: [] },
      violation: { field: "response" },
    });
  });

  it("names the first transaction that fails the item contract", () => {
    const item = {
      transactionId: "tx-1", type: 1, status: 1, amount: 1_000, destinationAmount: 800,
      destinationTax: null, createdAt: Date.UTC(2026, 8, 1),
    };
    const accepted = readFanslyWireResponse(fanslyWireSpec("transactions.page"), { limit: 20, offset: 0 },
      answer(200, envelope({ total: 1, data: [item] })));
    expect(accepted).toMatchObject({ kind: "accepted", value: { total: 1, data: [item] } });
    expect(readFanslyWireResponse(fanslyWireSpec("transactions.page"), { limit: 20, offset: 0 },
      answer(200, envelope({ total: 2, data: [item, { ...item, transactionId: "tx-2", amount: 1.5 }] }))))
      .toMatchObject({ kind: "contract_violation", violation: { field: "data[1].amount" } });
  });

  it("reads the subscribers total that matches the requested status", () => {
    const body = envelope({
      stats: { total: 9, totalActive: 4, totalExpired: 5 },
      subscriptions: [{ id: "s-1", subscriberId: "f-1", status: 5 }],
    });
    expect(readFanslyWireResponse(fanslyWireSpec("subscribers.page"), { status: "5", offset: 0 }, answer(200, body)))
      .toMatchObject({ kind: "accepted", value: { total: 5, totalActive: 4, totalExpired: 5 } });
    expect(readFanslyWireResponse(fanslyWireSpec("subscribers.page"), { status: "3,4", offset: 0 }, answer(200, body)))
      .toMatchObject({ kind: "accepted", value: { total: 4 } });
  });

  it("reads a 2xx without a successful envelope as unsuccessful", () => {
    const spec = fanslyWireSpec("account.me");
    expect(readFanslyWireResponse(spec, {}, answer(200, JSON.stringify({ success: false, error: { code: 1 } }))))
      .toMatchObject({ kind: "envelope_unsuccessful", status: 200, envelope: { success: false } });
    expect(readFanslyWireResponse(spec, {}, answer(200, JSON.stringify({ success: true }))))
      .toMatchObject({ kind: "envelope_unsuccessful" });
    expect(readFanslyWireResponse(spec, {}, answer(200, "<html>gateway</html>")))
      .toEqual({ kind: "envelope_unsuccessful", status: 200, envelope: null });
    // An empty body is "nothing here" only on a route that opts in.
    expect(readFanslyWireResponse(spec, {}, answer(200, ""))).toMatchObject({ kind: "envelope_unsuccessful" });
  });

  it("reads every non-2xx as an HTTP answer, a redirect included", () => {
    const spec = fanslyWireSpec("account.me");
    expect(readFanslyWireResponse(spec, {}, answer(302, "", { location: "/elsewhere" })))
      .toEqual({ kind: "http_error", status: 302, envelope: null, retryAfter: null, finalServerError: false });
    expect(readFanslyWireResponse(spec, {}, answer(429, "", { "retry-after": "120" })))
      .toMatchObject({ kind: "http_error", status: 429, retryAfter: "120" });
  });

  it("reads an empty answer as such only where the route opts in, never on an auth failure", () => {
    const spec = fanslyWireSpec("post.replies");
    const params = { postId: "p-1", before: null };
    expect(readFanslyWireResponse(spec, params, answer(204, ""))).toEqual({
      kind: "accepted", status: 204, response: { __empty: true, httpStatus: 204 }, value: { __empty: true, httpStatus: 204 },
    });
    expect(readFanslyWireResponse(spec, params, answer(200, "  "))).toMatchObject({
      kind: "accepted", response: { __empty: true, httpStatus: 200 },
    });
    expect(readFanslyWireResponse(spec, params, answer(401, ""))).toMatchObject({ kind: "http_error", status: 401 });
    // Elsewhere a 204 is a 2xx without an envelope, as the adapter reads it.
    expect(readFanslyWireResponse(fanslyWireSpec("posts.timeline"), { accountId: "a", before: "0" },
      answer(204, ""))).toEqual({ kind: "envelope_unsuccessful", status: 204, envelope: null });
  });

  it("marks a route's own final 5xx answer only where the route opts in and no Retry-After says otherwise", () => {
    const body = JSON.stringify({ success: false, error: { code: 500, details: "error getting graph" } });
    const params = { mediaOfferId: "mo", beforeMs: 2, afterMs: 1, periodMs: 86_400_000 };
    expect(readFanslyWireResponse(fanslyWireSpec("media.offer_stats"), params, answer(500, body)))
      .toMatchObject({ kind: "http_error", status: 500, finalServerError: true });
    expect(readFanslyWireResponse(fanslyWireSpec("media.offer_stats"), params, answer(500, body, { "retry-after": "5" })))
      .toMatchObject({ finalServerError: false });
    expect(readFanslyWireResponse(fanslyWireSpec("media.offer_stats"), params, answer(502, "bad gateway")))
      .toMatchObject({ finalServerError: false });
    expect(readFanslyWireResponse(fanslyWireSpec("account.stats"), { beforeMs: 2, afterMs: 1, periodMs: 1 },
      answer(500, body))).toMatchObject({ finalServerError: false });
  });

  it("parses the envelope as the adapter always has", () => {
    expect(parseFanslyEnvelope("{\"success\":true,\"response\":[]}")).toEqual({ success: true, response: [] });
    expect(parseFanslyEnvelope("{\"success\":\"yes\"}")).toBeNull();
    expect(parseFanslyEnvelope("{\"error\":{\"code\":\"x\"}}")).toBeNull();
    expect(parseFanslyEnvelope("[]")).toBeNull();
    expect(parseFanslyEnvelope("not json")).toBeNull();
    expect(isFanslyErrorEnvelope({ success: false, error: { code: 500, details: " " } })).toBe(false);
    expect(isFanslyErrorEnvelope({ success: false, error: { code: 500, details: "gone" } })).toBe(true);
  });
});

describe("the answers of the routes that journal nothing (step 3)", () => {
  const upgrade = fanslyWireSpec("ws.upgrade");
  const cdn = fanslyWireSpec("cdn.media");
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x7b]);

  it("reads an Upgrade by its status: 101 opens the socket, the page-level statuses stay errors", () => {
    expect(readFanslyWireResponse(upgrade, {}, answer(101, ""))).toEqual({ kind: "accepted", status: 101, response: { status: 101 }, value: { status: 101 } });
    for (const status of [400, 401, 403, 404, 408, 429, 500, 503]) {
      expect(readFanslyWireResponse(upgrade, {}, answer(status, "")), String(status)).toMatchObject({ kind: "http_error", status, envelope: null });
    }
  });

  it("reads every CDN hop status as the hop's own answer, but the session's, the deadline's and the provider's pace", () => {
    const ok = readFanslyWireResponse(cdn, { hop: 0 }, { ...answer(200, "", { "content-type": "image/jpeg" }), bodyBuffer: bytes });
    expect(ok).toEqual({
      kind: "accepted",
      status: 200,
      response: { status: 200, contentType: "image/jpeg", location: null, body: bytes, tooLarge: false },
      value: { status: 200, contentType: "image/jpeg", location: null, body: bytes, tooLarge: false },
    });
    expect(readFanslyWireResponse(cdn, { hop: 0 }, answer(302, "", { location: "https://cdn3.fansly.com/x" })))
      .toMatchObject({ kind: "accepted", value: { status: 302, location: "https://cdn3.fansly.com/x", body: null } });
    expect(readFanslyWireResponse(cdn, { hop: 0 }, { ...answer(200, ""), bodyOverflow: true }))
      .toMatchObject({ kind: "accepted", value: { status: 200, body: null, tooLarge: true } });
    for (const status of [404, 410, 500, 502]) {
      expect(readFanslyWireResponse(cdn, { hop: 1 }, answer(status, "nope")), String(status))
        .toMatchObject({ kind: "accepted", value: { status, body: null } });
    }
    for (const status of [401, 403, 408, 429]) {
      expect(readFanslyWireResponse(cdn, { hop: 0 }, answer(status, "")), String(status)).toMatchObject({ kind: "http_error", status });
    }
    expect(readFanslyWireResponse(cdn, { hop: 0 }, answer(503, "", { "retry-after": "30" })))
      .toMatchObject({ kind: "http_error", status: 503, retryAfter: "30" });
  });

  it("has no API request line: its URL is not the API's", () => {
    expect(() => buildFanslyWireUrl("cdn.media", { hop: 0 }, BASE_URL)).toThrow(RangeError);
    expect(() => buildFanslyWireUrl("ws.upgrade", {}, BASE_URL)).toThrow(RangeError);
    expect(isFanslyApiWireId("cdn.media")).toBe(false);
    expect(isFanslyApiWireId("ws.upgrade")).toBe(false);
  });
});

describe("the send refusal vocabulary", () => {
  it("carries the engine pacer's reasons beside every lease's", () => {
    const reasons: FanslySendRefusalReason[] = [
      "lease_inactive", "lease_used", "send_deadline_passed", "pace", "takeover_floor",
    ];
    for (const reason of reasons) {
      const refusal = new FanslySendRefusedError(reason);
      expect(refusal.reason).toBe(reason);
      expect(refusal.message).toContain(reason);
    }
  });
});
