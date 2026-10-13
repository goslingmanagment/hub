import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AI_NOTE_FIELD_LABEL_MAX_CHARS,
  AI_NOTE_FIELDS_MAX,
  AI_NOTE_VALUE_MAX_CHARS,
  aiFeatureStreamBodySchema,
  aiUsageBatchBodySchema,
  type AiGatewayStreamBody,
} from "@agency_hub_core/contracts";
import { aiUsageFeatures } from "@agency_hub_core/shared";

import {
  FEATURE_POLICIES,
  MIN_MESSAGES_FOR_NOTES_FILL,
  OPERATION_FEATURES,
  assertNoteFieldsRequestShape,
} from "../apps/runtime/src/modules/ai/index.ts";
import {
  buildAnthropicGatewayStreamRequest,
  resolveAnthropicGatewayRequestTuning,
} from "../apps/runtime/src/services/ai-gateway-anthropic.ts";
import { buildOpenrouterGatewayStreamRequest } from "../apps/runtime/src/services/ai-gateway-openrouter-provider.ts";
import { BadRequestError } from "../apps/runtime/src/services/errors.ts";

// fan-notes-fill: the Fansly notes panel's «fill with AI». The request carries
// the questionnaire labels (`noteFields`) and, in merge mode, their current
// values (`noteValues`); the hub assembles the prompt and streams one
// `Label: value` line per label.

const FIELDS = ["Имя", "Локация", "Возраст", "Работа", "Хобби", "Фетиши", "Характеристика", "Медиа"];

const request = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: randomUUID(),
  pageLabel: "lora-1",
  platform: "fansly",
  conversationRef: "group-1",
  fanRef: "fan-1",
  noteFields: FIELDS,
  clientContext: {
    transcript: "[10:00] Fan: im Mike",
    messageCount: 1,
    fanDisplayName: "Mike",
    transcriptCoverage: "full-history",
  },
  ...overrides,
});

describe("noteFields on the wire (aiFeatureStreamBodySchema)", () => {
  const parse = (noteFields: unknown) => aiFeatureStreamBodySchema.safeParse(request({ noteFields }));

  it("accepts the owner's template and keeps the labels in order", () => {
    const parsed = parse(FIELDS);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.noteFields).toEqual(FIELDS);
    // Optional: every other feature's request carries none.
    expect(aiFeatureStreamBodySchema.safeParse(request({ noteFields: undefined })).success).toBe(true);
  });

  it("trims each label, so the answer line carries the trimmed label", () => {
    expect(parse(["  Имя ", "\tЛокация"]).data?.noteFields).toEqual(["Имя", "Локация"]);
    // A trailing line break is whitespace, trimmed like any other.
    expect(parse(["Имя\r\n", "Возраст\u2028"]).data?.noteFields).toEqual(["Имя", "Возраст"]);
  });

  it("bounds the count to 1..30 and each trimmed label to 1..60 code units", () => {
    expect([AI_NOTE_FIELDS_MAX, AI_NOTE_FIELD_LABEL_MAX_CHARS]).toEqual([30, 60]);
    expect(parse([]).success).toBe(false);
    expect(parse(Array.from({ length: 30 }, (_, index) => `Поле ${index}`)).success).toBe(true);
    expect(parse(Array.from({ length: 31 }, (_, index) => `Поле ${index}`)).success).toBe(false);
    expect(parse(["я".repeat(60)]).success).toBe(true);
    expect(parse(["я".repeat(61)]).success).toBe(false);
    expect(parse([` ${"я".repeat(60)} `]).success).toBe(true);
    expect(parse([""]).success).toBe(false);
    expect(parse(["   "]).success).toBe(false);
    expect(parse([42]).success).toBe(false);
  });

  it("refuses a line break, a colon, and the characters the prompt escaping would change", () => {
    for (const label of ["Имя\nФамилия", "Имя\rФамилия", "Имя\u2028Фамилия", "Имя\u2029Фамилия", "Имя:", "Возраст: лет", "<b>", "a > b", "Хобби & интересы"]) {
      expect(parse([label]).success, JSON.stringify(label)).toBe(false);
    }
    for (const label of ["Секс/фетиши", "Медиа (что покупал)", "Город, страна", "Age", "Любимое — кино", "Имя?"]) {
      expect(parse([label]).success, JSON.stringify(label)).toBe(true);
    }
  });

  it("refuses repeated labels, compared case-insensitively after trimming", () => {
    expect(parse(["Имя", "имя"]).success).toBe(false);
    expect(parse(["ИМЯ", " Имя"]).success).toBe(false);
    expect(parse(["Name", "NAME"]).success).toBe(false);
    expect(parse(["Имя", "Имя 2"]).success).toBe(true);
  });
});

