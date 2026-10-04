import { describe, expect, it } from "vitest";

import {
  classifyFanslyPurchaseHistoryCapture,
} from "../apps/runtime/src/sync/fansly/lib/purchase-history.ts";

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

  it("consumes a 422 as a target-local rejection and keeps every other 4xx a durable block", () => {
    const rejected = (statusCode: number) => classifyFanslyPurchaseHistoryCapture({
      id: 1,
      targetKey: "single:media-1",
      requestBefore: null,
      statusCode,
      responsePayload: { error: { status: statusCode, code: 99 } },
    });
    // Fansly's "I understood the request but cannot serve THIS media" —
    // production ari-1 2026-09-02: {"code":99,"details":"error getting account
    // media"} for a media the account no longer holds.
    expect(rejected(422)).toMatchObject({
      outcome: "terminal_rejected",
      terminal: true,
      blocked: false,
      validatedPage: true,
      orderRows: 0,
    });
    expect(rejected(404)).toMatchObject({ outcome: "terminal_missing", terminal: true });
    // The same code 99 under HTTP 400 is the parameter-drift shape: a fact
    // about the request contract, never about one target.
    expect(rejected(400)).toMatchObject({ outcome: "http_rejected", blocked: true });
    expect(rejected(409)).toMatchObject({ outcome: "http_rejected", blocked: true });
    expect(rejected(403)).toMatchObject({ outcome: "http_rejected", blocked: true });
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
});
