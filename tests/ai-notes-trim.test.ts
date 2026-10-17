import { describe, expect, it } from "vitest";

import type { AiGatewayStreamFrame, AiGatewayUsage } from "@agency_hub_core/contracts";

import {
  NOTES_TRIM_SYSTEM_PROMPT,
  applyNotesTrim,
  buildNotesTrimPrompt,
  notesTrimPass,
  parseNotesTrimPieces,
  tidyTrimmedValue,
} from "../apps/runtime/src/modules/ai/index.ts";
import {
  COMPLETION_TRIM_KEEPALIVE_MS,
  sumAiGatewayUsage,
  trimCompletionStream,
  type AiGatewayCompletionTrim,
} from "../apps/runtime/src/services/ai-gateway.ts";

const FILL = [
  "Имя: =",
  "Работа: менеджер склада (10.2026), работа нравится, но давно думает о чём-то новом",
  "> «Im a warehouse manager»",
  "Хобби: зал и бургеры, вернулся после 3 лет перерыва; готовит мак-н-чиз из 5 сыров",
  "Фетиши: большая грудь; тиз и долгое воздержание",
  "График:",
  "+ Питомцы: большая собака Charlotte, любит обниматься, спит с ним",
].join("\n");

describe("notes trim: the answer", () => {
  it("reads `Label: piece` lines, keeps a piece's own leading space and skips NONE", () => {
    expect(parseNotesTrimPieces("NONE\n")).toEqual([]);
    expect(parseNotesTrimPieces("Работа: работа нравится, но \nХобби:  после 3 лет перерыва\nnoise\n: x\n")).toEqual([
      { label: "Работа", piece: "работа нравится, но" },
      { label: "Хобби", piece: " после 3 лет перерыва" },
    ]);
  });

  it("tidies what a cut leaves", () => {
    expect(tidyTrimmedValue("парикмахершу   , получил")).toBe("парикмахершу, получил");
    expect(tidyTrimmedValue("Charlotte ; 31 укус")).toBe("Charlotte; 31 укус");
    expect(tidyTrimmedValue("машин (  сейчас toyota)")).toBe("машин (сейчас toyota)");
    expect(tidyTrimmedValue("ушла от него   (не хотела детей)")).toBe("ушла от него (не хотела детей)");
    expect(tidyTrimmedValue("a, ; b")).toBe("a; b");
    expect(tidyTrimmedValue("x ()")).toBe("x");
    expect(tidyTrimmedValue("; a, ")).toBe("a");
  });
});

