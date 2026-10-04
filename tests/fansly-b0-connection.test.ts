import { afterEach, describe, expect, it, vi } from "vitest";
import { businessFanslyWsFrame, decodeFanslyWsCapture, fanslyWsCaptureContainsSubject, FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";
import {
  drainsOnStop, FANSLY_WS_CONNECTION_TIMING, receiveFanslyConnection, type FanslyWsStopReason,
} from "../apps/runtime/src/services/fansly-ws/connection.ts";

const known = JSON.stringify({ t: 10000, d: JSON.stringify({ serviceId: 5,
  event: JSON.stringify({ type: 1, data: { id: "101", accountId: "123" } }) }) });
const unknown = JSON.stringify({ t: 99999, d: { untouched: "keep me" } });
const batch = JSON.stringify({ t: 10001, d: JSON.stringify([known, unknown]) });
class Socket extends EventTarget {
  send = vi.fn();
  frame(frame: string) { this.dispatchEvent(new MessageEvent("message", { data: frame })); }
}
function harness(overrides: Partial<Parameters<typeof receiveFanslyConnection>[0]> = {}, authenticated = true) {
  const socket = new Socket();
  const stop = vi.fn();
  const controller = new AbortController();
  const capture = vi.fn(async () => 1);
  const guard = vi.fn(async () => {});
  const onIntakeStopped = vi.fn();
  const done = receiveFanslyConnection({ open: () => ({ socket, stop }), token: "SYNTHETIC_AUTH",
    signal: controller.signal, capture, guard, onIntakeStopped, ...overrides });
  socket.dispatchEvent(new Event("open"));
  if (authenticated) socket.frame(JSON.stringify({ t: 1, d: JSON.stringify({ token: "SYNTHETIC_AUTH" }) }));
  return { socket, stop, controller, capture: overrides.capture ?? capture, guard, onIntakeStopped, done };
}

/** A capture that commits only when the test says so, in arrival order. */
function gatedCapture() {
  const commits: Array<() => void> = [];
  let next = 100;
  const capture = vi.fn((_frame: string, _ordinal: number, _receivedAt: Date) => new Promise<number>((resolve) => {
    const id = next++;
    commits.push(() => resolve(id));
  }));
  return { capture, commitNext: () => commits.shift()?.() };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Fansly B0 durable receiver", () => {
  it("pins production timing: guard every 5 s, stale after 15 s, pong within 30 s", () => {
    // Integration tests run the real socket on scaled timing; these defaults
    // are what production runs.
    expect(FANSLY_WS_CONNECTION_TIMING).toEqual({
      authTimeoutMs: 10_000, checkMs: 5_000, guardStaleMs: 15_000, pingMs: 20_000, pongTimeoutMs: 30_000,
      drainMs: 20_000,
    });
  });

  it("captures the exact business frames in arrival order, one durable write at a time", async () => {
    const gate = gatedCapture();
    const h = harness({ capture: gate.capture });
    h.socket.frame(batch); h.socket.frame(known);
    expect(h.capture).toHaveBeenCalledOnce();
    expect(h.capture).toHaveBeenLastCalledWith(batch, 2, expect.any(Date));
    gate.commitNext();
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledTimes(2));
    expect(h.capture).toHaveBeenLastCalledWith(known, 3, expect.any(Date));
    gate.commitNext();
    h.socket.frame('{"t":2,"d":"{}"}');
    await Promise.resolve();
    h.controller.abort("disabled");
    expect(await h.done).toBe("disabled");
    expect(h.stop).toHaveBeenCalledOnce();
  });

  it("stops on durable capture failure without silently continuing", async () => {
    const h = harness({ capture: vi.fn().mockRejectedValue(new Error("db_down")) });
    h.socket.frame(batch); h.socket.frame(known);
    expect(await h.done).toBe("capture_unavailable");
    h.socket.frame(known);
    expect(h.capture).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledOnce();
  });

  it("bounds an in-flight capture plus queued frames, stops on overflow and bounds the drain", async () => {
    vi.useFakeTimers();
    const h = harness({ capture: vi.fn(() => new Promise<number>(() => {})) });
    for (let i = 0; i < 129; i++) h.socket.frame(known);
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.onIntakeStopped).toHaveBeenCalledOnce();
    // The in-flight capture never commits: the drain gives up at its bound.
    let settled = false; void h.done.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(FANSLY_WS_CONNECTION_TIMING.drainMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await h.done).toBe("overflow");
    expect(h.capture).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["ownership_lost", "generation_changed", "guard_unavailable", "disabled"])("closes immediately on %s", async (reason) => {
    const h = harness(); h.controller.abort(reason);
    expect(await h.done).toBe(reason); expect(h.stop).toHaveBeenCalledOnce();
    h.socket.frame(known); expect(h.capture).not.toHaveBeenCalled();
  });

  it("drops queued frames only when the right (or the ability) to write is lost", () => {
    const dropping: FanslyWsStopReason[] = ["ownership_lost", "generation_changed", "guard_unavailable",
      "capture_unavailable"];
    const draining: FanslyWsStopReason[] = ["disabled", "closed", "transport_error", "pong_timeout", "auth_timeout",
      "auth_refused", "provider_error", "invalid_frame", "overflow"];
    expect(dropping.filter(drainsOnStop)).toEqual([]);
    expect(draining.filter(drainsOnStop)).toEqual(draining);
  });

  it.each(["disabled", "closed"])("a graceful stop (%s) closes intake and captures a full queue already received", async (how) => {
    const gate = gatedCapture();
    const h = harness({ capture: gate.capture });
    for (let i = 0; i < 128; i++) h.socket.frame(known);
    expect(h.capture).toHaveBeenCalledOnce();
    if (how === "disabled") h.controller.abort("disabled");
    else h.socket.dispatchEvent(new Event("close"));
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.onIntakeStopped).toHaveBeenCalledOnce();
    // Intake is closed: a late frame is never queued.
    h.socket.frame(known);
    let settled = false; void h.done.then(() => { settled = true; });
    for (let i = 1; i < 128; i++) {
      gate.commitNext();
      await vi.waitFor(() => expect(h.capture).toHaveBeenCalledTimes(i + 1));
    }
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.commitNext();
    expect(await h.done).toBe(how);
    expect(h.capture).toHaveBeenCalledTimes(128);
    // Ordinal 1 is the session frame; every business frame keeps its own.
    expect(gate.capture.mock.calls.map((call) => call[1])).toEqual(Array.from({ length: 128 }, (_, i) => i + 2));
  });

  it("a drain ends at once when the right to write is lost mid-drain", async () => {
    const gate = gatedCapture();
    const h = harness({ capture: gate.capture });
    for (let i = 0; i < 5; i++) h.socket.frame(known);
    h.socket.dispatchEvent(new Event("close"));
    gate.commitNext();
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledTimes(2));
    h.controller.abort("ownership_lost");
    expect(await h.done).toBe("closed");
    gate.commitNext();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.capture).toHaveBeenCalledTimes(2);
  });

  it("a capture failure during a drain ends it without retrying the frame", async () => {
    let calls = 0;
    const h = harness({ capture: vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("db_down");
      return calls;
    }) });
    for (let i = 0; i < 4; i++) h.socket.frame(known);
    h.controller.abort("disabled");
    expect(await h.done).toBe("disabled");
    expect(h.capture).toHaveBeenCalledTimes(2);
  });

  it("closes within 20 seconds when the generation/DB guard never returns", async () => {
    vi.useFakeTimers();
    const h = harness({ guard: () => new Promise<void>(() => {}) });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await h.done).toBe("guard_unavailable"); expect(h.stop).toHaveBeenCalledOnce();
  });

  it("WS401 never writes a business payload", async () => {
    const h = harness(); h.socket.frame('{"t":0,"d":"{\\"code\\":401}"}');
    expect(await h.done).toBe("auth_refused"); expect(h.capture).not.toHaveBeenCalled();
  });

  it("pong alone cannot clear the authentication deadline", async () => {
    vi.useFakeTimers();
    const h = harness({}, false);
    h.socket.frame('{"t":2,"d":"{}"}');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await h.done).toBe("auth_timeout");
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("business frames cannot hide a missing pong, and stopped sockets cannot capture late frames", async () => {
    vi.useFakeTimers();
    const h = harness();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      h.socket.frame(known);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.capture).toHaveBeenCalledTimes(6);
    expect(h.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await h.done).toBe("pong_timeout");
    expect(h.stop).toHaveBeenCalledOnce();
    const sends = h.socket.send.mock.calls.length;
    h.socket.frame('{"t":2,"d":"{}"}');
    h.socket.frame(known);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.capture).toHaveBeenCalledTimes(6);
    expect(h.socket.send).toHaveBeenCalledTimes(sends);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets the failure sequence once after a verified quiet minute with working guards and pongs", async () => {
    vi.useFakeTimers();
    const onStable = vi.fn(); const h = harness({ onStable });
    for (let i = 0; i < 3; i++) {
      h.socket.frame('{"t":2,"d":"{}"}');
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(onStable).toHaveBeenCalledOnce();
    h.socket.frame(known); await vi.advanceTimersByTimeAsync(0);
    expect(onStable).toHaveBeenCalledOnce();
    h.controller.abort(); await h.done;
  });

  it("preserves unknown raw children while stripping nested control secrets", () => {
    const mixed = JSON.stringify({ t: 10001, d: JSON.stringify([known, unknown,
      { t: 1, d: JSON.stringify({ token: "SYNTHETIC_AUTH" }) }, { t: 2, d: "{}" }]) });
    const clean = businessFanslyWsFrame(mixed);
    expect(clean).not.toContain("SYNTHETIC_AUTH");
    expect(JSON.parse(JSON.parse(clean).d).slice(0, 2)).toEqual([known, unknown]);
    expect(businessFanslyWsFrame(batch)).toBe(batch);
  });

  it("bounded decode leaves debt and erasure reaches doubly encoded/unicode refs", () => {
    const large = JSON.stringify({ t: 10001, d: Array.from({ length: 1000 }, () => unknown) });
    expect(decodeFanslyWsCapture(large)).toHaveLength(256);
    expect(decodeFanslyWsCapture(large).at(-1)?.state).toBe("limit");
    const escaped = '{"t":9999,"d":"{\\"accountId\\":\\"\\\\u0031\\\\u0032\\\\u0033\\"}"}';
    expect(fanslyWsCaptureContainsSubject({ codec: FANSLY_WS_CAPTURE_KIND, frame: escaped }, "123")).toBe(true);
    expect(fanslyWsCaptureContainsSubject({ codec: FANSLY_WS_CAPTURE_KIND, frame: escaped }, "456")).toBe(false);
  });
});
