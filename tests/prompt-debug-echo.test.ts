import { describe, expect, it } from "vitest";

import { AI_STREAM_CAPABILITIES } from "@agency_hub_core/contracts";

import {
  hasDebugInputCapability,
  isPromptDebugEchoEnabled,
  parseAiStreamCapabilities,
} from "../apps/runtime/src/modules/ai/index.ts";

describe("AI stream capability header parsing (H-4a)", () => {
  it("keeps only known tokens, trimmed and case-sensitive", () => {
    expect([...parseAiStreamCapabilities("debug-input-v1, context-v1, split-all-v1")])
      .toEqual(["debug-input-v1", "context-v1", "split-all-v1"]);
    expect([...parseAiStreamCapabilities(" split-all-v1 ,future-v9,, context-v1 ,split-all-v1")])
      .toEqual(["split-all-v1", "context-v1"]);
    expect(parseAiStreamCapabilities("Context-V1, CONTEXT-V1, context-v10, x-context-v1").size).toBe(0);
    expect(parseAiStreamCapabilities("context-v1 split-all-v1").size).toBe(0);
    expect(parseAiStreamCapabilities("").size).toBe(0);
  });

  it("reads the header the SDK writes back as the same set", () => {
    const header = AI_STREAM_CAPABILITIES.join(", ");
    expect([...parseAiStreamCapabilities(header)]).toEqual([...AI_STREAM_CAPABILITIES]);
  });

  it("ignores a header longer than 256 chars, a repeated header and no header", () => {
    const padded = `context-v1,${" ".repeat(256 - "context-v1,".length - "split-all-v1".length)}split-all-v1`;
    expect(padded).toHaveLength(256);
    expect([...parseAiStreamCapabilities(padded)]).toEqual(["context-v1", "split-all-v1"]);
    expect(parseAiStreamCapabilities(`${padded} `).size).toBe(0);
    expect(parseAiStreamCapabilities(["context-v1"]).size).toBe(0);
    expect(parseAiStreamCapabilities(["context-v1", "debug-input-v1"]).size).toBe(0);
    expect(parseAiStreamCapabilities(undefined).size).toBe(0);
  });
});

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
