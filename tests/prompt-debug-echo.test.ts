import { describe, expect, it } from "vitest";

import {
  hasDebugInputCapability,
  isPromptDebugEchoAllowed,
  validatePromptDebugEcho,
} from "../apps/runtime/src/modules/ai/index.ts";

describe("prompt debug echo gate", () => {
  const now = new Date("2026-07-11T18:00:00Z");

  it("matches only the exact comma-separated capability token", () => {
    expect(hasDebugInputCapability("debug-input-v1")).toBe(true);
    expect(hasDebugInputCapability("other, debug-input-v1 ,third")).toBe(true);
    expect(hasDebugInputCapability("debug-input-v10")).toBe(false);
    expect(hasDebugInputCapability("prefix-debug-input-v1")).toBe(false);
    expect(hasDebugInputCapability(["debug-input-v1"])).toBe(false);
    expect(hasDebugInputCapability("x".repeat(257))).toBe(false);
    expect(hasDebugInputCapability(undefined)).toBe(false);
  });

  it("requires an exact normalized username inside a live window", () => {
    expect(isPromptDebugEchoAllowed("alice, DIMA @2026-07-11T20:00:00Z", "dima", now)).toBe(true);
    expect(isPromptDebugEchoAllowed("dima@2026-07-11T20:00:00Z", " Dima ", now)).toBe(true);
    expect(isPromptDebugEchoAllowed("dima2@2026-07-11T20:00:00Z", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("none", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("all@2026-07-11T20:00:00Z", "all", now)).toBe(false);
  });

  // Every malformed shape fails closed — a broken value must never widen access.
  it("fails closed on a missing, malformed or elapsed deadline", () => {
    expect(isPromptDebugEchoAllowed("dima", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima@", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("@2026-07-11T20:00:00Z", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima@tomorrow", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima@2026-07-11", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima@2026-02-30T12:00:00Z", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima@2026-07-11T18:00:00Z", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima@2026-07-11T17:59:59Z", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed(undefined, "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima@2026-07-11T20:00:00Z", "", now)).toBe(false);
  });

  // The owner PATCH cannot write these, but a restored dump, a hand-run UPDATE
  // or an older kernel's rules can. A declassification gate rejects the whole
  // value rather than salvaging the parts of it that happen to parse.
  it("rejects the WHOLE value when any part of it is bad", () => {
    // An empty token in the list — the value is corrupt, not "mostly fine".
    expect(isPromptDebugEchoAllowed("dima,,@2026-07-11T20:00:00Z", "dima", now)).toBe(false);
    // A wildcard smuggled into the list must not be silently dropped, leaving
    // the rest of the list live.
    expect(isPromptDebugEchoAllowed("dima,all@2026-07-11T20:00:00Z", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima,none@2026-07-11T20:00:00Z", "dima", now)).toBe(false);
    // The 24h cap is a RUNTIME rule, not just a write-time one.
    expect(isPromptDebugEchoAllowed("dima@2026-07-12T18:00:00Z", "dima", now)).toBe(true);
    expect(isPromptDebugEchoAllowed("dima@2026-07-12T18:00:00.001Z", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima@2026-07-13T20:00:00Z", "dima", now)).toBe(false);
  });

  // The deadline is split on the LAST "@" so an e-mail-shaped username cannot
  // move the boundary and smuggle in a bogus deadline.
  it("splits the deadline off the last @", () => {
    expect(isPromptDebugEchoAllowed(
      "dima@mail.com@2026-07-11T20:00:00Z",
      "dima@mail.com",
      now,
    )).toBe(true);
    expect(isPromptDebugEchoAllowed("dima@2026-07-11T20:00:00Z", "dima@2026-07-11", now)).toBe(false);
  });

  it("accepts none, caps one window at 24 hours, and rejects wildcards", () => {
    expect(validatePromptDebugEcho("none", now)).toBeNull();
    expect(validatePromptDebugEcho("NONE", now)).toBeNull();
    expect(validatePromptDebugEcho("Dima, chatter-2@2026-07-12T18:00:00Z", now)).toBeNull();
    expect(validatePromptDebugEcho("dima@2026-07-12T18:00:00.001Z", now)).toMatch(/24 hours/);
    expect(validatePromptDebugEcho("dima@2026-07-11T17:00:00Z", now)).toMatch(/past/);
    expect(validatePromptDebugEcho("dima@tomorrow", now)).toMatch(/ISO timestamp/);
    expect(validatePromptDebugEcho("dima@2026-07-11", now)).toMatch(/ISO timestamp/);
    expect(validatePromptDebugEcho("dima", now)).toMatch(/ISO deadline/);
    expect(validatePromptDebugEcho("all@2026-07-11T20:00:00Z", now)).toMatch(/forbidden/);
    expect(validatePromptDebugEcho("dima,none@2026-07-11T20:00:00Z", now)).toMatch(/forbidden/);
    expect(validatePromptDebugEcho("dima,@2026-07-11T20:00:00Z", now)).toMatch(/forbidden/);
  });
});
