import { describe, expect, it } from "vitest";

import {
  FAN_PROFILE_LITE_LOOPS_MAX_CHARS,
  FAN_PROFILE_LITE_MAX_CHARS,
  compileDossierForPrompt,
} from "../apps/runtime/src/modules/ai/index.ts";

// The owner's live `aiLiteDossierMaxChars` (2026-10-29) shrinks the dossier
// Reply and Ping read. A small budget must keep the facts: the open loops are
// cut to half of it instead of the fixed 1,500 that would leave the facts no room.

function section(heading: string, linePrefix: string, chars: number): string {
  const lines = [heading];
  for (let index = 0; lines.join("\n").length < chars; index += 1) {
    lines.push(`- ${linePrefix} ${index}: ${"x".repeat(60)}`);
  }
  return lines.join("\n");
}

const RAW = [
  section("## 1. ДОСЬЕ", "fact", 3_000),
  section("## 4. ДИНАМИКА ОБЩЕНИЯ", "talk", 1_000),
  section("## 6. ОТКРЫТЫЕ ПЕТЛИ", "loop", 1_400),
].join("\n\n");

describe("lite dossier budget", () => {
  it("keeps the facts and the whole open loops at the default budget", () => {
    const compiled = compileDossierForPrompt(RAW, { lite: true });

    expect(compiled.body.length).toBeLessThanOrEqual(FAN_PROFILE_LITE_MAX_CHARS);
    expect(compiled.droppedSections).toEqual(["COMMUNICATION DYNAMICS"]);
    expect(compiled.body).toContain("fact 0:");
    expect(compiled.body).not.toContain("[section truncated]");
    expect(compiled.body.includes("loop 0:") && compiled.body.includes("ОТКРЫТЫЕ ПЕТЛИ")).toBe(true);
    expect(FAN_PROFILE_LITE_LOOPS_MAX_CHARS).toBe(1_500);
  });

  it("gives the open loops at most half of a small budget and keeps the facts", () => {
    const budget = 2_000;
    const compiled = compileDossierForPrompt(RAW, { lite: true, targetChars: budget, hardCapChars: budget });

    expect(compiled.body.length).toBeLessThanOrEqual(budget);
    expect(compiled.truncated).toBe(true);
    expect(compiled.droppedSections).toEqual(["COMMUNICATION DYNAMICS"]);
    const loopsAt = compiled.body.indexOf("ОТКРЫТЫЕ ПЕТЛИ");
    expect(loopsAt).toBeGreaterThan(0);
    expect(compiled.body.length - loopsAt).toBeLessThanOrEqual(budget / 2 + "#### 6. ".length);
    expect(compiled.body).toContain("loop 0:");
    expect(compiled.body.slice(0, loopsAt)).toContain("fact 0:");
    expect(compiled.body.slice(0, loopsAt).length).toBeGreaterThan(budget / 3);
  });
});
