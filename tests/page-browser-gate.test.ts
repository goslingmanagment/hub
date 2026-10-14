import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiGate, bigDataRecords, controlRecordLimit, IN_FLIGHT_REFUSAL, MAX_BODY_BYTES, NO_RESPONSE_MS, operationOf, serverHelloIsTls13 } from "../apps/page-browser/src/egress/gate.ts";

// The send gate (Project Browser spec §9; stage 1, §3.1): a decision per TLS
// record Chrome writes into an API tunnel, within the window budget of the
// request the operator has just released. The numbers are the spec's: a
// control record is up to 39 bytes in TLS 1.3, 46 in TLS 1.2; a window
// carries the request's HEADERS and one DATA record of its body, a new
// connection adds its TLS 1.3 Finished and the HTTP/2 preface; a body over
// 16 375 bytes or of unknown length is never released.

const WARM = 1;
const OTHER = 2;
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

describe("the gate's numbers", () => {
  it("a control record is up to 39 bytes in TLS 1.3 and 46 in TLS 1.2 (unknown counts as 1.3)", () => {
    expect(controlRecordLimit(true)).toBe(39);
    expect(controlRecordLimit(false)).toBe(46);
    expect(controlRecordLimit(null)).toBe(39);
  });

  it("a body goes in DATA records of 16 375 bytes; a last one of 8 bytes or less fits a control record", () => {
    expect(MAX_BODY_BYTES).toBe(16_375);
    expect(bigDataRecords(0)).toBe(0);
    expect(bigDataRecords(8)).toBe(0);
    expect(bigDataRecords(9)).toBe(1);
    expect(bigDataRecords(16_375)).toBe(1);
    expect(bigDataRecords(16_375 + 8)).toBe(1);
    expect(bigDataRecords(16_375 + 9)).toBe(2);
  });
});

describe("with no window", () => {
  it("lets control records through and holds every bigger one", () => {
    expect(record(WARM, 39)).toBe("up");
    expect(record(WARM, 40)).toBe("hold");
    expect(record(WARM, 46, false)).toBe("up");
    expect(record(WARM, 47, false)).toBe("hold");
    expect(gate.admitsTunnel()).toBe(false);
  });
});

