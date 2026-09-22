import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEvents, cleanupAdapterHarness, loadAdapters, toJsonResponse } from "./helpers/adapter-harness.ts";

let harness: Awaited<ReturnType<typeof loadAdapters>>;
beforeAll(async () => { harness = await loadAdapters(); });
beforeEach(() => { harness.fetchMock.mockReset(); });
afterAll(cleanupAdapterHarness);

describe("Fansly audience response contracts", () => {
  it.each([
    null, {}, "private body", { followers: null }, { followers: [null] },
    { followers: [{ id: "relation-without-fan" }] },
    { followers: [], aggregationData: { accounts: "malformed" } },
  ])("returns rejected follower capture material without a phantom empty page: %j", async raw => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: raw }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
    const observed = captureEvents();
    const result = await adapter.getFollowersPage({
      session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      rateLimitWaiter: vi.fn(async () => 0), requestObserver: observed.requestObserver,
    }, "account-1", { offset: 100, limit: 100 });
    await adapter.close();
    expect(result).toMatchObject({ contractAccepted: false, done: false, raw, offset: 100 });
    expect(observed.events.map(event => event.state)).toEqual(["started", "success"]);
    expect(observed.events[1]).toMatchObject({ httpStatus: 200, responseMetadata: { contractAccepted: false } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, {}, { stats: null, subscriptions: [] }, { stats: { total: 0, totalActive: 0, totalExpired: 0 } },
    { stats: { total: 0, totalActive: -1, totalExpired: 0 }, subscriptions: [] },
    { stats: { total: 1, totalActive: 1, totalExpired: 0 }, subscriptions: [null] },
  ])("returns rejected subscriber capture material without throwing before capture: %j", async raw => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: raw }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
    const observed = captureEvents();
    const result = await adapter.getSubscribersPage({
      session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      rateLimitWaiter: vi.fn(async () => 0), requestObserver: observed.requestObserver,
    }, { offset: 100, limit: 100 });
    await adapter.close();
    expect(result).toMatchObject({ contractAccepted: false, done: false, raw, offset: 100 });
    expect(observed.events.map(event => event.state)).toEqual(["started", "success"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts explicit empty pages with their original completion semantics", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: { followers: [] } }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: {
        stats: { total: 0, totalActive: 0, totalExpired: 0 }, subscriptions: [],
      } }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
    const context = { session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      rateLimitWaiter: vi.fn(async () => 0) };
    expect(await adapter.getFollowersPage(context, "account", {})).toMatchObject({ contractAccepted: true, done: true });
    expect(await adapter.getSubscribersPage(context, {})).toMatchObject({ contractAccepted: true, done: true });
    await adapter.close();
  });

  it("keeps nullable optional follower sidecars and status-specific subscriber totals valid", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const responses = [{ followers: [], aggregationData: null },
      { followers: [], aggregationData: { accounts: null } },
      { stats: { totalActive: 0 }, subscriptions: [] },
      { stats: { totalExpired: 0 }, subscriptions: [] }];
    for (const response of responses) fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
    const context = { session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      rateLimitWaiter: vi.fn(async () => 0) };
    expect(await adapter.getFollowersPage(context, "account", {})).toMatchObject({ contractAccepted: true, done: true });
    expect(await adapter.getFollowersPage(context, "account", {})).toMatchObject({ contractAccepted: true, done: true });
    expect(await adapter.getSubscribersPage(context, {})).toMatchObject({ contractAccepted: true, done: true });
    expect(await adapter.getSubscribersPage(context, { status: "5" })).toMatchObject({ contractAccepted: true, done: true });
    await adapter.close();
  });

  it("keeps a throwing diagnostic summary separate from capture and excludes its private error text", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const raw = { content: "private DM body" };
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: raw }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
    const observed = captureEvents();
    const request = (adapter as unknown as { request: (...args: unknown[]) => Promise<{ raw: unknown }> }).request.bind(adapter);
    expect(await request({
      session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      rateLimitWaiter: vi.fn(async () => 0), requestObserver: observed.requestObserver,
    }, "/message", {
      operation: "message", endpointTemplate: "/message", category: "message",
      summarizeResponse: () => { throw new Error(raw.content); },
    })).toMatchObject({ raw });
    await adapter.close();
    expect(observed.events.map(event => event.state)).toEqual(["started", "success"]);
    expect(observed.events[1]).toMatchObject({ responseMetadata: { summaryUnavailable: true } });
    expect(JSON.stringify(observed.events)).not.toContain(raw.content);
  });
});
