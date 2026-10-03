import { describe, expect, it, vi } from "vitest";

import { materializeFanslyDmTipContextsBestEffort } from
  "../apps/runtime/src/services/sync/fansly-tip-contexts.ts";
import { parseFanslyDmTipSidecar } from
  "../apps/runtime/src/sync/fansly/lib/tip-contexts.ts";
import { runBackfillMaterializationSafely } from
  "../apps/runtime/src/services/transaction-tip-contexts-backfill.ts";

describe("Fansly DM tip sidecar parser", () => {
  it("keeps valid siblings and drops only malformed optional members", () => {
    const result = parseFanslyDmTipSidecar({
      requestParams: { groupId: "group-1", limit: 25 },
      responsePayload: {
        messages: [],
        tips: [
          {
            id: "tip-1",
            amount: 250_000,
            message: "  For your level up  ",
            senderId: "fan-1",
            receiverId: "creator-1",
            createdAt: 1_770_000_000,
            targets: [{ targetId: "untyped", targetType: 4_000 }],
          },
          {
            id: "tip-2",
            amount: "not-a-number",
            message: { drift: true },
            senderId: "fan-2",
            receiverId: 42,
            createdAt: 1_770_000_001,
          },
          {
            id: "tip-3",
            amount: "not-a-number",
            message: null,
            senderId: "fan-3",
            receiverId: 42,
            createdAt: 1_770_000_002,
          },
          null,
          { id: "" },
        ],
      },
    });

    expect(result).toMatchObject({
      envelopeStatus: "accepted",
      tipItemsSeen: 5,
      droppedOptionalMemberCount: 2,
      rejectedItems: [
        { index: 1, reason: "invalid_message" },
        { index: 3, reason: "not_object" },
        { index: 4, reason: "invalid_tip_id" },
      ],
    });
    expect(result.contexts).toEqual([
      {
        platformTipId: "tip-1",
        capturedConversationRef: "group-1",
        tipMessageText: "  For your level up  ",
        tipAmountMills: 250_000n,
        occurredAt: new Date("2026-02-02T02:40:00.000Z"),
        senderPlatformUserId: "fan-1",
        receiverPlatformUserId: "creator-1",
      },
      {
        platformTipId: "tip-3",
        capturedConversationRef: "group-1",
        tipMessageText: null,
        tipAmountMills: null,
        occurredAt: new Date("2026-02-02T02:40:02.000Z"),
        senderPlatformUserId: "fan-3",
        receiverPlatformUserId: null,
      },
    ]);
  });

  it("treats an absent sidecar as an honest empty capture", () => {
    expect(parseFanslyDmTipSidecar({
      requestParams: { groupId: "group-1" },
      responsePayload: { messages: [] },
    })).toEqual({
      envelopeStatus: "absent",
      tipItemsSeen: 0,
      contexts: [],
      rejectedItems: [],
      droppedOptionalMemberCount: 0,
    });
  });

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

  it("distinguishes absent/null/empty notes and rejects unsafe fence evidence", () => {
    const result = parseFanslyDmTipSidecar({
      requestParams: { groupId: "group-epistemic" },
      responsePayload: {
        tips: [
          { id: "absent", senderId: "fan-1", createdAt: 1_770_000_000 },
          { id: "null", message: null, senderId: "fan-1", createdAt: 1_770_000_001 },
          { id: "empty", message: "", senderId: "fan-1", createdAt: 1_770_000_002 },
          {
            id: "bad-message",
            message: { secret: "must not become null" },
            senderId: "fan-1",
            createdAt: 1_770_000_003,
          },
          { id: "bad-sender", message: "secret", senderId: null, createdAt: 1_770_000_004 },
          { id: "bad-time", message: "secret", senderId: "fan-1", createdAt: "drift" },
        ],
      },
    });
    expect(result.contexts.map((context) => [context.platformTipId, context.tipMessageText]))
      .toEqual([["absent", null], ["null", null], ["empty", ""]]);
    expect(result.rejectedItems).toEqual([
      { index: 3, reason: "invalid_message" },
      { index: 4, reason: "invalid_sender_id" },
      { index: 5, reason: "invalid_created_at" },
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

  it("fails open on projection writes and logs no verbatim note or payload", async () => {
    const warn = vi.fn();
    const result = await materializeFanslyDmTipContextsBestEffort({
      db: {
        transaction: vi.fn(async (run) => run({
          execute: vi.fn(async () => {
            throw new Error("db unavailable");
          }),
        })),
      },
      logger: { warn },
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
    });

    expect(result).toMatchObject({ failed: true, tipItemsSeen: 1, upserted: 0 });
    expect(warn).toHaveBeenCalledWith({
      accountId: 7,
      sourceRawPayloadId: 99,
      tipItemsSeen: 1,
      acceptedItemCount: 1,
      errorClass: "Error",
    }, "Fansly DM tip context materialization failed after durable raw capture");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("do not log this note");
    expect(logged).not.toContain("group-secret");
    expect(logged).not.toContain("tip-secret");
  });

  it("surfaces conversation identity conflicts with bounded diagnostics", async () => {
    const warn = vi.fn();
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ fenced: false }] })
      .mockResolvedValueOnce({
        rows: [{ id: "1", status: "conversation_conflict" }],
      });
    const result = await materializeFanslyDmTipContextsBestEffort({
      db: {
        transaction: vi.fn(async (run) => run({ execute })),
      },
      logger: { warn },
    } as never, {
      accountId: 8,
      requestParams: { groupId: "conflicting-secret-group" },
      responsePayload: {
        tips: [{
          id: "conflicting-secret-tip",
          message: "secret conflict note",
          senderId: "fan-secret",
          createdAt: 1_770_000_000,
        }],
      },
      sourceRawPayloadId: 100,
      capturedAt: new Date("2026-08-03T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      failed: false,
      upserted: 0,
      unchanged: 0,
      conversationConflicts: 1,
    });
    expect(warn).toHaveBeenCalledWith({
      accountId: 8,
      sourceRawPayloadId: 100,
      envelopeStatus: "accepted",
      tipItemsSeen: 1,
      rejectedItemCount: 0,
      droppedOptionalMemberCount: 0,
      conversationConflictCount: 1,
      deferredCount: 0,
      erasureFencedCount: 0,
    }, "Fansly DM tip sidecar materialized with bounded drift");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("conflicting-secret-group");
    expect(logged).not.toContain("conflicting-secret-tip");
    expect(logged).not.toContain("secret conflict note");
  });

  it("marks a shared-lock miss failed and deferred without leaking material", async () => {
    const warn = vi.fn();
    const result = await materializeFanslyDmTipContextsBestEffort({
      db: {
        transaction: vi.fn(async (run) => run({
          execute: vi.fn(async () => ({ rows: [{ locked: false }] })),
        })),
      },
      logger: { warn },
    } as never, {
      accountId: 9,
      requestParams: { groupId: "deferred-secret-group" },
      responsePayload: {
        tips: [{
          id: "deferred-secret-tip",
          message: "deferred secret note",
          senderId: "deferred-secret-fan",
          createdAt: 1_770_000_000,
        }],
      },
      sourceRawPayloadId: 101,
      capturedAt: new Date("2026-08-03T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      failed: true,
      deferred: true,
      deferredWrites: 1,
      upserted: 0,
      erasureFenced: 0,
    });
    expect(warn).toHaveBeenCalledWith({
      accountId: 9,
      sourceRawPayloadId: 101,
      envelopeStatus: "accepted",
      tipItemsSeen: 1,
      rejectedItemCount: 0,
      droppedOptionalMemberCount: 0,
      conversationConflictCount: 0,
      deferredCount: 1,
      erasureFencedCount: 0,
    }, "Fansly DM tip sidecar materialized with bounded drift");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("deferred-secret-group");
    expect(logged).not.toContain("deferred-secret-tip");
    expect(logged).not.toContain("deferred secret note");
    expect(logged).not.toContain("deferred-secret-fan");
  });

  it("sanitizes backfill DB errors without retaining note or provider refs", async () => {
    const unsafe = ["secret note", "secret-group", "secret-tip"].join("|");
    let thrown: unknown;
    try {
      await runBackfillMaterializationSafely({
        rawPayloadId: 77,
        batchIndex: 2,
        batchCount: 5,
        run: async () => {
          throw new Error(`Failed query params=[${unsafe}]`);
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "TransactionTipContextsBackfillError",
      reason: "database_write_failed",
      rawPayloadId: 77,
      batchIndex: 2,
      batchCount: 5,
    });
    expect(thrown).not.toHaveProperty("cause");
    expect(String(thrown)).toBe(
      "TransactionTipContextsBackfillError: Transaction tip context backfill failed",
    );
    expect(String(thrown)).not.toContain("77");
    expect(String(thrown)).not.toContain("batch");
    const rendered = `${String(thrown)} ${JSON.stringify(thrown)}`;
    expect(rendered).not.toContain("secret note");
    expect(rendered).not.toContain("secret-group");
    expect(rendered).not.toContain("secret-tip");
  });
});
