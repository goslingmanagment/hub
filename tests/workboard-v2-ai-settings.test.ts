import { describe, expect, it } from "vitest";

import {
  estimateCostUsd,
  modelPricing,
  resolveClosingSettings,
} from "../apps/runtime/src/modules/workboard/index.ts";

const ENV = {
  anthropicApiKey: "sk-test",
  wbClosingLlmEnabled: true,
  wbClosingLlmModel: "claude-haiku-4-5",
  wbClosingLlmDailyCapMin: 50,
  wbClosingLlmDailyCapMax: 400,
};

describe("resolveClosingSettings", () => {
  it("inherits env when there is no override", () => {
    const s = resolveClosingSettings(ENV, null);
    expect(s.enabled).toBe(true);
    expect(s.capMax).toBe(400);
    expect(s.model).toBe("claude-haiku-4-5");
    expect(s.source).toEqual({ enabled: "env", dailyCapMax: "env", model: "env" });
  });

  it("a per-page override wins over env (cap + model + disable)", () => {
    const s = resolveClosingSettings(ENV, { enabled: false, dailyCapMax: 120, model: "claude-sonnet-4-5" });
    expect(s.enabled).toBe(false);
    expect(s.capMax).toBe(120);
    expect(s.model).toBe("claude-sonnet-4-5");
    expect(s.source).toEqual({ enabled: "override", dailyCapMax: "override", model: "override" });
  });

  it("can enable a page even when the env flag is off (as long as a key exists)", () => {
    const s = resolveClosingSettings({ ...ENV, wbClosingLlmEnabled: false }, { enabled: true, dailyCapMax: null, model: null });
    expect(s.enabled).toBe(true);
    expect(s.capMax).toBe(400); // cap still inherits env
    expect(s.source.dailyCapMax).toBe("env");
  });

  it("never enables without an API key, regardless of override", () => {
    const s = resolveClosingSettings({ ...ENV, anthropicApiKey: null }, { enabled: true, dailyCapMax: null, model: null });
    expect(s.hasApiKey).toBe(false);
    expect(s.enabled).toBe(false);
  });

  it("treats a null override field as inherit, not as a value", () => {
    const s = resolveClosingSettings(ENV, { enabled: null, dailyCapMax: null, model: null });
    expect(s.enabled).toBe(true); // falls back to env-enabled
    expect(s.source.enabled).toBe("env");
  });
});

describe("estimateCostUsd", () => {
  it("prices Haiku 4.5 at $1/M in + $5/M out", () => {
    expect(modelPricing("claude-haiku-4-5")).toEqual({ input: 1, output: 5 });
    // 1M input + 1M output = $1 + $5
    expect(estimateCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000)).toBeCloseTo(6, 6);
    expect(estimateCostUsd("claude-haiku-4-5", 650, 300)).toBeCloseTo(0.00065 + 0.0015, 8);
  });

  it("falls back to Haiku pricing for an unknown model", () => {
    expect(estimateCostUsd("mystery-model", 1_000_000, 0)).toBeCloseTo(1, 6);
  });
});
