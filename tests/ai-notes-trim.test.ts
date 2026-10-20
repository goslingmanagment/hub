import { describe, expect, it, vi } from "vitest";

import type { AiGatewayStreamFrame, AiGatewayUsage } from "@agency_hub_core/contracts";

import {
  notesTrimPass,
} from "../apps/runtime/src/modules/ai/index.ts";
import {
  AiGatewayTerminalStreamConsumer,
  buildAiGatewayTerminalRecord,
  sumAiGatewayUsage,
  trimCompletionStream,
  type AiGatewayCompletionTrim,
} from "../apps/runtime/src/services/ai-gateway.ts";

const FILL_USAGE: AiGatewayUsage = {
  inputTokens: 28_000,
  outputTokens: 1_600,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  costMicroUsd: 100_000,
  costApproximate: false,
};
const PASS_USAGE: AiGatewayUsage = {
  inputTokens: 3_000,
  outputTokens: 400,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  costMicroUsd: 20_000,
  costApproximate: false,
};

async function* framesOf(frames: AiGatewayStreamFrame[]): AsyncIterable<AiGatewayStreamFrame> {
  for (const frame of frames) yield frame;
}

function fillFrames(stopReason: string | null = "end_turn"): AiGatewayStreamFrame[] {
  return [
    { type: "reasoning_delta", text: "thinking" },
    { type: "content_delta", text: "Работа: менеджер склада (10.2026), работа нравится, " },
    { type: "content_delta", text: "но давно думает о чём-то новом" },
    { type: "usage", usage: FILL_USAGE, providerResponseId: "msg_fill", cacheHit: false },
    { type: "done", stopReason },
  ];
}

function answerFrames(answer: string, stopReason: string | null = "end_turn"): AiGatewayStreamFrame[] {
  return [
    { type: "reasoning_delta", text: "pass thinking" },
    { type: "content_delta", text: answer },
    { type: "usage", usage: PASS_USAGE, providerResponseId: "msg_pass", cacheHit: false },
    { type: "done", stopReason },
  ];
}

const TRIM: AiGatewayCompletionTrim = notesTrimPass(["Работа"], ["warehouse manager"]);

async function run(
  frames: AiGatewayStreamFrame[],
  callModel: (signal: AbortSignal) => AsyncIterable<AiGatewayStreamFrame>,
  options: { trim?: AiGatewayCompletionTrim; now?: () => number; signal?: AbortSignal } = {},
) {
  const records: Record<string, unknown>[] = [];
  let calls = 0;
  const out: AiGatewayStreamFrame[] = [];
  for await (const frame of trimCompletionStream(framesOf(frames), {
    trim: options.trim ?? TRIM,
    signal: options.signal ?? new AbortController().signal,
    callModel: (_prompt, signal) => {
      calls += 1;
      return callModel(signal);
    },
    estimateCostMicroUsd: () => 90_000,
    onRecord: (record) => records.push(record),
    ...(options.now ? { now: options.now } : {}),
  })) {
    out.push(frame);
  }
  return { out, records, calls };
}

describe("trimCompletionStream", () => {
  it("sends the trimmed text once, one usage frame for both calls and the held done", async () => {
    const { out, records, calls } = await run(fillFrames(), () => framesOf(answerFrames("Работа: работа нравится, но \n")));
    expect(calls).toBe(1);
    expect(out).toEqual([
      { type: "reasoning_delta", text: "thinking" },
      { type: "content_delta", text: "Работа: менеджер склада (10.2026), давно думает о чём-то новом" },
      { type: "usage", usage: sumAiGatewayUsage(FILL_USAGE, PASS_USAGE), providerResponseId: "msg_fill", cacheHit: false },
      { type: "done", stopReason: "end_turn" },
    ]);
    expect(records).toEqual([expect.objectContaining({
      outcome: "trimmed",
      version: 1,
      untrimmedCompletion: "Работа: менеджер склада (10.2026), работа нравится, но давно думает о чём-то новом",
      usage: PASS_USAGE,
    })]);
  });

  it("leaves the fill as written when the pass fails, and charges its estimate when it reported no usage", async () => {
    const failed = await run(fillFrames(), () => framesOf([
      { type: "error", code: "provider_unavailable", message: "x", retryAfterMs: null },
    ]));
    expect(failed.out[1]).toMatchObject({ type: "content_delta", text: expect.stringContaining("работа нравится") });
    expect(failed.records[0]).toMatchObject({ outcome: "failed", errorCode: "provider_unavailable" });
    expect(failed.out[2]).toMatchObject({
      type: "usage",
      usage: { costMicroUsd: 190_000, costApproximate: true },
    });

    const thrown = await run(fillFrames(), () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("socket hang up")) }),
    }));
    expect(thrown.records[0]).toMatchObject({ outcome: "failed", errorCode: "trim_call_failed" });
    expect(thrown.out.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });

    const cutOff = await run(fillFrames(), () => framesOf(answerFrames("Работа: работа нравится, но ", "max_tokens")));
    expect(cutOff.records[0]).toMatchObject({ outcome: "failed", errorCode: "trim_stop_max_tokens" });
    expect(cutOff.out[1]).toMatchObject({ text: expect.stringContaining("работа нравится") });
  });

  it.each([false, true])("flushes held fill text and usage before rethrowing, without done (held done: %s)", async (heldDone) => {
    const error = new Error("fill socket failed");
    async function* failedFill() {
      yield* fillFrames().slice(0, heldDone ? undefined : -1);
      throw error;
    }
    const callModel = vi.fn(() => framesOf([]));
    const onRecord = vi.fn();
    const out: AiGatewayStreamFrame[] = [];
    const consumer = new AiGatewayTerminalStreamConsumer();
    const consume = async () => {
      for await (const frame of trimCompletionStream(failedFill(), {
        trim: TRIM,
        signal: new AbortController().signal,
        callModel,
        estimateCostMicroUsd: () => 90_000,
        onRecord,
      })) {
        out.push(frame);
        consumer.note(frame);
      }
    };

    await expect(consume()).rejects.toBe(error);
    expect(out).toEqual([
      fillFrames()[0],
      { type: "content_delta", text: "Работа: менеджер склада (10.2026), работа нравится, но давно думает о чём-то новом" },
      fillFrames()[3],
    ]);
    expect(callModel).not.toHaveBeenCalled();
    expect(onRecord).not.toHaveBeenCalled();
    // The SSE pump and CLI use this same consumer and failed-record builder.
    expect(buildAiGatewayTerminalRecord(consumer, {
      outcome: "failed", failure: null, durationMs: 0, completedAt: new Date(0),
    })).toMatchObject({
      outcome: "failed",
      completionText: "Работа: менеджер склада (10.2026), работа нравится, но давно думает о чём-то новом",
      usage: FILL_USAGE,
      providerResponseId: "msg_fill",
    });
  });
});
