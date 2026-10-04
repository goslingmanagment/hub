import { describe, expect, it } from "vitest";

import {
  fanslyWireSpec,
  readFanslyWireResponse,
  type FanslyWireId,
  type FanslyWireParams,
} from "@agency_hub_core/fansly";

// The container and identity contracts the legacy adapter's lanes read their
// pages by — followers, subscribers, the chat list, a chat's messages, the
// transactions ledger. The parsers moved to the wire layer unchanged and are
// the engine's contracts now; their cases were written against the adapter's
// methods and moved here when its HTTP was deleted (step 4, S4-20), read the
// way the engine reads an answer: a 200 envelope through the route's spec.
//
// A body the contract refuses is still in hand (`response`): the resource
// journals it before the work is quarantined, so a drifted page is never read
// as an empty one.

function read<I extends FanslyWireId>(id: I, params: FanslyWireParams<I>, response: unknown) {
  return readFanslyWireResponse(fanslyWireSpec(id), params, {
    status: 200,
    headers: {},
    bodyText: JSON.stringify({ success: true, response }),
  });
}

/** `undefined` members do not survive JSON: what the route reads back. */
function served(response: unknown): unknown {
  return JSON.parse(JSON.stringify({ response })).response;
}

describe("followers.page", () => {
  const params = { accountId: "account-1", offset: 100 };

  it.each([
    [{}],
    ["private body"],
    [{ followers: null }],
    [{ followers: [null] }],
    [{ followers: [{ id: "relation-without-fan" }] }],
    [{ followers: [], aggregationData: { accounts: "malformed" } }],
    [{ followers: [], aggregationData: { accounts: [{ username: "no-id" }] } }],
  ])("refuses %j with the body still in hand, never as an empty page", (raw) => {
    expect(read("followers.page", params, raw)).toEqual({
      kind: "contract_violation",
      status: 200,
      response: raw,
      violation: { field: "response", detail: expect.any(String) },
    });
  });

  it.each([
    [{ followers: [] }],
    [{ followers: [], aggregationData: null }],
    [{ followers: [], aggregationData: { accounts: null } }],
    [{ followers: [{ id: "follow-1", followerId: "fan-1" }], aggregationData: { accounts: [{ id: "fan-1" }] } }],
  ])("accepts %j: an explicit empty page and nullable sidecars are valid", (raw) => {
    expect(read("followers.page", params, raw)).toEqual({ kind: "accepted", status: 200, response: raw, value: raw });
  });
});

describe("subscribers.page", () => {
  const active = { status: "3,4", offset: 100 } as const;

  it.each([
    [{}],
    [{ stats: null, subscriptions: [] }],
    [{ stats: { total: 0, totalActive: 0, totalExpired: 0 } }],
    [{ stats: { total: 0, totalActive: -1, totalExpired: 0 }, subscriptions: [] }],
    [{ stats: { total: 1, totalActive: 1, totalExpired: 0 }, subscriptions: [null] }],
    [{ stats: { total: 1, totalActive: 1, totalExpired: 0 }, subscriptions: [{ id: "s-1", subscriberId: "f-1" }] }],
  ])("refuses %j with the body still in hand", (raw) => {
    expect(read("subscribers.page", active, raw)).toMatchObject({ kind: "contract_violation", response: raw });
  });

  it("reads the total of the requested status, and needs only that one", () => {
    expect(read("subscribers.page", active, { stats: { totalActive: 0 }, subscriptions: [] }))
      .toMatchObject({ kind: "accepted", value: { total: 0, totalActive: 0, totalExpired: null, subscriptions: [] } });
    expect(read("subscribers.page", { status: "5", offset: 0 }, { stats: { totalExpired: 0 }, subscriptions: [] }))
      .toMatchObject({ kind: "accepted", value: { total: 0, totalActive: null, totalExpired: 0 } });
    // The active total says nothing about the expired walk.
    expect(read("subscribers.page", { status: "5", offset: 0 }, { stats: { totalActive: 0 }, subscriptions: [] }))
      .toMatchObject({ kind: "contract_violation" });
  });

  it("uses the expired total for an expired page, whatever the overall total", () => {
    const raw = {
      stats: { total: 39, totalActive: 37, totalExpired: 2 },
      subscriptions: [
        { id: "expired-1", subscriberId: "fan-1", status: 5 },
        { id: "expired-2", subscriberId: "fan-2", status: 5 },
      ],
    };
    expect(read("subscribers.page", { status: "5", offset: 0 }, raw)).toMatchObject({
      kind: "accepted",
      value: { total: 2, totalActive: 37, totalExpired: 2, subscriptions: [{ id: "expired-1" }, { id: "expired-2" }] },
    });
  });
});

