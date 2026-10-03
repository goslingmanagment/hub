import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

/** The response classifiers of the Sync Engine's lib. */
function engineLibSource(file: string) {
  return readFileSync(
    join(ROOT, "apps/runtime/src/sync/fansly/lib", file),
    "utf8",
  );
}

describe("Fansly lane scaffold ratchet", () => {
  it("keeps every response family on the shared three-way classifier", () => {
    expect(engineLibSource("stats-rules.ts")).toContain("classifyFanslyResponse");
    expect(engineLibSource("media-stats-rules.ts")).toContain("classifyStatsWindow");
    for (const file of [
      "notifications-rules.ts",
      "catalog-rules.ts",
      "post-replies-rules.ts",
      "payouts-rules.ts",
      "purchase-history.ts",
    ]) {
      expect(engineLibSource(file), `${file} must use the shared response classifier`)
        .toContain("classifyFanslyResponse");
    }
  });
});
