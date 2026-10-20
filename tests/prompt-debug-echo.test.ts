import { describe, expect, it } from "vitest";

import {
  hasDebugInputCapability,
  isPromptDebugEchoEnabled,
} from "../apps/runtime/src/modules/ai/index.ts";

describe("prompt debug echo gate", () => {
  it("matches only the exact comma-separated capability token", () => {
    expect(hasDebugInputCapability("debug-input-v1")).toBe(true);
    expect(hasDebugInputCapability("other, debug-input-v1 ,third")).toBe(true);
    expect(hasDebugInputCapability("debug-input-v10")).toBe(false);
    expect(hasDebugInputCapability("prefix-debug-input-v1")).toBe(false);
    expect(hasDebugInputCapability(["debug-input-v1"])).toBe(false);
    expect(hasDebugInputCapability("x".repeat(257))).toBe(false);
    expect(hasDebugInputCapability(undefined)).toBe(false);
  });

  // The kill-switch is a plain boolean (Decision #140 addendum). A missing or
  // non-true effective value fails closed.
  it("is enabled only when the effective flag is exactly true", () => {
    expect(isPromptDebugEchoEnabled(true)).toBe(true);
    expect(isPromptDebugEchoEnabled(false)).toBe(false);
    expect(isPromptDebugEchoEnabled(undefined)).toBe(false);
  });
});
