import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureEvents,
  cleanupAdapterHarness,
  fanslyAccountResponse,
  loadAdapters,
} from "./helpers/adapter-harness.ts";
import { createTestFanslySendGuard } from "./helpers/fansly-send-guard.ts";

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
    });

    const request = adapter.getAccountMe({
      sendGuard: createTestFanslySendGuard(),
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
    // The refusal is raised inside `execute`, so the loop treats it as a
    // transport failure and sleeps the shared exponential ladder between its
    // three attempts — up to 35s of real wall clock against a 30s test
    // timeout. What is under test is the refusal, not the wait.
    const httpClient = await import("../packages/shared/src/http-client.ts");
    vi.spyOn(httpClient, "exponentialRetryDelayMs").mockReturnValue(1);

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
    });

    await expect(adapter.getAccountMe({
      sendGuard: createTestFanslySendGuard(),
      session: {
        authorization: "token",
      },
      requestObserver,
    })).rejects.toThrow(/fail-closed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