describe("a window", () => {
  it("is refused for a body it cannot count, and for a deadline gone", () => {
    expect(gate.open("w", now + 15_000, null)).toEqual({ ok: false, reason: "a body of unknown length" });
    expect(gate.open("w", now + 15_000, MAX_BODY_BYTES + 1).ok).toBe(false);
    expect(gate.open("w", now, 0)).toEqual({ ok: false, reason: "the admission's deadline has passed" });
    expect(gate.state.phase).toBe("closed");
    expect(gate.open("w", now + 15_000, MAX_BODY_BYTES)).toEqual({ ok: true });
  });

  it("on a warm connection carries one HEADERS record of a GET, then holds", () => {
    gate.open("w", now + 15_000, 0);
    expect(record(WARM, HEADERS)).toBe("up");
    gate.recordDone(WARM);
    expect(gate.state.phase).toBe("holding");
    // Chrome's repeat on the same connection (after REFUSED_STREAM).
    expect(record(WARM, HEADERS)).toBe("hold");
    // Control frames still go: PING, WINDOW_UPDATE, RST_STREAM.
    expect(record(WARM, 30)).toBe("up");
  });

  it("carries HEADERS and one DATA record of a body, not a third", () => {
    gate.open("w", now + 15_000, 300);
    expect(record(WARM, HEADERS)).toBe("up");
    gate.recordDone(WARM);
    expect(record(WARM, 340)).toBe("up");
    gate.recordDone(WARM);
    expect(gate.state.phase).toBe("holding");
    expect(record(WARM, 340)).toBe("hold");
  });

  it("belongs to the first tunnel its request goes up: another tunnel's big record is held", () => {
    gate.open("w", now + 15_000, 300);
    expect(record(WARM, HEADERS)).toBe("up");
    expect(record(OTHER, HEADERS)).toBe("hold");
    expect(record(OTHER, 20)).toBe("up");
  });

  it("admits one new tunnel, and budgets its TLS 1.3 Finished and HTTP/2 preface", () => {
    gate.open("w", now + 15_000, 0);
    expect(gate.admitsTunnel()).toBe(true);
    gate.noteTunnel(NEW);
    expect(gate.admitsTunnel()).toBe(false);
    // ClientHello, before the server's version is known: not application data.
    expect(record(NEW, 517, null, 22)).toBe("up");
    expect(record(NEW, 58)).toBe("up"); // Finished
    expect(record(NEW, 70)).toBe("up"); // preface + SETTINGS
    expect(record(NEW, HEADERS)).toBe("up");
    gate.recordDone(NEW);
    expect(gate.state.phase).toBe("holding");
    expect(record(NEW, HEADERS)).toBe("hold");
  });

  it("budgets only the preface on a new TLS 1.2 connection (its Finished is no application data)", () => {
    gate.open("w", now + 15_000, 0);
    gate.noteTunnel(NEW);
    expect(record(NEW, 6, false, 20)).toBe("up"); // ChangeCipherSpec
    expect(record(NEW, 45, false, 22)).toBe("up"); // Finished
    expect(record(NEW, 70, false)).toBe("up"); // preface
    expect(record(NEW, HEADERS, false)).toBe("up");
    gate.recordDone(NEW);
    expect(record(NEW, HEADERS, false)).toBe("hold");
  });

  it("holds once the server spoke after the request began, even within the budget", () => {
    gate.open("w", now + 15_000, 300);
    expect(record(WARM, HEADERS)).toBe("up");
    gate.recordDone(WARM);
    gate.noteServerBytes(WARM); // a refusal, say
    expect(record(WARM, 340)).toBe("hold");
  });

  it("does not count the server's handshake bytes on its own new connection", () => {
    gate.open("w", now + 15_000, 0);
    gate.noteTunnel(NEW);
    gate.noteServerBytes(NEW); // ServerHello and the rest
    expect(record(NEW, 58)).toBe("up");
    gate.noteServerBytes(NEW); // session tickets
    expect(record(NEW, 70)).toBe("up");
    expect(record(NEW, HEADERS)).toBe("up");
  });

  it("at its deadline with nothing sent, cuts every API tunnel: the request never leaves late", () => {
    const events: string[] = [];
    gate.onEvent = (event) => events.push(event.kind);
    gate.open("w", now + 15_000, 0);
    gate.noteTunnel(NEW);
    advance(15_000);
    expect(cuts).toEqual(["gate: the admission expired before the send"]);
    expect(events).toContain("expired");
    expect(gate.state.phase).toBe("closed");
    expect(record(NEW, HEADERS)).toBe("hold");
  });

  it("past its deadline, a record is decided as with no window", () => {
    gate.open("w", now + 1000, 0);
    now += 1000; // before the timer fires
    expect(record(WARM, HEADERS)).toBe("hold");
  });

  it("at its deadline after the send, only stops carrying anything new", () => {
    gate.open("w", now + 15_000, 300);
    expect(record(WARM, HEADERS)).toBe("up");
    advance(15_000);
    expect(cuts).toEqual([]);
    expect(gate.state.phase).toBe("holding");
    expect(record(WARM, 340)).toBe("hold");
  });

  it("without an answer 20 s after the send, cuts the API tunnels", () => {
    gate.open("w", now + 15_000, 0);
    expect(record(WARM, HEADERS)).toBe("up");
    gate.recordDone(WARM);
    advance(NO_RESPONSE_MS - 1);
    expect(cuts).toEqual([]);
    advance(1);
    expect(cuts).toEqual(["gate: no answer 20 s after the send"]);
  });

  it("counts the 20 s again from Chrome's announcement when it comes later", () => {
    gate.open("w", now + 15_000, 0);
    expect(record(WARM, HEADERS)).toBe("up");
    advance(5000);
    gate.announced("w");
    advance(NO_RESPONSE_MS - 1);
    expect(cuts).toEqual([]);
    advance(1);
    expect(cuts).toHaveLength(1);
  });

  it("an answer stops the 20 s; the request's end closes the window", () => {
    gate.open("w", now + 15_000, 0);
    expect(record(WARM, HEADERS)).toBe("up");
    gate.responding("w");
    advance(NO_RESPONSE_MS * 2);
    expect(cuts).toEqual([]);
    expect(gate.state.phase).toBe("responding");
    expect(record(WARM, HEADERS)).toBe("hold");
    gate.close("w");
    expect(gate.state).toEqual({ phase: "closed", window: null, deadline: null });
  });

  it("cuts what tunnels still hold from before whenever a window opens", () => {
    expect(heldCuts).toEqual([]);
    gate.open("w1", now + 15_000, 0);
    expect(heldCuts).toEqual(["gate: bytes held from before this window"]);
    gate.close("w1");
    gate.open("w2", now + 15_000, 0);
    expect(heldCuts).toHaveLength(2);
  });

  it("cuts, as it closes, a new connection its request never went up (stage 1, amendment 21) — never one that carried it", () => {
    const cutTunnels: number[] = [];
    gate.cutTunnel = (tunnel) => {
      cutTunnels.push(tunnel);
      return true;
    };
    const events: string[] = [];
    gate.onEvent = (event) => events.push(event.kind);
    gate.open("w1", now + 15_000, 0);
    gate.noteTunnel(NEW);
    expect(record(NEW, 517, null, 22)).toBe("up"); // its ClientHello: the request went nowhere yet
    gate.close("w1");
    expect(cutTunnels).toEqual([NEW]);
    expect(events).toContain("unused_cut");
    gate.open("w2", now + 15_000, 0);
    gate.noteTunnel(NEW + 1);
    record(NEW + 1, 517, null, 22);
    record(NEW + 1, 58);
    record(NEW + 1, 70);
    expect(record(NEW + 1, HEADERS)).toBe("up");
    gate.close("w2");
    // A warm connection's window opens none.
    gate.open("w3", now + 15_000, 0);
    gate.close("w3");
    expect(cutTunnels).toEqual([NEW]);
  });

  it("is gone with a reset (the exit closed, control lost)", () => {
    gate.open("w", now + 15_000, 0);
    gate.reset();
    expect(gate.admitsTunnel()).toBe(false);
    expect(record(WARM, HEADERS)).toBe("hold");
  });

  it("remembers the last send for the takeover pause", () => {
    expect(gate.lastSend).toBeNull();
    gate.open("w", now + 15_000, 0);
    record(WARM, HEADERS);
    expect(gate.lastSend?.mono).toBe(now);
  });
});

