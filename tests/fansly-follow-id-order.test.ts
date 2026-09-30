import { describe, expect, it } from "vitest";
import { compareFanslyFollowIds } from "@agency_hub_core/shared";

describe("compareFanslyFollowIds", () => {
  it.each([
    { a: "961330000000000000", b: "961321050841313280", expected: 1 },
    { a: "961291922045943816", b: "961321050841313280", expected: -1 },
    { a: "961321050841313280", b: "961321050841313280", expected: 0 },
    // Numeric, not lexicographic: a shorter id is the older one.
    { a: "999", b: "1000", expected: -1 },
    { a: "1000", b: "999", expected: 1 },
  ])("orders $a against $b as $expected", ({ a, b, expected }) => {
    expect(compareFanslyFollowIds(a, b)).toBe(expected);
  });

  it.each([
    { a: "known-follow", b: "1000" },
    { a: "1000", b: "known-follow" },
    { a: "", b: "1000" },
    { a: "-1", b: "1000" },
    { a: "1e3", b: "1000" },
    { a: " 1000", b: "1000" },
  ])("knows no order between $a and $b", ({ a, b }) => {
    expect(compareFanslyFollowIds(a, b)).toBeNull();
  });
});
