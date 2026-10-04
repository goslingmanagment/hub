import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { AiGatewayStreamBody, AiStreamCapability } from "@agency_hub_core/contracts";
import {
  AGENT_TRANSCRIPT_UNION_MAX_ROWS,
  AI_TRANSCRIPT_DEEP_MAX_ROWS,
  AI_TRANSCRIPT_UNION_MAX_LIMIT,
  ARCHIVE_AI_TRANSCRIPT_MAX_ROWS,
  aiTranscriptRowCap,
} from "@agency_hub_core/db";
import { getDescriptor, loadConfig, validateConfigOverride } from "@agency_hub_core/shared";

import {
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_REASONING,
  DEFAULT_MESSAGE_COUNT_BY_BUCKET,
  FEATURE_POLICIES,
  OPERATION_FEATURES,
  buildPrompt,
  createBundledPersonalities,
  formatTranscript,
  type TranscriptMessage,
} from "../apps/runtime/src/modules/ai/index.ts";
import { DEFAULT_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT } from "../apps/runtime/src/services/ai-gateway.ts";
import { estimateAnthropicGatewayRequestCost } from "../apps/runtime/src/services/ai-gateway-anthropic.ts";
import {
  aiTranscriptDeepMaxRowsOf,
  loadAiTranscriptDeepMaxRows,
  mayReadDeepTranscript,
  resolveAiTranscriptMaxRows,
} from "../apps/runtime/src/services/ai-transcript-depth.ts";

// chat-extension H-6: only the full Recap reads past the AI transcript readers'
// 1500-row cap, up to 3000, behind the owner's `aiTranscriptDeepMaxRows`.

const CONTEXT_V1: ReadonlySet<AiStreamCapability> = new Set<AiStreamCapability>(["context-v1"]);

function baseConfig(env: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: "postgres://localhost/test",
    APP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    ...env,
  } as unknown as NodeJS.ProcessEnv, { loadDotEnv: false });
}

/** An app whose one database read returns the given stored overrides. */
function appWith(overrides: Array<{ key: string; value: unknown }>, env: Record<string, string> = {}) {
  const findMany = vi.fn(async () => overrides.map((row) => ({ ...row, version: 1 })));
  const warn = vi.fn();
  return {
    app: { db: { query: { configSettings: { findMany } } }, config: baseConfig(env), logger: { warn } } as never,
    findMany,
    warn,
  };
}

