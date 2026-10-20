import { describe, expect, it } from "vitest";

import {
  fanslyWireSpec,
  isFanslyErrorEnvelope,
  parseFanslyAccountMe,
  parseFanslyAccountsByIds,
  parseFanslyEnvelope,
  parseFanslyGroupDetail,
  readFanslyWireResponse,
} from "@agency_hub_core/fansly";

// The response contracts of the wire layer: the three new parsers, the order
// in which an answer is read (auth, empty answer, status, envelope, contract),
// and the registry facts every spec must keep.

function envelope(response: unknown) {
  return JSON.stringify({ success: true, response });
}

function answer(status: number, bodyText: string, headers: Record<string, string> = {}) {
  return { status, headers, bodyText };
}

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
