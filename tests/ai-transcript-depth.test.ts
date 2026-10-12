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
import {
  buildAnthropicGatewayStreamRequest,
  estimateAnthropicGatewayRequestCost,
} from "../apps/runtime/src/services/ai-gateway-anthropic.ts";
import { estimateAiGatewayUsageCost } from "../apps/runtime/src/services/ai-gateway-pricing.ts";
import {
  FAN_NOTES_FILL_MIN_DEEP_ROWS,
  aiTranscriptDeepMaxRowsOf,
  deepTranscriptRowsOf,
  loadAiTranscriptDeepMaxRows,
  mayReadDeepTranscript,
  resolveAiTranscriptMaxRows,
} from "../apps/runtime/src/services/ai-transcript-depth.ts";

// chat-extension H-6, R20 HF-6: only the full Recap and the notes fill of a
// context-v1 client read past the AI transcript readers' 1500-row cap, up to
// 5000, on OnlyFans and Fansly alike: the Recap behind the owner's
// `aiTranscriptDeepMaxRows`, the notes fill never below 3000.

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
  it("is 1500 for both readers, and 5000 at the deepest", () => {
    expect(ARCHIVE_AI_TRANSCRIPT_MAX_ROWS).toBe(1500);
    expect(AI_TRANSCRIPT_UNION_MAX_LIMIT).toBe(1500);
    expect(AI_TRANSCRIPT_DEEP_MAX_ROWS).toBe(5000);
    // The agent read plane's transcript reader is another reader and stays where it was.
    expect(AGENT_TRANSCRIPT_UNION_MAX_ROWS).toBe(1500);
  });

  it("keeps the reader's cap unless a caller raises it, and never passes 5000", () => {
    expect(aiTranscriptRowCap(undefined, 1500)).toBe(1500);
    expect(aiTranscriptRowCap(3000, 1500)).toBe(3000);
    expect(aiTranscriptRowCap(5000, 1500)).toBe(5000);
    expect(aiTranscriptRowCap(2000, 1500)).toBe(2000);
    expect(aiTranscriptRowCap(3001, 1500)).toBe(3001);
    expect(aiTranscriptRowCap(5001, 1500)).toBe(5000);
    expect(aiTranscriptRowCap(1_000_000, 1500)).toBe(5000);
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
      enumValues: ["1500", "3000", "5000"],
    });
    // Raising it costs money per Recap: the console asks before it saves, and
    // the warning names the price at each step.
    const warning = getDescriptor("aiTranscriptDeepMaxRows")?.costWarning ?? "";
    for (const price of ["$0.42", "$0.67", "$1.00"]) {
      expect(warning).toContain(price);
    }
  });

  it("takes exactly three values, production's 3000 among them", () => {
    for (const value of ["1500", "3000", "5000"]) {
      expect(validateConfigOverride("aiTranscriptDeepMaxRows", value)).toEqual({ ok: true, value });
      expect(baseConfig({ AI_TRANSCRIPT_DEEP_MAX_ROWS: value }).aiTranscriptDeepMaxRows).toBe(value);
    }
    for (const value of ["2000", "3001", "4000", "5001", "6000", "0", "", "deep", 3000, 5000, 1500, true, null]) {
      expect(validateConfigOverride("aiTranscriptDeepMaxRows", value).ok, String(value)).toBe(false);
    }
    expect(() => baseConfig({ AI_TRANSCRIPT_DEEP_MAX_ROWS: "2000" })).toThrow();
    expect(() => baseConfig({ AI_TRANSCRIPT_DEEP_MAX_ROWS: "6000" })).toThrow();
  });

  it("reads as 3000 or 5000 only when it clearly says so", () => {
    expect(aiTranscriptDeepMaxRowsOf({ aiTranscriptDeepMaxRows: "5000" })).toBe(5000);
    expect(aiTranscriptDeepMaxRowsOf({ aiTranscriptDeepMaxRows: "3000" })).toBe(3000);
    expect(aiTranscriptDeepMaxRowsOf({ aiTranscriptDeepMaxRows: "1500" })).toBe(1500);
    // A config without the key (an older process shape) and a value that got
    // past validation some other way both read as the ordinary cap.
    expect(aiTranscriptDeepMaxRowsOf({})).toBe(1500);
    for (const value of ["2000", "6000", "", 3000, 5000, true, null]) {
      expect(aiTranscriptDeepMaxRowsOf({ aiTranscriptDeepMaxRows: value } as never), String(value)).toBe(1500);
    }
  });

  it("is the owner's live override over the environment, and the ordinary cap when it cannot be read", async () => {
    expect(await loadAiTranscriptDeepMaxRows(appWith([]).app)).toBe(1500);
    // Production since 2026-10-13: an override of 3000 (version 1, X37) stays valid.
    expect(await loadAiTranscriptDeepMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "3000" }]).app)).toBe(3000);
    expect(await loadAiTranscriptDeepMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "5000" }]).app)).toBe(5000);
    expect(await loadAiTranscriptDeepMaxRows(appWith([], { AI_TRANSCRIPT_DEEP_MAX_ROWS: "3000" }).app)).toBe(3000);
    expect(await loadAiTranscriptDeepMaxRows(appWith([], { AI_TRANSCRIPT_DEEP_MAX_ROWS: "5000" }).app)).toBe(5000);
    // The override wins in both directions.
    expect(await loadAiTranscriptDeepMaxRows(
      appWith([{ key: "aiTranscriptDeepMaxRows", value: "1500" }], { AI_TRANSCRIPT_DEEP_MAX_ROWS: "5000" }).app,
    )).toBe(1500);
    // A stored value the registry refuses is skipped: the environment's serves.
    expect(await loadAiTranscriptDeepMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "9000" }]).app)).toBe(1500);
    expect(await loadAiTranscriptDeepMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: 5000 }]).app)).toBe(1500);

    const broken = appWith([], { AI_TRANSCRIPT_DEEP_MAX_ROWS: "5000" });
    broken.findMany.mockRejectedValue(new Error("database down"));
    expect(await loadAiTranscriptDeepMaxRows(broken.app)).toBe(1500);
    expect(broken.warn).toHaveBeenCalledTimes(1);
  });
});

