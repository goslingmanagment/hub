// WP-F3 — the catalog walk's pure rules (`sync/fansly/lib/catalog-rules.ts`),
// which the engine's catalog resource reads. No database.

import { describe, expect, it } from "vitest";

import { nextVaultCursor, vaultMediaRows } from "../apps/runtime/src/sync/fansly/lib/catalog-rules.ts";

describe("WP-F3 catalog lane helpers", () => {
  it("reads albumMedia rows and nothing from the raw media sidecar", () => {
    expect(vaultMediaRows({ albumMedia: [{ id: "a" }], media: [{ id: "b" }] }))
      .toEqual([{ id: "a" }]);
    expect(vaultMediaRows({ media: [{ id: "b" }] })).toEqual([]);
    expect(vaultMediaRows(null)).toEqual([]);
  });

  it("takes the next cursor from the LAST row's own id", () => {
    expect(nextVaultCursor([{ id: "1", mediaId: "x" }, { id: "2", mediaId: "y" }]))
      .toBe("2");
    // A page of rows with no usable id cannot advance the walk, and saying so
    // is better than pretending it did.
    expect(nextVaultCursor([{ mediaId: "x" }])).toBeNull();
    expect(nextVaultCursor([])).toBeNull();
  });
});
