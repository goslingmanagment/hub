import { describe, expect, it } from "vitest";

import {
  buildPrompt,
  coachHistorySection,
  COACH_CHAT_TEMPLATE,
  FAN_SUMMARY_SHORT_TEMPLATE,
  projectCoachAnswer,
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

  it("tail-truncates an oversized recap on code points — never splits a surrogate pair", () => {
    // RECAP_ATTACH_MAX_CHARS is 30_000; a recap of pure emoji (surrogate pairs)
    // well past it forces the bounded() tail cut. A raw UTF-16 slice at 30_000
    // could leave a lone high surrogate; the code-point-safe slice must not.
    const built = buildPrompt({
      ...baseInput,
      recapAttach: {
        full: { body: "🎉".repeat(40_000), ageMs: 60_000 },
        short: null,
      },
    });
    // Assert on the RAW block text, not JSON.stringify — the latter escapes a
    // lone surrogate to \uXXXX and would mask the very bug under test.
    const text = built.userBlocks.map((block) => block.text).join("");
    expect(text).toContain("[recap truncated]"); // truncation actually fired
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
    expect(text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // no lone low surrogate
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

describe("coach answer replay projection (option c)", () => {
  it("preserves the beginning and ending, dropping the middle with a marker", () => {
    const head = "HEAD_SENTINEL " + "h".repeat(6_000);
    const middle = "MID_SENTINEL " + "m".repeat(30_000);
    const tail = "t".repeat(3_800) + " TAIL_SENTINEL";
    const projected = projectCoachAnswer(head + middle + tail);

    expect(projected.length).toBeLessThanOrEqual(10_000);
    expect(projected).toContain("HEAD_SENTINEL");
    expect(projected).toContain("TAIL_SENTINEL");
    expect(projected).not.toContain("MID_SENTINEL");
    expect(projected).toMatch(/\n\[… \d+ chars omitted …\]\n/);
  });

  it("is a byte-identical no-op within the cap and stable when re-projected", () => {
    const short = "a".repeat(10_000); // exactly at the cap
    expect(projectCoachAnswer(short)).toBe(short);
    // No double-projection distortion: projecting an already-projected answer
    // returns it unchanged (it is now well under the cap).
    const once = projectCoachAnswer("x".repeat(30_000));
    expect(projectCoachAnswer(once)).toBe(once);
  });

  it("slices on code points — never splits a surrogate pair", () => {
    // 🎉 is a surrogate pair (2 UTF-16 units, 1 code point); a naive .slice at
    // the head/tail boundary would leave a lone surrogate.
    const projected = projectCoachAnswer("🎉".repeat(20_000));
    expect(projected.startsWith("🎉")).toBe(true);
    expect(projected.endsWith("🎉")).toBe(true);
    expect(projected).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no high surrogate without a low
    expect(projected).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // no low surrogate without a high
  });
});

describe("coach history section budget (exact rendered size)", () => {
  it("caps an oversized newest entry via projection so it cannot overshoot the budget", () => {
    // Pre-option-"c" the newest entry was kept WHOLE (the old kept.length>0
    // guard) — a 40k answer would blow the 60k budget once escaped/wrapped.
    // Projection now caps it to ≤10k first.
    const section = coachHistorySection([{ question: "q", answer: "z".repeat(40_000) }]);
    expect(section.length).toBeLessThanOrEqual(60_000);
    expect(section).toMatch(/\n\[… \d+ chars omitted …\]\n/); // projected, not whole
  });

  it("sheds oldest entries so the exact rendered section stays within budget", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      question: `Q${i}`,
      answer: `A${i} ` + "y".repeat(9_900), // ~9.9k, just under the projection cap
    }));
    const section = coachHistorySection(entries);
    expect(section.length).toBeLessThanOrEqual(60_000);
    expect(section).toContain("A19"); // newest kept
    expect(section).not.toContain("A0 "); // oldest shed
  });

  it("renders a within-cap answer byte-identical (escaped), no projection marker", () => {
    const section = coachHistorySection([{ question: "q", answer: "plain answer text" }]);
    expect(section).toContain("<coach>plain answer text</coach>");
    expect(section).not.toContain("chars omitted");
  });
});

describe("fan-summary short variant", () => {
  const fanSummaryBase = {
    feature: "fan-summary",
    personality: { content: "PERSONA", id: "p1", name: "Persona", updatedAt: 1 },
    platform: "fansly",
    transcript: "fan: hi",
    fanSpendingData: "",
    fanSubscriptionData: "",
    fanDisplayName: "Bob",
  } satisfies PromptBuildInput;

  it("selects the short template when summaryMode is 'short'", () => {
    const built = buildPrompt({ ...fanSummaryBase, summaryMode: "short" });
    expect(JSON.stringify(built.userBlocks)).toContain("COMPACT RECAP");
  });

  it("keeps the full template when summaryMode is unset", () => {
    const built = buildPrompt(fanSummaryBase);
    expect(JSON.stringify(built.userBlocks)).not.toContain("COMPACT RECAP");
    // full fan-summary opens with the detailed profile framing
    expect(JSON.stringify(built.userBlocks)).toContain("detailed fan profile review");
  });

  it("short template carries the cache anchors (fan-agnostic static prefix)", () => {
    const built = buildPrompt({
      ...fanSummaryBase,
      summaryMode: "short",
      transcript: "TRANSCRIPTBODY",
      fanSpendingData: "SPENDBODY",
      transcriptCoverage: "window",
    });
    expect(built.userBlocks).toHaveLength(3);
    const [staticBlock, dynamicBlock, taskBlock] = built.userBlocks;
    expect(staticBlock?.cache).toBe("1h");
    expect(staticBlock?.text).toContain("COMPACT RECAP");
    expect(staticBlock?.text).not.toContain("TRANSCRIPTBODY");
    expect(staticBlock?.text).not.toContain("SPENDBODY");
    expect(dynamicBlock?.cache).toBe("5m");
    expect(dynamicBlock?.text).toContain("TRANSCRIPTBODY");
    expect(dynamicBlock?.text).toContain("SPENDBODY");
    expect(dynamicBlock?.text).toContain("most recent window only");
    expect(taskBlock?.cache).toBe("none");
    // The template file constant is what the selection returns (Fansly wording).
    expect(FAN_SUMMARY_SHORT_TEMPLATE).toContain("COMPACT RECAP");
  });
});
