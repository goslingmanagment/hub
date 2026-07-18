import { describe, expect, it } from "vitest";
import {
  AI_FEATURE_STREAM_BODY_LIMIT_BYTES,
  COACH_ANSWER_MAX_CHARS,
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
});

// Blocker 4 (P1-4): the scoped route bodyLimit is a BYTE budget enforced by
// Fastify BEFORE Zod, but the schema caps are CHAR counts. A static-math proof
// (not a 5MB upload) that the configured limit clears the worst-case
// schema-valid body — built at the field maxes with a 3-byte UTF-8 char, the
// per-code-unit worst case — and that the former 4 MiB limit did NOT.
describe("aiFeatureStream body limit vs the worst-case schema-valid body", () => {
  const schema = routeSchemas.aiFeatureStream.body;
  // "の" is 3 UTF-8 bytes and 1 UTF-16 code unit — the byte-per-char worst case
  // for z.string().max() (astral chars are 2 code units → 4 bytes = fewer
  // bytes/unit, so they never dominate).
  const fill = (units: number) => "の".repeat(units);

  it("8 MiB clears the worst case; 4 MiB did not", () => {
    const worstCase = {
      clientRequestId: "5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f",
      pageLabel: fill(120),
      platform: "fansly",
      conversationRef: fill(255),
      fanRef: fill(255),
      personaKey: fill(120),
      expectedPersonaDefinitionId: fill(100),
      model: fill(100),
      reasoningEffort: "max",
      replyTone: "spicy",
      replyMode: "preferSplit",
      messageCount: 3000,
      draftText: fill(20_000),
      isRegeneration: true,
      chatterQuestion: fill(2_000),
      // 20 × (2k question + 64k answer) = the 1.32M-char bulk.
      coachHistory: Array.from({ length: 20 }, () => ({
        question: fill(2_000),
        answer: fill(COACH_ANSWER_MAX_CHARS),
      })),
      summaryMode: "short",
      clientContext: {
        transcript: fill(300_000),
        messageCount: 5000,
        fanDisplayName: fill(200),
        fanSpendingData: fill(20_000),
        fanSubscriptionData: fill(20_000),
        fanBio: fill(5_000),
        pingSegment: "segment-a",
        transcriptCoverage: "full-history",
      },
    };
    // bodyLimit is enforced before validation, so the worst case that matters is
    // any body the schema would accept (cross-field feature rules run later).
    expect(schema.safeParse(worstCase).success, "worst case must be schema-valid").toBe(true);

    const bytes = Buffer.byteLength(JSON.stringify(worstCase), "utf8");
    // The historical 4 MiB limit 413'd this contract-valid request (the bug).
    expect(bytes).toBeGreaterThan(4 * 1024 * 1024);
    // The raised limit must clear it with headroom.
    expect(bytes).toBeLessThan(AI_FEATURE_STREAM_BODY_LIMIT_BYTES);
  });
});
