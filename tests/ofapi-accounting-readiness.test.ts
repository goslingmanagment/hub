import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOfapiClient,
  OfapiCreditAccountingUnavailableError,
} from "../apps/runtime/src/services/ofapi.ts";

const ACCOUNT = "acct_01000000000000000000000000000000";
const CONVERSATION = "123456789";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("credit accounting readiness is exposed for the pre-claim check (review #138 fix 2)", () => {
  it("rejects while a receipt is pending, resolves once the sink settles it, and never fetches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: 1 }, _meta: { _credits: { used: 1, balance: 9 } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let accountingUp = false;
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api", apiKey: "test-key", restDelayMs: 0,
      onCreditSpend: () => accountingUp,
    });
    await expect(client.sendTextMessage!({ pageId: 42 }, ACCOUNT, CONVERSATION, { text: "hi" })).resolves.toEqual({ messageId: "1", creditAccounting: "pending" });
    await expect(client.assertCreditAccountingReady!()).rejects.toBeInstanceOf(OfapiCreditAccountingUnavailableError);
    accountingUp = true;
    await expect(client.assertCreditAccountingReady!()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
