import { test } from "vitest";

import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";

// Scratch (bug hunt 2026-10-09, reviewer `design`): which canonicalizer
// families the minutely sweep probes, and how many kinds each lists.
test("canonicalizer families", () => {
  for (const f of CANONICALIZER_FAMILIES) {
    const kinds = (f as { kinds?: readonly string[] }).kinds ?? [];
    console.log(`FAMILY\t${f.source}\t${f.lane}\tkinds=${kinds.length}\tv${f.version}\t${kinds.join(",").slice(0, 200)}`);
  }
});