describe("notes trim: applying the pieces", () => {
  it("cuts only the fill's own values and reads well after a joining word", () => {
    const result = applyNotesTrim(FILL, [
      { label: "Работа", piece: "работа нравится, но " },
      { label: "Хобби", piece: ", вернулся после 3 лет перерыва" },
      { label: "Питомцы", piece: ", любит обниматься" },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.applied).toHaveLength(3);
    expect(result.text.split("\n")).toEqual([
      "Имя: =",
      "Работа: менеджер склада (10.2026), давно думает о чём-то новом",
      "> «Im a warehouse manager»",
      "Хобби: зал и бургеры; готовит мак-н-чиз из 5 сыров",
      "Фетиши: большая грудь; тиз и долгое воздержание",
      "График:",
      "+ Питомцы: большая собака Charlotte, спит с ним",
    ]);
  });

  it("never touches a = line, an empty one, a quote, an unknown label or an ambiguous piece", () => {
    const result = applyNotesTrim(FILL, [
      { label: "Имя", piece: "=" },
      { label: "График", piece: "x" },
      { label: "Возраст", piece: "30" },
      { label: "Работа", piece: "warehouse" },
      { label: "Фетиши", piece: "о" },
    ]);
    expect(result.text).toBe(FILL);
    expect(result.applied).toEqual([]);
    expect(result.rejected.map((piece) => piece.reason)).toEqual([
      "not_a_value",
      "not_a_value",
      "unknown_label",
      "not_found_once",
      "not_found_once",
    ]);
  });

  it("keeps a value the cuts would empty or halve", () => {
    const emptied = applyNotesTrim("Планы и даты: вечеринка 19.09.2026 (09.2026)", [
      { label: "Планы и даты", piece: "вечеринка 19.09.2026 (09.2026)" },
    ]);
    expect(emptied.text).toBe("Планы и даты: вечеринка 19.09.2026 (09.2026)");
    expect(emptied.rejected[0]?.reason).toBe("empties_value");

    const halved = applyNotesTrim("Хобби: зал; долгая история про то, как он начал ходить в зал", [
      { label: "Хобби", piece: "; долгая история про то, как он начал ходить в зал" },
    ]);
    expect(halved.applied).toEqual([]);
    expect(halved.rejected[0]?.reason).toBe("value_share");
  });

  it("applies nothing when the pass would cut too much of the whole note", () => {
    const note = ["А: один два три четыре пять шесть", "Б: семь восемь девять десять три пять"].join("\n");
    const result = applyNotesTrim(note, [
      { label: "А", piece: " пять шесть" },
      { label: "Б", piece: " десять три пять" },
    ]);
    expect(result.text).toBe(note);
    expect(result.applied).toEqual([]);
    expect(result.rejected.map((piece) => piece.reason)).toEqual(["total_share", "total_share"]);
  });
});

describe("notes trim: the prompt", () => {
  it("sends the recorded values escaped and the fill verbatim, never the chat", () => {
    const prompt = buildNotesTrimPrompt({
      noteFields: ["Имя", "Работа", "Другое"],
      noteValues: ["Chris", "", "a <b> & c"],
      completionText: `${FILL}\n`,
    });
    expect(prompt.systemBlocks).toEqual([{ text: NOTES_TRIM_SYSTEM_PROMPT, cache: "none" }]);
    const user = prompt.userBlocks[0]!.text;
    expect(user).toContain("<current_values>\nИмя: Chris\nРабота:\nДругое: a &lt;b&gt; &amp; c\n</current_values>");
    expect(user).toContain(`<filled_note>\n${FILL}\n</filled_note>`);
    expect(NOTES_TRIM_SYSTEM_PROMPT).not.toMatch(/fansly/i);
  });

  it("records the prompt version with what it applied", () => {
    const pass = notesTrimPass(["Работа"], ["warehouse manager"]);
    const { text, record } = pass.apply(FILL, "Работа: работа нравится, но \n");
    expect(text).toContain("Работа: менеджер склада (10.2026), давно думает о чём-то новом");
    expect(record).toEqual({
      version: 1,
      applied: [{ label: "Работа", piece: "работа нравится, но" }],
      rejected: [],
    });
  });
});

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
  options: { trim?: AiGatewayCompletionTrim; now?: () => number } = {},
) {
  const records: Record<string, unknown>[] = [];
  let calls = 0;
  const out: AiGatewayStreamFrame[] = [];
  for await (const frame of trimCompletionStream(framesOf(frames), {
    trim: options.trim ?? TRIM,
    signal: new AbortController().signal,
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

  it("records an answer with nothing to cut as unchanged", async () => {
    const { out, records } = await run(fillFrames(), () => framesOf(answerFrames("NONE")));
    expect(out[1]).toEqual({
      type: "content_delta",
      text: "Работа: менеджер склада (10.2026), работа нравится, но давно думает о чём-то новом",
    });
    expect(records[0]).toMatchObject({ outcome: "unchanged" });
    expect(records[0]).not.toHaveProperty("untrimmedCompletion");
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

  it("gives up on a pass slower than its timeout", async () => {
    const slow: AiGatewayCompletionTrim = { ...TRIM, timeoutMs: 20 };
    const { out, records } = await run(fillFrames(), (signal) => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<AiGatewayStreamFrame>>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      }),
    }), { trim: slow });
    expect(records[0]).toMatchObject({ outcome: "failed", errorCode: "trim_timeout" });
    expect(out.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("calls no pass for a cut-off, failed or empty fill and passes its frames on", async () => {
    const cutOff = await run(fillFrames("max_tokens"), () => framesOf(answerFrames("NONE")));
    expect(cutOff.calls).toBe(0);
    expect(cutOff.out.at(-1)).toEqual({ type: "done", stopReason: "max_tokens" });
    expect(cutOff.records).toEqual([]);

    const error: AiGatewayStreamFrame = { type: "error", code: "provider_stream_failed", message: "x", retryAfterMs: null };
    const failed = await run([fillFrames()[1]!, error], () => framesOf(answerFrames("NONE")));
    expect(failed.calls).toBe(0);
    expect(failed.out).toEqual([fillFrames()[1], error]);

    const empty = await run([
      { type: "content_delta", text: "  " },
      { type: "usage", usage: FILL_USAGE, providerResponseId: null, cacheHit: false },
      { type: "done", stopReason: "end_turn" },
    ], () => framesOf(answerFrames("NONE")));
    expect(empty.calls).toBe(0);
  });

  it("keeps a held stream alive with empty reasoning frames", async () => {
    let clock = 0;
    const now = () => {
      clock += COMPLETION_TRIM_KEEPALIVE_MS;
      return clock;
    };
    const { out } = await run(fillFrames(), () => framesOf(answerFrames("NONE")), { now });
    expect(out.filter((frame) => frame.type === "reasoning_delta" && frame.text === "").length).toBeGreaterThan(0);
    expect(out.filter((frame) => frame.type === "content_delta")).toHaveLength(1);
  });
});
