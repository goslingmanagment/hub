import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiGate, controlRecordLimit, IN_FLIGHT_REFUSAL, operationOf, SLOT_LIMIT_MS } from "../apps/page-browser/src/egress/gate.ts";

// The send gate (Project Browser spec §9; stage 1, §3.1): a decision per TLS
// record Chrome writes into an API tunnel, within the window budget of the
// request the operator has just released. The numbers are the spec's: a
// control record is up to 39 bytes in TLS 1.3, 46 in TLS 1.2; a window
// carries the request's HEADERS and one DATA record of its body, a new
// connection adds its TLS 1.3 Finished and the HTTP/2 preface; a body over
// 16 375 bytes or of unknown length is never released.

const WARM = 1;
const NEW = 3;
const HEADERS = 90; // a request's HEADERS record (47 bytes and more)

let now = 1_000_000;
let gate: ApiGate;
let cuts: string[];
let heldCuts: string[];

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000_000;
  gate = new ApiGate({ now: () => now });
  cuts = [];
  heldCuts = [];
  gate.cut = (reason) => {
    cuts.push(reason);
    return 1;
  };
  gate.cutHeld = (reason) => {
    heldCuts.push(reason);
    return 0;
  };
});

afterEach(() => {
  vi.useRealTimers();
});

/** A record of `size` bytes on a tunnel with a known TLS version. */
function record(tunnel: number, size: number, tls13: boolean | null = true, type = 23) {
  return gate.record(tunnel, size > controlRecordLimit(tls13), type === 23, tls13);
}

function advance(ms: number) {
  now += ms;
  vi.advanceTimersByTime(ms);
}

