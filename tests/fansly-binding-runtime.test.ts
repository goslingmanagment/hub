import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindingGeneration, bindingReceipt } from "./helpers/fansly-binding-fixtures.ts";

const spies = vi.hoisted(() => ({
  snapshot: vi.fn(), generation: vi.fn(), destroy: vi.fn(), end: vi.fn(), socket: vi.fn(),
  inspect: vi.fn(), short: vi.fn(), long: vi.fn(), guard: vi.fn(), acquire: vi.fn(), complete: vi.fn(),
}));
// Plan §2.5: the W0 scripts send through the page's send guard on a writable
// connection of their own (scripts/fansly-ws/send-guard.ts, tested on a real
// database in tests/fansly-send-guard-b2.integration.test.ts).
vi.mock("../scripts/fansly-ws/send-guard.ts", () => ({
  PROBE_HANDSHAKE_WINDOW_MS: 20_000,
  withFanslyScriptSendGuard: spies.guard,
}));
vi.mock("pg", () => ({ Pool: class { on() {} end = spies.end; } }));
vi.mock("@agency_hub_core/db", () => ({ createDb: () => ({}) }));
vi.mock("@agency_hub_core/shared", () => ({ loadConfig: () => ({ databaseUrl: "unused" }) }));
vi.mock("../apps/runtime/src/services/egress/fansly-probe-context.ts", () => ({
  readProbeSnapshot: spies.snapshot, readProbeGeneration: spies.generation,
}));
vi.mock("../apps/runtime/src/services/egress/fansly-probe-socket.ts", () => ({ openFanslyProbeSocket: spies.socket }));
vi.mock("../apps/runtime/src/services/egress/fansly-binding-preflight.ts", () => ({
  inspectFanslyBinding: spies.inspect, isNativeAccountId: (value: unknown) => value === "123",
}));
vi.mock("../scripts/fansly-ws/probe-observer.ts", () => ({ observeFanslyProbe: spies.short, MAX_PROBE_DURATION_MS: 120_000 }));
vi.mock("../scripts/fansly-ws/continuity.ts", () => ({ observeFanslyContinuity: spies.long }));
import { runStoredFanslyProbe } from "../scripts/fansly-ws/probe.ts";
import { runStoredFanslyContinuity } from "../scripts/fansly-ws/continuity-runtime.ts";
import { runBindingPreflight } from "../scripts/fansly-ws/binding-preflight.ts";

let directory: string;
let receiptPath: string;
let keyPath: string;
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), "binding-runtime-"));
  receiptPath = join(directory, "receipt.json");
  keyPath = join(directory, "key");
  await writeFile(receiptPath, JSON.stringify(bindingReceipt), { mode: 0o600 });
  await writeFile(keyPath, Buffer.alloc(32, 1), { mode: 0o600 });
  spies.snapshot.mockResolvedValue({ pageId: 7, expectedAccountId: "123", generation: bindingGeneration,
    token: "SYNTHETIC_SECRET", session: { authorization: "SYNTHETIC_SECRET" }, egress: { dispatcher: { destroy: spies.destroy } } });
  spies.generation.mockResolvedValue(bindingGeneration);
  spies.short.mockImplementation(async (input) => {
    input.connect();
    return { stopReason: "deadline", sessionFrameSeen: true };
  });
  spies.long.mockImplementation(async (input) => { input.connect(); return true; });
  spies.inspect.mockResolvedValue({ identityMatched: true, observedAccountId: "123", restRequests: 1,
    httpStatus: 200, reason: "matched" });
  spies.complete.mockResolvedValue(undefined);
  spies.acquire.mockResolvedValue(lease);
  spies.guard.mockImplementation(async (_config: unknown, _input: unknown, work: (guard: unknown) => Promise<unknown>) =>
    work(sendGuard));
});
const lease = { token: "lease-1", pageId: 7, sent: true, sendRefused: false, bind: (dispatcher: unknown) => dispatcher,
  complete: (...args: unknown[]) => spies.complete(...args) };
const sendGuard = { acquire: (...args: unknown[]) => spies.acquire(...args) };
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function run(kind: "short" | "long") {
  const controller = new AbortController();
  return kind === "short" ? runStoredFanslyProbe({ pageLabel: "lilly-1", durationMs: 5_000,
    bindingReceiptFile: receiptPath, controller })
    : runStoredFanslyContinuity({ pageLabel: "lilly-1", phase: "continuous", correlationKeyFile: keyPath,
      bindingReceiptFile: receiptPath }, controller, () => {});
}

