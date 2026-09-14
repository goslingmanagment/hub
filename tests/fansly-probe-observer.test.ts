import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { observeFanslyProbe } from "../scripts/fansly-ws/probe-observer.ts";
import {
  privateMessageEvent, serviceFrame, syntheticSecret, syntheticMessage, wrapped,
} from "./helpers/fansly-ws-fixtures.ts";

class TestSocket extends EventTarget {
  readyState = 0;
  send = vi.fn<(data: string) => void>();
  close = vi.fn();
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
}

function start(durationMs = 60_000, socket = new TestSocket()) {
  const controller = new AbortController();
  const connect = vi.fn(() => socket);
  const result = observeFanslyProbe({
    connect, token: syntheticSecret, key: Buffer.alloc(32, 1),
    durationMs, signal: controller.signal,
  });
  return { socket, controller, connect, result };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("bounded Fansly socket observation", () => {
  it("sends native nested auth once and retains only received metadata", async () => {
    const probe = start();
    probe.socket.open();
    expect(probe.socket.send).toHaveBeenCalledExactlyOnceWith(wrapped(1, {
      token: syntheticSecret, v: 3,
    }));
    probe.socket.receive(wrapped(1, {}));
    probe.socket.receive(serviceFrame(privateMessageEvent()));
    probe.controller.abort();
    const report = await probe.result;
    expect(report).toMatchObject({
      stopReason: "aborted", sessionFrameSeen: true, framesReceived: 2, framesRetained: 2,
    });
    expect(JSON.stringify(report)).not.toContain(syntheticSecret);
    expect(JSON.stringify(report)).not.toContain(syntheticMessage);
    expect(probe.connect).toHaveBeenCalledTimes(1);
    expect(probe.socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not treat pongs as authentication", async () => {
    const probe = start();
    probe.socket.open();
    probe.socket.receive(wrapped(2, {}));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await probe.result).toMatchObject({ stopReason: "auth_timeout", sessionFrameSeen: false });
    expect(probe.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps one connection alive with native pings until the absolute deadline", async () => {
    const probe = start();
    probe.socket.open();
    probe.socket.receive(wrapped(1, {}));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(probe.socket.send).toHaveBeenLastCalledWith("p");
    probe.socket.receive(wrapped(2, {}));
    await vi.advanceTimersByTimeAsync(20_000);
    probe.socket.receive(wrapped(2, {}));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await probe.result).toMatchObject({ stopReason: "deadline", sessionFrameSeen: true });
    expect(probe.connect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops on missing heartbeat without reconnecting", async () => {
    const probe = start();
    probe.socket.open();
    probe.socket.receive(wrapped(1, {}));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await probe.result).toMatchObject({ stopReason: "pong_timeout" });
    expect(probe.connect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["provider error", wrapped(0, { code: 401, message: syntheticSecret }), "provider_error"],
    ["invalid JSON", "invalid " + syntheticSecret, "invalid_frame"],
    ["binary data", new Uint8Array([1, 2]), "invalid_frame"],
    ["oversized frame", "x".repeat(1024 * 1024 + 1), "frame_limit"],
  ])("stops and excludes unsafe payloads: %s", async (_label, frame, reason) => {
    const probe = start();
    probe.socket.open();
    probe.socket.receive(frame);
    const report = await probe.result;
    expect(report.stopReason).toBe(reason);
    expect(JSON.stringify(report)).not.toContain(syntheticSecret);
    expect(probe.socket.send).toHaveBeenCalledTimes(1);
    expect(probe.connect).toHaveBeenCalledTimes(1);
  });

  it("stops at the record bound and reports the unretained frame", async () => {
    const probe = start();
    probe.socket.open();
    for (let i = 0; i < 1001; i++) probe.socket.receive(wrapped(2, {}));
    expect(await probe.result).toMatchObject({
      stopReason: "report_limit", framesReceived: 1001, framesRetained: 1000,
    });
  });

  it("excludes transport error details and close reasons", async () => {
    const probe = start();
    const error = Object.assign(new Event("error"), { message: syntheticSecret });
    probe.socket.dispatchEvent(error);
    probe.socket.dispatchEvent(Object.assign(new Event("close"), {
      code: 4001, reason: syntheticSecret,
    }));
    const report = await probe.result;
    expect(report.stopReason).toBe("transport_error");
    expect(JSON.stringify(report)).not.toContain(syntheticSecret);
    expect(probe.socket.close).toHaveBeenCalledTimes(1);
  });

  it("never connects after cancellation or invalid bounds", async () => {
    const connect = vi.fn(() => new TestSocket());
    const input = {
      connect, token: syntheticSecret, key: Buffer.alloc(32),
      durationMs: 120_001, signal: AbortSignal.abort(),
    };
    expect(() => observeFanslyProbe(input)).toThrow("invalid_probe_input");
    expect(await observeFanslyProbe({ ...input, durationMs: 120_000 }))
      .toMatchObject({ stopReason: "aborted" });
    expect(connect).not.toHaveBeenCalled();
  });
});