describe("the page's slot: one admitted operation at a time, from its first release until every request it released has its end (the owner's rule: one managed request in flight per page)", () => {
  let unended: Array<{ operation: string; pending: string[] }>;
  beforeEach(() => {
    unended = [];
    gate.onUnended = (operation, pending) => unended.push({ operation, pending });
  });
  const refused = (id: string, owner: string) => expect(gate.open(id, now + 15_000, 0, "R-x")).toEqual({ ok: false, reason: `${IN_FLIGHT_REFUSAL} (${owner})`, inFlight: owner });

  it("media takes the same slot without an API window; only its operation and every physical end free it", () => {
    expect(gate.takeSlot("hub:media", now + 15_000, "P-media")).toEqual({ ok: true });
    expect(gate.state).toEqual({ phase: "closed", window: null, deadline: null });
    expect(heldCuts).toEqual([]);
    refused("hub:api:main", "hub:media");
    expect(gate.takeSlot("hub:other-media", now + 15_000, "R-other")).toEqual({ ok: false, reason: `${IN_FLIGHT_REFUSAL} (hub:media)`, inFlight: "hub:media" });
    expect(gate.takeSlot("hub:media", now + 15_000, "R-media")).toEqual({ ok: true });
    gate.operationEnded("hub:media");
    gate.requestEnded("R-unrelated");
    gate.requestEnded("P-media");
    expect(gate.slotOwner).toBe("hub:media");
    expect(gate.slotPending).toEqual(["R-media"]);
    gate.requestEnded("R-media");
    expect(gate.slotOwner).toBeNull();
    expect(gate.open("hub:api:main", now + 15_000, 0, "R-api")).toEqual({ ok: true });
    expect(gate.takeSlot("hub:media2", now + 15_000, "R-media2")).toMatchObject({ ok: false, inFlight: "hub:api" });
    expect(gate.state.window).toBe("hub:api:main");
  });

  it("a media admission past its deadline takes no slot", () => {
    expect(gate.takeSlot("hub:media", now, "R-media")).toEqual({ ok: false, reason: "the admission's deadline has passed" });
    expect(gate.slotOwner).toBeNull();
  });

  it("media has the same unended bound; a reset keeps its slot, Chrome gone frees it", () => {
    gate.takeSlot("hub:media", now + 6000, "R-media");
    gate.operationEnded("hub:media");
    gate.reset();
    advance(6000 + SLOT_LIMIT_MS - 1);
    expect(unended).toEqual([]);
    advance(1);
    expect(unended).toEqual([{ operation: "hub:media", pending: ["R-media"] }]);
    expect(gate.slotOwner).toBe("hub:media");
    gate.browserGone();
    expect(gate.slotOwner).toBeNull();
    expect(gate.takeSlot("hub:media2", now + 6000, "R-media2")).toEqual({ ok: true });
    gate.requestEnded("R-media2");
    gate.operationEnded("hub:media2");
    advance(6000 + SLOT_LIMIT_MS);
    expect(unended).toHaveLength(1);
  });

  it("a preflight and its request are one operation; another operation is refused while it owns the slot — open, holding, answering", () => {
    expect(operationOf("hub:12:preflight")).toBe("hub:12");
    expect(operationOf("site:3f2e:main")).toBe("site:3f2e");
    const events: Array<{ kind: string; window: string | null; detail: Record<string, unknown> }> = [];
    gate.onEvent = (event) => events.push(event);
    expect(gate.open("hub:12:preflight", now + 15_000, 0, "P-1")).toEqual({ ok: true });
    gate.requestEnded("P-1");
    gate.close("hub:12:preflight");
    expect(gate.open("hub:12:main", now + 15_000, 0, "R-1")).toEqual({ ok: true });
    expect(record(WARM, HEADERS)).toBe("up");
    gate.recordDone(WARM);
    for (const phase of ["holding", "responding"]) {
      if (phase === "responding") gate.responding("hub:12:main");
      expect(gate.state.phase).toBe(phase);
      refused("site:9:preflight", "hub:12");
    }
    expect(gate.state.window).toBe("hub:12:main");
    expect(events.filter((event) => event.kind === "in_flight_refused")).toEqual([
      { kind: "in_flight_refused", window: "site:9:preflight", detail: { owner: "hub:12", pending: 1, ended: false, phase: "holding" } },
      { kind: "in_flight_refused", window: "site:9:preflight", detail: { owner: "hub:12", pending: 1, ended: false, phase: "responding" } },
    ]);
    // Its request's end and its operation's end: free.
    gate.close("hub:12:main");
    gate.requestEnded("R-1");
    expect(gate.slotOwner).toBe("hub:12");
    gate.operationEnded("hub:12");
    expect(gate.slotOwner).toBeNull();
    expect(gate.open("site:9:preflight", now + 15_000, 0, "P-2")).toEqual({ ok: true });
  });

  it("a preflight's end does not free it while its operation still waits for its request (Astra's 3)", () => {
    gate.open("site:1:preflight", now + 15_000, 0, "P-1");
    // The preflight answered and handed on: its end, its window closed.
    gate.requestEnded("P-1");
    gate.close("site:1:preflight");
    expect(gate.slotPending).toEqual([]);
    refused("site:2:preflight", "site:1");
    // Its request comes and goes under the same admission.
    expect(gate.open("site:1:main", now + 15_000, 0, "R-1")).toEqual({ ok: true });
  });

  it("the operation's end does not free it while a request it released has no end: Chrome may still write it — into nobody's window (Astra's 1)", () => {
    // A preflight released, its connection held past the deadline; the
    // operation ends (its request cancelled before release), told not sent.
    gate.open("hub:12:preflight", now + 6000, 0, "P-1");
    advance(6000);
    expect(gate.state.phase).toBe("closed");
    gate.close("hub:12:preflight");
    gate.operationEnded("hub:12");
    expect(gate.slotOwner).toBe("hub:12");
    // The next admission is refused: no window, no new connection — what
    // Chrome writes of the old request when its connection comes is held.
    expect(gate.open("site:9:preflight", now + 6000, 0, "P-2").ok).toBe(false);
    expect(gate.admitsTunnel()).toBe(false);
    expect(record(NEW, HEADERS)).toBe("hold");
    // Chrome's end of that very request (another request's end is nothing).
    gate.requestEnded("R-unrelated");
    expect(gate.slotOwner).toBe("hub:12");
    gate.requestEnded("P-1");
    expect(gate.slotOwner).toBeNull();
    expect(gate.open("site:9:preflight", now + 6000, 0, "P-2")).toEqual({ ok: true });
  });

  it("nothing but the ends, or Chrome gone, frees it: not a window's close, a reset (the exit closed, control lost) — Chrome gone does (Astra's 2)", () => {
    gate.open("site:3:main", now + 15_000, 0, "R-3");
    gate.close("site:3:main");
    gate.reset();
    gate.operationEnded("site:3");
    expect(gate.slotOwner).toBe("site:3");
    expect(gate.open("hub:4:main", now + 15_000, 0, "R-4").ok).toBe(false);
    gate.browserGone();
    expect(gate.slotOwner).toBeNull();
    expect(gate.open("hub:4:main", now + 15_000, 0, "R-4")).toEqual({ ok: true });
  });

  it("past its bound — its admission's deadline and the operation's limit — with an end unknown: a fault, and the slot stays until Chrome is gone", () => {
    gate.open("hub:12:preflight", now + 6000, 0, "P-1");
    gate.operationEnded("hub:12");
    advance(6000 + SLOT_LIMIT_MS - 1);
    expect(unended).toEqual([]);
    advance(1);
    expect(unended).toEqual([{ operation: "hub:12", pending: ["P-1"] }]);
    expect(gate.slotOwner).toBe("hub:12");
    expect(gate.open("site:9:main", now + 15_000, 0, "R-9").ok).toBe(false);
    gate.browserGone();
    expect(gate.open("site:9:main", now + 15_000, 0, "R-9")).toEqual({ ok: true });
    // Freed in time: no fault.
    gate.requestEnded("R-9");
    gate.operationEnded("site:9");
    advance(15_000 + SLOT_LIMIT_MS);
    expect(unended).toHaveLength(1);
  });
});