describe("AI transcript readers' row cap", () => {
  it("is 1500 for both readers, and 3000 at the deepest", () => {
    expect(ARCHIVE_AI_TRANSCRIPT_MAX_ROWS).toBe(1500);
    expect(AI_TRANSCRIPT_UNION_MAX_LIMIT).toBe(1500);
    expect(AI_TRANSCRIPT_DEEP_MAX_ROWS).toBe(3000);
    // The agent read plane's transcript reader is another reader and stays where it was.
    expect(AGENT_TRANSCRIPT_UNION_MAX_ROWS).toBe(1500);
  });

  it("keeps the reader's cap unless a caller raises it, and never passes 3000", () => {
    expect(aiTranscriptRowCap(undefined, 1500)).toBe(1500);
    expect(aiTranscriptRowCap(3000, 1500)).toBe(3000);
    expect(aiTranscriptRowCap(2000, 1500)).toBe(2000);
    expect(aiTranscriptRowCap(3001, 1500)).toBe(3000);
    expect(aiTranscriptRowCap(1_000_000, 1500)).toBe(3000);
  });

  it("is never lowered or broken by the caller's value", () => {
    for (const value of [1500, 1499, 100, 1, 0, -1, -3000, 2000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(aiTranscriptRowCap(value, 1500), String(value)).toBe(1500);
    }
  });
});

describe("the owner's aiTranscriptDeepMaxRows", () => {
  it("rests at 1500: a hub that merged this reads what it read before", () => {
    expect(baseConfig().aiTranscriptDeepMaxRows).toBe("1500");
    expect(aiTranscriptDeepMaxRowsOf(baseConfig())).toBe(1500);
    expect(getDescriptor("aiTranscriptDeepMaxRows")).toMatchObject({
      envName: "AI_TRANSCRIPT_DEEP_MAX_ROWS",
      kind: "string",
      default: "1500",
      editability: "editable",
      runtimeApply: "live",
      enumValues: ["1500", "3000"],
    });
    // Raising it costs money per Recap: the console asks before it saves.
    expect(getDescriptor("aiTranscriptDeepMaxRows")?.costWarning).toBeTruthy();
  });

  it("takes exactly two values", () => {
    for (const value of ["1500", "3000"]) {
      expect(validateConfigOverride("aiTranscriptDeepMaxRows", value)).toEqual({ ok: true, value });
      expect(baseConfig({ AI_TRANSCRIPT_DEEP_MAX_ROWS: value }).aiTranscriptDeepMaxRows).toBe(value);
    }
    for (const value of ["2000", "3001", "6000", "0", "", "deep", 3000, 1500, true, null]) {
      expect(validateConfigOverride("aiTranscriptDeepMaxRows", value).ok, String(value)).toBe(false);
    }
    expect(() => baseConfig({ AI_TRANSCRIPT_DEEP_MAX_ROWS: "2000" })).toThrow();
  });

  it("reads as 3000 only when it clearly says so", () => {
    expect(aiTranscriptDeepMaxRowsOf({ aiTranscriptDeepMaxRows: "3000" })).toBe(3000);
    expect(aiTranscriptDeepMaxRowsOf({ aiTranscriptDeepMaxRows: "1500" })).toBe(1500);
    // A config without the key (an older process shape) and a value that got
    // past validation some other way both read as the ordinary cap.
    expect(aiTranscriptDeepMaxRowsOf({})).toBe(1500);
    for (const value of ["2000", "6000", "", 3000, true, null]) {
      expect(aiTranscriptDeepMaxRowsOf({ aiTranscriptDeepMaxRows: value } as never), String(value)).toBe(1500);
    }
  });

  it("is the owner's live override over the environment, and the ordinary cap when it cannot be read", async () => {
    expect(await loadAiTranscriptDeepMaxRows(appWith([]).app)).toBe(1500);
    expect(await loadAiTranscriptDeepMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "3000" }]).app)).toBe(3000);
    expect(await loadAiTranscriptDeepMaxRows(appWith([], { AI_TRANSCRIPT_DEEP_MAX_ROWS: "3000" }).app)).toBe(3000);
    // The override wins in both directions.
    expect(await loadAiTranscriptDeepMaxRows(
      appWith([{ key: "aiTranscriptDeepMaxRows", value: "1500" }], { AI_TRANSCRIPT_DEEP_MAX_ROWS: "3000" }).app,
    )).toBe(1500);
    // A stored value the registry refuses is skipped: the environment's serves.
    expect(await loadAiTranscriptDeepMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "9000" }]).app)).toBe(1500);
    expect(await loadAiTranscriptDeepMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: 3000 }]).app)).toBe(1500);

    const broken = appWith([], { AI_TRANSCRIPT_DEEP_MAX_ROWS: "3000" });
    broken.findMany.mockRejectedValue(new Error("database down"));
    expect(await loadAiTranscriptDeepMaxRows(broken.app)).toBe(1500);
    expect(broken.warn).toHaveBeenCalledTimes(1);
  });
});

