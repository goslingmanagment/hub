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
  it("rotates the Fansly direct dispatcher after a transport error", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);

    const {
      FanslyAdapter,
      createRequestDispatcher,
      directDispatchers,
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

    expect(createRequestDispatcher).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      dispatcher: directDispatchers[0],
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      dispatcher: directDispatchers[1],
    });
    expect(directDispatchers[0]?.close).toHaveBeenCalled();
    expect(events.map((event) => [event.state, event.attemptNumber])).toEqual([
      ["started", 1],
      ["retry", 1],
      ["started", 2],
      ["success", 2],
    ]);
  });
});
