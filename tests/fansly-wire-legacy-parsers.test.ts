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
  ])("refuses %j with the body still in hand, never as an empty page", (raw) => {
    expect(read("followers.page", params, raw)).toEqual({
      kind: "contract_violation",
      status: 200,
      response: raw,
      violation: { field: "response", detail: expect.any(String) },
    });
  });
});

describe("subscribers.page", () => {
  const active = { status: "3,4", offset: 100 } as const;

  it.each([
    [{}],
  ])("refuses %j with the body still in hand", (raw) => {
    expect(read("subscribers.page", active, raw)).toMatchObject({ kind: "contract_violation", response: raw });
  });
});

describe("messaging.groups", () => {
  const params = { offset: 100 };

  it.each([
    [{}],
  ])("refuses %j with the body still in hand", (raw) => {
    expect(read("messaging.groups", params, raw)).toMatchObject({
      kind: "contract_violation",
      response: raw,
      violation: { field: "response" },
    });
  });
});

describe("messages.page", () => {
  const params = { groupId: "group-1", before: "m-9" };

  it.each([[{}]])(
    "refuses %j with the body still in hand",
    (raw) => {
      expect(read("messages.page", params, raw)).toMatchObject({ kind: "contract_violation", response: raw });
    },
  );
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
    ["a decimal-string amount", { amount: "12500.5" }, "amount"],
    ["a createdAt in seconds", { createdAt: Math.floor(Date.UTC(2026, 8, 28, 12) / 1000) }, "createdAt"],
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
  it.each([[{ timelineItems: [] }]])("refuse the drifted page %j at `posts`, the body still in hand", (raw) => {
    for (const result of [
      read("posts.timeline", { accountId: "772956494390898689", before: "0" }, raw),
      read("posts.by_ids", { ids: ["1"] }, raw),
    ]) {
      expect(result).toMatchObject({ kind: "contract_violation", response: raw, violation: { field: "posts" } });
    }
  });
});
