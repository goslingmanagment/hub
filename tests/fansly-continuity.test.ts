import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { observeFanslyContinuity, parseContinuityArgs, type ContinuityPhase } from "../scripts/fansly-ws/continuity.ts";
import { privateMessageEvent, serviceFrame, syntheticMessage, syntheticSecret, wrapped } from "./helpers/fansly-ws-fixtures.ts";

const generation = "a".repeat(64);
class TestSocket extends EventTarget {
  readyState = 0;
  send = vi.fn((data: string) => {
    if (data === "p") this.receive(wrapped(2, {}));
  });
  close = vi.fn();
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
}

function start(phase: ContinuityPhase = "after_short_gap", expectedGeneration = generation) {
  const socket = new TestSocket();
  const connect = vi.fn(() => socket);
  const controller = new AbortController();
  const lines: string[] = [];
  const readGeneration = vi.fn(async () => generation);
  const result = observeFanslyContinuity({
    phase, generation, expectedGeneration, token: syntheticSecret, key: Buffer.alloc(32, 1),
    connect, controller, readGeneration, writeLine: (line) => lines.push(line),
  });
  return { socket, connect, controller, lines, readGeneration, result,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("W0 continuity collection", () => {
  it("retains one six-hour connection beyond 1,000 pongs, with bounded metadata and no acceptance claim", async () => {
    const run = start("continuous");
    run.socket.open();
    await vi.advanceTimersByTimeAsync(8_000);
    run.socket.receive(wrapped(1, {}));
    run.socket.receive(serviceFrame(privateMessageEvent()));
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000 - 1);
    expect(run.socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await run.result).toBe(true);
    expect(run.connect).toHaveBeenCalledOnce();
    expect(run.socket.close).toHaveBeenCalledOnce();
    const records = run.records();
    expect(records[0]).toMatchObject({
      pageLabel: "lilly-1", accountBinding: "unverified", presence: "unverified",
      fanOut: "unverified", restRequests: 0, recovery: "external_evidence_required",
    });
    expect(records.at(-1)).toMatchObject({ kind: "finished", collectionCompleted: true,
      observation: { sessionObservedMs: 21_600_000, stopReason: "deadline" } });
    expect(records.filter((record) => record.kind === "frame").length).toBeGreaterThan(1_000);
    expect(run.readGeneration.mock.calls.length).toBeGreaterThanOrEqual(720);
    expect(run.lines.join("")).not.toContain(syntheticSecret);
    expect(run.lines.join("")).not.toContain(syntheticMessage);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["changed", "unavailable", "timeout"] as const)("stops on %s generation evidence without reconnect", async (failure) => {
    const run = start();
    if (failure === "changed") run.readGeneration.mockResolvedValue("b".repeat(64));
    if (failure === "unavailable") run.readGeneration.mockRejectedValue(new Error(syntheticSecret));
    if (failure === "timeout") run.readGeneration.mockImplementation(() => new Promise(() => {}));
    run.socket.open();
    run.socket.receive(wrapped(1, {}));
    await vi.advanceTimersByTimeAsync(35_000);
    expect(await run.result).toBe(false);
    expect(run.connect).toHaveBeenCalledOnce();
    expect(run.records()).toContainEqual(expect.objectContaining({ kind: "generation_check",
      state: failure === "changed" ? "changed" : "unavailable" }));
    expect(run.lines.join("")).not.toContain(syntheticSecret);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a resumed phase from another generation before connecting", async () => {
    const run = start("after_long_gap", "b".repeat(64));
    expect(await run.result).toBe(false);
    expect(run.connect).not.toHaveBeenCalled();
    expect(run.records().at(-1)).toMatchObject({ reason: "generation_changed_before_connect" });
  });

  it("does not extend the connection for repeated t=1 frames or a wall-clock change", async () => {
    const run = start();
    run.socket.open();
    run.socket.receive(wrapped(1, {}));
    await vi.advanceTimersByTimeAsync(100_000);
    run.socket.receive(wrapped(1, {}));
    vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await run.result).toBe(true);
    expect(run.records().at(-1)).toMatchObject({ observation: { sessionObservedMs: 120_000 } });
  });

  it.each(["cancel", "close", "auth_error", "no_t1", "no_pong"] as const)("retains %s as incomplete", async (failure) => {
    const run = start();
    run.socket.open();
    if (failure !== "no_t1") run.socket.receive(wrapped(1, {}));
    if (failure === "cancel") run.controller.abort();
    if (failure === "close") run.socket.dispatchEvent(Object.assign(new Event("close"), { code: 4001 }));
    if (failure === "auth_error") run.socket.receive(wrapped(0, { code: 401 }));
    if (failure === "no_pong") run.socket.send.mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await run.result).toBe(false);
    expect(run.connect).toHaveBeenCalledOnce();
    expect(run.records().at(-1)).toMatchObject({ collectionCompleted: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reserves a terminal receipt when the stream reaches its output bound", async () => {
    const run = start();
    run.socket.open();
    run.socket.receive(wrapped(1, {}));
    for (let index = 0; index < 1_100; index++) run.socket.receive(wrapped(2, {}));
    expect(await run.result).toBe(false);
    const records = run.records();
    expect(records).toHaveLength(1_000);
    expect(records.at(-1)).toMatchObject({ kind: "finished", collectionCompleted: false,
      observation: { stopReason: "output_error", framesReceived: 999, framesRetained: 998 } });
  });

  it("the long CLI accepts only Lilly-1 and fixed named phases, requiring the previous generation after gaps", () => {
    const first = ["--page", "lilly-1", "--phase", "continuous", "--correlation-key-file", "key"];
    expect(parseContinuityArgs(first)).toMatchObject({ phase: "continuous", pageLabel: "lilly-1" });
    expect(() => parseContinuityArgs([...first, "--seconds", "21600"])).toThrow();
    expect(() => parseContinuityArgs(first.map((value) => value === "lilly-1" ? "ari-1" : value))).toThrow();
    const resumed = first.map((value) => value === "continuous" ? "after_short_gap" : value);
    expect(() => parseContinuityArgs(resumed)).toThrow();
    expect(parseContinuityArgs([...resumed, "--expected-generation", generation]))
      .toMatchObject({ expectedGeneration: generation });
  });
});
