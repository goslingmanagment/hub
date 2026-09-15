import { afterEach, describe, expect, it, vi } from "vitest";
import { businessFanslyWsFrame, decodeFanslyWsCapture, fanslyWsCaptureContainsSubject, FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";
import { receiveFanslyConnection } from "../apps/runtime/src/services/fansly-ws/connection.ts";
import { fanslyWsPages, startFanslyWsWorker } from "../apps/runtime/src/services/fansly-ws/worker.ts";
import * as liveConfig from "../apps/runtime/src/services/effective-config.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";

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
  const decode = vi.fn(decodeFanslyWsCapture);
  const settle = vi.fn(async () => {});
  const guard = vi.fn(async () => {});
  const done = receiveFanslyConnection({ open: () => ({ socket, stop }), token: "SYNTHETIC_AUTH",
    signal: controller.signal, capture, decode, settle, guard, ...overrides });
  socket.dispatchEvent(new Event("open"));
  if (authenticated) socket.frame(JSON.stringify({ t: 1, d: JSON.stringify({ token: "SYNTHETIC_AUTH" }) }));
  return { socket, stop, controller, capture, decode, settle, guard, done };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Fansly B0 durable receiver", () => {
  it("does no work with default-off or empty/none allowlist", async () => {
    expect([...fanslyWsPages({})]).toEqual([]);
    expect([...fanslyWsPages({ fanslyWsCaptureEnabled: true })]).toEqual([]);
    expect([...fanslyWsPages({ fanslyWsCaptureEnabled: true, fanslyWsCapturePageAllowlist: "none" })]).toEqual([]);
    expect([...fanslyWsPages({ fanslyWsCaptureEnabled: true, fanslyWsCapturePageAllowlist: "lilly-1,lilly-1" })]).toEqual(["lilly-1"]);
    const load = vi.spyOn(liveConfig, "loadEffectiveConfig").mockResolvedValue({} as AppContext["config"]);
    const worker = startFanslyWsWorker({} as AppContext);
    await Promise.resolve(); await worker.stop();
    expect(load).toHaveBeenCalledOnce();
  });

  it("commits raw before decode; keeps unknown children and excludes controls", async () => {
    let commit!: (id: number) => void;
    const h = harness({ capture: vi.fn(() => new Promise<number>((resolve) => { commit = resolve; })) });
    h.socket.frame(batch);
    expect(h.decode).not.toHaveBeenCalled();
    commit(71);
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledWith(71, expect.arrayContaining([
      expect.objectContaining({ path: [1], state: "unknown", transportType: 99999 }),
    ])));
    h.socket.frame('{"t":2,"d":"{}"}');
    h.controller.abort("disabled");
    expect(await h.done).toBe("disabled");
    expect(h.decode).toHaveBeenCalledExactlyOnceWith(batch);
    expect(h.stop).toHaveBeenCalledOnce();
  });

  it("keeps committed raw pending after decode/receipt failure and proceeds", async () => {
    const h = harness({ settle: vi.fn().mockRejectedValue(new Error("db_down")) });
    h.socket.frame(known); h.socket.frame(unknown);
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledTimes(2));
    h.controller.abort(); await h.done;
  });

  it("stops on durable capture failure without decoding or silently continuing", async () => {
    const h = harness({ capture: vi.fn().mockRejectedValue(new Error("db_down")) });
    h.socket.frame(batch);
    expect(await h.done).toBe("capture_unavailable");
    h.socket.frame(known);
    expect(h.decode).not.toHaveBeenCalled();
    expect(h.stop).toHaveBeenCalledOnce();
  });

  it("bounds an in-flight capture plus queued frames and stops on overflow", async () => {
    const h = harness({ capture: vi.fn(() => new Promise<number>(() => {})) });
    for (let i = 0; i < 129; i++) h.socket.frame(known);
    expect(await h.done).toBe("overflow");
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.decode).not.toHaveBeenCalled();
  });

  it.each(["ownership_lost", "generation_changed", "disabled"])("closes immediately on %s", async (reason) => {
    const h = harness(); h.controller.abort(reason);
    expect(await h.done).toBe(reason); expect(h.stop).toHaveBeenCalledOnce();
    h.socket.frame(known); expect(h.capture).not.toHaveBeenCalled();
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