describe("one admitted request of the page at a time (the owner's rule: one managed request in flight per page)", () => {
  it("a preflight and its request are one operation; another operation's window is refused while one is unfinished — open, holding or answering", () => {
    expect(operationOf("hub:12:preflight")).toBe("hub:12");
    expect(operationOf("site:3f2e:main")).toBe("site:3f2e");
    const events: Array<{ kind: string; window: string | null; detail: Record<string, unknown> }> = [];
    gate.onEvent = (event) => events.push(event);
    expect(gate.open("hub:12:preflight", now + 15_000, 0)).toEqual({ ok: true });
    // Its own request, after the preflight: the same operation.
    expect(gate.open("hub:12:main", now + 15_000, 0)).toEqual({ ok: true });
    expect(record(WARM, HEADERS)).toBe("up");
    gate.recordDone(WARM);
    // Another operation, while that one is holding, then answering.
    for (const phase of ["holding", "responding"]) {
      if (phase === "responding") gate.responding("hub:12:main");
      expect(gate.state.phase).toBe(phase);
      expect(gate.open("site:9:preflight", now + 15_000, 0)).toEqual({ ok: false, reason: `${IN_FLIGHT_REFUSAL} (hub:12:main)`, inFlight: "hub:12:main" });
    }
    // Refused, nothing changed: still the first operation's window.
    expect(gate.state.window).toBe("hub:12:main");
    expect(events.filter((event) => event.kind === "in_flight_refused")).toEqual([
      { kind: "in_flight_refused", window: "site:9:preflight", detail: { unfinished: "hub:12:main", phase: "holding" } },
      { kind: "in_flight_refused", window: "site:9:preflight", detail: { unfinished: "hub:12:main", phase: "responding" } },
    ]);
    // Its end is known: the next operation's window opens.
    gate.close("hub:12:main");
    expect(gate.unfinished).toBeNull();
    expect(gate.open("site:9:preflight", now + 15_000, 0)).toEqual({ ok: true });
  });

  it("an admission that ran out unsent stays unfinished until its end is known: Chrome may still hold its request, and the next admission's new connection must not carry it late", () => {
    // Admitted for 6 s; its connection is held past the deadline (stand t9).
    gate.open("hub:12:preflight", now + 6000, 0);
    advance(6000);
    expect(cuts).toEqual(["gate: the admission expired before the send"]);
    expect(gate.state.phase).toBe("closed");
    expect(gate.unfinished).toBe("hub:12:preflight");
    // An engine that admits the next one meanwhile: refused — no window,
    // no new connection, and the expired request Chrome writes when its
    // connection comes is held.
    expect(gate.open("site:9:preflight", now + 6000, 0).ok).toBe(false);
    expect(gate.admitsTunnel()).toBe(false);
    expect(record(NEW, HEADERS)).toBe("hold");
    // Chrome reports its end (the cut failed it): the next one may go.
    gate.close("hub:12:preflight");
    expect(gate.open("site:9:preflight", now + 6000, 0)).toEqual({ ok: true });
    expect(gate.admitsTunnel()).toBe(true);
  });

  it("stays unfinished through a reset — the exit closed, control lost — until its path ends it", () => {
    gate.open("site:3:main", now + 15_000, 0);
    gate.reset();
    expect(gate.open("hub:4:main", now + 15_000, 0).ok).toBe(false);
    gate.close("site:3:main");
    expect(gate.open("hub:4:main", now + 15_000, 0)).toEqual({ ok: true });
  });
});

