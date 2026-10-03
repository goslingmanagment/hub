import { describe, expect, it } from "vitest";

import {
  evaluateFanslyStreamGate,
  fanslyNewStreamAllowed,
  GATED_FANSLY_STREAMS,
} from "../apps/runtime/src/services/sync/fansly-stream-gate.ts";

describe("the legacy new-stream allowlist", () => {
  it.each([undefined, "", "  ", " , ,"])("allows every page on an empty CSV %j", (csv) => {
    expect(fanslyNewStreamAllowed(csv, "lilly-1")).toBe(true);
  });

  it("matches labels exactly after trimming CSV whitespace", () => {
    expect(fanslyNewStreamAllowed("lilly-1", "lilly-1")).toBe(true);
    expect(fanslyNewStreamAllowed(" lilly-1 , ari-2", "ari-2")).toBe(true);
    expect(fanslyNewStreamAllowed("lilly-1,ari-2", "lora-3")).toBe(false);
    expect(fanslyNewStreamAllowed("lilly", "lilly-1")).toBe(false);
  });
});

// Expected wiring is explicit so a swapped flag cannot pass by deriving both
// the fixture and the assertion from the production table.
const cases = [
  ["fan_earnings", "fanslyFanEarningsSyncEnabled"],
  ["purchase_history", "fanslyPurchaseHistorySyncEnabled"],
] as const;

describe("the legacy money stream gates", () => {
  it("gates only the two money streams the legacy Fansly handlers still carry", () => {
    expect(GATED_FANSLY_STREAMS.map((gate) => gate.stream)).toEqual(cases.map(([stream]) => stream));
  });

  describe.each(cases)("%s", (stream, enabledField) => {
    it("reads its own flag and the shared new-stream allowlist", () => {
      expect(evaluateFanslyStreamGate({ [enabledField]: true }, stream, "lilly-1")).toEqual({ state: "ramped" });
      expect(evaluateFanslyStreamGate({ [enabledField]: true, fanslyNewStreamPageAllowlist: "lilly-1" }, stream, "lilly-1"))
        .toEqual({ state: "ramped" });
      expect(evaluateFanslyStreamGate({ [enabledField]: true, fanslyNewStreamPageAllowlist: "other-page" }, stream, "lilly-1"))
        .toEqual({ state: "not_allowlisted" });
      expect(evaluateFanslyStreamGate({ [enabledField]: false, fanslyNewStreamPageAllowlist: "lilly-1" }, stream, "lilly-1"))
        .toEqual({ state: "flag_off" });
    });

    it("does not borrow the other stream's flag", () => {
      const other = cases.find(([candidate]) => candidate !== stream)![1];
      expect(evaluateFanslyStreamGate({ [other]: true }, stream, "lilly-1")).toEqual({ state: "flag_off" });
    });
  });
});