describe("W0 preflight and receiver boundary", () => {
  it.each(["short", "long"] as const)("%s refuses changed or unavailable generation without any socket", async (kind) => {
    for (const unavailable of [false, true]) {
      spies.generation.mockReset();
      if (unavailable) spies.generation.mockRejectedValue(new Error("SYNTHETIC_SECRET"));
      else spies.generation.mockResolvedValue("b".repeat(64));
      await expect(run(kind)).rejects.toThrow(unavailable ? /^binding_generation_unavailable$/ : /^binding_generation_changed$/);
    }
    expect(spies.socket).not.toHaveBeenCalled();
    expect(spies.short).not.toHaveBeenCalled();
    expect(spies.long).not.toHaveBeenCalled();
    // Refused before the page's guard was taken.
    expect(spies.acquire).not.toHaveBeenCalled();
    expect(spies.end).toHaveBeenCalledTimes(2);
  });

  it.each(["short", "long"] as const)("%s opens its one handshake on a capture of the page's guard", async (kind) => {
    await run(kind);
    expect(spies.guard).toHaveBeenCalledOnce();
    expect(spies.guard.mock.calls[0]![1]).toMatchObject({ pageId: 7, source: "ws_probe" });
    expect(spies.acquire).toHaveBeenCalledOnce();
    expect(spies.acquire.mock.calls[0]![0]).toMatchObject({ operation: "ws_probe", requestTimeoutMs: 20_000 });
    expect(spies.socket).toHaveBeenCalledOnce();
    expect(spies.socket.mock.calls[0]![1]).toBe(lease);
    // Completed once the observation is over (the handshake completes it
    // first in production; this is the idempotent backstop).
    expect(spies.complete).toHaveBeenCalledOnce();
    expect(spies.acquire.mock.invocationCallOrder[0]).toBeLessThan(spies.socket.mock.invocationCallOrder[0]!);
  });

  it.each(["short", "long"] as const)("%s sends nothing when the page's guard refuses", async (kind) => {
    spies.acquire.mockRejectedValue(new Error("Fansly page 7 is closed to new requests"));
    await expect(run(kind)).rejects.toThrow("closed to new requests");
    expect(spies.socket).not.toHaveBeenCalled();
    expect(spies.complete).not.toHaveBeenCalled();
    expect(spies.end).toHaveBeenCalledOnce();
    expect(spies.destroy).toHaveBeenCalledOnce();
  });

  it.each(["short", "long"] as const)("%s connects only after the current generation read succeeds", async (kind) => {
    await run(kind);
    expect(spies.socket).toHaveBeenCalledOnce();
    expect(spies.generation.mock.invocationCallOrder[0]).toBeLessThan(spies.socket.mock.invocationCallOrder[0]!);
    expect(spies.inspect).not.toHaveBeenCalled();
    expect(spies.end).toHaveBeenCalledOnce();
    expect(spies.snapshot).toHaveBeenCalledOnce();
    expect(spies.destroy).toHaveBeenCalledOnce();
  });

  it.each(["continuous", "after_short_gap", "after_long_gap"] as const)(
    "%s refuses a snapshot from another generation using the original binding receipt", async (phase) => {
      spies.snapshot.mockResolvedValue({ pageId: 7, expectedAccountId: "123", generation: "b".repeat(64),
        egress: { dispatcher: { destroy: spies.destroy } } });
      await expect(runStoredFanslyContinuity({ pageLabel: "lilly-1", phase,
        correlationKeyFile: keyPath, bindingReceiptFile: receiptPath }, new AbortController(), () => {}))
        .rejects.toThrow(/^binding_snapshot_mismatch$/);
      expect(spies.socket).not.toHaveBeenCalled();
      expect(spies.generation).not.toHaveBeenCalled();
      expect(spies.destroy).toHaveBeenCalledOnce();
      expect(spies.end).toHaveBeenCalledOnce();
    },
  );

  it.each(["changed", "unavailable"])("short post-read keeps %s generation evidence without another dispatcher", async (state) => {
    spies.generation.mockResolvedValueOnce(bindingGeneration);
    if (state === "changed") spies.generation.mockResolvedValueOnce("b".repeat(64));
    else spies.generation.mockRejectedValueOnce(new Error("SYNTHETIC_SECRET"));
    const result = await run("short");
    expect(result).toMatchObject({ generationUnchanged: state === "changed" ? false : null, restRequests: 0 });
    expect(spies.snapshot).toHaveBeenCalledOnce();
    expect(spies.generation).toHaveBeenCalledTimes(2);
    expect(spies.destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
  });

  it("the legacy short remains unverified with zero REST and no preflight read", async () => {
    const result = await runStoredFanslyProbe({ pageLabel: "lilly-1", durationMs: 5_000, controller: new AbortController() });
    expect(result).toMatchObject({ accountBinding: "unverified", restRequests: 0, connectionAttempts: 1 });
    expect(result).not.toHaveProperty("bindingPreflight");
    expect(spies.generation).toHaveBeenCalledOnce();
    expect(spies.socket.mock.invocationCallOrder[0]).toBeLessThan(spies.generation.mock.invocationCallOrder[0]!);
    expect(spies.inspect).not.toHaveBeenCalled();
  });

  it("preflight uses one snapshot and its session/dispatcher, never a socket or receiver", async () => {
    const result = await runBindingPreflight("lilly-1", new AbortController().signal);
    expect(spies.snapshot).toHaveBeenCalledOnce();
    expect(spies.inspect).toHaveBeenCalledWith(expect.objectContaining({
      expectedAccountId: "123", session: { authorization: "SYNTHETIC_SECRET" },
      egress: { dispatcher: { destroy: spies.destroy } },
      // Plan §2.5: under the page's send guard, on its own writable connection.
      sendGuard,
    }));
    expect(spies.guard).toHaveBeenCalledOnce();
    expect(spies.guard.mock.calls[0]![1]).toMatchObject({ pageId: 7, source: "binding_preflight" });
    expect(result).toMatchObject({ identityMatched: true, restRequests: 1, credentialRouteGeneration: bindingGeneration });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
    expect(spies.socket).not.toHaveBeenCalled();
    expect(spies.end).toHaveBeenCalledOnce();
  });

  it("preflight still closes the DB pool if owned dispatcher cleanup fails", async () => {
    spies.destroy.mockRejectedValue(new Error("fixture_cleanup_failure"));
    await expect(runBindingPreflight("lilly-1", new AbortController().signal)).rejects.toThrow("fixture_cleanup_failure");
    expect(spies.end).toHaveBeenCalledOnce();
  });
});
