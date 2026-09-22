import { describe, expect, it } from "vitest";

import type { AiGatewayStreamFrame, AiGatewayUsage } from "@agency_hub_core/contracts";

import { AiGatewayTerminalStreamConsumer, buildAiGatewayTerminalRecord } from "../apps/runtime/src/services/ai-gateway.ts";

// P1-5a: the shared terminal-stream consumer both the HTTP SSE pump and the CLI
// smoke path drive, so the two lanes cannot drift on the coach ceiling or on
// what counts as a committed, usable generation. These unit tests pin that seam
// directly (the integration tests exercise the HTTP wiring on top of it).

const usage: AiGatewayUsage = {
  inputTokens: 50,
  outputTokens: 5,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  costMicroUsd: 100,
  costApproximate: false,
};

const content = (text: string): AiGatewayStreamFrame => ({ type: "content_delta", text });
const usageFrame: AiGatewayStreamFrame = {
  type: "usage",
  usage,
  providerResponseId: "msg_1",
  cacheHit: false,
};
const done = (stopReason: string | null): AiGatewayStreamFrame => ({ type: "done", stopReason });

describe("shared terminal accounting", () => {
  const completedAt = new Date("2026-09-23T00:00:00Z");

  it("retains the ceiling failure and estimates missing usage", () => {
    const consumer = new AiGatewayTerminalStreamConsumer(4);
    consumer.note(content("hello"));
    const record = buildAiGatewayTerminalRecord(consumer, {
      outcome: consumer.outcome, failure: null, durationMs: 123, completedAt,
    });
    expect(record).toMatchObject({
      outcome: "failed", errorCode: "coach_output_too_long", failurePhase: "stream",
      usage: null, estimateCostOnMissingUsage: true, completionText: "hello", durationMs: 123, completedAt,
    });
  });

  it("prefers the transport failure while retaining observed usage", () => {
    const consumer = new AiGatewayTerminalStreamConsumer();
    consumer.note(content("partial"));
    consumer.note(usageFrame);
    consumer.finish();
    const record = buildAiGatewayTerminalRecord(consumer, {
      outcome: "failed", failure: { code: "provider_stream_failed", failurePhase: "provider_response", providerHttpStatus: 503 },
      durationMs: 123, completedAt,
    });
    expect(record).toMatchObject({
      outcome: "failed", errorCode: "provider_stream_failed", failurePhase: "provider_response", providerHttpStatus: 503,
      usage, providerResponseId: "msg_1", completionText: "partial", estimateCostOnMissingUsage: false,
    });
  });

  it.each(["completed", "cancelled"] as const)("clears failure fields for the explicit %s outcome", (outcome) => {
    const consumer = new AiGatewayTerminalStreamConsumer();
    consumer.finish();
    const record = buildAiGatewayTerminalRecord(consumer, {
      outcome, failure: { code: "provider_stream_failed", failurePhase: "stream", providerHttpStatus: 503 },
      durationMs: 123, completedAt,
    });
    expect(record).toMatchObject({ outcome, errorCode: null, failurePhase: null, providerHttpStatus: null });
    expect(consumer.outcome).toBe("failed");
  });
});

