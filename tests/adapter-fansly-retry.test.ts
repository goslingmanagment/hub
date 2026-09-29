import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as FanslyErrorsModule from "../packages/fansly/src/errors.ts";
import type * as HttpClientModule from "../packages/shared/src/http-client.ts";

import {
  captureEvents,
  cleanupAdapterHarness,
  fanslyAccountResponse,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";

// ONE harness for the whole file (the rule tests/adapter-fansly-endpoint-scour
// states): `loadAdapters` resets the module registry and re-spies
// `undici.fetch`, so calling it per test leaves the adapter bound to a module
// instance the new spy no longer covers and the calls escape to the real
// network. The Fansly error class is taken from the same registry for the same
// reason — a top-level import of the package would freeze the real `fetch`
// into the adapter's binding before the harness ever spies it.
let harness: Awaited<ReturnType<typeof loadAdapters>>;
let FanslyApiError: typeof FanslyErrorsModule.FanslyApiError;
let httpClient: typeof HttpClientModule;

beforeAll(async () => {
  harness = await loadAdapters();
  ({ FanslyApiError } = await import("../packages/fansly/src/errors.ts"));
  httpClient = await import("../packages/shared/src/http-client.ts");
});

beforeEach(() => {
  harness.fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  cleanupAdapterHarness();
});

function rateLimitedResponse(retryAfter?: string) {
  return toJsonResponse({
    success: false,
    error: {
      message: "rate limited",
    },
  }, {
    status: 429,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
  });
}

function fanslyRequestInput(requestObserver: ReturnType<typeof captureEvents>["requestObserver"]) {
  return {
    session: { authorization: "token" },
    proxy: { url: "socks5://proxy.example:1080" },
    requestObserver,
  };
}

function buildAdapter() {
  return new harness.FanslyAdapter({
    baseUrl: "https://fansly.example",
    globalDelayMs: 0,
  });
}

describe("adapter hardening", () => {
  it("retries Fansly 429 responses and respects retry-after", async () => {
    const { fetchMock } = harness;
    const { events, requestObserver } = captureEvents();

    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse("0.001"))
      .mockResolvedValueOnce(fanslyAccountResponse());

    await expect(buildAdapter().getAccountMe(fanslyRequestInput(requestObserver)))
      .resolves.toMatchObject({
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

  it("stops retrying a 429 whose Retry-After outruns the in-process clamp", async () => {
    const { fetchMock } = harness;
    const { events, requestObserver } = captureEvents();

    // Three retries are budgeted and the provider said 600s. Clamping that to
    // the 60s in-process ceiling would spend every attempt inside a window the
    // provider already declared closed — each one another 429 for this page.
    // (A Response body reads once, so every attempt gets a fresh one.)
    fetchMock.mockImplementation(async () => rateLimitedResponse("600"));

    const before = Date.now();
    const error = await buildAdapter().getAccountMe(fanslyRequestInput(requestObserver))
      .catch((thrown: unknown) => thrown);
    const after = Date.now();

    expect(error).toBeInstanceOf(FanslyApiError);
    const apiError = error as InstanceType<typeof FanslyApiError>;
    expect(apiError.status).toBe(429);
    expect(apiError.retryAfterAt).toBeInstanceOf(Date);
    // The deadline is the provider's own: absolute and unclamped.
    expect(apiError.retryAfterAt!.getTime()).toBeGreaterThanOrEqual(before + 600_000);
    expect(apiError.retryAfterAt!.getTime()).toBeLessThanOrEqual(after + 600_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.map((event) => [event.state, event.attemptNumber])).toEqual([
      ["started", 1],
      ["failed", 1],
    ]);
  });

  it("carries a Retry-After HTTP-date deadline on the terminal 503", async () => {
    const { fetchMock } = harness;
    const { requestObserver } = captureEvents();
    const deadline = new Date(Date.now() + 900_000);

    fetchMock.mockImplementation(async () => toJsonResponse({
      success: false,
      error: { message: "unavailable" },
    }, {
      status: 503,
      headers: {
        "content-type": "application/json",
        "retry-after": deadline.toUTCString(),
      },
    }));

    const error = await buildAdapter().getAccountMe(fanslyRequestInput(requestObserver))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FanslyApiError);
    const apiError = error as InstanceType<typeof FanslyApiError>;
    expect(apiError.status).toBe(503);
    // The date form is the same fact as delta-seconds; `toUTCString` is the
    // wire's own second-resolution rendering of it.
    expect(apiError.retryAfterAt?.toUTCString()).toBe(deadline.toUTCString());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the in-process retry for a Retry-After inside the clamp", async () => {
    const { fetchMock } = harness;
    const { events, requestObserver } = captureEvents();
    const abortSignalTimeout = vi.spyOn(AbortSignal, "timeout")
      .mockImplementation(() => new AbortController().signal);
    vi.useFakeTimers();

    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse("5"))
      .mockResolvedValueOnce(fanslyAccountResponse());

    const request = buildAdapter().getAccountMe(fanslyRequestInput(requestObserver));

    await Promise.resolve();
    await vi.runAllTimersAsync();

    await expect(request).resolves.toMatchObject({
      parsed: { account: { id: "acct-1" } },
    });
    expect(events.map((event) => [event.state, event.attemptNumber])).toEqual([
      ["started", 1],
      ["retry", 1],
      ["started", 2],
      ["success", 2],
    ]);
    // Five seconds fits the clamp, so nothing on this path changed.
    expect(events[1]).toMatchObject({
      state: "retry",
      httpStatus: 429,
      retryDelayMs: 5_000,
    });
    abortSignalTimeout.mockRestore();
  });

  it("leaves the deadline null when a terminal 429 names none", async () => {
    const { fetchMock } = harness;
    const { events, requestObserver } = captureEvents();
    // No wall clock in a unit test; the ladder itself is pinned in
    // tests/http-client.test.ts. The HTTP-response retry takes its delay from
    // `resolveRetryDelayMs`, which reaches `exponentialRetryDelayMs` through a
    // module-local binding a namespace spy cannot intercept — so the spy goes
    // on the function the adapter actually calls.
    const resolveRetryDelayMs = vi.spyOn(httpClient, "resolveRetryDelayMs")
      .mockReturnValue(1);

    fetchMock.mockImplementation(async () => rateLimitedResponse());

    const error = await buildAdapter().getAccountMe({
      ...fanslyRequestInput(requestObserver),
      // One retry left, so the loop exhausts it and throws.
      remainingAttempts: () => 2,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FanslyApiError);
    // Nothing to hand the durable retry: the page-sync ladder owns the wait.
    expect((error as InstanceType<typeof FanslyApiError>).retryAfterAt).toBeNull();
    expect(events.map((event) => [event.state, event.attemptNumber])).toEqual([
      ["started", 1],
      ["retry", 1],
      ["started", 2],
      ["failed", 2],
    ]);
    // The spy is the one on the path: the retry waited its 1ms, not the ladder.
    expect(events[1]).toMatchObject({ state: "retry", httpStatus: 429, retryDelayMs: 1 });
    resolveRetryDelayMs.mockRestore();
  });

  it("takes its transport backoff from the shared exponential ladder", async () => {
    const { fetchMock } = harness;
    const { events, requestObserver } = captureEvents();
    const exponentialRetryDelayMs = vi.spyOn(httpClient, "exponentialRetryDelayMs")
      .mockReturnValue(1);

    fetchMock
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(fanslyAccountResponse());

    await expect(buildAdapter().getAccountMe(fanslyRequestInput(requestObserver)))
      .resolves.toMatchObject({ parsed: { account: { id: "acct-1" } } });

    // The adapter no longer keeps its own linear 5s*n transport ladder.
    expect(exponentialRetryDelayMs).toHaveBeenCalledWith(1);
    expect(events[1]).toMatchObject({
      state: "retry",
      failureKind: "transport",
      retryDelayMs: 1,
    });
    exponentialRetryDelayMs.mockRestore();
  });
});