describe("the server's TLS version", () => {
  function serverHello(supportedVersion: number | null, sessionIdLength = 32): Buffer {
    const extensions = supportedVersion === null ? Buffer.alloc(0) : Buffer.from([0x00, 0x2b, 0x00, 0x02, supportedVersion >> 8, supportedVersion & 0xff]);
    const body = Buffer.concat([
      Buffer.from([0x03, 0x03]),
      Buffer.alloc(32, 7),
      Buffer.from([sessionIdLength]),
      Buffer.alloc(sessionIdLength, 1),
      Buffer.from([0x13, 0x01, 0x00]),
      ...(supportedVersion === null ? [] : [Buffer.from([extensions.length >> 8, extensions.length & 0xff]), extensions]),
    ]);
    const handshake = Buffer.concat([Buffer.from([0x02, 0, body.length >> 8, body.length & 0xff]), body]);
    return Buffer.concat([Buffer.from([0x16, 0x03, 0x03, handshake.length >> 8, handshake.length & 0xff]), handshake]);
  }

  it("reads 1.3, 1.2, a ServerHello split over records, and refuses garbage", () => {
    expect(serverHelloIsTls13(serverHello(0x0304))).toBe(true);
    expect(serverHelloIsTls13(serverHello(null))).toBe(false);
    const whole = serverHello(0x0304);
    expect(serverHelloIsTls13(whole.subarray(0, 20))).toBeUndefined();
    // The same handshake message in two records (RFC 8446 §5.1).
    const message = whole.subarray(5);
    const split = Buffer.concat([
      Buffer.from([0x16, 0x03, 0x03, 0, 10]),
      message.subarray(0, 10),
      Buffer.from([0x16, 0x03, 0x03, (message.length - 10) >> 8, (message.length - 10) & 0xff]),
      message.subarray(10),
    ]);
    expect(serverHelloIsTls13(split)).toBe(true);
    expect(serverHelloIsTls13(Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"))).toBeNull();
  });
});
