// WP-F3 — the catalog walk's pure helpers. No database: the form, paging,
// coverage and physical-attempt invariants that need one stay in
// fansly-catalog-lane.integration.test.ts.

import { describe, expect, it } from "vitest";

import {
  nextVaultCursor,
  vaultMediaRows,
  walkContinuationAt,
} from "../apps/runtime/src/services/sync/fansly-catalog.ts";

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

  it("jitters the continuation so a deep walk cannot run contiguously", () => {
    const base = new Date("2026-08-22T09:00:00.000Z");
    // Burst SHAPE, not daily volume, is the real ban-risk surface.
    expect(walkContinuationAt(base, 20_000, () => 0).getTime() - base.getTime()).toBe(14_000);
    expect(walkContinuationAt(base, 20_000, () => 1).getTime() - base.getTime()).toBe(26_000);
    expect(walkContinuationAt(base, 20_000, () => 0.5).getTime() - base.getTime()).toBe(20_000);
  });
});
