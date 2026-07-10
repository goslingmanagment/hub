import { afterEach, describe, expect, it } from "vitest";

import {
  captureEvents,
  cleanupAdapterHarness,
  fanslyAccountResponse,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("adapter hardening", () => {
  it("retries Fansly 429 responses and respects retry-after", async () => {
    const {
      FanslyAdapter,
      fetchMock,
    } = await loadAdapters();
    const { events, requestObserver } = captureEvents();

    fetchMock
      .mockResolvedValueOnce(toJsonResponse({
        success: false,
        error: {
          message: "rate limited",
        },
      }, {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "0.001",
        },
      }))
      .mockResolvedValueOnce(fanslyAccountResponse());

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });

    await expect(adapter.getAccountMe({
      session: {
        authorization: "token",
      },
      proxy: { url: "socks5://proxy.example:1080" },
      requestObserver,
    })).resolves.toMatchObject({
      parsed: {
        account: {
          id: "acct-1",
        },
      },
    });

    expect(events.map((event) => [event.state, event.attemptNumber])).toEqual([
      ["started", 1],
      ["retry", 1],
      ["started", 2],
      ["success", 2],
    ]);
    expect(events[1]).toMatchObject({
      state: "retry",
      httpStatus: 429,
      retryDelayMs: 1,
    });
  });
});
