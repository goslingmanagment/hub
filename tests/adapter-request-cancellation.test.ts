import type { runWithHttpRequestSignal as RunWithHttpRequestSignal } from "@agency_hub_core/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  cleanupAdapterHarness,
  fanslyAccountResponse,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const context = {
  session: { authorization: "synthetic-token" },
  proxy: { url: "socks5://proxy.example:1080" },
};

describe("Fansly adapter lease cancellation", () => {
  let harness: Awaited<ReturnType<typeof loadAdapters>>;
  let runWithHttpRequestSignal: typeof RunWithHttpRequestSignal;
  beforeAll(async () => {
    // Keep one spy identity: the external CommonJS undici namespace can retain
    // its first named-export binding across Vitest module resets.
    harness = await loadAdapters();
    ({ runWithHttpRequestSignal } = await import("@agency_hub_core/shared"));
  });
  afterEach(() => {
    harness.fetchMock.mockReset();
    vi.useRealTimers();
  });
  afterAll(() => cleanupAdapterHarness());
  it("prevents a Fansly physical retry after the response observer cancels the chunk", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const controller = new AbortController();
    const reason = new Error("synthetic lease loss");
    fetchMock.mockResolvedValue(toJsonResponse({ success: false }, { status: 503 }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });

    await expect(runWithHttpRequestSignal(controller.signal, () => adapter.getAccountMe({
      ...context,
      requestObserver: {
        async onRequestEvent(event) { if (event.state === "retry") controller.abort(reason); },
      },
    }))).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("allows a Fansly response body already in flight to reach the caller after cancellation", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const controller = new AbortController();
    const entered = deferred<void>();
    const response = deferred<Response>();
    fetchMock.mockImplementation(() => { entered.resolve(); return response.promise; });
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
    const request = runWithHttpRequestSignal(controller.signal, () => adapter.getAccountMe(context));
    await entered.promise;
    controller.abort(new Error("synthetic lease loss"));
    response.resolve(fanslyAccountResponse());

    await expect(request).resolves.toMatchObject({ parsed: { account: { id: "acct-1" } } });
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestOptions = fetchMock.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(requestOptions.signal.aborted).toBe(false);
    await adapter.close();
  });

  it("keeps a cancelled fallback waiter from letting another request bypass its predecessor", async () => {
    vi.useFakeTimers();
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockImplementation(async () => fanslyAccountResponse());
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 100 });
    await adapter.getAccountMe(context);
    const predecessor = adapter.getAccountMe(context);
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const reason = new Error("synthetic lease loss");
    const cancelled = runWithHttpRequestSignal(controller.signal, () => adapter.getAccountMe(context));
    const rejected = expect(cancelled).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await rejected;
    const successor = adapter.getAccountMe(context);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await predecessor;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await successor;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await adapter.close();
  });

});

describe("OFAPI adapter lease cancellation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(["account", "collection"] as const)("refuses OFAPI dispatch after an awaited %s hook loses the lease", async (hook) => {
    vi.resetModules();
    const { runWithHttpRequestSignal } = await import("@agency_hub_core/shared");
    const { createOfapiClient } = await import("../apps/runtime/src/services/ofapi.ts");
    const controller = new AbortController();
    const reason = new Error("synthetic lease loss");
    const gate = deferred<void>();
    const entered = deferred<void>();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let accountChecks = 0;
    let collectionRequestId: string | null = null;
    const onCollectionCancelled = vi.fn(async () => undefined);
    const events: string[] = [];
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api",
      apiKey: "synthetic-token",
      restDelayMs: 0,
      async beforeAccountRequest() {
        accountChecks += 1;
        if (hook === "account" && accountChecks === 2) { entered.resolve(); await gate.promise; }
        return 1;
      },
      async beforeCollectionRequest(input) {
        collectionRequestId = input.requestId;
        if (hook === "collection") { entered.resolve(); await gate.promise; }
      },
      onCollectionCancelled,
    });
    const request = runWithHttpRequestSignal(controller.signal, () => client.listChats({
      pageId: 55,
      requestObserver: { async onRequestEvent(event) { events.push(event.state); } },
    }, "acct_synthetic", {}));
    const rejected = expect(request).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    gate.resolve();
    await rejected;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toEqual(["started", "failed"]);
    if (hook === "collection") expect(onCollectionCancelled).toHaveBeenCalledWith(collectionRequestId);
    else expect(onCollectionCancelled).not.toHaveBeenCalled();
  });
});