describe("noteValues on the wire (aiFeatureStreamBodySchema)", () => {
  const VALUES = ["Ethan", "Australia, Brisbane", "", "", "", "", "Māori & Dutch, Japan at the end of the year", "Sexting 1"];
  const parse = (noteValues: unknown) => aiFeatureStreamBodySchema.safeParse(request({ noteValues }));

  it("accepts one value per label, empty ones included, and keeps them in order", () => {
    const parsed = parse(VALUES);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.noteValues).toEqual(VALUES);
    // Absent is the released clients' request (2.10.1), accepted as before.
    const legacy = aiFeatureStreamBodySchema.safeParse(request());
    expect(legacy.success).toBe(true);
    expect(legacy.data).not.toHaveProperty("noteValues");
  });

  it("trims each value, so a value with only whitespace is an empty value", () => {
    expect(parse(["  Ethan ", "\tBrisbane", "   "]).data?.noteValues).toEqual(["Ethan", "Brisbane", ""]);
    // A trailing line break is whitespace, trimmed like any other.
    expect(parse(["Ethan\r\n", "Brisbane\u2028", "Sexting 1\u2029"]).data?.noteValues).toEqual(["Ethan", "Brisbane", "Sexting 1"]);
  });

  it("bounds each trimmed value to 0..2000 code units and the list to 1..30 values", () => {
    expect(AI_NOTE_VALUE_MAX_CHARS).toBe(2_000);
    expect(parse(["я".repeat(2_000)]).success).toBe(true);
    expect(parse([` ${"я".repeat(2_000)} `]).success).toBe(true);
    expect(parse(["я".repeat(2_001)]).success).toBe(false);
    // Code units, not characters: an astral character counts two.
    expect(parse(["😀".repeat(1_000)]).success).toBe(true);
    expect(parse([`${"😀".repeat(1_000)}я`]).success).toBe(false);
    expect(parse([""]).success).toBe(true);
    expect(parse([]).success).toBe(false);
    expect(parse(Array.from({ length: 30 }, () => "")).success).toBe(true);
    expect(parse(Array.from({ length: 31 }, () => "")).success).toBe(false);
    expect(parse([42]).success).toBe(false);
    expect(parse([null]).success).toBe(false);
    expect(parse("Ethan").success).toBe(false);
  });

  it("refuses a line break inside a value and takes every other character", () => {
    for (const value of ["Ethan\nSmith", "Ethan\rSmith", "Ethan\u2028Smith", "Ethan\u2029Smith", "a\r\nb"]) {
      expect(parse([value]).success, JSON.stringify(value)).toBe(false);
    }
    for (const value of [
      "<b>VIP</b> & co",
      "4 on 4 off: nights",
      "«Sexting 1»",
      "Флорида (08.2026)",
      "tab\tinside",
      "it's \"quoted\"",
      "Любимое — кино",
      "Cities Skylines 2 / Knockout / NRL",
      "😀 emoji",
    ]) {
      const parsed = parse([value]);
      expect(parsed.success, JSON.stringify(value)).toBe(true);
      expect(parsed.data?.noteValues, JSON.stringify(value)).toEqual([value]);
    }
  });
});