describe("which request may read deep", () => {
  const deep = { feature: "fan-summary", summaryMode: undefined, capabilities: CONTEXT_V1 } as const;
  const notesFill = { feature: "fan-notes-fill", summaryMode: undefined, capabilities: CONTEXT_V1 } as const;

  it("is the full Recap or the notes fill of a context-v1 client, on any platform, and nothing else", () => {
    expect(mayReadDeepTranscript(deep)).toBe(true);
    expect(mayReadDeepTranscript(notesFill)).toBe(true);
    for (const feature of OPERATION_FEATURES) {
      for (const summaryMode of [undefined, "short"] as const) {
        for (const capabilities of [CONTEXT_V1, new Set<AiStreamCapability>(), undefined]) {
          const expected = capabilities === CONTEXT_V1
            && ((feature === "fan-summary" && summaryMode === undefined) || feature === "fan-notes-fill");
          expect(
            mayReadDeepTranscript({ feature, summaryMode, capabilities }),
            `${feature} ${summaryMode} ${capabilities ? [...capabilities].join() : "no header"}`,
          ).toBe(expected);
        }
      }
    }
    // One rule for both platforms: the request the rule reads names none.
    expect(Object.keys(deep).sort()).toEqual(["capabilities", "feature", "summaryMode"]);
  });

  it("leaves Review on the deep bucket's 1500, though it shares the bucket with Recap", () => {
    expect(FEATURE_POLICIES["chat-review"].messageCountBucket).toBe("deep");
    expect(FEATURE_POLICIES["fan-summary"].messageCountBucket).toBe("deep");
    expect(FEATURE_POLICIES["fan-notes-fill"].messageCountBucket).toBe("deep");
    // A request that names no window still asks for 1500: the deeper read is
    // for a client that asks for it.
    expect(DEFAULT_MESSAGE_COUNT_BY_BUCKET.deep).toBe(1500);
    expect(mayReadDeepTranscript({ ...deep, feature: "chat-review" })).toBe(false);
    expect(mayReadDeepTranscript({ ...deep, feature: "coach-chat" })).toBe(false);
  });

  it("does not take another capability for context-v1", () => {
    for (const capability of ["debug-input-v1", "split-all-v1"] as const) {
      expect(mayReadDeepTranscript({ ...deep, capabilities: new Set<AiStreamCapability>([capability]) })).toBe(false);
      expect(mayReadDeepTranscript({ ...notesFill, capabilities: new Set<AiStreamCapability>([capability]) })).toBe(false);
    }
    expect(mayReadDeepTranscript({
      ...deep,
      capabilities: new Set<AiStreamCapability>(["debug-input-v1", "context-v1", "split-all-v1"]),
    })).toBe(true);
  });

  it("gives the full Recap the owner's depth and the notes fill never fewer than 3000", () => {
    expect(FAN_NOTES_FILL_MIN_DEEP_ROWS).toBe(3000);
    for (const [owner, recap, fill] of [[1500, 1500, 3000], [3000, 3000, 3000], [5000, 5000, 5000]] as const) {
      expect(deepTranscriptRowsOf("fan-summary", owner), `recap at ${owner}`).toBe(recap);
      expect(deepTranscriptRowsOf("fan-notes-fill", owner), `notes fill at ${owner}`).toBe(fill);
    }
  });

  it("hands the readers the owner's depth for the full Recap, once the owner raised it", async () => {
    expect(await resolveAiTranscriptMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "5000" }]).app, deep)).toBe(5000);
    expect(await resolveAiTranscriptMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "3000" }]).app, deep)).toBe(3000);
    // Resting: the readers get nothing and keep their own cap.
    expect(await resolveAiTranscriptMaxRows(appWith([]).app, deep)).toBeUndefined();
    expect(await resolveAiTranscriptMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "1500" }]).app, deep))
      .toBeUndefined();
  });

  it("hands the readers at least 3000 for the notes fill, whatever the owner's value", async () => {
    expect(await resolveAiTranscriptMaxRows(appWith([]).app, notesFill)).toBe(3000);
    expect(await resolveAiTranscriptMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "1500" }]).app, notesFill)).toBe(3000);
    expect(await resolveAiTranscriptMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "3000" }]).app, notesFill)).toBe(3000);
    expect(await resolveAiTranscriptMaxRows(appWith([{ key: "aiTranscriptDeepMaxRows", value: "5000" }]).app, notesFill)).toBe(5000);
  });

  it("reads nothing for every other request: their generations make the reads they always made", async () => {
    const raised = [{ key: "aiTranscriptDeepMaxRows", value: "5000" }];
    for (const request of [
      { ...deep, capabilities: undefined },
      { ...deep, capabilities: new Set<AiStreamCapability>(["debug-input-v1"]) },
      { ...deep, summaryMode: "short" as const },
      { ...notesFill, capabilities: undefined },
      { ...notesFill, capabilities: new Set<AiStreamCapability>(["debug-input-v1"]) },
      { ...deep, feature: "chat-review" },
      { ...deep, feature: "coach-chat" },
      { ...deep, feature: "fast-reply" },
    ]) {
      const { app, findMany } = appWith(raised);
      expect(await resolveAiTranscriptMaxRows(app, request), JSON.stringify(request)).toBeUndefined();
      expect(findMany).not.toHaveBeenCalled();
    }
  });

  it("costs a Recap its depth, never the Recap, when the value cannot be read; the notes fill keeps 3000", async () => {
    const recap = appWith([], { AI_TRANSCRIPT_DEEP_MAX_ROWS: "5000" });
    recap.findMany.mockRejectedValue(new Error("database down"));
    expect(await resolveAiTranscriptMaxRows(recap.app, deep)).toBeUndefined();
    expect(recap.warn).toHaveBeenCalledTimes(1);

    const fill = appWith([], { AI_TRANSCRIPT_DEEP_MAX_ROWS: "5000" });
    fill.findMany.mockRejectedValue(new Error("database down"));
    expect(await resolveAiTranscriptMaxRows(fill.app, notesFill)).toBe(3000);
  });
});

