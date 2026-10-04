import { afterEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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
