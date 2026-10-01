import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupAdapterHarness,
  fanslyTransactionsResponse,
  loadAdapters,
} from "./helpers/adapter-harness.ts";
import { createTestFanslySendGuard } from "./helpers/fansly-send-guard.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("Fansly transaction query-shape parity seam", () => {
  it("can A/B omitted and present-empty unbounded bounds", async () => {
    const { FanslyAdapter, fetchMock } = await loadAdapters();
    fetchMock
      .mockResolvedValueOnce(fanslyTransactionsResponse())
      .mockResolvedValueOnce(fanslyTransactionsResponse());
    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
    });
    const context = {
      sendGuard: createTestFanslySendGuard(),
      session: { authorization: "token" },
      proxy: { url: "socks5://proxy.example:1080" },
    };

    await adapter.getTransactionsPage(context, {
      limit: 10,
      offset: 0,
      unboundedQueryShape: "omitted",
    });
    await adapter.getTransactionsPage(context, {
      limit: 10,
      offset: 0,
      unboundedQueryShape: "present-empty",
    });
    await adapter.close();

    const [omitted, presentEmpty] = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)));
    expect(omitted?.searchParams.has("before")).toBe(false);
    expect(omitted?.searchParams.has("after")).toBe(false);
    expect(presentEmpty?.searchParams.has("before")).toBe(true);
    expect(presentEmpty?.searchParams.get("before")).toBe("");
    expect(presentEmpty?.searchParams.has("after")).toBe(true);
    expect(presentEmpty?.searchParams.get("after")).toBe("");
    for (const url of [omitted, presentEmpty]) {
      expect(url?.searchParams.get("limit")).toBe("10");
      expect(url?.searchParams.get("offset")).toBe("0");
    }
  });
});
