import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureEvents, cleanupAdapterHarness, loadAdapters, toJsonResponse } from "./helpers/adapter-harness.ts";
import { createTestFanslySendGuard } from "./helpers/fansly-send-guard.ts";

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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const observed = captureEvents();
    const result = await adapter.getFollowersPage({
      sendGuard: createTestFanslySendGuard(),
      session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      requestObserver: observed.requestObserver,
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const observed = captureEvents();
    const result = await adapter.getSubscribersPage({
      sendGuard: createTestFanslySendGuard(),
      session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      requestObserver: observed.requestObserver,
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const context = { sendGuard: createTestFanslySendGuard(), session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" } };
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const context = { sendGuard: createTestFanslySendGuard(), session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" } };
    expect(await adapter.getFollowersPage(context, "account", {})).toMatchObject({ contractAccepted: true, done: true });
    expect(await adapter.getFollowersPage(context, "account", {})).toMatchObject({ contractAccepted: true, done: true });
    expect(await adapter.getSubscribersPage(context, {})).toMatchObject({ contractAccepted: true, done: true });
    expect(await adapter.getSubscribersPage(context, { status: "5" })).toMatchObject({ contractAccepted: true, done: true });
    await adapter.close();
  });

  it.each([
    null, {}, "private body", { data: null }, { data: "" }, { data: {} }, { data: [null] },
    { data: [{ flags: 0 }] }, { data: [{ groupId: 7 }] }, { data: [], aggregationData: "malformed" },
    { data: [], aggregationData: { accounts: "malformed" } },
    { data: [], aggregationData: { groups: [{ type: 1 }] } },
    { data: [], aggregationData: { accounts: [{ username: "no-id" }] } },
  ])("returns rejected messaging groups capture material without throwing before capture: %j", async raw => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: raw }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const observed = captureEvents();
    const result = await adapter.getMessagingGroupsPage({
      sendGuard: createTestFanslySendGuard(),
      session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      requestObserver: observed.requestObserver,
    }, { offset: 100, limit: 100 });
    await adapter.close();
    expect(result).toMatchObject({
      contractAccepted: false, done: false, items: [], accounts: [], groups: [], raw, offset: 100,
    });
    expect(observed.events.map(event => event.state)).toEqual(["started", "success"]);
    expect(observed.events[1]).toMatchObject({ httpStatus: 200, responseMetadata: { contractAccepted: false } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, {}, "private body", { messages: null }, { messages: "" }, { messages: {} },
  ])("returns rejected message page capture material without throwing before capture: %j", async raw => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: raw }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const observed = captureEvents();
    const result = await adapter.getMessagesPage({
      sendGuard: createTestFanslySendGuard(),
      session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      requestObserver: observed.requestObserver,
    }, { groupId: "group-1", limit: 25, before: "m-9" });
    await adapter.close();
    expect(result).toMatchObject({
      contractAccepted: false, done: false, items: [], groupId: "group-1", before: "m-9", raw,
    });
    expect(observed.events.map(event => event.state)).toEqual(["started", "success"]);
    expect(observed.events[1]).toMatchObject({ httpStatus: 200, responseMetadata: { contractAccepted: false } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts empty and thin DM pages with their original completion semantics", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const groupPages = [{ data: [] }, { data: [], aggregationData: null },
      { data: [], aggregationData: { total: 0, accounts: null, groups: null } }];
    for (const response of groupPages) fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response }));
    // Per-message drift is the lane's to account for after capture, not a
    // page refusal (a limit-1 head repair must not wedge the sweep on it).
    for (const response of [{ messages: [] }, { messages: [{ content: "no id or createdAt" }] }]) {
      fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response }));
    }
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const context = { sendGuard: createTestFanslySendGuard(), session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" } };
    for (const _ of groupPages) {
      expect(await adapter.getMessagingGroupsPage(context, {}))
        .toMatchObject({ contractAccepted: true, done: true, items: [], accounts: [], groups: [] });
    }
    expect(await adapter.getMessagesPage(context, { groupId: "group-1" }))
      .toMatchObject({ contractAccepted: true, done: true, items: [] });
    expect(await adapter.getMessagesPage(context, { groupId: "group-1" }))
      .toMatchObject({ contractAccepted: true, done: true, items: [{ content: "no id or createdAt" }] });
    await adapter.close();
  });

  it("keeps a throwing diagnostic summary separate from capture and excludes its private error text", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const raw = { content: "private DM body" };
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: raw }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const observed = captureEvents();
    const request = (adapter as unknown as { request: (...args: unknown[]) => Promise<{ raw: unknown }> }).request.bind(adapter);
    expect(await request({
      sendGuard: createTestFanslySendGuard(),
      session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      requestObserver: observed.requestObserver,
    }, "/message", {
      operation: "message", endpointTemplate: "/message", category: "message",
      summarizeResponse: () => { throw new Error(raw.content); },
    })).toMatchObject({ raw });
    await adapter.close();
    expect(observed.events.map(event => event.state)).toEqual(["started", "success"]);
    expect(observed.events[1]).toMatchObject({ responseMetadata: { summaryUnavailable: true } });
    expect(JSON.stringify(observed.events)).not.toContain(raw.content);
  });

  it.each([
    null, {}, { account: null }, { account: [] }, { account: {} },
    { account: { id: "" } }, { account: { id: 123 } },
  ])("rejects malformed account identity during session verification: %j", async raw => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: raw }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const observed = captureEvents();
    await expect(adapter.verifySession({
      sendGuard: createTestFanslySendGuard(),
      session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      requestObserver: observed.requestObserver,
    })).rejects.toMatchObject({
      name: "FanslyApiError", message: "Fansly session verification returned an invalid account",
    });
    await adapter.close();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observed.events.map(event => event.state)).toEqual(["started", "success"]);
    expect(observed.events[1]).toMatchObject({ httpStatus: 200 });
  });

  it("verifies an explicit account identity without requiring optional profile counters", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const raw = { account: { id: "account-1" } };
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: raw }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    expect(await adapter.verifySession({
      sendGuard: createTestFanslySendGuard(),
      session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
    })).toMatchObject({ parsed: raw, raw });
    await adapter.close();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps malformed account responses available for capture outside session verification", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const raw = { content: "private account body" };
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: raw }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const observed = captureEvents();
    expect(await adapter.getAccountMe({
      sendGuard: createTestFanslySendGuard(),
      session: { authorization: "token" }, proxy: { url: "socks5://proxy.example:1080" },
      requestObserver: observed.requestObserver,
    })).toMatchObject({ raw });
    await adapter.close();
    expect(observed.events.map(event => event.state)).toEqual(["started", "success"]);
    expect(observed.events[1]).toMatchObject({ responseMetadata: { summaryUnavailable: true } });
    expect(JSON.stringify(observed.events)).not.toContain(raw.content);
  });
});