describe("AiGatewayTerminalStreamConsumer", () => {
  it("threads a clean completion's outcome, usage, and stopReason and holds the done frame", () => {
    const consumer = new AiGatewayTerminalStreamConsumer();
    expect(consumer.note(content("hello ")).emit).toEqual([content("hello ")]);
    expect(consumer.note(usageFrame).emit).toEqual([usageFrame]);
    // The done frame is held back — only finish() releases it.
    expect(consumer.note(done("end_turn")).emit).toEqual([]);

    const finished = consumer.finish();
    expect(finished.usageMissing).toBe(false);
    expect(finished.emit).toEqual([done("end_turn")]);
    expect(consumer.outcome).toBe("completed");
    expect(consumer.usage).toEqual(usage);
    expect(consumer.providerResponseId).toBe("msg_1");
    expect(consumer.completionText).toBe("hello ");
    expect(consumer.stopReason).toBe("end_turn");
    expect(consumer.ceilingExceeded).toBe(false);
  });

  it("threads a truncation stopReason so the recap selector can exclude it", () => {
    // A fan-summary that ended on max_tokens records stopReason='max_tokens' —
    // the selector's exhausted check then keeps it out of coach attach.
    const consumer = new AiGatewayTerminalStreamConsumer();
    consumer.note(content("partial recap"));
    consumer.note(usageFrame);
    consumer.note(done("max_tokens"));
    consumer.finish();
    expect(consumer.outcome).toBe("completed");
    expect(consumer.stopReason).toBe("max_tokens");
  });

  it("aborts on the coach ceiling: emits the crossing content plus the error, no done, failed", () => {
    const consumer = new AiGatewayTerminalStreamConsumer(10);
    expect(consumer.note(content("12345")).ceilingCrossed).toBe(false);
    const crossing = consumer.note(content("67890X")); // total 11 > 10
    expect(crossing.ceilingCrossed).toBe(true);
    expect(crossing.emit).toEqual([
      content("67890X"),
      { type: "error", code: "coach_output_too_long", message: expect.any(String), retryAfterMs: null },
    ]);
    expect(consumer.ceilingExceeded).toBe(true);
    expect(consumer.outcome).toBe("failed");
    // finish() is a no-op after a ceiling abort: no done frame, still failed.
    const finished = consumer.finish();
    expect(finished.emit).toEqual([]);
    expect(finished.usageMissing).toBe(false);
    expect(consumer.outcome).toBe("failed");
  });

  it("fails a stream that emitted content but no usage frame", () => {
    const consumer = new AiGatewayTerminalStreamConsumer();
    consumer.note(content("orphan content"));
    consumer.note(done("end_turn"));
    const finished = consumer.finish();
    expect(finished.usageMissing).toBe(true);
    expect(finished.emit).toEqual([
      { type: "error", code: "provider_usage_missing", message: expect.any(String), retryAfterMs: null },
    ]);
    expect(consumer.outcome).toBe("failed");
  });

  it("fails a content-bearing stream that reached EOF with a null-stopReason done (premature EOF)", () => {
    // P1-2: Anthropic on a clean iterator end that never saw a terminal
    // message_delta still yields the saved usage and a SYNTHETIC done with
    // stopReason=null. That is a truncated generation, not a completed one — it
    // must fail closed with an error frame and NO done, so no client can commit
    // an aborted coach answer or attach a truncated recap.
    const consumer = new AiGatewayTerminalStreamConsumer();
    consumer.note(content("partial answer"));
    consumer.note(usageFrame);
    consumer.note(done(null));
    const finished = consumer.finish();
    expect(finished.usageMissing).toBe(false);
    expect(finished.emit).toEqual([
      { type: "error", code: "provider_stream_incomplete", message: expect.any(String), retryAfterMs: null },
    ]);
    // No done frame is released.
    expect(finished.emit.some((frame) => frame.type === "done")).toBe(false);
    expect(consumer.outcome).toBe("failed");
  });

  it("fails a content-bearing stream that ended with NO done frame at all", () => {
    // A provider iterator that simply ends after content+usage (no done frame)
    // is the same premature-EOF class: no terminal stopReason ever arrived.
    const consumer = new AiGatewayTerminalStreamConsumer();
    consumer.note(content("partial answer"));
    consumer.note(usageFrame);
    const finished = consumer.finish();
    expect(finished.emit).toEqual([
      { type: "error", code: "provider_stream_incomplete", message: expect.any(String), retryAfterMs: null },
    ]);
    expect(finished.emit.some((frame) => frame.type === "done")).toBe(false);
    expect(consumer.outcome).toBe("failed");
  });

  it("fails a zero-content stream even when usage and a clean terminal are present", () => {
    const consumer = new AiGatewayTerminalStreamConsumer();
    consumer.note(usageFrame);
    consumer.note(done("end_turn"));
    const finished = consumer.finish();
    expect(finished.emit).toEqual([
      { type: "error", code: "provider_output_empty", message: expect.any(String), retryAfterMs: null },
    ]);
    expect(finished.emit.some((frame) => frame.type === "done")).toBe(false);
    expect(consumer.outcome).toBe("failed");
  });

  it("fails a whitespace-only stream before it can be persisted as completed", () => {
    const consumer = new AiGatewayTerminalStreamConsumer();
    consumer.note(content(" \t\n "));
    consumer.note(usageFrame);
    consumer.note(done("end_turn"));
    const finished = consumer.finish();
    expect(finished.emit).toEqual([
      { type: "error", code: "provider_output_empty", message: expect.any(String), retryAfterMs: null },
    ]);
    expect(finished.emit.some((frame) => frame.type === "done")).toBe(false);
    expect(consumer.outcome).toBe("failed");
  });

  it("an error frame pins the outcome to failed", () => {
    const consumer = new AiGatewayTerminalStreamConsumer();
    const errorFrame: AiGatewayStreamFrame = {
      type: "error",
      code: "provider_stream_failed",
      message: "boom",
      retryAfterMs: null,
    };
    expect(consumer.note(errorFrame).emit).toEqual([errorFrame]);
    expect(consumer.outcome).toBe("failed");
  });
});