describe("noteFields in the feature service", () => {
  it("is required for fan-notes-fill", () => {
    expect(() => assertNoteFieldsRequestShape("fan-notes-fill", {})).toThrow(BadRequestError);
    expect(() => assertNoteFieldsRequestShape("fan-notes-fill", {})).toThrow("fan-notes-fill requires noteFields");
    expect(() => assertNoteFieldsRequestShape("fan-notes-fill", { noteFields: [] })).toThrow("fan-notes-fill requires noteFields");
    expect(() => assertNoteFieldsRequestShape("fan-notes-fill", { noteFields: FIELDS })).not.toThrow();
  });

  it("is refused by every other feature, by name", () => {
    for (const feature of OPERATION_FEATURES.filter((name) => name !== "fan-notes-fill")) {
      expect(() => assertNoteFieldsRequestShape(feature, {}), feature).not.toThrow();
      expect(() => assertNoteFieldsRequestShape(feature, { noteFields: FIELDS }), feature).toThrow(BadRequestError);
      expect(() => assertNoteFieldsRequestShape(feature, { noteFields: FIELDS }), feature)
        .toThrow(`${feature} does not accept noteFields`);
    }
  });
});

describe("noteValues in the feature service", () => {
  const VALUES = FIELDS.map((_, index) => (index % 2 === 0 ? "" : `value ${index}`));
  const MISMATCH = "noteValues must hold exactly one value per noteFields label";

  it("is optional on fan-notes-fill: absent is the released request, accepted as before", () => {
    expect(() => assertNoteFieldsRequestShape("fan-notes-fill", { noteFields: FIELDS })).not.toThrow();
  });

  it("takes exactly one value per label, all empty included", () => {
    expect(() => assertNoteFieldsRequestShape("fan-notes-fill", { noteFields: FIELDS, noteValues: VALUES })).not.toThrow();
    expect(() => assertNoteFieldsRequestShape("fan-notes-fill", { noteFields: FIELDS, noteValues: FIELDS.map(() => "") }))
      .not.toThrow();
    expect(() => assertNoteFieldsRequestShape("fan-notes-fill", { noteFields: ["Имя"], noteValues: ["Ethan"] })).not.toThrow();
  });

  it("refuses a list of another length with a 400, before any provider call", () => {
    for (const noteValues of [VALUES.slice(1), [...VALUES, ""], ["Ethan"], []]) {
      expect(() => assertNoteFieldsRequestShape("fan-notes-fill", { noteFields: FIELDS, noteValues }), String(noteValues.length))
        .toThrow(BadRequestError);
      expect(() => assertNoteFieldsRequestShape("fan-notes-fill", { noteFields: FIELDS, noteValues }), String(noteValues.length))
        .toThrow(MISMATCH);
    }
    // Values never stand in for the labels.
    expect(() => assertNoteFieldsRequestShape("fan-notes-fill", { noteValues: ["Ethan"] }))
      .toThrow("fan-notes-fill requires noteFields");
  });

  it("is refused by every other feature, by name", () => {
    for (const feature of OPERATION_FEATURES.filter((name) => name !== "fan-notes-fill")) {
      expect(() => assertNoteFieldsRequestShape(feature, { noteValues: VALUES }), feature).toThrow(BadRequestError);
      expect(() => assertNoteFieldsRequestShape(feature, { noteValues: VALUES }), feature)
        .toThrow(`${feature} does not accept noteValues`);
      // With the labels too, the labels are named first.
      expect(() => assertNoteFieldsRequestShape(feature, { noteFields: FIELDS, noteValues: VALUES }), feature)
        .toThrow(`${feature} does not accept noteFields`);
    }
  });
});

