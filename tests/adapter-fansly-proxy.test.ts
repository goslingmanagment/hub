import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupAdapterHarness,
  fanslyAccountResponse,
  loadAdapters,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("adapter hardening", () => {
  it("reuses Fansly proxy dispatchers, attaches the 30s timeout, and closes cached agents", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const {
      FanslyAdapter,
      createProxyRequestDispatcher,
      directDispatchers,
      fetchMock,
      proxyDispatchers,
    } = await loadAdapters();

    fetchMock.mockImplementation(async () => fanslyAccountResponse());

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });
    const proxy = {
      url: "http://proxy.example:8080",
      username: "user",
      password: "pass",
    };

    await adapter.getAccountMe({
      session: {
        authorization: "token-a",
      },
      proxy,
    });
    await adapter.getAccountMe({
      session: {
        authorization: "token-b",
      },
      proxy,
    });
    await adapter.close();

    expect(createProxyRequestDispatcher).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      dispatcher: proxyDispatchers[0],
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      dispatcher: proxyDispatchers[0],
    });
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(proxyDispatchers[0]?.close).toHaveBeenCalled();
    expect(directDispatchers[0]?.close).toHaveBeenCalled();
  });
});
