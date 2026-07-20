import { describe, expect, it } from "vitest";
import { isOutputExhausted } from "@agency_hub_core/shared";

describe("isOutputExhausted", () => {
  it("flags provider exhaustion reasons", () => {
    expect(isOutputExhausted("max_tokens")).toBe(true);  // Anthropic
    expect(isOutputExhausted("length")).toBe(true);       // OpenRouter
  });
  it("passes normal terminals", () => {
    expect(isOutputExhausted("end_turn")).toBe(false);
    expect(isOutputExhausted("stop")).toBe(false);
    expect(isOutputExhausted(null)).toBe(false);
    expect(isOutputExhausted(undefined)).toBe(false);
  });
});
