import { describe, expect, it } from "vitest";

import type { State } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
import { browserBufferDrained } from "../apps/runtime/src/sync/fansly/browser-page.ts";

// When a page's browser buffer counts as drained (Project Browser PR 14,
// Astra round 2, P1): a positive fact — the operator says its buffer is open
// and keeps nothing, and the engine's intake committed that buffer's last
// event — never a count that happens to be zero. A buffer that cannot be
// opened counts 0 bytes; an operator from before `state.buffer.open` says
// nothing of it.

const BUFFER = "0b8d3f0e-6a1c-4c2e-9f3a-7d5e1b2c4a6f";
const OTHER = "1c9e4a1f-7b2d-4d3f-8a4b-8e6f2c3d5b70";

function state(buffer: State["buffer"]): State {
  return {
    type: "state",
    step: "exit_closed",
    stopReason: "owner_stop",
    retryAtWall: null,
    exitOpen: false,
    mode: "automation",
    sessionFingerprint: null,
    accountId: null,
    exitIp: null,
    chromeVersion: "155.0",
    operatorVersion: "1",
    buffer,
    selfTest: null,
  };
}

const empty = { id: BUFFER, lastSeq: 41, outcomes: 0, pending: 0 };
const at = (committedSeq: number, bufferId = BUFFER) => ({ bufferId, committedSeq });

describe("browserBufferDrained", () => {
  it("the operator says its open buffer keeps nothing, and the intake committed its last event: drained", () => {
    expect(browserBufferDrained(state({ bytes: 0, oldestAgeMs: 0, open: empty }), at(41))).toBe(true);
    // A buffer that never gave an event, a subscription from its start.
    expect(browserBufferDrained(state({ bytes: 0, oldestAgeMs: 0, open: { ...empty, lastSeq: 0 } }), at(0))).toBe(true);
    // The engine has more of the buffer than it gave (a file restored from
    // before): it keeps nothing the engine has not taken.
    expect(browserBufferDrained(state({ bytes: 0, oldestAgeMs: 0, open: empty }), at(50))).toBe(true);
  });

  it("a buffer that cannot be opened is never drained, whatever it counts (Astra: bytes 0, the stop reason replaced by a stopPage)", () => {
    expect(browserBufferDrained(state({ bytes: 0, oldestAgeMs: 0, open: null }), at(41))).toBe(false);
    expect(browserBufferDrained(state({ bytes: 0, oldestAgeMs: 0, open: null }), null)).toBe(false);
  });

  it("an operator that does not say what its buffer holds is unknown: never drained", () => {
    expect(browserBufferDrained(state({ bytes: 0, oldestAgeMs: 0 }), at(41))).toBe(false);
    expect(browserBufferDrained(null, at(41))).toBe(false);
  });

  it("anything kept is not drained: an outcome waiting for its resultAck, something written and not committed, a byte", () => {
    expect(browserBufferDrained(state({ bytes: 0, oldestAgeMs: 0, open: { ...empty, outcomes: 1 } }), at(41))).toBe(false);
    expect(browserBufferDrained(state({ bytes: 0, oldestAgeMs: 0, open: { ...empty, pending: 1 } }), at(41))).toBe(false);
    expect(browserBufferDrained(state({ bytes: 120, oldestAgeMs: 5, open: empty }), at(41))).toBe(false);
  });

  it("the intake must stand on that buffer, up to its last event: no subscription (a refused one), another buffer, or a position behind is not drained", () => {
    const said = state({ bytes: 0, oldestAgeMs: 0, open: empty });
    expect(browserBufferDrained(said, null)).toBe(false);
    expect(browserBufferDrained(said, at(41, OTHER))).toBe(false);
    expect(browserBufferDrained(said, at(40))).toBe(false);
  });
});
