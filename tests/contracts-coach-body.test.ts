import { describe, expect, it } from "vitest";
import {
  AI_FEATURE_STREAM_BODY_LIMIT_BYTES,
  COACH_ANSWER_MAX_CHARS,
  FAN_SILENCE_DAYS_MAX,
  routeSchemas,
} from "@agency_hub_core/contracts";

const base = {
  clientRequestId: "5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f",
  pageLabel: "demo-page",
  platform: "fansly",
  conversationRef: "group-123",
};

describe("aiFeatureStream body — coach fields", () => {
  const schema = routeSchemas.aiFeatureStream.body;

  it("accepts coach fields within bounds", () => {
    const r = schema.safeParse({
      ...base,
      chatterQuestion: "как продать ppv?",
      coachHistory: [{ question: "q1", answer: "a1" }],
      clientContext: {
        transcript: "fan: hi", messageCount: 1, fanDisplayName: "Bob",
        transcriptCoverage: "window",
      },
    });
    expect(r.success, JSON.stringify(r)).toBe(true);
  });

  it("rejects out-of-bounds history", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      question: `q${i}`, answer: `a${i}`,
    }));
    expect(schema.safeParse({ ...base, coachHistory: tooMany }).success).toBe(false);
    // Option "c": the answer bound is the 64k TRANSPORT ceiling, not the old
    // 10k prompt bound — a 10k-plus answer replays verbatim within schema.
    expect(schema.safeParse({
      ...base,
      coachHistory: [{ question: "q", answer: "x".repeat(10_001) }],
    }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      coachHistory: [{ question: "q", answer: "x".repeat(64_000) }],
    }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      coachHistory: [{ question: "q", answer: "x".repeat(64_001) }],
    }).success).toBe(false);
  });

  it("accepts summaryMode 'short' only", () => {
    expect(schema.safeParse({ ...base, summaryMode: "short" }).success).toBe(true);
    expect(schema.safeParse({ ...base, summaryMode: "full" }).success).toBe(false);
  });

  it("bounds fanSilenceDays to a whole number from 0 through the shared maximum", () => {
    const clientContext = {
      transcript: "fan: hi",
      messageCount: 1,
      fanDisplayName: "Bob",
      pingSegment: "segment-a",
    };
    expect(schema.safeParse({
      ...base,
      clientContext: { ...clientContext, fanSilenceDays: 0 },
    }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      clientContext: { ...clientContext, fanSilenceDays: FAN_SILENCE_DAYS_MAX },
    }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      clientContext: { ...clientContext, fanSilenceDays: -1 },
    }).success).toBe(false);
    expect(schema.safeParse({
      ...base,
      clientContext: { ...clientContext, fanSilenceDays: FAN_SILENCE_DAYS_MAX + 1 },
    }).success).toBe(false);
    expect(schema.safeParse({
      ...base,
      clientContext: { ...clientContext, fanSilenceDays: 1.5 },
    }).success).toBe(false);
  });
});

// Blocker 4 (P1-4) / round-4 P2-4: the scoped route bodyLimit is a BYTE budget
// enforced by Fastify BEFORE Zod, but the schema caps are CHAR counts. A
// static-math proof (not a multi-MB upload) that the configured limit clears the
// worst-case schema-valid body. The large free-text fields are content-agnostic
// plain bounded strings again -- the control-char ban was reverted (it regressed
// live Fansly features and was invisible in the OpenAPI) -- so the true
// per-code-unit worst case on the JSON wire is a SIX-byte "\uXXXX" escape.
describe("aiFeatureStream body limit vs the worst-case schema-valid body", () => {
  const schema = routeSchemas.aiFeatureStream.body;

  const scalars = {
    clientRequestId: "5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f",
    platform: "fansly",
    reasoningEffort: "max",
    replyTone: "spicy",
    replyMode: "preferSplit",
    messageCount: 3000,
    isRegeneration: true,
    summaryMode: "short",
  } as const;

  // A body at EVERY field's max, each field filled with one code unit repeated,
  // so the serialized size is the worst case for that unit.
  const maxBodyFilledWith = (unit: string) => ({
    ...scalars,
    pageLabel: unit.repeat(120),
    conversationRef: unit.repeat(255),
    fanRef: unit.repeat(255),
    personaKey: unit.repeat(120),
    expectedPersonaDefinitionId: unit.repeat(100),
    model: unit.repeat(100),
    draftText: unit.repeat(20_000),
    chatterQuestion: unit.repeat(2_000),
    // 20 x (2k question + 64k answer) = the 1.32M-code-unit bulk.
    coachHistory: Array.from({ length: 20 }, () => ({
      question: unit.repeat(2_000),
      answer: unit.repeat(COACH_ANSWER_MAX_CHARS),
    })),
    clientContext: {
      transcript: unit.repeat(300_000),
      messageCount: 5000,
      fanDisplayName: unit.repeat(200),
      fanSpendingData: unit.repeat(20_000),
      fanSubscriptionData: unit.repeat(20_000),
      fanBio: unit.repeat(5_000),
      pingSegment: "segment-a",
      fanSilenceDays: FAN_SILENCE_DAYS_MAX,
      transcriptCoverage: "full-history",
    },
  });

  it("a 3-byte-UTF-8 (の) worst case is schema-valid and fits 12 MiB (>4 MiB)", () => {
    // "の" is 3 UTF-8 bytes and 1 UTF-16 code unit -- the byte-per-char worst
    // case among PRINTABLE chars for z.string().max() (astral chars are 2 code
    // units -> 4 bytes = fewer bytes/unit, so they never dominate). ~5.06MB.
    const worstCase = maxBodyFilledWith("の");
    expect(schema.safeParse(worstCase).success, "の worst case must be schema-valid").toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(worstCase), "utf8");
    // The historical 4 MiB limit 413'd this contract-valid request.
    expect(bytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(bytes).toBeLessThan(AI_FEATURE_STREAM_BODY_LIMIT_BYTES);
  });

  it("a lone-high-surrogate (U+D800) worst case is schema-valid and fits 12 MiB (>8 MiB)", () => {
    // Round-4 P2-4: with the control-char ban reverted, the TRUE worst case is a
    // lone surrogate. "\ud800" is a legal JSON string value (1 UTF-16 code unit,
    // so z.string().max() accepts it) that JSON.stringify escapes to a SIX-byte
    // "\ud800" sequence -- ~1.69M units x 6 ~= 10.1MB. The former 8 MiB limit
    // would have 413'd this contract-valid body; 12 MiB clears it with headroom.
    const worstCase = maxBodyFilledWith("\ud800");
    expect(schema.safeParse(worstCase).success, "surrogate worst case must be schema-valid").toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(worstCase), "utf8");
    // Proves why 12 MiB was needed: the six-byte escape blows past the old 8 MiB.
    expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(bytes).toBeLessThan(AI_FEATURE_STREAM_BODY_LIMIT_BYTES);
  });
});
