// Stage 26 — the raw-fetch ratchet: platform traffic goes through the egress
// resolver, and `scripts/check-raw-fetch.mjs` holds the count of direct
// `fetch(` sites to its budget. A source scan; no database.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("raw-fetch ratchet (Stage 26)", () => {
  it("holds its budget", () => {
    const output = execFileSync(
      "node",
      [join(__dirname, "..", "scripts", "check-raw-fetch.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toMatch(/raw fetch\( sites: \d+ \(budget \d+\)/);
  });
});
