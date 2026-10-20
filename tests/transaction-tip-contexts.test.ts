import { describe, expect, it, vi } from "vitest";

import { materializeFanslyDmTipContexts, parseFanslyDmTipSidecar } from
  "../apps/runtime/src/sync/fansly/lib/tip-contexts.ts";

describe("Fansly DM tip sidecar parser", () => {
  it("pins the observed string tip-id contract and refuses numeric coercion", () => {
    const result = parseFanslyDmTipSidecar({
      requestParams: { groupId: "group-1" },
      responsePayload: {
        tips: [
          {
            id: 123,
            message: "never coerce provider identity",
            senderId: "fan-1",
            createdAt: 1_770_000_000,
          },
          {
            id: "123",
            message: "observed string id",
            senderId: "fan-1",
            createdAt: 1_770_000_000,
          },
        ],
      },
    });
    expect(result.rejectedItems).toEqual([{ index: 0, reason: "invalid_tip_id" }]);
    expect(result.contexts).toEqual([
      expect.objectContaining({ platformTipId: "123", tipMessageText: "observed string id" }),
    ]);
  });

  it("isolates invalid envelopes, missing request scope, and duplicate ids", () => {
    expect(parseFanslyDmTipSidecar({
      requestParams: { groupId: "group-1" },
      responsePayload: { tips: { drift: true } },
    })).toMatchObject({ envelopeStatus: "invalid", contexts: [] });

    const result = parseFanslyDmTipSidecar({
      requestParams: {},
      responsePayload: {
        tips: [
          { id: "duplicate", message: "first" },
          { id: "duplicate", message: "second" },
          { id: "unique", message: "still scoped by no group" },
        ],
      },
    });
    expect(result.contexts).toEqual([]);
    expect(result.rejectedItems).toEqual([
      { index: 0, reason: "duplicate_tip_id" },
      { index: 1, reason: "duplicate_tip_id" },
      { index: 2, reason: "missing_conversation_ref" },
    ]);
  });

  it("throws on a failed projection write, so its caller's transaction decides", async () => {
    await expect(materializeFanslyDmTipContexts({
      transaction: vi.fn(async (run) => run({
        execute: vi.fn(async () => {
          throw new Error("db unavailable");
        }),
      })),
    } as never, {
      accountId: 7,
      requestParams: { groupId: "group-secret" },
      responsePayload: {
        tips: [{
          id: "tip-secret",
          message: "do not log this note",
          amount: 10_000,
          senderId: "fan-secret",
          createdAt: 1_770_000_000,
        }],
      },
      sourceRawPayloadId: 99,
      capturedAt: new Date("2026-08-03T00:00:00.000Z"),
    })).rejects.toThrow("db unavailable");
  });
});
