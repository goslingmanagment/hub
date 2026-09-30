import { afterEach, describe, expect, it, vi } from "vitest";

import { createOfapiClient, OfapiCreditAccountingUnavailableError, type OfapiCreditSpendObservation } from "../apps/runtime/src/services/ofapi.ts";
import { resolveOfapiListNextOffset } from "../apps/runtime/src/services/ofapi-list-pagination.ts";
import { resolveOfapiReadGatewayRequest } from "../apps/runtime/src/services/ofapi-read-gateway.ts";

const ACCOUNT = "acct_audit";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const paid = (data: unknown) => ({ data, _meta: { _credits: { used: 1, balance: 99 } } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("OFAPI request audit regressions", () => {
  it("checks admission before every physical attempt and preserves local refusal without transport retry", async () => {
    const admission = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("local permission denied"));
    const fetch = vi.fn(async () => new Response(JSON.stringify(paid([])), { status: 429, headers: { "retry-after": "0" } }));
    vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "test", restDelayMs: 0, beforeOperationRequest: admission });
    await expect(client.listChats({}, ACCOUNT, {})).rejects.toThrow("local permission denied");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(admission).toHaveBeenCalledTimes(2);
    expect(admission).toHaveBeenLastCalledWith({ operation: "ofapi_chats", accountId: ACCOUNT, method: "GET" });
    const beforeDispatch = vi.fn(async () => true);
    await expect(client.dispatchGovernedRaw!({}, {
      attemptId: "test", operation: "test", method: "GET", pathname: `/${ACCOUNT}/posts`,
      priorityClass: "bulk", deadlineAt: new Date(Date.now() + 60_000), beforeDispatch,
    })).rejects.toMatchObject({ phase: "pre_dispatch", reason: "cancelled" });
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("R1 accepts short/empty nonterminal pages and validates the offset without forwarding URLs", () => {
    const input = { pathname: `/${ACCOUNT}/tracking-links/1/subscribers`, offset: 0, limit: 100 };
    expect(resolveOfapiListNextOffset({ hasNextPage: true }, input)).toBe(100);
    expect(resolveOfapiListNextOffset({ hasNextPage: false }, input)).toBeNull();
    expect(resolveOfapiListNextOffset({ hasNextPage: true, nextPageUrl:
      `/api/${ACCOUNT}/tracking-links/1/subscribers?offset=10&limit=100` }, input)).toBe(10);
    for (const nextPageUrl of [
      `/api/${ACCOUNT}/tracking-links/1/subscribers?offset=0`,
      `/api/${ACCOUNT}/tracking-links/1/subscribers?offset=10&offset=20`,
      `/api/${ACCOUNT}/tracking-links/1/subscribers?offset=10&limit=10`,
      `/api/${ACCOUNT}/tracking-links/2/subscribers?offset=100`,
      `https://other.test/api/${ACCOUNT}/tracking-links/1/subscribers?offset=100`,
    ]) expect(() => resolveOfapiListNextOffset({ hasNextPage: true, nextPageUrl }, input)).toThrow();
  });

  it("R1 treats both OFAPI vendor hosts as the default base origin and keeps every other check", () => {
    const input = { pathname: `/${ACCOUNT}/tracking-links/1/subscribers`, offset: 0, limit: 100 };
    const path = `/api/${ACCOUNT}/tracking-links/1/subscribers`;
    for (const origin of ["https://api.onlyfansapi.com", "https://app.onlyfansapi.com"]) {
      expect(resolveOfapiListNextOffset({ hasNextPage: true, nextPageUrl: `${origin}${path}?limit=100&offset=100` }, input)).toBe(100);
      expect(resolveOfapiListNextOffset({ hasNextPage: true, nextPageUrl: `${origin}${path}?offset=100` },
        { ...input, baseUrl: "https://app.onlyfansapi.com/api" })).toBe(100);
    }
    for (const nextPageUrl of [
      `https://evil.example${path}?offset=100`,
      `http://api.onlyfansapi.com${path}?offset=100`,
      `https://api.onlyfansapi.com:8443${path}?offset=100`,
      `https://www.onlyfansapi.com${path}?offset=100`,
      `https://user@api.onlyfansapi.com${path}?offset=100`,
      `https://api.onlyfansapi.com/api/${ACCOUNT}/tracking-links/2/subscribers?offset=100`,
      `https://api.onlyfansapi.com${path}?offset=100&sort=desc`,
      `https://api.onlyfansapi.com${path}?offset=100&limit=100&limit=100`,
      `https://api.onlyfansapi.com${path}?offset=100#x`,
      `https://api.onlyfansapi.com${path}?offset=0`,
    ]) expect(() => resolveOfapiListNextOffset({ hasNextPage: true, nextPageUrl }, input))
      .toThrow("OFAPI list pagination invalid or not advancing");
    // A custom (test/proxy) base keeps the exact-origin rule.
    const custom = { ...input, baseUrl: "https://ofapi.test/api" };
    expect(resolveOfapiListNextOffset({ hasNextPage: true, nextPageUrl: `https://ofapi.test${path}?offset=100` }, custom)).toBe(100);
    expect(() => resolveOfapiListNextOffset({ hasNextPage: true, nextPageUrl: `https://api.onlyfansapi.com${path}?offset=100` }, custom)).toThrow();
  });

  it.each([
    { data: {} }, { data: { lst: [] } }, { data: { list: [] } },
    { data: { list: [null], hasMore: false } }, { data: { list: [], hasMore: "false" } },
    { data: [], _pagination: { next_page: 10 } },
  ])("R2 rejects malformed list evidence without certifying completion: %j", async body => {
    const fetch = vi.fn(async () => response(body)); vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "test", restDelayMs: 0 });
    await expect(client.listTransactions!({}, ACCOUNT, {})).rejects.toThrow(/OFAPI list/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("R2 accepts documented empty pages and keeps spender array fallback isolated", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ data: { list: [], hasMore: false } }))
      .mockResolvedValueOnce(response({ data: [], _pagination: { next_page: null } }))
      .mockResolvedValueOnce(response({ data: [{ onlyfans_id: "1" }] }))
      .mockResolvedValueOnce(response({ data: [] }))
      .mockResolvedValueOnce(response({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "test", restDelayMs: 0 });
    await expect(client.listTransactions!({}, ACCOUNT, {})).resolves.toMatchObject({ items: [], hasNextPage: false });
    await expect(client.listChats({}, ACCOUNT, {})).resolves.toMatchObject({ items: [], hasNextPage: false });
    await expect(client.listTrackingLinkUsers!({}, ACCOUNT, "1", "spenders", { limit: 1 }))
      .resolves.toMatchObject({ items: [{ onlyfans_id: "1" }], hasNextPage: true });
    await expect(client.listTrackingLinkUsers!({}, ACCOUNT, "1", "spenders", { limit: 1 }))
      .resolves.toMatchObject({ items: [], hasNextPage: false });
    await expect(client.listTrackingLinkUsers!({}, ACCOUNT, "1", "subscribers", {})).rejects.toThrow("continuation");
  });

  it.each(["provider", "persistence"])("R3 refreshes one shared preflight after transient %s failure", async failure => {
    vi.useFakeTimers();
    let release: ((value: Response) => void) | undefined;
    const fetch = vi.fn().mockResolvedValueOnce(response({ team: { slug: "expected" } }, failure === "provider" ? 503 : 200))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const onPreflight = vi.fn().mockImplementationOnce(async () => {
      if (failure === "persistence") throw new Error("database unavailable");
    }).mockResolvedValue(undefined);
    const client = createOfapiClient({ apiKey: "test", restDelayMs: 0,
      credentialPolicy: { expectedTeamSlug: "expected" }, onPreflight });
    expect(await client.getCredentialPreflight!()).toMatchObject({ status: "unknown" });
    await expect(client.assertCredentialReady!()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001);
    const first = client.getCredentialPreflight!();
    const second = client.getCredentialPreflight!();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    release!(response({ team: { slug: "expected" } }));
    const results = await Promise.all([first, second]);
    expect(results.map(value => value.status)).toEqual(["verified", "verified"]);
    await expect(client.assertCredentialReady!()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["text", "media", "typing", "unsend", "markRead", "admin"] as const)(
    "R4 keeps confirmed %s once, latches later dispatch, and recovers only accounting", async kind => {
      let accountingAvailable = false;
      const spend = vi.fn((_receipt: OfapiCreditSpendObservation) => accountingAvailable);
      const fetch = vi.fn(async () => response(paid({ id: "123", success: true })));
      vi.stubGlobal("fetch", fetch);
      const client = createOfapiClient({ apiKey: "test", restDelayMs: 0, onCreditSpend: spend });
      const send = () => kind === "text" ? client.sendTextMessage!({}, ACCOUNT, "1", { text: "test" })
        : kind === "media" ? client.sendMediaMessage!({}, ACCOUNT, "1", { text: "test", price: 0, mediaFiles: ["1"], previews: [] })
        : kind === "typing" ? client.startTyping!({}, ACCOUNT, "1")
        : kind === "unsend" ? client.unsendMessage!({}, ACCOUNT, "1", "123")
        : kind === "markRead" ? client.markChatRead!({}, ACCOUNT, "1")
        : client.createWebhook({ endpointUrl: "https://hub.test", signingSecret: "test", events: [], accountScope: "global" });
      const result = await send();
      expect(result).toHaveProperty("creditAccounting", "pending");
      await expect(send()).rejects.toBeInstanceOf(OfapiCreditAccountingUnavailableError);
      expect(fetch).toHaveBeenCalledTimes(1);
      // Free diagnostics remain usable while a paid receipt is pending.
      await client.pingBalance({});
      expect(fetch).toHaveBeenCalledTimes(2);
      accountingAvailable = true;
      await send();
      expect(fetch).toHaveBeenCalledTimes(3);
      const firstReceipt = spend.mock.calls[0]![0];
      expect(spend.mock.calls[1]![0]).toEqual(firstReceipt);
      expect(spend.mock.calls[3]![0]).toEqual(firstReceipt);
    },
  );

  it("R4 refuses legacy gateway success when accounting rejects and blocks its next egress", async () => {
    const fetch = vi.fn(async () => response(paid({ id: "1" }))); vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "test", restDelayMs: 0, onCreditSpend: () => false });
    const read = () => client.proxyRead!({}, { operation: "test", pathname: `/${ACCOUNT}/users/1`,
      query: {}, fallbackCredits: 1, fallbackEstimated: true });
    await expect(read()).rejects.toThrow("accounting unavailable");
    await expect(read()).rejects.toBeInstanceOf(OfapiCreditAccountingUnavailableError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("R5 preserves every accepted media identifier at the safe integer boundary", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response(paid({ id: "123" }))); vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "test", restDelayMs: 0 });
    const ids = ["9007199254740991", "9007199254740992", "9007199254740993", "123456789012345678901234567890", "ofapi_media_abc"];
    await client.sendMediaMessage!({}, ACCOUNT, "1", { text: "test", price: 1, mediaFiles: ids, previews: ids.slice(0, 2) });
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      mediaFiles: [9007199254740991, ...ids.slice(1)], previews: [9007199254740991, ids[1]],
    });
  });

  it("R6 rejects absent required query fields and enforces list limit boundaries locally", () => {
    for (const path of [`${ACCOUNT}/users/list`, `${ACCOUNT}/chats/1/messages/search`]) {
      expect(() => resolveOfapiReadGatewayRequest(path, {})).toThrow("required");
    }
    for (const limit of ["1", "9", "51", "100"]) {
      expect(() => resolveOfapiReadGatewayRequest(`${ACCOUNT}/user-lists`, { limit })).toThrow("10..50");
    }
    for (const limit of ["10", "50"]) {
      expect(resolveOfapiReadGatewayRequest(`${ACCOUNT}/user-lists`, { limit })).toMatchObject({ kind: "proxy", query: { limit } });
    }
  });
});
