import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  captureEvents,
  cleanupAdapterHarness,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";
import { createTestFanslySendGuard } from "./helpers/fansly-send-guard.ts";

// ONE harness for the whole file (see tests/adapter-fansly-retry.test.ts):
// calling `loadAdapters` per test leaves the adapter bound to a `fetch` the new
// spy no longer covers.
let harness: Awaited<ReturnType<typeof loadAdapters>>;

beforeAll(async () => {
  harness = await loadAdapters();
});

beforeEach(() => {
  harness.fetchMock.mockReset();
});

afterAll(() => {
  cleanupAdapterHarness();
});

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

async function fetchTransactionsPage(response: unknown) {
  const { FanslyAdapter, fetchMock } = harness;
  const { events, requestObserver } = captureEvents();
  fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response }));
  const adapter = new FanslyAdapter({
    baseUrl: "https://fansly.example",
  });
  const page = await adapter.getTransactionsPage({
    sendGuard: createTestFanslySendGuard(),
    session: { authorization: "token" },
    proxy: { url: "socks5://proxy.example:1080" },
    requestObserver,
  }, { offset: 0, limit: 100 });
  await adapter.close();
  const success = events.find((event) => event.state === "success");
  return { page, responseMetadata: success?.responseMetadata };
}

describe("Fansly transaction page contract", () => {
  it("preserves raw drift without dereferencing malformed totals or data", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const missingTotal = { data: [] };
    const unsafeTotal = { total: Number.MAX_SAFE_INTEGER + 1, data: [] };
    const missingData = { total: 0 };

    fetchMock
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: missingTotal }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: unsafeTotal }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: missingData }));

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
    });
    const context = {
      sendGuard: createTestFanslySendGuard(),
      session: { authorization: "token" },
      proxy: { url: "socks5://proxy.example:1080" },
    };

    const results = [
      await adapter.getTransactionsPage(context, { offset: 0, limit: 100 }),
      await adapter.getTransactionsPage(context, { offset: 100, limit: 100 }),
      await adapter.getTransactionsPage(context, { offset: 200, limit: 100 }),
    ];
    await adapter.close();

    expect(results).toEqual([
      {
        total: null,
        items: [],
        offset: 0,
        done: false,
        contractAccepted: false,
        itemViolation: null,
        raw: missingTotal,
      },
      {
        total: null,
        items: [],
        offset: 100,
        done: false,
        contractAccepted: false,
        itemViolation: null,
        raw: unsafeTotal,
      },
      {
        total: null,
        items: [],
        offset: 200,
        done: false,
        contractAccepted: false,
        itemViolation: null,
        raw: missingData,
      },
    ]);
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
  ])("rejects an item with %s but keeps the total", async (_label, overrides, field) => {
    const bad = transaction({ transactionId: "tx-bad", ...overrides });
    const response = { total: 250, data: [transaction({ transactionId: "tx-ok" }), bad] };

    const { page, responseMetadata } = await fetchTransactionsPage(response);

    expect(page).toEqual({
      total: 250,
      items: [],
      offset: 0,
      done: false,
      contractAccepted: false,
      itemViolation: { index: 1, transactionId: "tx-bad", field },
      raw: response,
    });
    expect(responseMetadata).toEqual({
      total: 250,
      returnedItems: null,
      done: null,
      contractAccepted: false,
      itemViolation: { index: 1, transactionId: "tx-bad", field },
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["numeric", 123],
  ])("rejects an item whose transactionId is %s", async (_label, transactionId) => {
    const response = { total: 1, data: [transaction({ transactionId })] };

    const { page } = await fetchTransactionsPage(response);

    expect(page).toMatchObject({
      total: 1,
      items: [],
      contractAccepted: false,
      itemViolation: { index: 0, transactionId: null, field: "transactionId" },
    });
  });

  it("rejects an item that is not an object", async () => {
    const response = { total: 2, data: [transaction(), null] };

    const { page } = await fetchTransactionsPage(response);

    expect(page).toMatchObject({
      total: 2,
      items: [],
      contractAccepted: false,
      itemViolation: { index: 1, transactionId: null, field: "item" },
    });
  });

  it("accepts negative amounts and a null destinationTax", async () => {
    const refund = transaction({
      transactionId: "tx-refund",
      amount: -12_500,
      destinationAmount: -10_000,
      destinationTax: null,
    });
    const response = { total: 1, data: [refund] };

    const { page, responseMetadata } = await fetchTransactionsPage(response);

    expect(page).toEqual({
      total: 1,
      items: [refund],
      offset: 0,
      done: true,
      contractAccepted: true,
      itemViolation: null,
      raw: response,
    });
    expect(responseMetadata).toEqual({
      total: 1,
      returnedItems: 1,
      done: true,
      contractAccepted: true,
    });
  });

  it("accepts integer-string amounts as the same mills", async () => {
    const response = {
      total: 1,
      data: [transaction({ amount: "12500", destinationAmount: "-10000" })],
    };

    const { page } = await fetchTransactionsPage(response);

    expect(page.items).toEqual([transaction({ amount: 12_500, destinationAmount: -10_000 })]);
    expect(page.contractAccepted).toBe(true);
    expect(page.itemViolation).toBeNull();
  });
});
