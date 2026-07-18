import { describe, expect, it } from "vitest";

import {
  buildPrompt,
  COACH_CHAT_TEMPLATE,
  type PromptBuildInput,
} from "../apps/runtime/src/modules/ai/index.ts";

const baseInput = {
  feature: "coach-chat",
  personality: { content: "PERSONA", id: "p1", name: "Persona", updatedAt: 1 },
  platform: "fansly",
  transcript: "fan: hi",
  fanSpendingData: "",
  fanSubscriptionData: "",
  fanDisplayName: "Bob",
  chatterQuestion: "как продать ppv?",
} satisfies PromptBuildInput;

describe("coach-chat prompt", () => {
  it("includes question, dated recaps, and history with escaping", () => {
    const built = buildPrompt({
      ...baseInput,
      coachHistory: [{ question: "q<1>", answer: "a1" }],
      recapAttach: {
        full: { body: "FULL RECAP", ageMs: 3 * 86_400_000 },
        short: { body: "SHORT RECAP", ageMs: 10 * 60_000 },
      },
    });
    const text = JSON.stringify(built.userBlocks);
    expect(text).toContain("как продать ppv?");
    expect(text).toContain("q&lt;1&gt;"); // history escaped
    expect(text).toContain("FULL RECAP");
    expect(text).toContain("SHORT RECAP");
    expect(text).toMatch(/full recap.*3 day/i); // age labels
  });

  it("sheds oldest history entries over the prompt budget", () => {
    const big = Array.from({ length: 20 }, (_, i) => ({
      question: `q${i} ` + "x".repeat(1900),
      answer: `a${i} ` + "y".repeat(9900),
    }));
    const built = buildPrompt({ ...baseInput, coachHistory: big });
    const text = JSON.stringify(built.userBlocks);
    expect(text).toContain("q19"); // newest kept
    expect(text).not.toContain("q0 "); // oldest shed
  });

  it("template carries the cache anchors and draft grammar", () => {
    expect(COACH_CHAT_TEMPLATE).toContain("## Conversation Transcript");
    expect(COACH_CHAT_TEMPLATE).toContain("## Your Task");
    expect(COACH_CHAT_TEMPLATE).toContain("```draft");
  });

  it("keeps per-fan recaps, dossier and coach history out of the 1h static prefix", () => {
    const built = buildPrompt({
      ...baseInput,
      transcript: "TRANSCRIPTBODY",
      coachHistory: [{ question: "PRIORQ", answer: "PRIORA" }],
      recapAttach: { full: { body: "FULLBODY", ageMs: 60_000 }, short: null },
    });
    expect(built.userBlocks).toHaveLength(3);
    const [staticBlock, dynamicBlock, taskBlock] = built.userBlocks;
    // The 1h prefix must be fan-agnostic (builder invariant) — none of the
    // per-fan / per-turn data may ride here or the breakpoint never re-hits.
    expect(staticBlock?.cache).toBe("1h");
    expect(staticBlock?.text).toContain("## Rules");
    expect(staticBlock?.text).not.toContain("FULLBODY");
    expect(staticBlock?.text).not.toContain("PRIORQ");
    expect(staticBlock?.text).not.toContain("TRANSCRIPTBODY");
    expect(staticBlock?.text).not.toContain("## Fan Recaps");
    // Recaps + dossier + coach history ride the ephemeral dynamic block.
    expect(dynamicBlock?.cache).toBe("5m");
    expect(dynamicBlock?.text).toContain("TRANSCRIPTBODY");
    expect(dynamicBlock?.text).toContain("FULLBODY");
    expect(dynamicBlock?.text).toContain("PRIORQ");
    // The question stays in the uncached task block.
    expect(taskBlock?.cache).toBe("none");
    expect(taskBlock?.text).toContain("как продать ppv?");
  });
});
