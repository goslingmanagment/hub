// W8.2 (A13 remainder, decision #133): occurred_at plausibility clamp at
// canonicalize time. Out-of-window provider timestamps fall back to the
// observation's receipt time — never a guessed boundary — with the raw value
// preserved in event data; in-window drafts pass through untouched.

import { describe, expect, it } from "vitest";

import {
  clampDraftOccurredAt,
  OCCURRED_AT_CLAMP_MIN,
  occurredAtClampMax,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import type { CanonicalEventDraft } from "../apps/runtime/src/services/canonicalize/types.ts";

const NOW = new Date("2026-07-11T12:00:00Z");
const RECEIVED_AT = new Date("2026-07-10T09:30:00Z");

function draft(occurredAt: Date): CanonicalEventDraft {
  return {
    type: "transaction.posted",
    occurredAt,
    fanIdentityRef: "fan-1",
    data: { amount: 100 },
    schemaVersion: 1,
    dedupKey: "txn:clamp-1",
  };
}

describe("clampDraftOccurredAt (W8.2)", () => {
  it("bounds the window at [2024-01-01, now + 2 months]", () => {
    expect(OCCURRED_AT_CLAMP_MIN.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(occurredAtClampMax(NOW).toISOString()).toBe("2026-09-11T12:00:00.000Z");
  });

  it("passes in-window drafts through IDENTICALLY (no data pollution)", () => {
    for (const at of [
      new Date("2024-01-01T00:00:00Z"), // inclusive lower edge
      new Date("2026-06-15T10:00:00Z"),
      occurredAtClampMax(NOW), // inclusive upper edge
    ]) {
      const input = draft(at);
      const output = clampDraftOccurredAt(input, RECEIVED_AT, NOW);
      expect(output).toBe(input);
      expect(output.data).not.toHaveProperty("occurredAtClamped");
    }
  });

  it("clamps a pre-2024 timestamp to receivedAt and records the raw value", () => {
    const out = clampDraftOccurredAt(draft(new Date(0)), RECEIVED_AT, NOW);
    expect(out.occurredAt).toEqual(RECEIVED_AT);
    expect(out.data).toMatchObject({
      amount: 100, // original data preserved
      occurredAtClamped: true,
      occurredAtRaw: "1970-01-01T00:00:00.000Z",
    });
    // The dedup key was built by the canonicalizer BEFORE the clamp — stable.
    expect(out.dedupKey).toBe("txn:clamp-1");
  });

  it("clamps a far-future timestamp (provider fat-finger) the same way", () => {
    const out = clampDraftOccurredAt(draft(new Date("2035-01-01T00:00:00Z")), RECEIVED_AT, NOW);
    expect(out.occurredAt).toEqual(RECEIVED_AT);
    expect(out.data).toMatchObject({
      occurredAtClamped: true,
      occurredAtRaw: "2035-01-01T00:00:00.000Z",
    });
    // Just past the +2mo edge clamps too.
    const edge = new Date(occurredAtClampMax(NOW).getTime() + 1);
    expect(clampDraftOccurredAt(draft(edge), RECEIVED_AT, NOW).occurredAt).toEqual(RECEIVED_AT);
  });

  it("clamps an Invalid Date to receivedAt with a null raw value", () => {
    const out = clampDraftOccurredAt(draft(new Date(Number.NaN)), RECEIVED_AT, NOW);
    expect(out.occurredAt).toEqual(RECEIVED_AT);
    expect(out.data).toMatchObject({ occurredAtClamped: true, occurredAtRaw: null });
  });
});
