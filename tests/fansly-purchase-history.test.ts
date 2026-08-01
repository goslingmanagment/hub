import { describe, expect, it } from "vitest";

import { FanslyPurchaseHistoryContractError } from "../apps/runtime/src/services/sync/errors.ts";
import {
  assertFanslyPurchaseHistoryTargetKindsConsistent,
  classifyFanslyPurchaseHistoryCapture,
  classifyFanslyPurchaseHistoryCaptures,
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

describe("Fansly purchase-history cursor v4", () => {
  it("migrates a valid v2 cursor without losing raw progress or pending targets", () => {
    expect(parseFanslyPurchaseHistoryCursorState({
      version: 2,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "bundle", contentId: "bundle-9" }],
    })).toEqual({
      version: 4,
      transactionCursorId: 0,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "bundle", contentId: "bundle-9", before: null }],
    });
  });

  it("round-trips a valid v3 cursor", () => {
    expect(parseFanslyPurchaseHistoryCursorState({
      version: 3,
      transactionCursorId: 456,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "single", contentId: "media-9" }],
    })).toEqual({
      version: 4,
      transactionCursorId: 456,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "single", contentId: "media-9", before: null }],
    });
  });

  it("round-trips a valid v4 per-target cursor", () => {
    expect(parseFanslyPurchaseHistoryCursorState({
      version: 4,
      transactionCursorId: 456,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "single", contentId: "media-9", before: "order-100" }],
    })).toEqual({
      version: 4,
      transactionCursorId: 456,
      rawPayloadCursorId: 987,
      pendingTargets: [{ kind: "single", contentId: "media-9", before: "order-100" }],
    });
  });

  it.each([
    { version: 3, transactionCursorId: -1, rawPayloadCursorId: 1, pendingTargets: [] },
    { version: 3, rawPayloadCursorId: 1, pendingTargets: [] },
    { version: 3, transactionCursorId: 1, rawPayloadCursorId: -1, pendingTargets: [] },
    {
      version: 4,
      transactionCursorId: 1,
      rawPayloadCursorId: 1,
      pendingTargets: [{ kind: "single", contentId: "media", before: "" }],
    },
    {
      version: 4,
      transactionCursorId: 1,
      rawPayloadCursorId: 1,
      pendingTargets: [
        { kind: "single", contentId: "media", before: null },
        { kind: "single", contentId: "media", before: "order-1" },
      ],
    },
  ])("rejects an invalid cursor %#", (state) => {
    expect(parseFanslyPurchaseHistoryCursorState(state)).toBeNull();
  });
});

describe("Fansly purchase-history page classification", () => {
  const capture = (
    responsePayload: unknown,
    requestBefore: string | null = null,
  ) => classifyFanslyPurchaseHistoryCapture({
    id: 1,
    targetKey: "single:media-1",
    requestBefore,
    statusCode: null,
    responsePayload,
  });

  it("treats only an empty successful page as terminal", () => {
    expect(capture({ accountMediaOrderHistory: [] })).toMatchObject({
      outcome: "terminal_empty",
      terminal: true,
      blocked: false,
      orderRows: 0,
    });
    expect(capture({
      accountMediaOrderHistory: [{ orderId: "order-1" }],
    })).toMatchObject({
      outcome: "continuation",
      terminal: false,
      nextBefore: "order-1",
      orderRows: 1,
    });
  });

  it("continues a full page when its last row has an order cursor", () => {
    expect(capture({
      accountMediaOrderHistory: Array.from(
        { length: 100 },
        (_, index) => ({ orderId: `order-${index + 1}` }),
      ),
    })).toMatchObject({
      outcome: "continuation",
      nextBefore: "order-100",
      orderRows: 100,
      blocked: false,
    });
  });

  it("blocks non-empty pages with a missing or repeated cursor", () => {
    expect(capture({ accountMediaOrderHistory: [{ id: "order-1" }] })).toMatchObject({
      outcome: "cursor_missing",
      blocked: true,
    });
    expect(capture({
      accountMediaOrderHistory: [{ orderId: "order-1" }],
    }, "order-1")).toMatchObject({
      outcome: "cursor_repeated",
      blocked: true,
    });
  });

  it("reconstructs complete, resumable, and cyclic chains from raw pages", () => {
    const base = {
      targetKey: "single:media-1",
      statusCode: null,
    };
    const complete = classifyFanslyPurchaseHistoryCaptures([
      {
        ...base,
        id: 1,
        requestBefore: null,
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
      },
      {
        ...base,
        id: 2,
        requestBefore: "order-1",
        responsePayload: { accountMediaOrderHistory: [] },
      },
    ]);
    expect(complete.validatedCompleteTargetKeys).toEqual(["single:media-1"]);
    expect(complete.resumableTargets).toEqual([]);

    const resumable = classifyFanslyPurchaseHistoryCaptures([
      {
        ...base,
        id: 1,
        requestBefore: null,
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
      },
    ]);
    expect(resumable.resumableTargets).toEqual([{
      kind: "single",
      contentId: "media-1",
      before: "order-1",
    }]);

    const cyclic = classifyFanslyPurchaseHistoryCaptures([
      {
        ...base,
        id: 1,
        requestBefore: null,
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
      },
      {
        ...base,
        id: 2,
        requestBefore: "order-1",
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-2" }] },
      },
      {
        ...base,
        id: 3,
        requestBefore: "order-2",
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
      },
    ]);
    expect(cyclic.blocked[0]).toMatchObject({ outcome: "cursor_repeated" });
  });

  it("blocks forked capture history at the same request cursor", () => {
    const forked = classifyFanslyPurchaseHistoryCaptures([
      {
        id: 1,
        targetKey: "single:media-1",
        requestBefore: null,
        statusCode: null,
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
      },
      {
        id: 2,
        targetKey: "single:media-1",
        requestBefore: null,
        statusCode: null,
        responsePayload: { accountMediaOrderHistory: [{ orderId: "order-2" }] },
      },
    ]);

    expect(forked.validatedCompleteTargetKeys).toEqual([]);
    expect(forked.resumableTargets).toEqual([]);
    expect(forked.blocked).toHaveLength(1);
    expect(forked.blocked[0]).toMatchObject({
      requestBefore: null,
      outcome: "cursor_conflict",
      blocked: true,
    });
  });
});