describe("which request may read deep", () => {
  const deep = { feature: "fan-summary", summaryMode: undefined, isFanslyRequest: false, capabilities: CONTEXT_V1 } as const;

  it("is the full Recap of an OnlyFans chat from a context-v1 client, and nothing else", () => {
    expect(mayReadDeepTranscript(deep)).toBe(true);
    for (const feature of OPERATION_FEATURES) {
      for (const summaryMode of [undefined, "short"] as const) {
        for (const isFanslyRequest of [false, true]) {
          for (const capabilities of [CONTEXT_V1, new Set<AiStreamCapability>(), undefined]) {
            const expected = feature === "fan-summary" && summaryMode === undefined && !isFanslyRequest
              && capabilities === CONTEXT_V1;
            expect(
              mayReadDeepTranscript({ feature, summaryMode, isFanslyRequest, capabilities }),
              `${feature} ${summaryMode} fansly=${isFanslyRequest} ${capabilities ? [...capabilities].join() : "no header"}`,
            ).toBe(expected);
          }
        }
      }
    }
  });

  it("leaves Review on the deep bucket's 1500, though it shares the bucket with Recap", () => {
    expect(FEATURE_POLICIES["chat-review"].messageCountBucket).toBe("deep");
    expect(FEATURE_POLICIES["fan-summary"].messageCountBucket).toBe("deep");
    // A request that names no window still asks for 1500: the deeper read is
    // for a client that asks for it.
    expect(DEFAULT_MESSAGE_COUNT_BY_BUCKET.deep).toBe(1500);
    expect(mayReadDeepTranscript({ ...deep, feature: "chat-review" })).toBe(false);
    expect(mayReadDeepTranscript({ ...deep, feature: "coach-chat" })).toBe(false);
  });

  it("does not take another capability for context-v1", () => {
    for (const capability of ["debug-input-v1", "split-all-v1"] as const) {
      expect(mayReadDeepTranscript({ ...deep, capabilities: new Set<AiStreamCapability>([capability]) })).toBe(false);
    }
    expect(mayReadDeepTranscript({
      ...deep,
      capabilities: new Set<AiStreamCapability>(["debug-input-v1", "context-v1", "split-all-v1"]),
    })).toBe(true);
  });

  it("hands the readers 3000 only for that request, once the owner raised the value", async () => {
    const raised = [{ key: "aiTranscriptDeepMaxRows", value: "3000" }];
    expect(await resolveAiTranscriptMaxRows(appWith(raised).app, deep)).toBe(3000);
    // Resting: the readers get nothing and keep their own cap.
    expect(await resolveAiTranscriptMaxRows(appWith([]).app, deep)).toBeUndefined();
    expect(await resolveAiTranscriptMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "1500" }]).app, deep))
      .toBeUndefined();
  });

  it("reads nothing for every other request: their generations make the reads they always made", async () => {
    const raised = [{ key: "aiTranscriptDeepMaxRows", value: "3000" }];
    for (const request of [
      { ...deep, capabilities: undefined },
      { ...deep, capabilities: new Set<AiStreamCapability>(["debug-input-v1"]) },
      { ...deep, summaryMode: "short" as const },
      { ...deep, isFanslyRequest: true },
      { ...deep, feature: "chat-review" },
      { ...deep, feature: "coach-chat" },
      { ...deep, feature: "fast-reply" },
    ]) {
      const { app, findMany } = appWith(raised);
      expect(await resolveAiTranscriptMaxRows(app, request), JSON.stringify(request.feature)).toBeUndefined();
      expect(findMany).not.toHaveBeenCalled();
    }
  });

  it("costs a Recap its depth, never the Recap, when the value cannot be read", async () => {
    const { app, findMany, warn } = appWith([], { AI_TRANSCRIPT_DEEP_MAX_ROWS: "3000" });
    findMany.mockRejectedValue(new Error("database down"));
    expect(await resolveAiTranscriptMaxRows(app, deep)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("the cost of a 3000-message full Recap", () => {
  /** A transcript of `count` messages of `chars` characters each, alternating senders. */
  function transcriptOf(count: number, chars: number): string {
    const startMs = Date.parse("2026-09-01T00:00:00.000Z");
    const messages: TranscriptMessage[] = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      createdAtMs: startMs + index * 60_000,
      sender: index % 2 === 0 ? "Fan" : "Model",
      text: "x".repeat(chars),
      labels: [],
    }));
    return formatTranscript(messages);
  }

  function fullRecapRequest(transcript: string): AiGatewayStreamBody {
    const prompt = buildPrompt({
      feature: "fan-summary",
      personality: (() => {
        const persona = createBundledPersonalities()[0]!;
        return { id: persona.id, name: persona.name, content: persona.content, updatedAt: 1 };
      })(),
      platform: "onlyfans",
      transcript,
      fanSpendingData: "",
      fanSubscriptionData: "",
      fanDisplayName: "Alex",
    });
    return {
      clientRequestId: randomUUID(),
      feature: "fan-summary",
      pageLabel: "lora-of",
      platform: "onlyfans",
      platformUserId: "123456789",
      conversationId: "123456789",
      model: DEFAULT_FEATURE_MODELS["fan-summary"],
      reasoningEffort: DEFAULT_FEATURE_REASONING["fan-summary"],
      isRegeneration: false,
      prompt: { systemBlocks: prompt.systemBlocks, userBlocks: prompt.userBlocks },
    };
  }

  it("clears the gateway's per-request ceiling on the Recap's default model, with room to spare", () => {
    expect(DEFAULT_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT).toBe(5_000_000);

    // Production, 2026-10-04: the heaviest 3000-message window of an OnlyFans
    // chat holds 182k characters of text, 61 per message on average. The
    // preflight estimate also reserves the model's whole output budget.
    const likeProduction = estimateAnthropicGatewayRequestCost(fullRecapRequest(transcriptOf(3000, 61))).costMicroUsd;
    expect(likeProduction).toBeLessThan(1_500_000);

    // Four times that message length is still admitted.
    const fourTimes = estimateAnthropicGatewayRequestCost(fullRecapRequest(transcriptOf(3000, 250))).costMicroUsd;
    expect(fourTimes).toBeGreaterThan(likeProduction);
    expect(fourTimes).toBeLessThan(DEFAULT_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT);
  });
});
