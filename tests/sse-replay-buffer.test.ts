import { describe, expect, it, vi } from "vitest";

import {
  createBoundedSseReplayBuffer,
  validateGaplessReplayBatch,
  validateV2DeliverableReplayBatch,
} from "../apps/runtime/src/services/sse-replay-buffer.ts";

describe("bounded SSE pre-replay buffer", () => {
  it("releases retained events and closes exactly once on overflow", () => {
    const onOverflow = vi.fn();
    const buffer = createBoundedSseReplayBuffer<string>({
      maxBytes: 5,
      sizeOf: (item) => item.length,
      onOverflow,
    });

    expect(buffer.push("aa")).toBe(true);
    expect(buffer.push("bbb")).toBe(true);
    expect(buffer.push("x")).toBe(false);
    expect(buffer.overflowed).toBe(true);
    expect(buffer.drain()).toEqual([]);
    expect(buffer.push("later")).toBe(false);
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it("drains a bounded replay backlog in arrival order", () => {
    const buffer = createBoundedSseReplayBuffer<number>({
      maxBytes: 3,
      sizeOf: () => 1,
      onOverflow: () => undefined,
    });
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(buffer.drain()).toEqual([1, 2, 3]);
    expect(buffer.drain()).toEqual([]);
  });

  it("rejects an internal or terminal ledger hole before a later cursor is emitted", () => {
    expect(validateGaplessReplayBatch({
      rows: [{ accountSeq: 12 }],
      afterSeq: 10,
      throughSeq: 12,
      limit: 500,
    })).toEqual({ ok: false });
    expect(validateGaplessReplayBatch({
      rows: [],
      afterSeq: 10,
      throughSeq: 11,
      limit: 500,
    })).toEqual({ ok: false });
  });

  it("accepts complete and full non-terminal gapless batches", () => {
    expect(validateGaplessReplayBatch({
      rows: [{ accountSeq: 11 }, { accountSeq: 12 }],
      afterSeq: 10,
      throughSeq: 12,
      limit: 500,
    })).toEqual({ ok: true, nextSeq: 12, done: true });
    expect(validateGaplessReplayBatch({
      rows: [{ accountSeq: 11 }, { accountSeq: 12 }],
      afterSeq: 10,
      throughSeq: 15,
      limit: 2,
    })).toEqual({ ok: true, nextSeq: 12, done: false });
  });

  it("accepts only checkpoint-proven projection gaps", () => {
    expect(validateV2DeliverableReplayBatch({
      rows: [{
        accountSeq: 13,
        type: "stream.projection_checkpoint",
        data: { hiddenCount: 2 },
      }],
      afterSeq: 10,
      throughSeq: 13,
      limit: 500,
    })).toEqual({ ok: true, nextSeq: 13, done: true });

    expect(validateV2DeliverableReplayBatch({
      rows: [{ accountSeq: 13, type: "message.received", data: {} }],
      afterSeq: 10,
      throughSeq: 13,
      limit: 500,
    })).toEqual({ ok: false });
    expect(validateV2DeliverableReplayBatch({
      rows: [{
        accountSeq: 13,
        type: "stream.projection_checkpoint",
        data: { hiddenCount: 1 },
      }],
      afterSeq: 10,
      throughSeq: 13,
      limit: 500,
    })).toEqual({ ok: false });
  });
});
