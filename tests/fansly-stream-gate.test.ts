// W8.1 (A12/A20, decision #133): ONE gate function feeds both the executor's
// skip ladder and the pageTopSpenders `source.streamState` reporter — this
// matrix is the shared semantic, incl. the empty-allowlist = all-pages rule.

import { describe, expect, it } from "vitest";

import {
  fanslyNewStreamAllowed,
  resolveFanslyNewStreamState,
} from "../apps/runtime/src/services/sync/fansly-stream-gate.ts";

describe("fanslyNewStreamAllowed (Stage 16 ramp allowlist)", () => {
  it("treats an empty/blank/undefined CSV as ALL pages allowed", () => {
    expect(fanslyNewStreamAllowed(undefined, "lilly-1")).toBe(true);
    expect(fanslyNewStreamAllowed("", "lilly-1")).toBe(true);
    expect(fanslyNewStreamAllowed("  ", "lilly-1")).toBe(true);
    expect(fanslyNewStreamAllowed(" , ,", "lilly-1")).toBe(true);
  });

  it("matches labels exactly, trimming CSV whitespace", () => {
    expect(fanslyNewStreamAllowed("lilly-1", "lilly-1")).toBe(true);
    expect(fanslyNewStreamAllowed(" lilly-1 , ari-2", "ari-2")).toBe(true);
    expect(fanslyNewStreamAllowed("lilly-1,ari-2", "lora-3")).toBe(false);
    expect(fanslyNewStreamAllowed("lilly", "lilly-1")).toBe(false);
  });
});

describe("resolveFanslyNewStreamState (W8.1 reporter)", () => {
  const base = {
    platform: "fansly",
    pageLabel: "lilly-1",
    streamEnabled: true,
    allowlistCsv: "",
  };

  it("reports ramped when the flag is on and the (empty) allowlist admits the page", () => {
    expect(resolveFanslyNewStreamState(base)).toBe("ramped");
    expect(resolveFanslyNewStreamState({ ...base, allowlistCsv: "lilly-1" })).toBe("ramped");
  });

  it("reports flag_off before allowlist state (executor ladder order)", () => {
    expect(resolveFanslyNewStreamState({ ...base, streamEnabled: false })).toBe("flag_off");
    expect(resolveFanslyNewStreamState({
      ...base,
      streamEnabled: false,
      allowlistCsv: "someone-else",
    })).toBe("flag_off");
  });

  it("reports not_allowlisted for a page outside a non-empty allowlist", () => {
    expect(resolveFanslyNewStreamState({ ...base, allowlistCsv: "someone-else" }))
      .toBe("not_allowlisted");
  });

  it("reports unsupported_platform for non-fansly pages regardless of flags", () => {
    expect(resolveFanslyNewStreamState({ ...base, platform: "onlyfans" }))
      .toBe("unsupported_platform");
    expect(resolveFanslyNewStreamState({
      ...base,
      platform: "onlyfans",
      streamEnabled: false,
    })).toBe("unsupported_platform");
  });
});
