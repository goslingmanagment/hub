import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeObservedRequest,
  getHttpRequestSignal,
  runWithHttpRequestSignal,
  waitForHttpRequestDelay,
  type HttpRequestEvent,
} from "@agency_hub_core/shared";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function requestFixture() {
  const events: HttpRequestEvent[] = [];
  return {
    events,
    requestId: "synthetic-request",
    operation: "synthetic-read",
    endpointTemplate: "/synthetic",
    method: "GET",
    observer: { onRequestEvent: vi.fn(async (event: HttpRequestEvent) => { events.push(event); }) },
    execute: vi.fn(async () => "captured-response"),
    onResponse: vi.fn(async (value: string) => ({ kind: "success" as const, value, httpStatus: 200 })),
    onTransportError: vi.fn((error: unknown) => ({ kind: "failed" as const, error })),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("observed request cancellation", () => {
  it("refuses an already cancelled scope before rate admission or an attempt", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic lease loss");
    controller.abort(reason);
    const fixture = requestFixture();
    const waitForRateLimit = vi.fn(async () => 0);

    await expect(runWithHttpRequestSignal(controller.signal, () => executeObservedRequest({
      ...fixture, waitForRateLimit,
    }))).rejects.toBe(reason);

    expect(waitForRateLimit).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
  });

  it("releases a cancelled caller while its rate reservation drains without dispatch", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic lease loss");
    const gate = deferred<number>();
    const entered = deferred<void>();
    const fixture = requestFixture();
    const request = runWithHttpRequestSignal(controller.signal, () => executeObservedRequest({
      ...fixture,
      waitForRateLimit: () => { entered.resolve(); return gate.promise; },
    }));
    const rejected = expect(request).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    await rejected;
    gate.resolve(60_000);
    await gate.promise;

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.onTransportError).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
  });

  it.each(["http", "transport"] as const)("cancels a %s retry delay without a second attempt", async (failureKind) => {
    const controller = new AbortController();
    const reason = new Error("synthetic lease loss");
    const retrySeen = deferred<void>();
    const fixture = requestFixture();
    const retry = { kind: "retry" as const, retryDelayMs: 60_000, failureKind };
    const request = runWithHttpRequestSignal(controller.signal, () => executeObservedRequest({
      ...fixture,
      execute: failureKind === "transport"
        ? fixture.execute.mockRejectedValue(new Error("synthetic connection failure"))
        : fixture.execute,
      onResponse: () => ({ ...retry, httpStatus: 503 }),
      onTransportError: () => retry,
      observer: {
        async onRequestEvent(event) {
          fixture.events.push(event);
          if (event.state === "retry") retrySeen.resolve();
        },
      },
    }));
    const rejected = expect(request).rejects.toBe(reason);
    await retrySeen.promise;
    // Let the retry transition enter the actual node:timers/promises delay.
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(reason);
    await rejected;

    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.events.map((event) => event.state)).toEqual(["started", "retry"]);
  });

  it("rechecks after asynchronous attempt telemetry and records local refusal without transport retry", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic lease loss");
    const fixture = requestFixture();
    fixture.observer.onRequestEvent.mockImplementation(async (event) => {
      fixture.events.push(event);
      if (event.state === "started") controller.abort(reason);
    });

    await expect(runWithHttpRequestSignal(controller.signal, () => executeObservedRequest(fixture)))
      .rejects.toBe(reason);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.onTransportError).not.toHaveBeenCalled();
    expect(fixture.events[1]).toMatchObject({ state: "failed", failureKind: "policy" });
  });

  it("finishes response processing and returns capture material after in-flight cancellation", async () => {
    const controller = new AbortController();
    const response = deferred<string>();
    const entered = deferred<void>();
    const fixture = requestFixture();
    fixture.execute.mockImplementation(() => { entered.resolve(); return response.promise; });
    const request = runWithHttpRequestSignal(controller.signal, () => executeObservedRequest(fixture));
    await entered.promise;
    controller.abort(new Error("synthetic lease loss"));
    response.resolve("verbatim capture material");

    await expect(request).resolves.toBe("verbatim capture material");
    expect(fixture.onResponse).toHaveBeenCalledWith("verbatim capture material", {
      attemptNumber: 1, retriesRemaining: 0,
    });
    expect(fixture.events.map((event) => event.state)).toEqual(["started", "success"]);
  });

  it("isolates overlapping page scopes and restores unscoped admission", async () => {
    const cancelled = new AbortController();
    const active = new AbortController();
    const reason = new Error("synthetic page A lost lease");
    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    const gateA = deferred<number>();
    const gateB = deferred<number>();
    const fixtureA = requestFixture();
    const fixtureB = requestFixture();
    const pageA = runWithHttpRequestSignal(cancelled.signal, () => executeObservedRequest({
      ...fixtureA,
      waitForRateLimit: () => { enteredA.resolve(); return gateA.promise; },
    }));
    const pageB = runWithHttpRequestSignal(active.signal, () => executeObservedRequest({
      ...fixtureB,
      waitForRateLimit: () => { enteredB.resolve(); return gateB.promise; },
    }));
    const rejected = expect(pageA).rejects.toBe(reason);
    await Promise.all([enteredA.promise, enteredB.promise]);
    cancelled.abort(reason);
    gateB.resolve(0);
    await rejected;
    await expect(pageB).resolves.toBe("captured-response");
    gateA.resolve(0);

    expect(fixtureA.execute).not.toHaveBeenCalled();
    expect(fixtureB.execute).toHaveBeenCalledOnce();
    expect(getHttpRequestSignal()).toBeUndefined();
    await expect(executeObservedRequest(requestFixture())).resolves.toBe("captured-response");
  });

  it("removes completed admission listeners and restores an outer scope after nesting", async () => {
    const outer = new AbortController();
    const inner = new AbortController();
    const add = vi.spyOn(inner.signal, "addEventListener");
    const remove = vi.spyOn(inner.signal, "removeEventListener");
    await runWithHttpRequestSignal(outer.signal, async () => {
      await runWithHttpRequestSignal(inner.signal, () => executeObservedRequest(requestFixture()));
      expect(getHttpRequestSignal()).toBe(outer.signal);
      await waitForHttpRequestDelay(0);
    });
    expect(add).toHaveBeenCalledTimes(remove.mock.calls.length);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
    expect(getHttpRequestSignal()).toBeUndefined();
  });
});
