import { afterEach, describe, expect, it, vi } from "vitest";
import { createProxyRequestDispatcher } from "../packages/shared/src/http-client.ts";
import { createProbeTransportDiagnostics } from "../apps/runtime/src/services/egress/fansly-probe-diagnostics.ts";
import { observeFanslyProbe } from "../scripts/fansly-ws/probe-observer.ts";

const secret = "SYNTHETIC_SECRET https://user:password@private.invalid/token";
const dispatchers: ReturnType<typeof createProxyRequestDispatcher>[] = [];
afterEach(async () => { await Promise.all(dispatchers.splice(0).map((item) => item.destroy())); });

function capture() {
  const dispatcher = createProxyRequestDispatcher({ url: "http://127.0.0.1:1" });
  dispatchers.push(dispatcher);
  type Handler = Parameters<typeof dispatcher.dispatch>[1];
  type Controller = Parameters<NonNullable<Handler["onResponseError"]>>[0];
  let intercepted: Handler;
  const forward = {
    onRequestStart: vi.fn(), onRequestUpgrade: vi.fn(), onResponseStart: vi.fn(),
    onResponseStarted: vi.fn(), onResponseData: vi.fn(), onResponseEnd: vi.fn(), onResponseError: vi.fn(),
  };
  const dispatch = vi.spyOn(dispatcher, "dispatch").mockImplementation((_options, handler) => {
    intercepted = handler;
    return false;
  });
  const diagnostics = createProbeTransportDiagnostics();
  const options = { origin: "https://wsv3.fansly.com", path: "/?v=3", method: "GET" as const };
  expect(diagnostics.wrap(dispatcher).dispatch(options, forward)).toBe(false);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatch.mock.calls[0]?.[0]).toBe(options);
  return { diagnostics, handler: intercepted!, forward, controller: {} as Controller };
}

describe("W0 per-attempt transport diagnostics", () => {
  it("captures only a bounded allowlisted code and forwards the original error/receiver", () => {
    const run = capture();
    const error = new Error(secret, { cause: Object.assign(new Error(secret), { code: "ECONNREFUSED" }) });
    run.handler.onResponseError!(run.controller, error);
    expect(run.forward.onResponseError).toHaveBeenCalledExactlyOnceWith(run.controller, error);
    expect(run.forward.onResponseError.mock.contexts[0]).toBe(run.forward);
    expect(run.diagnostics.finish()).toEqual({ transportErrorCode: "ECONNREFUSED", httpStatus: null });
    expect(JSON.stringify(run.diagnostics.finish())).not.toContain(secret);
  });

  it("keeps unknown, cyclic, too-deep and throwing errors bounded without replacing them", () => {
    const cyclic = Object.assign(new Error(secret), { code: secret, cause: null as unknown });
    cyclic.cause = cyclic;
    const deep = { cause: { cause: { cause: { cause: { code: "ECONNRESET" } } } } };
    const throwing = Object.defineProperty(new Error(secret), "code", { get() { throw new Error(secret); } });
    const throwingCause = Object.defineProperty(new Error(secret), "cause", { get() { throw new Error(secret); } });
    for (const error of [new Error(secret), cyclic, deep, throwing, throwingCause]) {
      const run = capture();
      run.handler.onResponseError!(run.controller, error as Error);
      run.handler.onResponseError!(run.controller, Object.assign(new Error(secret), { code: "UND_ERR_ABORTED" }));
      expect(run.diagnostics.finish()).toEqual({ transportErrorCode: null, httpStatus: null });
      expect(run.forward.onResponseError.mock.calls[0]?.[1]).toBe(error);
    }
  });

  it("reads an allowlisted code getter only once so a later value cannot leak", () => {
    const run = capture();
    let reads = 0;
    const error = Object.defineProperty(new Error(secret), "code", {
      get() { return ++reads <= 2 ? "ECONNREFUSED" : secret; },
    });
    run.handler.onResponseError!(run.controller, error);
    expect(run.diagnostics.finish()).toEqual({ transportErrorCode: "ECONNREFUSED", httpStatus: null });
    expect(reads).toBe(1);
  });

  it("ignores interim/invalid status, preserves rejection status and forwards callbacks", () => {
    const run = capture();
    const headers = { "x-private": secret };
    run.handler.onRequestStart!(run.controller, headers);
    run.handler.onResponseStarted!();
    for (const code of [103, 199, 99, 600, 403.5, Number.NaN, 403]) {
      run.handler.onResponseStart!(run.controller, code, headers, secret);
    }
    const chunk = Buffer.from(secret);
    run.handler.onResponseData!(run.controller, chunk);
    run.handler.onResponseEnd!(run.controller, headers);
    expect(run.diagnostics.finish()).toEqual({ transportErrorCode: null, httpStatus: 403 });
    expect(run.forward.onRequestStart).toHaveBeenCalledExactlyOnceWith(run.controller, headers);
    expect(run.forward.onResponseStart).toHaveBeenLastCalledWith(run.controller, 403, headers, secret);
    expect(run.forward.onResponseData).toHaveBeenCalledExactlyOnceWith(run.controller, chunk);
    expect(run.forward.onResponseEnd).toHaveBeenCalledExactlyOnceWith(run.controller, headers);
    expect(run.forward.onResponseStart.mock.contexts.every((value) => value === run.forward)).toBe(true);
  });

  it("records 101 independently of open and freezes before cleanup errors and late status", async () => {
    const run = capture();
    const socket = new class extends EventTarget {
      readyState = 0;
      send() {}
      close() {
        run.handler.onResponseError!(run.controller, Object.assign(new Error(secret), { code: "UND_ERR_ABORTED" }));
        run.handler.onResponseStart!(run.controller, 503, {}, secret);
      }
    };
    const report = observeFanslyProbe({ connect: () => socket, token: secret, key: Buffer.alloc(32),
      durationMs: 60_000, signal: new AbortController().signal, transportDiagnostics: run.diagnostics });
    run.forward.onRequestUpgrade.mockReturnValue(true);
    expect(run.handler.onRequestUpgrade!(run.controller, 101, { "x-private": secret }, socket as never)).toBe(true);
    run.handler.onResponseError!(run.controller, Object.assign(new Error(secret), { code: "ECONNRESET" }));
    socket.dispatchEvent(new Event("error"));
    const result = await report;
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 4001, reason: secret }));
    expect(result).toMatchObject({ stopReason: "transport_error", failurePhase: "pre_open",
      openedAt: null, sessionFrameSeen: false, closeCode: null, transportErrorCode: "ECONNRESET", httpStatus: 101 });
    expect(run.diagnostics.finish()).toEqual({ transportErrorCode: "ECONNRESET", httpStatus: 101 });
    expect(run.forward.onRequestUpgrade).toHaveBeenCalledExactlyOnceWith(run.controller, 101, { "x-private": secret }, socket);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