describe("messaging.groups", () => {
  const params = { offset: 100 };

  it.each([
    [{}],
    ["private body"],
    [{ data: null }],
    [{ data: "" }],
    [{ data: {} }],
    [{ data: [null] }],
    [{ data: [{ flags: 0 }] }],
    [{ data: [{ groupId: 7 }] }],
    [{ data: [], aggregationData: "malformed" }],
    [{ data: [], aggregationData: { accounts: "malformed" } }],
    [{ data: [], aggregationData: { groups: [{ type: 1 }] } }],
    [{ data: [], aggregationData: { accounts: [{ username: "no-id" }] } }],
  ])("refuses %j with the body still in hand", (raw) => {
    expect(read("messaging.groups", params, raw)).toMatchObject({
      kind: "contract_violation",
      response: raw,
      violation: { field: "response" },
    });
  });

  it.each([
    [{ data: [] }],
    [{ data: [], aggregationData: null }],
    [{ data: [], aggregationData: { total: 0, accounts: null, groups: null } }],
  ])("accepts the empty and the thin page %j", (raw) => {
    expect(read("messaging.groups", params, raw)).toEqual({ kind: "accepted", status: 200, response: raw, value: raw });
  });
});

describe("messages.page", () => {
  const params = { groupId: "group-1", before: "m-9" };

  it.each([[{}], ["private body"], [{ messages: null }], [{ messages: "" }], [{ messages: {} }]])(
    "refuses %j with the body still in hand",
    (raw) => {
      expect(read("messages.page", params, raw)).toMatchObject({ kind: "contract_violation", response: raw });
    },
  );

  it("accepts an empty page, and leaves per-message drift to the lane", () => {
    expect(read("messages.page", params, { messages: [] })).toMatchObject({ kind: "accepted", value: { messages: [] } });
    // A missing id or createdAt is accounted for after capture: refusing the
    // page for one bad message would wedge a limit-1 head repair on it.
    const drifted = { messages: [{ content: "no id or createdAt" }] };
    expect(read("messages.page", params, drifted)).toEqual({ kind: "accepted", status: 200, response: drifted, value: drifted });
  });
});

