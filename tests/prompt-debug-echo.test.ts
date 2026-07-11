import { describe, expect, it } from "vitest";

import {
  hasDebugInputCapability,
  isPromptDebugEchoAllowed,
  validatePromptDebugEchoUntil,
  validatePromptDebugEchoUsers,
} from "../apps/runtime/src/modules/ai/index.ts";

describe("prompt debug echo gate", () => {
  it("matches only the exact comma-separated capability token", () => {
    expect(hasDebugInputCapability("debug-input-v1")).toBe(true);
    expect(hasDebugInputCapability("other, debug-input-v1 ,third")).toBe(true);
    expect(hasDebugInputCapability("debug-input-v10")).toBe(false);
    expect(hasDebugInputCapability("prefix-debug-input-v1")).toBe(false);
    expect(hasDebugInputCapability(["debug-input-v1"])).toBe(false);
    expect(hasDebugInputCapability("x".repeat(257))).toBe(false);
  });

  it("requires an exact normalized username and an unexpired timestamp", () => {
    const now = new Date("2026-07-11T18:00:00Z");
    expect(isPromptDebugEchoAllowed(
      "alice, DIMA ",
      "2026-07-11T20:00:00Z",
      "dima",
      now,
    )).toBe(true);
    expect(isPromptDebugEchoAllowed("none", "2026-07-11T20:00:00Z", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("all", "2026-07-11T20:00:00Z", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima2", "2026-07-11T20:00:00Z", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima", "invalid", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima", "2026-07-11", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima", "2026-07-11T18:00:00Z", "dima", now)).toBe(false);
    expect(isPromptDebugEchoAllowed("dima", "none", "dima", now)).toBe(false);
  });

  it("accepts none and caps one enable window at 24 hours", () => {
    const now = new Date("2026-07-11T18:00:00Z");
    expect(validatePromptDebugEchoUntil("none", now)).toBeNull();
    expect(validatePromptDebugEchoUntil("2026-07-12T18:00:00Z", now)).toBeNull();
    expect(validatePromptDebugEchoUntil("2026-07-12T18:00:00.001Z", now)).toMatch(/24 hours/);
    expect(validatePromptDebugEchoUntil("tomorrow", now)).toMatch(/ISO timestamp/);
    expect(validatePromptDebugEchoUntil("2026-07-11", now)).toMatch(/ISO timestamp/);
    expect(validatePromptDebugEchoUntil("2026-02-30T12:00:00Z", now)).toMatch(/ISO timestamp/);
  });

  it("accepts a username CSV or none and rejects wildcard/mixed sentinels", () => {
    expect(validatePromptDebugEchoUsers("none")).toBeNull();
    expect(validatePromptDebugEchoUsers("Dima, chatter-2")).toBeNull();
    expect(validatePromptDebugEchoUsers("all")).toContain("forbidden");
    expect(validatePromptDebugEchoUsers("dima,none")).toContain("forbidden");
    expect(validatePromptDebugEchoUsers("dima,")).toContain("forbidden");
  });
});