describe("fan-notes-fill policy", () => {
  it("reads like the full Recap, with the bio, without the dossier or image notes", () => {
    expect(FEATURE_POLICIES["fan-notes-fill"]).toEqual({
      surface: "panel-tab",
      resultKind: "text",
      promptMode: "analysis",
      timeoutBucket: "deep",
      messageCountBucket: "deep",
      modelFeature: "fan-notes-fill",
      includesEarnings: true,
      minMessages: MIN_MESSAGES_FOR_NOTES_FILL,
      rerunAction: "regenerate",
      supportsReplyMode: false,
      supportsSplitAll: false,
      supportsReplyTone: false,
      requiresDraft: false,
      usesPingSegment: false,
      usesFanProfile: false,
      includesFanBio: true,
      usesImageNotes: false,
    });
    expect(MIN_MESSAGES_FOR_NOTES_FILL).toBe(1);
    expect(FEATURE_POLICIES["fan-notes-fill"].messageCountBucket).toBe(FEATURE_POLICIES["fan-summary"].messageCountBucket);
    expect(FEATURE_POLICIES["fan-notes-fill"].timeoutBucket).toBe(FEATURE_POLICIES["fan-summary"].timeoutBucket);
  });
});

describe("fan-notes-fill on the gateway", () => {
  const body = (overrides: Partial<AiGatewayStreamBody> = {}): AiGatewayStreamBody => ({
    clientRequestId: randomUUID(),
    feature: "fan-notes-fill",
    pageLabel: "lora-1",
    platform: "fansly",
    platformUserId: "fan-1",
    conversationId: "group-1",
    model: "anthropic:claude-sonnet-5-5",
    reasoningEffort: "low",
    isRegeneration: false,
    prompt: {
      systemBlocks: [{ text: "safety", cache: "none" }, { text: "persona", cache: "none" }],
      userBlocks: [{ text: "task", cache: "none" }],
    },
    ...overrides,
  });

  it("runs the Sonnet 5.5 default with low adaptive thinking, room for it, and no sampling parameter", () => {
    const built = buildAnthropicGatewayStreamRequest(body());
    expect(built).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 8000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
    });
    expect(built).not.toHaveProperty("temperature");
  });

  it("keeps a modest visible cap and a low temperature where the model takes them", () => {
    expect(resolveAnthropicGatewayRequestTuning({
      providerModelId: "claude-haiku-4-5",
      feature: "fan-notes-fill",
      temperature: 0.2,
      reasoningEffort: "off",
    })).toEqual({ maxTokens: 2000, temperature: 0.2 });
    expect(buildAnthropicGatewayStreamRequest(body({ model: "anthropic:claude-haiku-4-5", reasoningEffort: "off" })))
      .toMatchObject({ max_tokens: 2000, temperature: 0.2 });
    expect(buildOpenrouterGatewayStreamRequest(body({ model: "openrouter:openai/gpt-4o-mini", reasoningEffort: "off" })))
      .toMatchObject({ max_tokens: 2000, temperature: 0.2 });
  });
});

describe("fan-notes-fill in the usage ledger", () => {
  it("is a wire feature the client usage batch accepts", () => {
    expect(aiUsageFeatures).toContain("fan-notes-fill");
    const parsed = aiUsageBatchBodySchema.safeParse({
      events: [{
        clientEventId: randomUUID(),
        feature: "fan-notes-fill",
        model: "anthropic:claude-sonnet-5-5",
        inputTokens: 1200,
        outputTokens: 90,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        conversationId: "group-1",
        durationMs: 2100,
        isCacheHit: false,
        isRegeneration: false,
        completedAt: new Date().toISOString(),
      }],
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("has a DB enum migration", () => {
    const sql = readFileSync("packages/db/migrations/0269_fan_notes_fill_feature.sql", "utf8");
    expect(sql).toMatch(/alter type "ai_usage_feature" add value if not exists 'fan-notes-fill';/i);
  });
});
