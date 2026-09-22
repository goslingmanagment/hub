import { describe, expect, it, vi } from "vitest";
import { executeObservedRequest, type HttpRequestEvent } from "@agency_hub_core/shared";

describe("observed response processing", () => {
  it.each([false, true])("terminalizes a response exception once (async=%s), without retry or payload diagnostics", async (asyncFailure) => {
    const events: HttpRequestEvent[] = [];
    const error = new Error("private response body must stay out of telemetry");
    const execute = vi.fn(async () => "captured response");
    const onTransportError = vi.fn(() => ({ kind: "retry" as const, retryDelayMs: 0 }));

    await expect(executeObservedRequest({
      requestId: "response-failure", operation: "send", endpointTemplate: "/messages", method: "POST",
      retries: 3, execute, onTransportError,
      observer: { async onRequestEvent(event) { events.push(event); } },
      onResponse: () => {
        if (asyncFailure) return Promise.reject(error);
        throw error;
      },
    })).rejects.toBe(error);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(onTransportError).not.toHaveBeenCalled();
    expect(events.map(event => event.state)).toEqual(["started", "failed"]);
    expect(events[1]).toMatchObject({ failureKind: "provider", errorMessage: "HTTP response processing failed" });
    expect(JSON.stringify(events)).not.toContain(error.message);
  });

  it("does not emit a second terminal event when the terminal observer fails", async () => {
    const states: string[] = [];
    const error = new Error("telemetry unavailable");
    await expect(executeObservedRequest({
      requestId: "observer-failure", operation: "read", endpointTemplate: "/read", method: "GET",
      execute: async () => "body",
      onTransportError: failure => ({ kind: "failed", error: failure }),
      onResponse: value => ({ kind: "success", value, httpStatus: 200 }),
      observer: { async onRequestEvent(event) {
        states.push(event.state);
        if (event.state === "success") throw error;
      } },
    })).rejects.toBe(error);
    expect(states).toEqual(["started", "success"]);
  });
});
