import { describe, expect, it } from "vitest";
import { parseProbeArgs } from "../scripts/fansly-ws/probe.ts";

describe("Fansly probe invocation", () => {
  it("accepts only one named page and a bounded duration", () => {
    expect(parseProbeArgs(["--page", "lilly-1", "--seconds", "120"]))
      .toEqual({ pageLabel: "lilly-1", durationMs: 120_000 });
  });

  it("accepts an optional private key path without changing the probe bounds", () => {
    expect(parseProbeArgs([
      "--page", "lilly-1", "--seconds", "120",
      "--correlation-key-file", "/run/fansly-w0-correlation.key",
    ])).toEqual({
      pageLabel: "lilly-1", durationMs: 120_000,
      correlationKeyFile: "/run/fansly-w0-correlation.key",
    });
  });

  it.each([
    [],
    ["--page", "all", "--seconds", "121"],
    ["--page", "lilly-1", "--seconds", "0"],
    ["--page", "lilly-1", "--seconds", "Infinity"],
    ["--page", "lilly-1,lora-1", "--seconds", "60"],
    ["--page", "lilly-1", "--seconds", "60", "--token", "SYNTHETIC_SECRET"],
    ["--page", "lilly-1", "--seconds", "60", "--correlation-key-file"],
    ["--page", "lilly-1", "--seconds", "60", "--correlation-key-file", ""],
    ["--page", "lilly-1", "--seconds", "60", "--correlation-key-file", "--token"],
    ["--page", "lilly-1", "--seconds", "60", "--correlation-key-file", "key\nvalue"],
    ["--page", "lilly-1", "--seconds", "121", "--correlation-key-file", "key"],
  ].map(args => ({ args })))("refuses unbounded or credential-bearing arguments %#", ({ args }) => {
    expect(() => parseProbeArgs(args)).toThrow(/^invalid_probe_/);
  });
});