describe("transactions.page", () => {
  const params = { limit: 100, offset: 0 };

  function transaction(overrides: Record<string, unknown> = {}) {
    return {
      walletId: "wallet-1",
      transactionId: "tx-1",
      accountId: "acct-1",
      correlationId: "corr-1",
      correlationAccountId: "fan-1",
      type: 20001,
      destination: 0,
      amount: 12_500,
      destinationTax: 2000,
      destinationAmount: 10_000,
      newBalance: null,
      newBalance64: 50_000,
      createdAt: Date.UTC(2026, 8, 28, 12),
      updatedAt: null,
      status: 2,
      senderId: "fan-1",
      receiverId: "acct-1",
      ...overrides,
    };
  }

  it.each([
    ["a missing total", { data: [] }],
    ["an unsafe total", { total: Number.MAX_SAFE_INTEGER + 1, data: [] }],
    ["a negative total", { total: -1, data: [] }],
    ["missing data", { total: 0 }],
  ])("refuses a page with %s without dereferencing it", (_label, raw) => {
    expect(read("transactions.page", params, raw)).toMatchObject({
      kind: "contract_violation",
      response: raw,
      violation: { field: "response" },
    });
  });

  it.each([
    ["a fractional amount", { amount: 12_500.5 }, "amount"],
    ["a fractional destinationAmount", { destinationAmount: 9_999.9 }, "destinationAmount"],
    ["a decimal-string amount", { amount: "12500.5" }, "amount"],
    ["an unsafe integer amount", { amount: Number.MAX_SAFE_INTEGER + 1 }, "amount"],
    ["a non-numeric amount", { amount: true }, "amount"],
    ["a missing destinationAmount", { destinationAmount: undefined }, "destinationAmount"],
    ["a createdAt in seconds", { createdAt: Math.floor(Date.UTC(2026, 8, 28, 12) / 1000) }, "createdAt"],
    ["a createdAt far in the future", { createdAt: Date.now() + 3 * 24 * 60 * 60 * 1000 }, "createdAt"],
    ["a string createdAt", { createdAt: "2026-09-28T12:00:00.000Z" }, "createdAt"],
    ["a fractional destinationTax", { destinationTax: 2000.5 }, "destinationTax"],
    ["a string destinationTax", { destinationTax: "2000" }, "destinationTax"],
    ["a missing type", { type: undefined }, "type"],
    ["a string status", { status: "2" }, "status"],
  ])("names the item with %s, and keeps the whole page for the journal", (_label, overrides, field) => {
    const raw = { total: 250, data: [transaction({ transactionId: "tx-ok" }), transaction({ transactionId: "tx-bad", ...overrides })] };
    expect(read("transactions.page", params, raw)).toEqual({
      kind: "contract_violation",
      status: 200,
      response: served(raw),
      violation: { field: `data[1].${field}`, detail: "transaction tx-bad failed the item contract" },
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["numeric", 123],
  ])("names an item whose transactionId is %s by its position", (_label, transactionId) => {
    expect(read("transactions.page", params, { total: 1, data: [transaction({ transactionId })] })).toMatchObject({
      kind: "contract_violation",
      violation: { field: "data[0].transactionId", detail: "transaction (no id) failed the item contract" },
    });
  });

  it("names an item that is not an object", () => {
    expect(read("transactions.page", params, { total: 2, data: [transaction(), null] })).toMatchObject({
      kind: "contract_violation",
      violation: { field: "data[1].item" },
    });
  });

  it("accepts negative amounts and a null destinationTax", () => {
    const refund = transaction({ transactionId: "tx-refund", amount: -12_500, destinationAmount: -10_000, destinationTax: null });
    expect(read("transactions.page", params, { total: 1, data: [refund] }))
      .toMatchObject({ kind: "accepted", value: { total: 1, data: [refund] } });
  });

  it("reads integer-string amounts as the same mills, and keeps the served body as it was", () => {
    const raw = { total: 1, data: [transaction({ amount: "12500", destinationAmount: "-10000" })] };
    const result = read("transactions.page", params, raw);
    expect(result).toMatchObject({
      kind: "accepted",
      response: raw,
      value: { total: 1, data: [transaction({ amount: 12_500, destinationAmount: -10_000 })] },
    });
  });
});

describe("posts.timeline and posts.by_ids", () => {
  const page = {
    posts: [
      { id: "881547312038436864", accountId: "772956494390898689", content: "first post", createdAt: 1_771_671_617, attachments: [] },
      { id: "881340289321549825", accountId: "772956494390898689", content: "older post", createdAt: 1_771_622_259, attachments: [{ contentType: 2, contentId: "media-1" }] },
    ],
    accountMedia: [{ id: "media-1" }],
  };

  it("accept a page with a posts array and keep its sidecars", () => {
    expect(read("posts.timeline", { accountId: "772956494390898689", before: "900000000000000000" }, page))
      .toEqual({ kind: "accepted", status: 200, response: page, value: page });
    expect(read("posts.by_ids", { ids: ["881547312038436864"] }, { posts: [] })).toMatchObject({ kind: "accepted", value: { posts: [] } });
  });

  it.each([[{ timelineItems: [] }], [{ posts: null }], [[]]])("refuse the drifted page %j at `posts`, the body still in hand", (raw) => {
    for (const result of [
      read("posts.timeline", { accountId: "772956494390898689", before: "0" }, raw),
      read("posts.by_ids", { ids: ["1"] }, raw),
    ]) {
      expect(result).toMatchObject({ kind: "contract_violation", response: raw, violation: { field: "posts" } });
    }
  });
});
