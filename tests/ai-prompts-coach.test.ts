import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildPrompt,
  coachBudgetStats,
  coachHistorySection,
  COACH_CHAT_TEMPLATE,
  COACH_PROMPT_MAX_CHARS,
  ANALYSIS_SAFETY_PREAMBLE,
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
    expect(built.coachRecapSlots).toEqual({ full: true, short: true });
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
    expect(built.userBlocks).toHaveLength(4);
    const [staticBlock, dynamicBlock, historyBlock, taskBlock] = built.userBlocks;
    // The 1h prefix must be fan-agnostic (builder invariant) — none of the
    // per-fan / per-turn data may ride here or the breakpoint never re-hits.
    expect(staticBlock?.cache).toBe("1h");
    expect(staticBlock?.text).toContain("## Rules");
    expect(staticBlock?.text).not.toContain("FULLBODY");
    expect(staticBlock?.text).not.toContain("PRIORQ");
    expect(staticBlock?.text).not.toContain("TRANSCRIPTBODY");
    expect(staticBlock?.text).not.toContain("## Fan Recaps");
    // Recaps + dossier ride the ephemeral dynamic block with the transcript.
    expect(dynamicBlock?.cache).toBe("5m");
    expect(dynamicBlock?.text).toContain("TRANSCRIPTBODY");
    expect(dynamicBlock?.text).toContain("FULLBODY");
    expect(dynamicBlock?.text).not.toContain("PRIORQ");
    // The per-turn coach dialog rides its OWN 5m block after the transcript,
    // so a growing dialog never invalidates the cached transcript bytes.
    expect(historyBlock?.cache).toBe("5m");
    expect(historyBlock?.text).toContain("## Coach Dialog So Far");
    expect(historyBlock?.text).toContain("PRIORQ");
    expect(historyBlock?.text).not.toContain("TRANSCRIPTBODY");
    // The recap age label is never minute-granular (it sits in a cached block).
    expect(dynamicBlock?.text).toContain("Full recap, generated under an hour ago:");
    // The question stays in the uncached task block.
    expect(taskBlock?.cache).toBe("none");
    expect(taskBlock?.text).toContain("как продать ppv?");
  });

  it("pins the normal English-draft task with an empty preset slot", () => {
    const built = buildPrompt({ ...baseInput });
    const taskBlock = built.userBlocks[3];
    expect(taskBlock?.text).toBe(`## Your Task

The chatter asks:

<chatter_question>
как продать ppv?
</chatter_question>



Answer the chatter now in the language they asked in. Use a draft fence for any proposed fan message, in the fan's language (English by default). Keep the explanation outside the fence.
`);
    expect(built.user).not.toContain("## Preset Turn");
    expect(built.user).not.toContain("{presetInstructions}");

    const withDraft = buildPrompt({
      ...baseInput,
      draftText: "  hey <babe> & wanna see more? 😘  ",
    });
    expect(
      createHash("sha256").update(JSON.stringify(withDraft.userBlocks)).digest("hex"),
    ).toBe("a27e53c16324f65f46804a55775f0688e061d78dc3afc7dc1f097a87e8cd72b3");
  });

  it("renders the situation preset only in the uncached task block", () => {
    const built = buildPrompt({
      ...baseInput,
      preset: "situation",
      draftText: "warm start",
    });
    expect(built.userBlocks).toHaveLength(4);
    const [staticBlock, dynamicBlock, historyBlock, taskBlock] = built.userBlocks;
    expect(staticBlock?.cache).toBe("1h");
    expect(staticBlock?.text).not.toContain("## Preset Turn");
    expect(dynamicBlock?.cache).toBe("5m");
    expect(dynamicBlock?.text).not.toContain("## Preset Turn");
    expect(historyBlock?.cache).toBe("5m");
    expect(historyBlock?.text).not.toContain("## Preset Turn");
    expect(taskBlock?.cache).toBe("none");
    expect(taskBlock?.text).toContain("## Preset Turn");
    expect(taskBlock?.text).toContain("СИТУАЦИЯ:");
    expect(taskBlock?.text).toContain("ЧТО УПУЩЕНО:");
    expect(taskBlock?.text).toContain("СЛЕДУЮЩИЙ ХОД:");
    expect(taskBlock?.text).toContain("РИСК:");
    expect(taskBlock?.text).toContain("EXACTLY two draft fences");
    expect(taskBlock?.text.indexOf("## Chatter's Working Draft")).toBeLessThan(
      taskBlock!.text.indexOf("## Preset Turn"),
    );
    expect(taskBlock?.text.indexOf("## Preset Turn")).toBeLessThan(
      taskBlock!.text.indexOf("Answer the chatter now in the language they asked in."),
    );
    expect(built.user).not.toContain("{presetInstructions}");
  });

  it("bounds the whole worst-legal escaped prompt while preserving the question and newest transcript", () => {
    const amp = "&";
    const transcript =
      "OLDEST_TRANSCRIPT_SENTINEL\n"
      + amp.repeat(299_940)
      + "\nNEWEST_TRANSCRIPT_🎉";
    const built = buildPrompt({
      ...baseInput,
      personality: {
        ...baseInput.personality,
        content: amp.repeat(50_000),
      },
      transcript,
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: amp.repeat(1_980) + "QUESTION_SENTINEL",
      preset: "situation",
      coachHistory: Array.from({ length: 20 }, (_, index) => ({
        question: `HISTORY_Q_${index}` + amp.repeat(1_980),
        answer: `HISTORY_A_${index}` + amp.repeat(63_980),
      })),
      recapAttach: {
        full: { body: "FULL_RECAP " + amp.repeat(40_000), ageMs: 86_400_000 },
        short: { body: "SHORT_RECAP " + amp.repeat(40_000), ageMs: 60_000 },
      },
      fanProfile: {
        body: "DOSSIER " + amp.repeat(19_990),
        generatedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      transcriptCoverage: "window",
    });
    const text = built.system + built.user;

    expect(text.length).toBeLessThanOrEqual(COACH_PROMPT_MAX_CHARS);
    expect(built.system).toContain(amp.repeat(50_000));
    expect(built.user).toContain("QUESTION_SENTINEL");
    expect(built.user).toContain("## Preset Turn");
    expect(built.user).toContain("[older transcript omitted]");
    expect(built.user).toContain("NEWEST_TRANSCRIPT_🎉");
    expect(built.user).not.toContain("OLDEST_TRANSCRIPT_SENTINEL");
    expect(built.coachRecapSlots).toEqual({ full: false, short: false });
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("sheds oldest coach exchanges before reducing summaries or the transcript", () => {
    const amp = "&";
    const built = buildPrompt({
      ...baseInput,
      personality: { ...baseInput.personality, content: amp.repeat(50_000) },
      transcript: "TRANSCRIPT_HEAD\n" + amp.repeat(1_800) + "\nTRANSCRIPT_TAIL",
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: amp.repeat(2_000),
      coachHistory: [
        { question: "OLDEST_HISTORY", answer: "old " + "o".repeat(3_000) },
        { question: "NEWEST_HISTORY", answer: "new " + "n".repeat(500) },
      ],
      recapAttach: {
        full: { body: "FULL_UNTOUCHED", ageMs: 86_400_000 },
        short: { body: "SHORT_UNTOUCHED", ageMs: 60_000 },
      },
      fanProfile: {
        body: "DOSSIER_UNTOUCHED",
        generatedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });

    expect(built.system.length + built.user.length).toBeLessThanOrEqual(
      COACH_PROMPT_MAX_CHARS,
    );
    expect(built.user).not.toContain("OLDEST_HISTORY");
    expect(built.user).toContain("NEWEST_HISTORY");
    expect(built.user).toContain("FULL_UNTOUCHED");
    expect(built.user).toContain("SHORT_UNTOUCHED");
    expect(built.user).toContain("DOSSIER_UNTOUCHED");
    expect(built.user).not.toContain("older transcript omitted");
    expect(built.coachRecapSlots).toEqual({ full: true, short: true });
  });

  it("reduces intact summary sections before trimming the oldest transcript", () => {
    const amp = "&";
    const built = buildPrompt({
      ...baseInput,
      // The window is packed against the exact 300k ceiling, so the padding has
      // to move with the system preamble: bytes added there (Decision #189's
      // writing rules) come straight out of the budget under test, and a fixed
      // 50k would silently start shedding the recap this case asserts is KEPT.
      // The same goes for the coach template itself: it was 2_191 chars when
      // this case was calibrated, and every later template edit (Decision
      // #283's fan-language rule, for one) must come out of the padding too.
      personality: {
        ...baseInput.personality,
        content: amp.repeat(
          50_000 - ANALYSIS_SAFETY_PREAMBLE.length - (COACH_CHAT_TEMPLATE.length - 2_191),
        ),
      },
      transcript: "TRANSCRIPT_HEAD\n" + amp.repeat(2_000) + "\nTRANSCRIPT_TAIL",
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: amp.repeat(2_000),
      recapAttach: {
        full: { body: "FULL_TO_SHED " + amp.repeat(500), ageMs: 86_400_000 },
        short: { body: "SHORT_TO_KEEP " + amp.repeat(500), ageMs: 60_000 },
      },
      fanProfile: {
        body: "DOSSIER_TO_SHED " + amp.repeat(500),
        generatedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });

    expect(built.system.length + built.user.length).toBeLessThanOrEqual(
      COACH_PROMPT_MAX_CHARS,
    );
    expect(built.user).not.toContain("DOSSIER_TO_SHED");
    expect(built.user).not.toContain("FULL_TO_SHED");
    expect(built.user).toContain("SHORT_TO_KEEP");
    expect(built.user).toContain("TRANSCRIPT_HEAD");
    expect(built.user).toContain("TRANSCRIPT_TAIL");
    expect(built.user).not.toContain("older transcript omitted");
    expect((built.user.match(/<short_recap>/g) ?? [])).toHaveLength(1);
    expect((built.user.match(/<\/short_recap>/g) ?? [])).toHaveLength(1);
    expect(built.coachRecapSlots).toEqual({ full: false, short: true });
  });

  it("reports how much of the transcript the budget left out, in the string's own units", () => {
    // Whole transcript: nothing left out. Other features have no reducer and no report.
    expect(buildPrompt(baseInput).coachTranscriptOmittedChars).toBe(0);
    expect(buildPrompt({ ...baseInput, feature: "help-me" })).not.toHaveProperty("coachTranscriptOmittedChars");

    // Astral characters: the reducer counts code points, the report is UTF-16
    // units, so `slice` on the caller's string lands exactly on the cut.
    const transcript = Array.from({ length: 4_000 }, (_, index) => `[10:00] Fan: line ${index} 🎉 ${"x".repeat(90)}`)
      .join("\n");
    const variants: Array<Partial<PromptBuildInput>> = [
      {},
      // The shed-draft path: the cascade runs twice and reuses the first search.
      {
        draftText: "d".repeat(20_000),
        coachHistory: [{ question: "earlier question", answer: "a".repeat(5_000) }],
        recapAttach: { full: { body: "FULL RECAP", ageMs: 86_400_000 }, short: null },
      },
      // A small draft rides the transcript search and costs its own size.
      { draftText: "short draft" },
    ];
    const cuts = variants.map((variant) => {
      const built = buildPrompt({ ...baseInput, transcript, ...variant });
      const omitted = built.coachTranscriptOmittedChars!;
      expect(built.system.length + built.user.length).toBeLessThanOrEqual(COACH_PROMPT_MAX_CHARS);
      expect(omitted).toBeGreaterThan(0);
      expect(omitted).toBeLessThan(transcript.length);
      // The prompt holds exactly the rest, behind the marker, and not one unit more.
      expect(built.user).toContain(`[older transcript omitted]\n${transcript.slice(omitted)}`);
      expect(built.user).not.toContain(transcript.slice(omitted - 1));
      return omitted;
    });
    // The small draft took its room from the oldest transcript lines.
    expect(cuts[2]).toBeGreaterThan(cuts[0]!);
  });

  it("deduplicates a byte-identical recap already carried as the dossier", () => {
    const built = buildPrompt({
      ...baseInput,
      fanProfile: {
        body: "SAME_SUMMARY",
        generatedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      recapAttach: {
        full: { body: "SAME_SUMMARY", ageMs: 60_000 },
        short: { body: "FRESH_SHORT", ageMs: 1_000 },
      },
    });

    expect(built.user).toContain("<fan_dossier>\nSAME_SUMMARY\n</fan_dossier>");
    expect(built.user).not.toContain("<full_recap>");
    expect(built.user).toContain("<short_recap>\nFRESH_SHORT\n</short_recap>");
    expect(built.coachRecapSlots).toEqual({ full: false, short: true });
  });
});

describe("coach-chat optional draft", () => {
  it("renders the escaped, framed draft section in the uncached task block when a draft is present", () => {
    const built = buildPrompt({
      ...baseInput,
      draftText: "  hey <babe> & wanna see more? 😘  ",
    });
    const [staticBlock, dynamicBlock, historyBlock, taskBlock] = built.userBlocks;
    // The section is present and framed as the chatter's OWN unsent reply.
    expect(built.user).toContain("## Chatter's Working Draft");
    expect(built.user).toContain("This is their OWN unsent draft");
    // Body is trimmed and escaped (untrusted input), wrapped in the builder tag.
    expect(built.user).toContain(
      "<chatter_draft>\nhey &lt;babe&gt; &amp; wanna see more? 😘\n</chatter_draft>",
    );
    expect(built.user).not.toContain("hey <babe> & wanna");
    // No leftover placeholder.
    expect(built.user).not.toContain("{coachDraftSection}");
    // Review P2: the draft is a per-turn volatile input — it rides the UNCACHED
    // task block next to the question, so a changed/attached draft never
    // invalidates the 5m dynamic prefix (retry / fresh-dialog cache hits).
    expect(staticBlock?.cache).toBe("1h");
    expect(staticBlock?.text).not.toContain("## Chatter's Working Draft");
    expect(dynamicBlock?.cache).toBe("5m");
    expect(dynamicBlock?.text).not.toContain("## Chatter's Working Draft");
    expect(historyBlock?.cache).toBe("5m");
    expect(historyBlock?.text).not.toContain("## Chatter's Working Draft");
    expect(taskBlock?.cache).toBe("none");
    expect(taskBlock?.text).toContain("## Chatter's Working Draft");
    expect(taskBlock?.text).toContain("<chatter_draft>");
    expect(built.coachDraftIncluded).toBe(true);
  });

  it("omits the draft section entirely when no draft is provided", () => {
    const built = buildPrompt({ ...baseInput });
    expect(built.user).not.toContain("## Chatter's Working Draft");
    expect(built.user).not.toContain("<chatter_draft>");
    expect(built.user).not.toContain("{coachDraftSection}");
  });

  it("omits the draft section when the draft is whitespace-only", () => {
    const built = buildPrompt({ ...baseInput, draftText: "   \n\t  " });
    expect(built.user).not.toContain("## Chatter's Working Draft");
    expect(built.user).not.toContain("<chatter_draft>");
  });

  it("sheds the draft whole under budget pressure while keeping the question and newest transcript", () => {
    const amp = "&";
    const built = buildPrompt({
      ...baseInput,
      personality: { ...baseInput.personality, content: amp.repeat(50_000) },
      transcript: "OLDEST_TX\n" + amp.repeat(299_940) + "\nNEWEST_TX_🎉",
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: amp.repeat(1_980) + "QUESTION_SENTINEL",
      // Worst-legal draft (20k chars, ~100k escaped) — cannot be protected.
      draftText: "DRAFT_SENTINEL " + amp.repeat(19_980),
    });
    const text = built.system + built.user;
    expect(text.length).toBeLessThanOrEqual(COACH_PROMPT_MAX_CHARS);
    // The draft is dropped whole — no fragment leaks through, no dangling heading.
    expect(built.user).not.toContain("DRAFT_SENTINEL");
    expect(built.user).not.toContain("## Chatter's Working Draft");
    // Review round 3: the shed is visible to the audit trail, never silent.
    expect(built.coachDraftIncluded).toBe(false);
    // Review round 8: on the trimmed path the note rides the search itself —
    // it costs ~78 chars of the OLDEST transcript tail, never a section — so
    // the «critique my draft» turn always sees the omission owned up to.
    expect(built.user).toContain(
      "(the chatter attached a working draft; it was omitted to fit the prompt budget)",
    );
    // The protected fields survive: the question and the newest transcript.
    expect(built.user).toContain("QUESTION_SENTINEL");
    expect(built.user).toContain("NEWEST_TX_🎉");
    expect(built.user).toContain("[older transcript omitted]");
    expect(built.user).not.toContain("OLDEST_TX");
  });

  it("keeps the working draft while shedding an older summary that alone covers the overage", () => {
    const amp = "&";
    const built = buildPrompt({
      ...baseInput,
      personality: { ...baseInput.personality, content: amp.repeat(50_000) },
      transcript: "TX_HEAD TX_TAIL",
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: amp.repeat(2_000),
      draftText: "DRAFT_KEEP " + amp.repeat(200),
      fanProfile: {
        body: "DOSSIER_TO_SHED " + amp.repeat(4_000),
        generatedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    expect(built.system.length + built.user.length).toBeLessThanOrEqual(
      COACH_PROMPT_MAX_CHARS,
    );
    // The stale dossier is shed BEFORE the draft is even considered...
    expect(built.user).not.toContain("DOSSIER_TO_SHED");
    // ...and the shed is reported for the manifest correction (review round 6).
    expect(built.coachDossierIncluded).toBe(false);
    // ...so the freshest current-turn context — the working draft — survives,
    // and the transcript is never trimmed.
    expect(built.user).toContain("## Chatter's Working Draft");
    expect(built.user).toContain("DRAFT_KEEP");
    expect(built.user).toContain("TX_HEAD TX_TAIL");
    expect(built.user).not.toContain("older transcript omitted");
  });

  it("marks a budget-evicted dialog as omitted instead of claiming a first question", () => {
    const amp = "&";
    const built = buildPrompt({
      ...baseInput,
      personality: { ...baseInput.personality, content: amp.repeat(50_000) },
      transcript: "TX_HEAD TX_TAIL",
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: amp.repeat(2_000),
      draftText: "DRAFT_KEEP " + amp.repeat(200),
      // One prior exchange whose projected answer (~10k chars → ~50k escaped)
      // pushes the prompt over the ceiling; step 1 sheds the WHOLE dialog.
      coachHistory: [{ question: "PRIOR_Q", answer: amp.repeat(10_000) }],
    });
    expect(built.system.length + built.user.length).toBeLessThanOrEqual(
      COACH_PROMPT_MAX_CHARS,
    );
    expect(built.user).not.toContain("PRIOR_Q");
    // The section owns up to the eviction — it must NOT claim first-question
    // status for a dialog the caller actually sent.
    expect(built.user).toContain(
      "(earlier 1 coach exchange omitted to fit the prompt budget)",
    );
    expect(built.user).not.toContain("this is the first question");
    // The draft (shed only at step 2b, after history) survives.
    expect(built.user).toContain("DRAFT_KEEP");
  });

  it("never sheds context to make room for a draft that itself cannot fit", () => {
    const amp = "&";
    const built = buildPrompt({
      ...baseInput,
      personality: { ...baseInput.personality, content: amp.repeat(50_000) },
      transcript: "TX_HEAD TX_TAIL",
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: amp.repeat(2_000),
      coachHistory: [{ question: "HIST_KEEP_Q", answer: "hist " + amp.repeat(500) }],
      fanProfile: {
        body: "DOSSIER_KEEP " + amp.repeat(800),
        generatedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      recapAttach: {
        full: { body: "FULLREC_KEEP " + amp.repeat(400), ageMs: 60_000 },
        short: { body: "SHORTREC_KEEP " + amp.repeat(400), ageMs: 30_000 },
      },
      // Worst-legal draft (~100k escaped): cannot fit even after every optional
      // section is gone.
      draftText: "DRAFT_TOO_BIG " + amp.repeat(19_980),
    });
    // Review P1: the draftless prompt fits WITH all context, so attaching an
    // unfittable draft must not cost the coach that context — the reducer's
    // second pass rebuilds from the original inputs with the draft off.
    expect(built.system.length + built.user.length).toBeLessThanOrEqual(
      COACH_PROMPT_MAX_CHARS,
    );
    expect(built.user).not.toContain("DRAFT_TOO_BIG");
    expect(built.user).not.toContain("## Chatter's Working Draft");
    expect(built.coachDraftIncluded).toBe(false);
    expect(built.user).toContain("HIST_KEEP_Q");
    expect(built.user).toContain("DOSSIER_KEEP");
    expect(built.user).toContain("FULLREC_KEEP");
    expect(built.user).toContain("SHORTREC_KEEP");
    expect(built.user).toContain("TX_HEAD TX_TAIL");
    // No HISTORY was evicted (the draftless pass kept everything)…
    expect(built.user).not.toContain("coach exchange");
    // …but the attached draft's own omission is owned up to (review round 6),
    // and the kept dossier reports included for the manifest.
    expect(built.user).toContain("(the chatter attached a working draft");
    expect(built.coachDossierIncluded).toBe(true);
  });

  it("reuses the pass-1 transcript search when the draftless pass re-trims (memo path)", () => {
    const amp = "&";
    const searchesBefore = coachBudgetStats.transcriptSearches;
    const built = buildPrompt({
      ...baseInput,
      personality: { ...baseInput.personality, content: amp.repeat(50_000) },
      // Transcript that must be tail-trimmed even AFTER every optional section
      // is shed — both passes reach step 3, the second via the memoized search.
      transcript: "OLDEST_MEMO\n" + amp.repeat(40_000) + "\nNEWEST_MEMO",
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: amp.repeat(2_000),
      coachHistory: [{ question: "MEMO_HIST_Q", answer: "hist " + amp.repeat(500) }],
      fanProfile: {
        body: "MEMO_DOSSIER " + amp.repeat(500),
        generatedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      draftText: "MEMO_DRAFT " + amp.repeat(19_980),
    });
    expect(built.system.length + built.user.length).toBeLessThanOrEqual(
      COACH_PROMPT_MAX_CHARS,
    );
    // The draft could not fit; the second pass also shed everything and trimmed
    // the transcript via the memo — the ceiling still holds exactly.
    // Review round 7 regression guard: the memo means exactly ONE binary
    // search ran across both passes — without it this asserts 2.
    expect(coachBudgetStats.transcriptSearches - searchesBefore).toBe(1);
    expect(built.coachDraftIncluded).toBe(false);
    expect(built.coachDossierIncluded).toBe(false);
    expect(built.user).toContain("NEWEST_MEMO");
    expect(built.user).not.toContain("OLDEST_MEMO");
    expect(built.user).toContain("[older transcript omitted]");
    // Round 8: the note rides the memoized search too — identical across passes.
    expect(built.user).toContain("(the chatter attached a working draft");
  });

  it("a transient duplicate recap never evicts history (dedupe precedes measurement)", () => {
    const amp = "&";
    const dupBody = "DUP_RECAP " + amp.repeat(200);
    const base = {
      ...baseInput,
      personality: { ...baseInput.personality, content: amp.repeat(50_000) },
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: amp.repeat(2_000),
      coachHistory: [{ question: "HISTORY_SENTINEL", answer: "hist " + amp.repeat(100) }],
      draftText: "DRAFT_KEEP " + amp.repeat(100),
      recapAttach: {
        full: { body: dupBody, ageMs: 86_400_000 },
        short: { body: dupBody, ageMs: 60_000 },
      },
    };
    // Calibrate: with ONE recap copy (post-dedupe truth) everything fits at the
    // exact ceiling.
    const probe = buildPrompt({ ...base, transcript: "X" });
    const slack = COACH_PROMPT_MAX_CHARS - (probe.system.length + probe.user.length);
    const built = buildPrompt({ ...base, transcript: "X" + "y".repeat(slack) });
    expect(built.system.length + built.user.length).toBeLessThanOrEqual(COACH_PROMPT_MAX_CHARS);
    // Round 8: the duplicate is dead weight and must be gone BEFORE the shed
    // loop measures anything — history survives.
    expect(built.user).toContain("HISTORY_SENTINEL");
    expect(built.user).toContain("DRAFT_KEEP");
  });

  it("multi-entry marker compensation sheds exactly one more entry (loop 1 fires)", () => {
    // Calibrate SIX entries whose markerless render is exactly 59_999 (walk
    // keeps all six with 1 char of slack); the counted marker + wider absolute
    // numbers then overflow, and the compensation loop must shed exactly one
    // (review round 10: the previous calibration missed the join newlines and
    // fired neither loop — verified by instrumented execution).
    const probe = coachHistorySection([{ question: "q", answer: "a".repeat(100) }]).length;
    const wrapper = probe - 100; // per-entry non-answer chars at n="1"
    const answer = "a".repeat(9_999 - wrapper);
    const entries = Array.from({ length: 6 }, () => ({ question: "q", answer }));
    // Baseline sanity: without outer omissions the walk keeps ALL six.
    const baseline = coachHistorySection(entries);
    expect(baseline.length).toBeGreaterThan(59_900);
    expect(baseline.length).toBeLessThanOrEqual(60_000);
    expect(baseline).not.toContain("omitted to fit the prompt budget");

    const section = coachHistorySection(entries, 3);
    expect(section.length).toBeLessThanOrEqual(60_000);
    // 3 outer + 1 compensation-shed = 4 omitted; the newest keeps its absolute
    // number (dialog of 9), the compensation victim's number is gone.
    expect(section).toContain("(earlier 4 coach exchanges omitted to fit the prompt budget)");
    expect(section).toContain('<coach_exchange n="9">');
    expect(section).not.toContain('<coach_exchange n="4">');
  });

  it("a SMALL draft rides the transcript search instead of being shed (review round 10)", () => {
    const amp = "&";
    const built = buildPrompt({
      ...baseInput,
      personality: { ...baseInput.personality, content: amp.repeat(50_000) },
      transcript: "OLDEST_SMALL\n" + amp.repeat(40_000) + "\nNEWEST_SMALL",
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: "оцени мой черновик?",
      draftText: "привет, скучал? у меня для тебя кое-что есть…",
    });
    expect(built.system.length + built.user.length).toBeLessThanOrEqual(
      COACH_PROMPT_MAX_CHARS,
    );
    // The tiny draft costs oldest-tail chars, not its own existence: the coach
    // SEES the draft on a «critique my draft» turn even under max pressure.
    expect(built.coachDraftIncluded).toBe(true);
    expect(built.user).toContain("привет, скучал?");
    expect(built.user).toContain("NEWEST_SMALL");
    expect(built.user).not.toContain("OLDEST_SMALL");
    expect(built.user).not.toContain("(the chatter attached a working draft");
  });

  it("single-entry compensation loses only the marker's worth, not hundreds of chars (loop 2)", () => {
    // Escaped near-boundary single entry (review round 9): markerless ≈ 59_941,
    // marker + wider number ≈ +63 → overflow ≈ 4. The binary search must find
    // the LARGEST fitting projection — the old fixed cut lost 200+ chars.
    const amp = "&";
    const section = coachHistorySection(
      [{ question: amp.repeat(1_973), answer: amp.repeat(10_000) }],
      15,
    );
    expect(section.length).toBeLessThanOrEqual(60_000);
    expect(section.length).toBeGreaterThanOrEqual(59_900);
    expect(section).toContain("omitted to fit the prompt budget");
    expect(section).toContain('<coach_exchange n="16">');
  });

  it("a dropped draft displaces NOTHING even at the exact ceiling (twin equivalence)", () => {
    const amp = "&";
    const base = {
      ...baseInput,
      personality: { ...baseInput.personality, content: amp.repeat(50_000) },
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: amp.repeat(2_000),
      fanProfile: {
        body: "DOSSIER_KEEP " + amp.repeat(300),
        generatedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    };
    // Calibrate a plain-text transcript so the DRAFTLESS prompt lands exactly
    // on the ceiling while keeping the dossier.
    const probe = buildPrompt({ ...base, transcript: "X" });
    const slack = COACH_PROMPT_MAX_CHARS - (probe.system.length + probe.user.length);
    const transcript = "X" + "y".repeat(slack);
    const twin = buildPrompt({ ...base, transcript });
    expect(twin.system.length + twin.user.length).toBe(COACH_PROMPT_MAX_CHARS);
    expect(twin.user).toContain("DOSSIER_KEEP");

    // Round-6 regression (review round 7): the omission note used to ride the
    // cascade and evict the dossier here. Attaching an unfittable draft must
    // change NOTHING at the boundary — the note is dropped, the dossier stays.
    const withDraft = buildPrompt({
      ...base,
      transcript,
      draftText: "DRAFT_TOO_BIG " + amp.repeat(19_980),
    });
    expect(withDraft.system.length + withDraft.user.length).toBeLessThanOrEqual(
      COACH_PROMPT_MAX_CHARS,
    );
    expect(withDraft.user).toContain("DOSSIER_KEEP");
    expect(withDraft.coachDossierIncluded).toBe(true);
    expect(withDraft.coachDraftIncluded).toBe(false);
    expect(withDraft.user).not.toContain("(the chatter attached a working draft");
    expect(withDraft.user).toBe(twin.user);
  });

  it("a shed draft leaves the CACHED dynamic block byte-identical to the draftless twin (final P1)", () => {
    const amp = "&";
    const base = {
      ...baseInput,
      personality: { ...baseInput.personality, content: amp.repeat(50_000) },
      transcript: "OLDEST_EQ\n" + amp.repeat(40_000) + "\nNEWEST_EQ",
      fanSpendingData: amp.repeat(20_000),
      fanSubscriptionData: amp.repeat(20_000),
      fanBio: amp.repeat(5_000),
      chatterQuestion: amp.repeat(2_000),
    };
    const draftless = buildPrompt(base);
    const shed = buildPrompt({ ...base, draftText: "DRAFT_EQ " + amp.repeat(19_980) });
    expect(shed.coachDraftIncluded).toBe(false);
    expect(shed.user).toContain("(the chatter attached a working draft");
    // The 5m-cached dynamic block (userBlocks[1]) must not differ by a byte —
    // a differing prefix re-bills the whole block at the provider.
    expect(shed.userBlocks[1]?.text).toBe(draftless.userBlocks[1]?.text);
  });

  it("keeps the first-question claim only for a genuinely empty dialog", () => {
    expect(coachHistorySection(undefined)).toContain("this is the first question");
    expect(coachHistorySection([], 0)).toContain("this is the first question");
    expect(coachHistorySection([], 2)).toBe(
      "(earlier 2 coach exchanges omitted to fit the prompt budget)",
    );
    // Partial eviction is owned up to too: counted marker + ABSOLUTE numbering
    // (review P2 — the survivor must not be renumbered as the dialog opener).
    const partial = coachHistorySection([{ question: "q16", answer: "a16" }], 15);
    expect(partial).toContain(
      "(earlier 15 coach exchanges omitted to fit the prompt budget)",
    );
    expect(partial).toContain('<coach_exchange n="16">');
    expect(partial).not.toContain('<coach_exchange n="1">');
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
    // Review P2: this internal shed is owned up to as well — counted marker,
    // and the newest entry keeps its ABSOLUTE dialog number.
    expect(section).toContain("omitted to fit the prompt budget");
    expect(section).toContain('<coach_exchange n="20">');
    expect(section).not.toContain('<coach_exchange n="1">');
  });

  it("renders a within-cap answer byte-identical (escaped), no projection marker", () => {
    const section = coachHistorySection([{ question: "q", answer: "plain answer text" }]);
    expect(section).toContain("<coach>plain answer text</coach>");
    expect(section).not.toContain("chars omitted");
  });

  it("shrinks the newest entry when '&'-escaping inflates its rendered size past the budget", () => {
    // Round-4 P2-5: the newest entry used to bypass the budget entirely (the
    // old kept.length>0 guard). Every '&' escapes to the 5-char '&amp;', so a
    // MAX question (2000 '&' -> 10000 rendered) plus a projection-cap answer
    // (10000 '&', a projectCoachAnswer no-op, -> 50000 rendered) plus the XML
    // wrapper renders to ~60076 -- OVER the 60k budget. The newest entry must be
    // re-projected smaller until its RENDERED (escaped+wrapped) form fits.
    const section = coachHistorySection([
      { question: "&".repeat(2_000), answer: "&".repeat(10_000) },
    ]);
    expect(section.length).toBeLessThanOrEqual(60_000);
    // It was shrunk, not dropped: the shrink projection leaves the omission
    // marker, and the (escaped) newest question is still present.
    expect(section).toContain("chars omitted");
    expect(section).toContain("&amp;".repeat(1)); // question rendered, escaped
  });

  it("shrinks the newest entry even when it is the ONLY entry (max question + max answer)", () => {
    // The worst legal single entry: 2000-char question + 64000-char answer, all
    // '&'. Proves the guarantee holds with nothing older to shed.
    const section = coachHistorySection([
      { question: "&".repeat(2_000), answer: "&".repeat(64_000) },
    ]);
    expect(section.length).toBeLessThanOrEqual(60_000);
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

  it("short template keeps its anchor layout (fan-agnostic static prefix) and sends it uncached (Decision 319)", () => {
    const built = buildPrompt({
      ...fanSummaryBase,
      summaryMode: "short",
      transcript: "TRANSCRIPTBODY",
      fanSpendingData: "SPENDBODY",
      transcriptCoverage: "window",
    });
    expect(built.userBlocks).toHaveLength(3);
    const [staticBlock, dynamicBlock, taskBlock] = built.userBlocks;
    expect(staticBlock?.cache).toBe("none");
    expect(staticBlock?.text).toContain("COMPACT RECAP");
    expect(staticBlock?.text).not.toContain("TRANSCRIPTBODY");
    expect(staticBlock?.text).not.toContain("SPENDBODY");
    expect(dynamicBlock?.cache).toBe("none");
    expect(dynamicBlock?.text).toContain("TRANSCRIPTBODY");
    expect(dynamicBlock?.text).toContain("SPENDBODY");
    expect(dynamicBlock?.text).toContain("most recent window only");
    expect(taskBlock?.cache).toBe("none");
    // The template file constant is what the selection returns (Fansly wording).
    expect(FAN_SUMMARY_SHORT_TEMPLATE).toContain("COMPACT RECAP");
  });
});