// R20 HF-6, the owner's condition (chat-extension decision X34): before the
// ceiling goes to 5000, a representative 5000-message context with the system
// part and room for the answer fits the window of the Recap's actual model, and
// the price of a full Recap is named. No provider call: the prompt is built by
// the hub's own builder and measured; tokens come from a ratio measured on
// production (below).
describe("X34: a 5000-message full Recap on the Recap's model", () => {
  /** Anthropic's model catalog: Opus 5.5 (and Sonnet 5.5) take a 1M-token prompt. */
  const MODEL_WINDOW_TOKENS = 1_000_000;
  /**
   * Production, 2026-10-13: 25 full Recaps on Opus 5.5, the provider's input
   * tokens against the characters of the prompt the hub sent, read 1.97 to
   * 2.67 characters a token (2.3 over all of them). 1.9 is below every one.
   */
  const PESSIMISTIC_CHARS_PER_TOKEN = 1.9;
  const CENTRAL_CHARS_PER_TOKEN = 2.3;
  /** Production, 2026-10-13: the mean output of the full Recaps that read over 900 messages. */
  const RECAP_OUTPUT_TOKENS = 10_000;
  /**
   * Production, 2026-10-13: the text of the newest 1500, 3000 and 5000 live
   * messages of the heaviest chat (a Fansly chat of 5920), in UTF-16 units:
   * 90,900, 215,477 and 374,391, so 61, 72 and 75 a message.
   */
  const HEAVIEST_CHARS_PER_MESSAGE = { 1500: 61, 3000: 72, 5000: 75 } as const;

  /** A transcript of `count` messages of `chars` characters each, alternating senders. */
  function transcriptOf(count: number, chars: number): string {
    const startMs = Date.parse("2026-09-01T00:00:00.000Z");
    const messages: TranscriptMessage[] = Array.from({ length: count }, (_, index) => ({
      id: String(index + 1),
      createdAtMs: startMs + index * 60_000,
      sender: index % 2 === 0 ? "Fan" : "Model",
      text: "x".repeat(chars),
      labels: [],
    }));
    return formatTranscript(messages);
  }

  function requestOf(feature: "fan-summary" | "fan-notes-fill", transcript: string): AiGatewayStreamBody {
    const prompt = buildPrompt({
      feature,
      personality: (() => {
        const persona = createBundledPersonalities()[0]!;
        return { id: persona.id, name: persona.name, content: persona.content, updatedAt: 1 };
      })(),
      platform: "fansly",
      transcript,
      fanSpendingData: "",
      fanSubscriptionData: "",
      fanDisplayName: "Alex",
      ...(feature === "fan-notes-fill" ? { noteFields: ["Имя", "Возраст", "Локация", "Работа", "Медиа"] } : {}),
    });
    return {
      clientRequestId: randomUUID(),
      feature,
      pageLabel: "lora-fansly",
      platform: "fansly",
      platformUserId: "123456789",
      conversationId: "123456789",
      model: DEFAULT_FEATURE_MODELS[feature],
      reasoningEffort: DEFAULT_FEATURE_REASONING[feature],
      isRegeneration: false,
      prompt: { systemBlocks: prompt.systemBlocks, userBlocks: prompt.userBlocks },
    };
  }

  /** Everything the model reads, in UTF-16 units: the system part and the user part. */
  function promptChars(body: AiGatewayStreamBody): number {
    return [...body.prompt.systemBlocks, ...body.prompt.userBlocks].reduce((sum, block) => sum + block.text.length, 0);
  }

  const heaviest = (count: 1500 | 3000 | 5000, feature: "fan-summary" | "fan-notes-fill" = "fan-summary") =>
    requestOf(feature, transcriptOf(count, HEAVIEST_CHARS_PER_MESSAGE[count]));

  it("runs on Opus 5.5, priced at its list price", () => {
    expect(DEFAULT_FEATURE_MODELS["fan-summary"]).toBe("anthropic:claude-opus-5-5");
    const usage = { cacheWriteTokens: 0, cacheReadTokens: 0 };
    expect(estimateAiGatewayUsageCost("anthropic:claude-opus-5-5", { ...usage, inputTokens: 1_000_000, outputTokens: 0 })
      .costMicroUsd).toBe(4_000_000);
    expect(estimateAiGatewayUsageCost("anthropic:claude-opus-5-5", { ...usage, inputTokens: 0, outputTokens: 1_000_000 })
      .costMicroUsd).toBe(20_000_000);
    // A full Recap's prompt carries no cache marker: all of it is input.
    for (const block of [...heaviest(5000).prompt.systemBlocks, ...heaviest(5000).prompt.userBlocks]) {
      expect(block.cache ?? "none").toBe("none");
    }
  });

  it("fits the model's window with the system part and the answer's whole budget, the heaviest chat included", () => {
    for (const feature of ["fan-summary", "fan-notes-fill"] as const) {
      const body = heaviest(5000, feature);
      const chars = promptChars(body);
      const answer = buildAnthropicGatewayStreamRequest(body).max_tokens;
      expect(answer, feature).toBe(feature === "fan-summary" ? 24_000 : 8_000);
      // About 460k characters: the system part and the 5000 lines.
      expect(chars, feature).toBeGreaterThan(455_000);
      expect(chars, feature).toBeLessThan(465_000);
      // At a ratio below any production Recap's, a third of the window.
      expect(Math.ceil(chars / PESSIMISTIC_CHARS_PER_TOKEN) + answer, feature).toBeLessThan(MODEL_WINDOW_TOKENS / 3);
      // And with no tokenizer assumed at all: one token for every character.
      expect(chars + answer, feature).toBeLessThan(MODEL_WINDOW_TOKENS);
    }
  });

  it("clears the gateway's per-request ceiling at every depth", () => {
    expect(DEFAULT_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT).toBe(5_000_000);
    // The preflight reserves the answer's whole budget (24k tokens at $20 a million).
    for (const count of [1500, 3000, 5000] as const) {
      const preflight = estimateAnthropicGatewayRequestCost(heaviest(count)).costMicroUsd;
      expect(preflight, String(count)).toBeLessThan(1_000_000);
    }
    // Message length is what moves it: three times production's heaviest still passes.
    expect(estimateAnthropicGatewayRequestCost(requestOf("fan-summary", transcriptOf(5000, 225))).costMicroUsd)
      .toBeLessThan(DEFAULT_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT);
  });

  it("costs what the setting's warning names, by the model's list price", () => {
    const priceOf = (count: 1500 | 3000 | 5000) => estimateAiGatewayUsageCost(DEFAULT_FEATURE_MODELS["fan-summary"], {
      inputTokens: Math.round(promptChars(heaviest(count)) / CENTRAL_CHARS_PER_TOKEN),
      outputTokens: RECAP_OUTPUT_TOKENS,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    }).costMicroUsd / 1_000_000;
    const warning = getDescriptor("aiTranscriptDeepMaxRows")?.costWarning ?? "";
    for (const [count, named] of [[1500, 0.42], [3000, 0.67], [5000, 1.0]] as const) {
      expect(Math.abs(priceOf(count) - named), `${count}: ${priceOf(count)}`).toBeLessThan(0.01);
      expect(warning).toContain(`$${named.toFixed(2)}`);
    }
  });
});
