import { describe, expect, it } from "vitest";
import { routeSchemas } from "@agency_hub_core/contracts";

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
