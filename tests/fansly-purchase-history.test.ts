import { describe, expect, it } from "vitest";

import { FanslyPurchaseHistoryContractError } from "../apps/runtime/src/services/sync/errors.ts";
import {
  assertFanslyPurchaseHistoryTargetKindsConsistent,
  extractFanslyPurchaseHistoryTargetsFromTransactions,
  parseFanslyPurchaseHistoryCursorState,
} from "../apps/runtime/src/services/sync/fansly-purchase-history.ts";

describe("Fansly purchase-history transaction discovery", () => {
  it("maps current and legacy media transaction types to the correct target kind", () => {
    expect(extractFanslyPurchaseHistoryTargetsFromTransactions([
      { rawType: 2010, correlationId: "legacy-media" },
      { rawType: "2110", correlationId: "media" },
      { rawType: 2016, correlationId: "legacy-bundle" },
      { rawType: "2116", correlationId: "bundle" },
      { rawType: 15001, correlationId: "subscription-history" },
      { rawType: 2110, correlationId: null },
      { rawType: 2110, correlationId: "  " },
    ])).toEqual([
      { kind: "single", contentId: "legacy-media" },
      { kind: "single", contentId: "media" },
      { kind: "bundle", contentId: "legacy-bundle" },
      { kind: "bundle", contentId: "bundle" },
    ]);
  });

  it("deduplicates repeat sales of the same content without changing first-seen order", () => {
    expect(extractFanslyPurchaseHistoryTargetsFromTransactions([
      { rawType: 2110, correlationId: "media-2" },
      { rawType: 2110, correlationId: "media-1" },
      { rawType: 2110, correlationId: "media-2" },
      { rawType: 2016, correlationId: "bundle-1" },
      { rawType: 2116, correlationId: "bundle-1" },
    ])).toEqual([
      { kind: "single", contentId: "media-2" },
      { kind: "single", contentId: "media-1" },
      { kind: "bundle", contentId: "bundle-1" },
    ]);
  });

  it("fails closed when one content id appears in both media namespaces", () => {
    expect(() => extractFanslyPurchaseHistoryTargetsFromTransactions([
      { rawType: 2110, correlationId: "ambiguous-content" },
      { rawType: 2116, correlationId: "ambiguous-content" },
    ])).toThrow(expect.objectContaining({
      name: "FanslyPurchaseHistoryContractError",
      code: "purchase_history_target_kind_conflict",
    }));

    try {
      extractFanslyPurchaseHistoryTargetsFromTransactions([
        { rawType: 2110, correlationId: "ambiguous-content" },
        { rawType: 2116, correlationId: "ambiguous-content" },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(FanslyPurchaseHistoryContractError);
    }
  });

  it("fails closed when conflicting kinds arrive across batches or sources", () => {
    expect(() => assertFanslyPurchaseHistoryTargetKindsConsistent(
      [{ kind: "bundle", contentId: "cross-batch-content" }],
      new Set(["single:cross-batch-content"]),
    )).toThrow(expect.objectContaining({
      name: "FanslyPurchaseHistoryContractError",
      code: "purchase_history_target_kind_conflict",
    }));

    expect(() => assertFanslyPurchaseHistoryTargetKindsConsistent(
      [{ kind: "bundle", contentId: "conflicting-captured-content" }],
      new Set([
        "single:conflicting-captured-content",
      ]),
    )).toThrow(expect.objectContaining({
      code: "purchase_history_target_kind_conflict",
    }));
  });
});

describe("Fansly purchase-history cursor v3", () => {
  it("migrates a valid v2 cursor without losing raw progress or pending targets", () => {
    expect(parseFanslyPurchaseHistoryCursorState({
      version: 2,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "bundle", contentId: "bundle-9" }],
    })).toEqual({
      version: 3,
      transactionCursorId: 0,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "bundle", contentId: "bundle-9" }],
    });
  });

  it("round-trips a valid v3 cursor", () => {
    expect(parseFanslyPurchaseHistoryCursorState({
      version: 3,
      transactionCursorId: 456,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "single", contentId: "media-9" }],
    })).toEqual({
      version: 3,
      transactionCursorId: 456,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "single", contentId: "media-9" }],
    });
  });

  it.each([
    { version: 3, transactionCursorId: -1, rawPayloadCursorId: 1, pendingTargets: [] },
    { version: 3, rawPayloadCursorId: 1, pendingTargets: [] },
    { version: 3, transactionCursorId: 1, rawPayloadCursorId: -1, pendingTargets: [] },
    { version: 4, transactionCursorId: 1, rawPayloadCursorId: 1, pendingTargets: [] },
  ])("rejects an invalid cursor %#", (state) => {
    expect(parseFanslyPurchaseHistoryCursorState(state)).toBeNull();
  });
});
