import { describe, expect, it } from "vitest";

import { routeSchemas } from "@agency_hub_core/contracts";

// Decision #142: the Fansly extension needs the complete current 694-row
// ranking, while the endpoint remains a deliberately bounded one-query read.
// Pin the tactical cap so a generated SDK/OpenAPI refresh cannot silently
// restore the old 500-row ceiling or turn the bound into an unbounded query.

const querySchema = routeSchemas.pageTopSpenders.querystring;

describe("pageTopSpenders query contract", () => {
  it("accepts the 1000-row tactical ceiling", () => {
    expect(querySchema.parse({ window: "lifetime", limit: 500 }).limit).toBe(500);
    expect(querySchema.parse({ window: "lifetime", limit: 1000 })).toEqual({
      window: "lifetime",
      limit: 1000,
    });
    expect(querySchema.parse({ window: "2026-07", limit: "1000" })).toEqual({
      window: "2026-07",
      limit: 1000,
    });
  });

  it("keeps the response bounded and the default unchanged", () => {
    expect(querySchema.safeParse({ window: "lifetime", limit: 1001 }).success).toBe(false);
    expect(querySchema.parse({ window: "lifetime" }).limit).toBe(150);
  });
});
