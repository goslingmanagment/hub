import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureEvents,
  cleanupAdapterHarness,
  fanslyAccountResponse,
  loadAdapters,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("adapter hardening", () => {
  // W3.1 (decision #124): Fansly requests always ride the page proxy — the
  // rotation-after-transport-error behavior now lives on the proxy
  // dispatcher (the direct dispatcher is refused, pinned below).
  it("rotates the Fansly proxy dispatcher after a transport error", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);

    const {
      FanslyAdapter,
      createProxyRequestDispatcher,
      proxyDispatchers,
      fetchMock,
    } = await loadAdapters();
    const { events, requestObserver } = captureEvents();

    fetchMock
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(fanslyAccountResponse());

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });

    const request = adapter.getAccountMe({
      session: {
        authorization: "token",
      },
      proxy: { url: "socks5://proxy.example:1080" },
      requestObserver,
    });

    await Promise.resolve();
    await vi.runAllTimersAsync();

    await expect(request).resolves.toMatchObject({
      parsed: {
        account: {
          id: "acct-1",
        },
      },
    });

    expect(createProxyRequestDispatcher).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      dispatcher: proxyDispatchers[0],
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      dispatcher: proxyDispatchers[1],
    });
    expect(proxyDispatchers[0]?.close).toHaveBeenCalled();
    expect(events.map((event) => [event.state, event.attemptNumber])).toEqual([
      ["started", 1],
      ["retry", 1],
      ["started", 2],
      ["success", 2],
    ]);
  });

  it("refuses proxyless Fansly dispatch fail-closed (decision #124)", async () => {
    const { FanslyAdapter, fetchMock } = await loadAdapters();
    const { requestObserver } = captureEvents();

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });

    await expect(adapter.getAccountMe({
      session: {
        authorization: "token",
      },
      requestObserver,
    })).rejects.toThrow(/fail-closed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
