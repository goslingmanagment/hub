import { describe, expect, it } from "vitest";
import { parseProbeArgs } from "../scripts/fansly-ws/probe.ts";

describe("Fansly probe invocation", () => {
  it("accepts only one named page and a bounded duration", () => {
    expect(parseProbeArgs(["--page", "lilly-1", "--seconds", "120"]))
      .toEqual({ pageLabel: "lilly-1", durationMs: 120_000 });
  });

  it.each([
    [],
    ["--page", "all", "--seconds", "121"],
    ["--page", "lilly-1", "--seconds", "0"],
    ["--page", "lilly-1", "--seconds", "Infinity"],
    ["--page", "lilly-1,lora-1", "--seconds", "60"],
    ["--page", "lilly-1", "--seconds", "60", "--token", "SYNTHETIC_SECRET"],
  ].map(args => ({ args })))("refuses unbounded or credential-bearing arguments %#", ({ args }) => {
    expect(() => parseProbeArgs(args)).toThrow(/^invalid_probe_/);
  });
});
